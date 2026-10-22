import type { Config } from '../config/env.js';
import type { Contexto } from '../types.js';
import * as usuarios from '../models/users.js';
import type { FiltroContas, StatusConta, UserRow } from '../models/users.js';
import * as excecoes from '../models/userModels.js';
import * as notificacoes from '../models/notifications.js';
import * as tokens from '../models/refreshTokens.js';
import * as auditoria from '../models/auditLog.js';
import * as creditos from '../models/creditGrants.js';
import * as assinaturas from '../models/subscriptions.js';
import * as planos from '../models/plans.js';
import { conflito, naoEncontrado, requisicaoInvalida } from '../utils/errors.js';
import { uuid } from '../utils/crypto.js';
import { auditar } from './auditService.js';
import { revogarTudo } from './tokenService.js';
import { DIAS_DE_VALIDADE } from './creditosAvulsos.js';

export interface ListagemContas {
  linhas: UserRow[];
  total: number;
  pagina: number;
  porPagina: number;
  resumo: Record<string, number>;
}

export const COLUNAS_SENSIVEIS = ['password_hash'] as const;

/** Projeção segura: hash de senha nunca sai daqui. */
export function publico(conta: UserRow): Omit<UserRow, 'password_hash'> {
  const { password_hash: _ignorado, ...resto } = conta;
  return resto;
}

export async function listar(
  db: D1Database,
  filtro: FiltroContas & { pagina: number; porPagina: number },
): Promise<ListagemContas> {
  const { linhas, total } = await usuarios.listar(db, filtro);
  const resumo = await usuarios.contarPorStatus(db);
  return {
    linhas,
    total,
    pagina: filtro.pagina,
    porPagina: filtro.porPagina,
    resumo,
  };
}

export async function detalhar(db: D1Database, id: string) {
  const conta = await usuarios.buscarPorId(db, id);
  if (!conta) throw naoEncontrado('conta nao encontrada');
  const agora = new Date().toISOString();
  const [modelos, avisos, sessoes, historico, planosAtivos, assinatura, saldoAvulso] = await Promise.all([
    excecoes.listarPorUsuario(db, id),
    notificacoes.listarPorUsuario(db, id, 20),
    tokens.contarAtivos(db, 'user', id),
    auditoria.listar(db, { targetId: id, limite: 30, deslocamento: 0 }),
    planos.listarAtivos(db),
    assinaturas.buscarViva(db, id),
    creditos.saldoDe(db, id, agora),
  ]);
  // O nome do plano sai de uma segunda busca porque a assinatura pode apontar para um plano
  // que **saiu de linha** (a `listarAtivos` não o traz) — e o painel tem de dizer o nome dele
  // mesmo assim, senão a tela mostraria um id cru bem na hora de o admin tirar a pessoa dali.
  const planoDaConta = assinatura ? await planos.buscarPorId(db, assinatura.plan_id) : null;
  return {
    conta: publico(conta),
    excecoes: modelos,
    avisos,
    sessoesAtivas: sessoes,
    historico: historico.linhas,
    planosDisponiveis: planosAtivos,
    plano: assinatura
      ? {
          id: assinatura.plan_id,
          nome: planoDaConta?.nome ?? assinatura.plan_id,
          status: assinatura.status,
          renovaEm: assinatura.renova_em,
        }
      : null,
    creditosAvulsos: saldoAvulso,
  };
}

async function exigirConta(db: D1Database, id: string): Promise<UserRow> {
  const conta = await usuarios.buscarPorId(db, id);
  if (!conta) throw naoEncontrado('conta nao encontrada');
  return conta;
}

/** Revoga refresh + marca o piso de emissão: access token na rua morre na hora. */
async function invalidarAcesso(db: D1Database, id: string): Promise<number> {
  const { sessoesRevogadas } = await revogarTudo(db, { tipo: 'user', id }, new Date().toISOString());
  return sessoesRevogadas;
}

export async function banir(
  db: D1Database,
  contexto: Contexto,
  entrada: { id: string; motivo: string },
): Promise<UserRow> {
  const antes = await exigirConta(db, entrada.id);
  if (antes.status === 'banned') throw conflito('ja_banida', 'conta ja esta banida');
  const depois = await usuarios.definirStatus(db, entrada.id, {
    status: 'banned',
    motivo: entrada.motivo,
    autorId: contexto.ator.id ?? 'sistema',
    agora: new Date().toISOString(),
  });
  if (!depois) throw naoEncontrado('conta nao encontrada');
  const sessoes = await invalidarAcesso(db, entrada.id);
  await auditar(db, contexto, {
    action: 'account.ban',
    targetType: 'user',
    targetId: entrada.id,
    before: { status: antes.status, motivo: antes.status_reason },
    after: { status: depois.status, motivo: depois.status_reason },
    details: { sessoes_revogadas: sessoes, motivo: entrada.motivo },
  });
  return depois;
}

