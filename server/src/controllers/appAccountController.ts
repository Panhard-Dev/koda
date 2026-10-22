import type { ContextoApp } from '../types.js';
import { corpoJson, parametros } from '../middlewares/validacao.js';
import {
  identificadorParamSchema,
  loginContaSchema,
  refreshSchema,
  registroContaSchema,
} from '../validation/schemas.js';
import { auditar, contextoDe } from '../services/auditService.js';
import { encerrar, loginConta, renovar } from '../services/authService.js';
import * as contas from '../services/accountService.js';
import * as usuarios from '../models/users.js';
import * as notificacoes from '../models/notifications.js';
import * as modelos from '../services/modelService.js';
import * as assinaturas from '../models/subscriptions.js';
import * as planos from '../models/plans.js';
import * as pagamentos from '../models/payments.js';
import * as creditos from '../models/creditGrants.js';
import { prazoDeEstorno } from '../services/reembolso.js';
import { hashSenha, politicaDeSenha } from '../services/passwordService.js';
import { emitirSessao } from '../services/tokenService.js';
import type { Sujeito } from '../services/tokenService.js';
import { acessoNegado, naoEncontrado, requisicaoInvalida } from '../utils/errors.js';

function contexto(c: ContextoApp) {
  return contextoDe({
    ip: c.get('ip'),
    userAgent: c.get('userAgent'),
    requestId: c.get('requestId'),
    ator: c.get('ator'),
  });
}

/** POST /api/auth/login — login de conta comum (não é o /admin/login). */
export async function entrar(c: ContextoApp) {
  const cfg = c.get('config');
  const dados = await corpoJson(c, loginContaSchema);
  const { sessao, sujeito } = await loginConta(c.env.DB, cfg, contexto(c), {
    email: dados.email,
    senha: dados.senha,
  });
  return c.json({
    ok: true,
    access_token: sessao.accessToken,
    refresh_token: sessao.refreshToken,
    token_type: 'Bearer',
    expires_in: cfg.accessTtlS,
    // O nome vai junto desde o login: é ele que faz o app saber com quem está falando, e
    // sem ele a tela só teria o e-mail até alguém pedir `/api/account/me`.
    conta: { id: sujeito.id, email: sujeito.email, nome: sujeito.nome ?? null },
  });
}

/**
 * POST /api/auth/register — cadastro da conta comum, feito pelo próprio app.
 *
 * Cria a conta pela mesma régua do painel (política de senha, hash com o algoritmo
 * configurado, registro de auditoria) e já devolve uma sessão: quem acabou de se
 * cadastrar entra direto, sem passar pelo login de novo.
 */
export async function registrar(c: ContextoApp) {
  const cfg = c.get('config');
  if (!cfg.cadastroAberto) throw acessoNegado('cadastro_fechado', 'cadastro desativado no painel');

  const dados = await corpoJson(c, registroContaSchema);
  const motivo = politicaDeSenha(dados.senha, { email: dados.email });
  if (motivo) throw requisicaoInvalida(motivo);

  const senhaHash = await hashSenha(dados.senha, {
    algo: cfg.hashAlgo,
    bcryptCost: cfg.bcryptCost,
    pbkdf2Iterations: cfg.pbkdf2Iterations,
  });

  // `criarConta` recusa e-mail repetido e audita a criação (`account.create`).
  const conta = await contas.criarConta(c.env.DB, contexto(c), cfg, {
    email: dados.email,
    senhaHash,
    nome: dados.nome ?? null,
  });

  const agora = new Date().toISOString();
  await usuarios.registrarLoginOk(c.env.DB, conta.id, c.get('ip') ?? 'desconhecido', agora);
  await auditar(c.env.DB, contexto(c), {
    action: 'user.register',
    targetType: 'user',
    targetId: conta.id,
    after: { email: conta.email, nome: conta.display_name, origem: 'app' },
  });

  const sujeito: Sujeito = { tipo: 'user', id: conta.id, email: conta.email, papel: 'user' };
  const sessao = await emitirSessao(c.env.DB, cfg, {
    sujeito,
    aud: 'app',
    ip: c.get('ip'),
    userAgent: c.get('userAgent'),
  });

  return c.json(
    {
      ok: true,
      access_token: sessao.accessToken,
      refresh_token: sessao.refreshToken,
      token_type: 'Bearer',
      expires_in: cfg.accessTtlS,
      conta: { id: conta.id, email: conta.email, nome: conta.display_name },
    },
    201,
  );
}

/** POST /api/auth/refresh */
export async function renovarToken(c: ContextoApp) {
  const cfg = c.get('config');
  const dados = await corpoJson(c, refreshSchema);
  if (!dados.refresh_token) throw acessoNegado('missing_refresh', 'refresh token ausente');
  const { sessao, sujeito } = await renovar(c.env.DB, cfg, contexto(c), dados.refresh_token, 'app');
  return c.json({
    ok: true,
    access_token: sessao.accessToken,
    refresh_token: sessao.refreshToken,
    token_type: 'Bearer',
    expires_in: cfg.accessTtlS,
    // O nome entra também na renovação: é a resposta que a tela usa na maioria das vezes,
    // e sem ele o nome sumiria depois do primeiro refresh.
    conta: { id: sujeito.id, email: sujeito.email, nome: sujeito.nome ?? null },
  });
}