export async function suspender(
  db: D1Database,
  contexto: Contexto,
  entrada: { id: string; motivo: string; horas: number },
): Promise<UserRow> {
  if (!Number.isFinite(entrada.horas) || entrada.horas <= 0 || entrada.horas > 24 * 365) {
    throw requisicaoInvalida('prazo da suspensao deve ficar entre 1 hora e 1 ano');
  }
  const antes = await exigirConta(db, entrada.id);
  const ate = new Date(Date.now() + entrada.horas * 3_600_000).toISOString();
  const depois = await usuarios.definirStatus(db, entrada.id, {
    status: 'suspended',
    motivo: entrada.motivo,
    suspensoAte: ate,
    autorId: contexto.ator.id ?? 'sistema',
    agora: new Date().toISOString(),
  });
  if (!depois) throw naoEncontrado('conta nao encontrada');
  const sessoes = await invalidarAcesso(db, entrada.id);
  await auditar(db, contexto, {
    action: 'account.suspend',
    targetType: 'user',
    targetId: entrada.id,
    before: { status: antes.status, suspenso_ate: antes.suspended_until },
    after: { status: depois.status, suspenso_ate: depois.suspended_until },
    details: { sessoes_revogadas: sessoes, motivo: entrada.motivo, horas: entrada.horas },
  });
  return depois;
}

/** Reverte banimento ou suspensão (o "desfazer" do painel). */
export async function reativar(
  db: D1Database,
  contexto: Contexto,
  entrada: { id: string; motivo: string },
): Promise<UserRow> {
  const antes = await exigirConta(db, entrada.id);
  if (antes.status === 'active' && antes.deleted_at === null) {
    throw conflito('ja_ativa', 'conta ja esta ativa');
  }
  const depois = await usuarios.definirStatus(db, entrada.id, {
    status: 'active',
    motivo: entrada.motivo,
    suspensoAte: null,
    autorId: contexto.ator.id ?? 'sistema',
    agora: new Date().toISOString(),
  });
  if (!depois) throw naoEncontrado('conta nao encontrada');
  await auditar(db, contexto, {
    action: 'account.reactivate',
    targetType: 'user',
    targetId: entrada.id,
    before: { status: antes.status, suspenso_ate: antes.suspended_until, motivo: antes.status_reason },
    after: { status: depois.status },
    details: { motivo: entrada.motivo },
  });
  return depois;
}

export async function deletarLogico(
  db: D1Database,
  contexto: Contexto,
  entrada: { id: string; motivo: string },
): Promise<UserRow> {
  const antes = await exigirConta(db, entrada.id);
  if (antes.deleted_at !== null) throw conflito('ja_removida', 'conta ja foi removida (soft delete)');
  const depois = await usuarios.deletarLogico(db, entrada.id, new Date().toISOString(), contexto.ator.id ?? 'sistema');
  if (!depois) throw naoEncontrado('conta nao encontrada');
  const sessoes = await invalidarAcesso(db, entrada.id);
  await auditar(db, contexto, {
    action: 'account.soft_delete',
    targetType: 'user',
    targetId: entrada.id,
    before: { status: antes.status, deleted_at: antes.deleted_at },
    after: { status: depois.status, deleted_at: depois.deleted_at },
    details: { sessoes_revogadas: sessoes, motivo: entrada.motivo },
  });
  return depois;
}

export async function restaurar(
  db: D1Database,
  contexto: Contexto,
  entrada: { id: string; motivo: string },
): Promise<UserRow> {
  const antes = await exigirConta(db, entrada.id);
  if (antes.deleted_at === null) throw conflito('nao_removida', 'conta nao esta removida');
  const depois = await usuarios.restaurar(db, entrada.id, new Date().toISOString(), contexto.ator.id ?? 'sistema');
  if (!depois) throw naoEncontrado('conta nao encontrada');
  await auditar(db, contexto, {
    action: 'account.restore',
    targetType: 'user',
    targetId: entrada.id,
    before: { deleted_at: antes.deleted_at, status: antes.status },
    after: { deleted_at: depois.deleted_at, status: depois.status },
    details: { motivo: entrada.motivo },
  });
  return depois;
}

/**
 * Hard delete: só com confirmação explícita. A auditoria é gravada ANTES de a
 * linha desaparecer — depois não haveria como dizer quem apagou o quê.
 */
export async function deletarDefinitivo(
  db: D1Database,
  contexto: Contexto,
  entrada: { id: string; confirmacao: string },
): Promise<{ removida: boolean }> {
  const conta = await exigirConta(db, entrada.id);
  if (entrada.confirmacao !== conta.email.toLowerCase()) {
    throw requisicaoInvalida('confirmacao deve repetir o e-mail da conta');
  }
  await invalidarAcesso(db, entrada.id);
  await auditar(db, contexto, {
    action: 'account.hard_delete',
    targetType: 'user',
    targetId: entrada.id,
    before: { email: conta.email, status: conta.status, criada_em: conta.created_at },
    details: { irreversivel: true },
  });
  await usuarios.deletarDefinitivo(db, entrada.id);
  return { removida: true };
}

export async function avisar(
  db: D1Database,
  contexto: Contexto,
  entrada: { id: string; titulo: string; corpo: string; severidade: 'info' | 'warning' | 'critical' },
): Promise<string> {
  const conta = await exigirConta(db, entrada.id);
  const id = uuid();
  await notificacoes.criar(db, {
    id,
    userId: entrada.id,
    titulo: entrada.titulo,
    corpo: entrada.corpo,
    severidade: entrada.severidade,
    autorId: contexto.ator.id,
    agora: new Date().toISOString(),
  });
  await auditar(db, contexto, {
    action: 'account.notify',
    targetType: 'user',
    targetId: entrada.id,
    details: { notificacao_id: id, titulo: entrada.titulo, severidade: entrada.severidade, email: conta.email },
  });
  return id;
}

/** Exceção individual de modelo (tabela user_models). */
export async function definirModelo(
  db: D1Database,
  contexto: Contexto,
  entrada: { userId: string; modelId: string; habilitado: boolean | null },
): Promise<{ aplicado: 'habilitado' | 'desabilitado' | 'herdando' }> {
  const conta = await exigirConta(db, entrada.userId);
  const agora = new Date().toISOString();

  if (entrada.habilitado === null) {
    await excecoes.remover(db, entrada.userId, entrada.modelId);
    await auditar(db, contexto, {
      action: 'model.user_override_removed',
      targetType: 'user',
      targetId: entrada.userId,
      details: { model_id: entrada.modelId, email: conta.email },
    });
    return { aplicado: 'herdando' };
  }

  await excecoes.definir(db, {
    userId: entrada.userId,
    modelId: entrada.modelId,
    enabled: entrada.habilitado,
    autorId: contexto.ator.id,
    agora,
  });
  await auditar(db, contexto, {
    action: entrada.habilitado ? 'model.user_enabled' : 'model.user_disabled',
    targetType: 'user',
    targetId: entrada.userId,
    details: { model_id: entrada.modelId, email: conta.email },
  });
  return { aplicado: entrada.habilitado ? 'habilitado' : 'desabilitado' };
}

/**
 * Dá **moedas** (crédito avulso) para a conta, pelo painel.
 *
 * O crédito nasce como os comprados: linha própria, com validade. Não vira um número somado
 * em algum lugar porque é justamente a linha com data que faz a validade valer — e é a mesma
 * tabela que `/api/creditos` soma para a tela da conta. `payment_id` fica nulo: não houve
 * cobrança; quem responde pela concessão é a auditoria (quem deu, quanto, por quê).
 */
export async function darMoedas(
  db: D1Database,
  contexto: Contexto,
  entrada: { id: string; creditos: number; motivo: string },
): Promise<{ creditos: number; expiraEm: string }> {
  if (!Number.isInteger(entrada.creditos) || entrada.creditos <= 0 || entrada.creditos > 1_000_000) {
    throw requisicaoInvalida('creditos deve ser um inteiro entre 1 e 1000000');
  }
  const conta = await exigirConta(db, entrada.id);
  const agora = new Date().toISOString();
  const expiraEm = new Date(Date.now() + DIAS_DE_VALIDADE * 86_400_000).toISOString();

  await creditos.concederManual(db, {
    id: uuid(),
    userId: entrada.id,
    creditos: entrada.creditos,
    expiraEm,
    agora,
  });
  await auditar(db, contexto, {
    action: 'account.credits_grant',
    targetType: 'user',
    targetId: entrada.id,
    after: { creditos: entrada.creditos, expira_em: expiraEm },
    details: { email: conta.email, creditos: entrada.creditos, motivo: entrada.motivo, validade_dias: DIAS_DE_VALIDADE },
  });
  return { creditos: entrada.creditos, expiraEm };
}