/** POST /api/auth/logout */
export async function sair(c: ContextoApp) {
  const dados = await corpoJson(c, refreshSchema);
  await encerrar(c.env.DB, contexto(c), dados.refresh_token ?? null);
  return c.json({ ok: true });
}

/** GET /api/account/me */
export async function perfil(c: ContextoApp) {
  const ator = c.get('ator');
  if (!ator.id) throw acessoNegado('invalid_subject');
  const conta = await usuarios.buscarPorId(c.env.DB, ator.id);
  if (!conta) throw naoEncontrado('conta nao encontrada');

  const [efetivos, avisos, naoLidas, painel, assinatura, pago, creditosAvulsos] = await Promise.all([
    modelos.efetivosParaUsuario(c.env.DB, conta.id),
    notificacoes.listarPorUsuario(c.env.DB, conta.id, 20),
    notificacoes.contarNaoLidas(c.env.DB, conta.id),
    modelos.catalogoDoPainel(c.env.DB, conta.id),
    assinaturas.buscarViva(c.env.DB, conta.id),
    pagamentos.ultimoAprovado(c.env.DB, conta.id),
    creditos.saldoDe(c.env.DB, conta.id, new Date().toISOString()),
  ]);

  // O **nome** do plano vai junto com o id de propósito: a tela não deve adivinhar o nome a
  // partir de uma lista própria. Se o painel publicar um plano que o app não conhece, o app
  // mostraria o id cru — e um plano renomeado apareceria com o nome velho.
  const planoDaConta = assinatura ? await planos.buscarPorId(c.env.DB, assinatura.plan_id) : null;

  return c.json({
    ok: true,
    conta: {
      id: conta.id,
      email: conta.email,
      nome: conta.display_name,
      status: conta.status,
      suspenso_ate: conta.suspended_until,
      criada_em: conta.created_at,
      ultimo_login: conta.last_login_at,
    },
    modelos: efetivos.map((item) => ({
      slug: item.slug,
      name: item.name,
      provider: item.provider,
      tem_excecao: item.tem_excecao === 1,
      habilitado: item.habilitado_usuario === 1,
    })),
    // O catálogo como o painel o vê, e o que ele tirou desta conta. Vai junto com o perfil
    // de propósito: o app já bate aqui para saber se a sessão está viva, e é nesta mesma
    // resposta que ele descobre que um modelo deixou de valer — sem uma segunda ida à rede.
    catalogo: painel.catalogo,
    modelos_bloqueados: painel.bloqueados,
    // O plano entra **aqui**, e não numa rota nova: esta já é a chamada que o
    // app faz para saber se a sessão está viva, e é nesta mesma resposta que
    // ele descobre em que plano está — sem uma segunda ida à rede. Mesma razão
    // de o catálogo vir junto. `null` é o Free: quem não assinou nada.
    plano: assinatura
      ? {
          id: assinatura.plan_id,
          nome: planoDaConta?.nome ?? assinatura.plan_id,
          // Os números vão junto: a tela da conta mostra **os benefícios do plano**, e sem eles
          // ela teria de buscar o plano numa segunda chamada — ou, pior, numa lista própria,
          // que é justamente a lista que diverge.
          preco_centavos: planoDaConta?.preco_centavos ?? null,
          horas_por_dia: planoDaConta?.horas_por_dia ?? null,
          moedas_por_mes: planoDaConta?.moedas_por_mes ?? null,
          moedas_por_dia: planoDaConta?.moedas_por_dia ?? null,
          status: assinatura.status,
          renova_em: assinatura.renova_em,
          // Até quando o dinheiro pode voltar. A tela mostra o prazo e desabilita o botão de
          // reembolso depois dele — mas quem **decide** é o servidor, no cancelamento. Isto
          // aqui existe para a pessoa **saber**, não para autorizar.
          estorno_ate: prazoDeEstorno(pago),
        }
      : null,
    /**
     * Os créditos comprados avulsos, já sem os vencidos.
     *
     * Vai junto do plano porque a tela precisa dos dois para dizer quanto a pessoa tem: o plano
     * dá as horas e os créditos do mês, e isto é o que ela comprou por fora. Número só, e não a
     * lista de compras — a tela mostra saldo, não extrato.
     */
    creditos_avulsos: creditosAvulsos,
    avisos,
    avisos_nao_lidos: naoLidas,
  });
}

/** POST /api/account/notifications/:id/read */
export async function marcarAvisoLido(c: ContextoApp) {
  const ator = c.get('ator');
  const { id } = parametros(c, identificadorParamSchema);
  if (!ator.id) throw acessoNegado('invalid_subject');
  await notificacoes.marcarLido(c.env.DB, id, ator.id, new Date().toISOString());
  return c.json({ ok: true });
}