/**
 * Define o plano da conta pelo painel — inclusive **voltar para o Free**.
 *
 * `planoId` nulo é o Free, e o Free **não é uma linha da tabela `plans`**: é a ausência de
 * assinatura. Por isso "voltar para o Free" é encerrar a viva, e não gravar um plano chamado
 * `free` — gravar um id que não existe na tabela estouraria a chave estrangeira.
 *
 * Com plano, a assinatura viva é **reaproveitada** e passa a valer (`definirPlano` no modelo:
 * uma viva `pendente` — sobra de checkout não pago — vira `ativa`, senão o app continuaria
 * mostrando «Plano Free»). Sem nenhuma viva, nasce uma **ativa**.
 *
 * O «já está neste plano» só vale para assinatura **ativa**: numa `pendente` com o mesmo
 * `plan_id`, reclamar deixaria a conta travada — o admin clicaria, receberia erro e o plano
 * nunca sairia do papel.
 */
export async function definirPlano(
  db: D1Database,
  contexto: Contexto,
  entrada: { id: string; planoId: string | null; motivo: string },
): Promise<{ plano: string | null }> {
  const conta = await exigirConta(db, entrada.id);
  const agora = new Date().toISOString();
  const viva = await assinaturas.buscarViva(db, entrada.id);
  const antes = viva?.plan_id ?? null;

  if (entrada.planoId === null) {
    if (!viva) throw conflito('ja_no_free', 'a conta ja esta no Free');
    await assinaturas.cancelar(db, entrada.id, agora);
    await auditar(db, contexto, {
      action: 'account.plan_change',
      targetType: 'user',
      targetId: entrada.id,
      before: { plano: antes, status: viva.status },
      after: { plano: null },
      details: { email: conta.email, motivo: entrada.motivo, voltou_para_free: true },
    });
    return { plano: null };
  }

  const plano = await planos.buscarPorId(db, entrada.planoId);
  if (!plano) throw naoEncontrado('plano nao encontrado');
  if (viva?.status === 'ativa' && antes === entrada.planoId) {
    throw conflito('ja_neste_plano', 'a conta ja esta neste plano');
  }

  const renovaEm = new Date(Date.now() + 30 * 86_400_000).toISOString();
  if (viva) {
    await assinaturas.definirPlano(db, { userId: entrada.id, planId: entrada.planoId, agora, renovaEm });
  } else {
    await assinaturas.criarAtiva(db, {
      id: uuid(),
      userId: entrada.id,
      planId: entrada.planoId,
      agora,
      renovaEm,
    });
  }
  await auditar(db, contexto, {
    action: 'account.plan_change',
    targetType: 'user',
    targetId: entrada.id,
    before: { plano: antes, status: viva?.status ?? null },
    after: { plano: entrada.planoId, status: 'ativa' },
    details: { email: conta.email, motivo: entrada.motivo, plano_nome: plano.nome },
  });
  return { plano: entrada.planoId };
}

export async function criarConta(
  db: D1Database,
  contexto: Contexto,
  cfg: Config,
  entrada: { email: string; senhaHash: string; nome?: string | null },
): Promise<UserRow> {
  const existente = await usuarios.buscarPorEmail(db, entrada.email);
  if (existente) throw conflito('email_em_uso', 'ja existe conta com este e-mail');
  const id = uuid();
  const agora = new Date().toISOString();
  await usuarios.criar(db, {
    id,
    email: entrada.email.toLowerCase(),
    passwordHash: entrada.senhaHash,
    displayName: entrada.nome ?? null,
    agora,
  });
  await auditar(db, contexto, {
    action: 'account.create',
    targetType: 'user',
    targetId: id,
    after: { email: entrada.email.toLowerCase(), nome: entrada.nome ?? null },
    details: { algoritmo_de_hash: cfg.hashAlgo },
  });
  const criada = await usuarios.buscarPorId(db, id);
  if (!criada) throw naoEncontrado('conta recem-criada nao encontrada');
  return criada;
}

export const statusValidos: StatusConta[] = ['active', 'suspended', 'banned'];
