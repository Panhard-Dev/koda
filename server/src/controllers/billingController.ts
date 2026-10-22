import type { ContextoApp } from '../types.js';
import { corpoJson } from '../middlewares/validacao.js';
import { cobrancaCartaoSchema, cobrancaPixSchema, compraDeCreditosSchema } from '../validation/schemas.js';
import * as planos from '../models/plans.js';
import * as assinaturas from '../models/subscriptions.js';
import * as pagamentos from '../models/payments.js';
import * as creditos from '../models/creditGrants.js';
import * as usuarios from '../models/users.js';
import * as mercadoPago from '../services/mercadoPagoService.js';
import { auditar, contextoDe } from '../services/auditService.js';
import { maisDias, maisUmMes } from '../utils/datas.js';
import { DIAS_DE_VALIDADE, creditosDoValor } from '../services/creditosAvulsos.js';
import { dentroDoPrazoDeEstorno, prazoDeEstorno } from '../services/reembolso.js';
import { uuid } from '../utils/crypto.js';
import { soDigitos, tipoDocumento } from '../utils/documento.js';
import { AppError, acessoNegado, erroApi, naoEncontrado, requisicaoInvalida } from '../utils/errors.js';
import type { PaymentRow } from '../models/payments.js';
import type { PlanRow } from '../models/plans.js';
import type { SubscriptionRow } from '../models/subscriptions.js';
import type { UserRow } from '../models/users.js';

/**
 * Cobrança e assinatura.
 *
 * ## O caminho de uma assinatura
 *
 *   1. O app manda o **id do plano** e quem paga. Nunca o preço.
 *   2. Nasce uma linha em `payments` (pendente) e a assinatura fica `pendente`.
 *   3. Falamos com o Mercado Pago e guardamos o id que ele deu.
 *   4. Pago? A assinatura vira `ativa` — **na hora**, se a resposta já vier
 *      aprovada, e pelo webhook quando o PIX é pago depois.
 *
 * O passo 4 aparece em dois lugares de propósito. O webhook é a fonte confiável
 * (é ele que chega quando a pessoa paga o PIX meia hora depois), mas esperar
 * por ele para o cartão aprovado faria a tela dizer «pendente» por alguns
 * segundos depois de a cobrança já ter passado. Os dois chamam a **mesma**
 * função, e ela é idempotente.
 */
function contexto(c: ContextoApp) {
  return contextoDe({
    ip: c.get('ip'),
    userAgent: c.get('userAgent'),
    requestId: c.get('requestId'),
    ator: c.get('ator'),
  });
}

/** O plano como o app precisa dele. O preço vai em centavos — quem formata é a tela. */
function planoPublico(plano: PlanRow) {
  return {
    id: plano.id,
    nome: plano.nome,
    preco_centavos: plano.preco_centavos,
    horas_por_dia: plano.horas_por_dia,
    moedas_por_mes: plano.moedas_por_mes,
    moedas_por_dia: plano.moedas_por_dia,
  };
}

function assinaturaPublica(assinatura: SubscriptionRow | null) {
  if (!assinatura) return null;
  return {
    plano_id: assinatura.plan_id,
    status: assinatura.status,
    iniciada_em: assinatura.iniciada_em,
    renova_em: assinatura.renova_em,
  };
}

function cobrancaPublica(cobranca: PaymentRow) {
  return {
    id: cobranca.id,
    metodo: cobranca.metodo,
    status: cobranca.status,
    status_detalhe: cobranca.status_detalhe,
    valor_centavos: cobranca.valor_centavos,
    qr_code: cobranca.qr_code,
    qr_code_base64: cobranca.qr_code_base64,
    expira_em: cobranca.expira_em,
    criada_em: cobranca.created_at,
  };
}

/**
 * GET /api/public/plans — o catálogo, com o preço que **será cobrado**.
 *
 * Público porque a tela de planos abre antes de qualquer login, e porque preço
 * não é segredo. É esta rota que faz a tela de venda parar de ter os números
 * escritos nela: preço em dois lugares é preço que um dia diverge, e o lado que
 * diverge calado é sempre o que não cobra.
 */
export async function planosPublicos(c: ContextoApp) {
  const lista = await planos.listarAtivos(c.env.DB);
  return c.json({ ok: true, planos: lista.map(planoPublico) });
}

/** GET /api/assinatura — em que plano a conta está, e o que ficou em aberto. */
export async function minhaAssinatura(c: ContextoApp) {
  const ator = c.get('ator');
  if (!ator.id) throw acessoNegado('invalid_subject');

  const [assinatura, abertas] = await Promise.all([
    assinaturas.buscarViva(c.env.DB, ator.id),
    pagamentos.pendentesDoUsuario(c.env.DB, ator.id),
  ]);

  return c.json({
    ok: true,
    assinatura: assinaturaPublica(assinatura),
    cobrancas_abertas: abertas.map(cobrancaPublica),
    // A Public Key é **pública** de propósito: o app precisa dela para trocar o
    // número do cartão por um token sem passar por nós. O Access Token, esse,
    // não sai daqui de jeito nenhum.
    public_key: mercadoPago.publicKey(c.env),
  });
}

/**
 * O preparo comum às duas formas de pagamento.
 *
 * A ordem importa: a chave de idempotência é conferida **antes** de qualquer
 * coisa, porque é ela que transforma um retry do app na mesma cobrança em vez
 * de uma segunda.
 */
async function prepararCobranca(
  c: ContextoApp,
  dados: { planoId: string; chave: string; metodo: 'cartao' | 'pix' },
): Promise<{ cobranca: PaymentRow; plano: PlanRow; conta: UserRow }> {
  const ator = c.get('ator');
  if (!ator.id) throw acessoNegado('invalid_subject');

  const conta = await usuarios.buscarPorId(c.env.DB, ator.id);
  if (!conta) throw naoEncontrado('conta nao encontrada');

  const jaExiste = await pagamentos.buscarPorChave(c.env.DB, dados.chave);
  if (jaExiste) {
    // A mesma chave, mas de uma compra de crédito: é **outra coisa** com a mesma chave, e seguir
    // daqui trataria a compra como assinatura. Não acontece no uso normal — a chave é de uma
    // tentativa, e a tentativa tem um tipo —, e recusar é melhor que devolver a cobrança errada.
    if (!jaExiste.plan_id) throw erroApi('chave_em_uso', 409, 'Chave de cobranca ja usada');
    const plano = await planos.buscarPorId(c.env.DB, jaExiste.plan_id);
    if (!plano) throw naoEncontrado('plano nao encontrado');
    return { cobranca: jaExiste, plano, conta };
  }

  const plano = await planos.buscarPorId(c.env.DB, dados.planoId);
  // Plano inativo não se vende — mas continua renovável para quem já tem (ver
  // `models/plans.buscarPorId`). Aqui é venda, então `ativo` conta.
  if (!plano || plano.ativo !== 1) throw naoEncontrado('plano nao encontrado');

  const agora = new Date().toISOString();

  const cobranca = await pagamentos.criar(c.env.DB, {
    id: uuid(),
    userId: ator.id,
    planId: plano.id,
    metodo: dados.metodo,
    // O valor sai **daqui**, do plano que está no banco. É a linha que impede
    // o app de escolher quanto pagar.
    valorCentavos: plano.preco_centavos,
    chaveIdempotencia: dados.chave,
    status: 'pending',
    agora,
  });

  return { cobranca, plano, conta };
}

/**
 * Para onde o Mercado Pago deve avisar — ou `undefined` para ele usar a do painel.
 *
 * Derivada da própria requisição, para o endereço acompanhar o Worker (produção, preview,
 * `wrangler dev`) sem uma variável para esquecer de trocar. **Mas o Mercado Pago exige HTTPS
 * neste campo**, e em dev o Worker roda em `http://127.0.0.1` — mandar isso é um 400 na certa
 * («notificaction_url attribute must be url valid»).
 *
 * Quando a origem não é HTTPS, o campo é **omitido**: aí o Mercado Pago usa a URL configurada
 * no painel, que é a de produção. É melhor do que apontar para um endereço que ele recusa.
 */
function urlDeNotificacao(c: ContextoApp): string | undefined {
  const origem = new URL(c.req.url).origin;
  return origem.startsWith('https://') ? `${origem}/api/public/mp/webhook` : undefined;
}

/**
 * Grava o que o Mercado Pago respondeu e, se foi aprovado, ativa a assinatura.
 *
 * **Idempotente de propósito**: é chamada pela criação da cobrança e pelo
 * webhook, e os dois podem acontecer para o mesmo pagamento. Ativar duas vezes
 * não pode empurrar a data de renovação duas vezes.
 */
async function aplicarResultado(
  c: ContextoApp,
  cobranca: PaymentRow,
  resposta: mercadoPago.PagamentoDoMercadoPago,
): Promise<PaymentRow> {
  const agora = new Date().toISOString();
  const aprovado = resposta.status === 'approved';
  const ehCompraDeCredito = cobranca.creditos !== null;

  // A assinatura nasce **aqui**, e não antes de falar com o Mercado Pago.
  //
  // Nascer antes deixava uma assinatura `pendente` para trás toda vez que a cobrança falhava ou
  // a pessoa abandonava o checkout — e a tela tratava `pendente` como assinatura, então a conta
  // passava a dizer «Sua assinatura» sem ninguém ter assinado nada. Tentativa que não virou
  // cobrança não é assinatura, e não deve existir como linha.
  //
  // Compra de crédito **não** passa por aqui: ela não é tentativa de assinar, e criar uma
  // assinatura `pendente` por causa de um pacote de crédito seria inventar uma intenção que a
  // pessoa não teve.
  if (!ehCompraDeCredito && cobranca.plan_id) {
    await assinaturas.garantirPendente(c.env.DB, {
      id: uuid(),
      userId: cobranca.user_id,
      planId: cobranca.plan_id,
      agora,
    });
  }

  const atualizada = await pagamentos.definirMpId(c.env.DB, cobranca.id, String(resposta.id), agora);
  const comStatus =
    (await pagamentos.registrarStatus(c.env.DB, cobranca.id, {
      status: resposta.status,
      statusDetalhe: resposta.status_detail ?? null,
      agora,
      pago: aprovado,
    })) ?? atualizada ?? cobranca;

  if (!aprovado) return comStatus;

  if (ehCompraDeCredito) {
    // `conceder` é idempotente pelo UNIQUE de `payment_id`: se o webhook repetir, a segunda
    // tentativa não insere nada e `concedido` volta `false`. Crédito de graça é o pior defeito
    // possível desta rota, e é o banco que o impede — não a boa vontade do código.
    const concedido = await creditos.conceder(c.env.DB, {
      id: uuid(),
      userId: cobranca.user_id,
      creditos: cobranca.creditos as number,
      paymentId: cobranca.id,
      expiraEm: maisDias(agora, DIAS_DE_VALIDADE),
      agora,
    });
    await auditar(c.env.DB, contexto(c), {
      action: 'credits.grant',
      targetType: 'user',
      targetId: cobranca.user_id,
      after: {
        creditos: cobranca.creditos,
        valor_centavos: cobranca.valor_centavos,
        mp_payment_id: String(resposta.id),
        concedido,
      },
    });
    return comStatus;
  }

  if (cobranca.plan_id) {
    await assinaturas.ativar(c.env.DB, {
      userId: cobranca.user_id,
      planId: cobranca.plan_id,
      agora,
      renovaEm: maisUmMes(agora),
    });
    await auditar(c.env.DB, contexto(c), {
      action: 'subscription.activate',
      targetType: 'user',
      targetId: cobranca.user_id,
      after: { plano_id: cobranca.plan_id, metodo: cobranca.metodo, mp_payment_id: String(resposta.id) },
    });
  }

  return comStatus;
}

/** POST /api/assinatura/pix — cria a cobrança PIX e devolve o QR. */
export async function assinarComPix(c: ContextoApp) {
  const dados = await corpoJson(c, cobrancaPixSchema);
  const { cobranca, plano, conta } = await prepararCobranca(c, {
    planoId: dados.plano_id,
    chave: dados.chave_idempotencia,
    metodo: 'pix',
  });

  // Cobrança que já tem QR não é recriada: o retry devolve o mesmo código, e o
  // Mercado Pago não precisa saber que o app tentou de novo.
  if (cobranca.qr_code) {
    return c.json({ ok: true, plano: planoPublico(plano), pagamento: cobrancaPublica(cobranca) });
  }

  const tipo = tipoDocumento(dados.documento);
  if (!tipo) throw requisicaoInvalida('CPF ou CNPJ invalido');

  const resposta = await mercadoPago.criarPix(c.env, {
    valorCentavos: cobranca.valor_centavos,
    descricao: `${plano.nome} — assinatura mensal`,
    // O e-mail do pagador é o da conta, e não um campo da tela: o Mercado Pago
    // exige um, este é o que temos, e pedir de novo seria pedir um dado que já
    // está aqui.
    pagador: { email: conta.email, nome: dados.nome, documento: soDigitos(dados.documento) },
    tipoDocumento: tipo,
    referencia: cobranca.id,
    chaveIdempotencia: cobranca.chave_idempotencia,
    urlDeNotificacao: urlDeNotificacao(c),
  });

  const dados_do_pix = resposta.point_of_interaction?.transaction_data ?? null;
  const agora = new Date().toISOString();
  await pagamentos.guardarQr(c.env.DB, cobranca.id, {
    qrCode: dados_do_pix?.qr_code ?? null,
    qrCodeBase64: dados_do_pix?.qr_code_base64 ?? null,
    expiraEm: dados_do_pix?.expiration_date ?? null,
    agora,
  });

  const atualizada = await aplicarResultado(c, cobranca, resposta);
  const comQr = await pagamentos.buscarPorId(c.env.DB, atualizada.id);

  return c.json({ ok: true, plano: planoPublico(plano), pagamento: cobrancaPublica(comQr ?? atualizada) }, 201);
}

/**
 * GET /api/creditos — o saldo de crédito avulso da conta.
 *
 * É também a **sonda da compra**: depois de pagar o PIX, a tela pergunta aqui até o saldo
 * subir. Quem credita de verdade é o webhook, e o webhook pode chegar antes ou depois — a tela
 * não precisa saber qual dos dois, só olhar o saldo.
 */
export async function meusCreditos(c: ContextoApp) {
  const ator = c.get('ator');
  if (!ator.id) throw acessoNegado('invalid_subject');

  const agora = new Date().toISOString();
  const [saldo, vencendo] = await Promise.all([
    creditos.saldoDe(c.env.DB, ator.id, agora),
    creditos.vencendoEm(c.env.DB, ator.id, agora),
  ]);

  return c.json({ ok: true, creditos: saldo, vencendo_em: vencendo?.expira_em ?? null });
}

/**
 * POST /api/creditos/pix — compra crédito avulso e devolve o QR.
 *
 * ## O que muda em relação à assinatura
 *
 * Três coisas, e as três importam:
 *
 * 1. **Não nasce assinatura.** Uma compra de crédito não é uma tentativa de assinar, e criar
 *    uma assinatura `pendente` por causa de um pacote seria inventar uma intenção que a pessoa
 *    não teve — foi exatamente esse defeito que fez a tela dizer «Sua assinatura» para quem não
 *    tinha assinado nada.
 * 2. **O valor vem do app, a quantidade não.** A pessoa escolhe quanto gastar; quantos créditos
 *    isso compra é conta do servidor (`creditosDoValor`). O contrário deixaria o cliente decidir
 *    quanto levar por um preço.
 * 3. **A mesma chave devolve a mesma cobrança.** Se a resposta se perder e o app tentar de novo,
 *    ele recebe a cobrança que já existe em vez de uma segunda — e o `payment_id` UNIQUE em
 *    `credit_grants` impede que as duas venham a creditar.
 */
export async function comprarCreditos(c: ContextoApp) {
  const ator = c.get('ator');
  if (!ator.id) throw acessoNegado('invalid_subject');

  const dados = await corpoJson(c, compraDeCreditosSchema);
  const conta = await usuarios.buscarPorId(c.env.DB, ator.id);
  if (!conta) throw naoEncontrado('conta nao encontrada');

  const quantos = creditosDoValor(dados.valor_centavos);
  if (quantos === null) throw requisicaoInvalida('valor fora da faixa de compra');

  const tipo = tipoDocumento(dados.documento);
  if (!tipo) throw requisicaoInvalida('CPF ou CNPJ invalido');

  const agora = new Date().toISOString();
  const jaExiste = await pagamentos.buscarPorChave(c.env.DB, dados.chave_idempotencia);
  const cobranca =
    jaExiste ??
    (await pagamentos.criar(c.env.DB, {
      id: uuid(),
      userId: ator.id,
      // O produto existe em `plans` para a chave estrangeira continuar válida — ver a migração.
      planId: 'creditos',
      creditos: quantos,
      metodo: 'pix',
      valorCentavos: dados.valor_centavos,
      chaveIdempotencia: dados.chave_idempotencia,
      status: 'pending',
      agora,
    }));

  // Cobrança já resolvida não é cobrada de novo — o mesmo cuidado do cartão.
  if (cobranca.mp_payment_id) {
    return c.json({ ok: true, creditos: cobranca.creditos, pagamento: cobrancaPublica(cobranca) });
  }

  const resposta = await mercadoPago.criarPix(c.env, {
    valorCentavos: cobranca.valor_centavos,
    descricao: `${cobranca.creditos} creditos Koda`,
    pagador: { email: conta.email, nome: dados.nome, documento: soDigitos(dados.documento) },
    tipoDocumento: tipo,
    referencia: cobranca.id,
    chaveIdempotencia: cobranca.chave_idempotencia,
    urlDeNotificacao: urlDeNotificacao(c),
  });

  const doPix = resposta.point_of_interaction?.transaction_data ?? null;
  await pagamentos.guardarQr(c.env.DB, cobranca.id, {
    qrCode: doPix?.qr_code ?? null,
    qrCodeBase64: doPix?.qr_code_base64 ?? null,
    expiraEm: doPix?.expiration_date ?? null,
    agora,
  });

  const atualizada = await aplicarResultado(c, cobranca, resposta);
  const comQr = await pagamentos.buscarPorId(c.env.DB, atualizada.id);

  return c.json(
    { ok: true, creditos: cobranca.creditos, pagamento: cobrancaPublica(comQr ?? atualizada) },
    201,
  );
}

/** POST /api/assinatura/cartao — cobra no cartão a partir do card token. */
export async function assinarComCartao(c: ContextoApp) {
  const dados = await corpoJson(c, cobrancaCartaoSchema);
  const { cobranca, plano, conta } = await prepararCobranca(c, {
    planoId: dados.plano_id,
    chave: dados.chave_idempotencia,
    metodo: 'cartao',
  });

  // Cartão já resolvido não é cobrado de novo. Sem esta linha, um retry do app
  // depois de um timeout cobraria duas vezes — o pior erro possível aqui.
  if (cobranca.mp_payment_id) {
    return c.json({ ok: true, plano: planoPublico(plano), pagamento: cobrancaPublica(cobranca) });
  }

  const tipo = tipoDocumento(dados.documento);
  if (!tipo) throw requisicaoInvalida('CPF ou CNPJ invalido');

  const resposta = await mercadoPago.criarCartao(c.env, {
    valorCentavos: cobranca.valor_centavos,
    descricao: `${plano.nome} — assinatura mensal`,
    // O nome no cartão pode diferir do nome da conta (cartão de outra pessoa,
    // cartão corporativo). Quando o app manda, é ele que vale.
    pagador: { email: conta.email, nome: dados.nome ?? conta.display_name ?? conta.email, documento: soDigitos(dados.documento) },
    tipoDocumento: tipo,
    referencia: cobranca.id,
    chaveIdempotencia: cobranca.chave_idempotencia,
    urlDeNotificacao: urlDeNotificacao(c),
    tokenDoCartao: dados.card_token_id,
    paymentMethodId: dados.payment_method_id ?? null,
  });

  const atualizada = await aplicarResultado(c, cobranca, resposta);
  const assinatura = await assinaturas.buscarViva(c.env.DB, cobranca.user_id);

  return c.json(
    {
      ok: true,
      plano: planoPublico(plano),
      pagamento: cobrancaPublica(atualizada),
      assinatura: assinaturaPublica(assinatura),
    },
    201,
  );
}

/**
 * POST /api/assinatura/cancelar — encerra a assinatura e, se ainda der, devolve o dinheiro.
 *
 * ## O estorno vem antes, e isso é o desenho
 *
 * Se o Mercado Pago recusar o estorno, **nada mudou** e a pessoa pode tentar de novo. Cancelar
 * primeiro e falhar no estorno deixaria o pior estado possível: a assinatura encerrada e o
 * dinheiro na nossa conta, sem ninguém conseguir desfazer sozinho.
 *
 * ## O prazo é conferido aqui, não na tela
 *
 * A tela mostra o prazo e desabilita o botão, mas quem **decide** é este arquivo: uma regra de
 * dinheiro que só existe no cliente é uma regra que qualquer um contorna falando direto com a
 * API. Passados os sete dias, o cancelamento acontece do mesmo jeito — o que acaba é o
 * reembolso, não o direito de sair.
 */
export async function cancelarAssinatura(c: ContextoApp) {
  const ator = c.get('ator');
  if (!ator.id) throw acessoNegado('invalid_subject');

  const agora = new Date().toISOString();

  const pago = await pagamentos.ultimoAprovado(c.env.DB, ator.id);
  const dentroDoPrazo = dentroDoPrazoDeEstorno(pago, agora);

  let estorno: { id: number; status: string } | null = null;
  let estornoMotivo: 'sem_pagamento' | 'prazo_expirado' | null = null;

  if (pago?.mp_payment_id && dentroDoPrazo) {
    const resposta = await mercadoPago.estornarPagamento(c.env, pago.mp_payment_id);
    estorno = { id: resposta.id, status: resposta.status };
    await pagamentos.registrarStatus(c.env.DB, pago.id, {
      status: 'refunded',
      statusDetalhe: 'estornado no cancelamento',
      agora,
      pago: false,
    });
  } else {
    estornoMotivo = pago?.mp_payment_id ? 'prazo_expirado' : 'sem_pagamento';
  }

  const encerrada = await assinaturas.cancelar(c.env.DB, ator.id, agora);
  if (!encerrada) throw naoEncontrado('nao ha assinatura para cancelar');

  await auditar(c.env.DB, contexto(c), {
    action: 'subscription.cancel',
    targetType: 'user',
    targetId: ator.id,
    before: { plano_id: encerrada.plan_id, status: encerrada.status },
    // O id do estorno fica na auditoria: é o que liga «esta pessoa cancelou» a «o dinheiro
    // voltou», e sem ele não haveria como provar depois que o reembolso saiu. O motivo, quando
    // não saiu, é a resposta para «por que não devolveram?».
    after: { estorno: estorno?.id ?? null, motivo: estornoMotivo },
  });

  return c.json({
    ok: true,
    assinatura: assinaturaPublica({ ...encerrada, status: 'cancelada' }),
    estorno,
    estorno_motivo: estornoMotivo,
  });
}

/**
 * POST /api/public/mp/webhook — a notificação do Mercado Pago.
 *
 * ## O corpo não é prova de nada
 *
 * A notificação diz *que* algo aconteceu; **o que** aconteceu a gente pergunta.
 * Por isso o status que vale é o do `GET /v1/payments`, e não o do corpo: quem
 * souber a URL pode postar aqui, e sem a conferência de assinatura poderia
 * ativar assinatura de graça dizendo «aprovado».
 *
 * ## Sempre 200 quando o evento não é nosso
 *
 * O Mercado Pago reentrega até receber 200. Devolver erro para um evento que
 * não nos interessa (outro tipo de notificação, um pagamento que não é deste
 * Worker) faria ele reentregar para sempre — um erro nosso que vira fila infinita.
 */
export async function webhookDoMercadoPago(c: ContextoApp) {
  const url = new URL(c.req.url);
  const tipo = url.searchParams.get('type') ?? url.searchParams.get('topic') ?? '';
  const dataId = url.searchParams.get('data.id') ?? url.searchParams.get('id') ?? '';

  const confere = await mercadoPago.assinaturaDoWebhookConfere(c.env, {
    xSignature: c.req.header('x-signature') ?? null,
    xRequestId: c.req.header('x-request-id') ?? null,
    dataId,
  });
  if (!confere) throw acessoNegado('invalid_signature', 'assinatura do webhook nao confere');

  if (tipo !== 'payment' || !mercadoPago.idDePagamentoValido(dataId)) {
    return c.json({ ok: true, ignorado: true });
  }

  const resposta = await consultarSemMorrer(c, dataId);
  if (!resposta) return c.json({ ok: true, ignorado: true });

  const referencia = resposta.external_reference ?? '';
  const cobranca = referencia === '' ? null : await pagamentos.buscarPorId(c.env.DB, referencia);

  // Sem linha nossa não há o que atualizar, e reentrega nenhuma vai criar a
  // linha. 200 para o Mercado Pago parar de tentar.
  if (!cobranca) return c.json({ ok: true, ignorado: true });

  await aplicarResultado(c, cobranca, resposta);
  return c.json({ ok: true });
}

/**
 * Consulta o pagamento, e devolve `null` quando ele **não existe neste ambiente**.
 *
 * O caso é real e não é hipotético: o painel do Mercado Pago deixa apontar a
 * mesma URL nos modos de teste e de produção, e o ambiente de quem responde é
 * decidido pela **credencial** que o Worker carrega. Com a credencial de
 * produção aqui, uma notificação de teste cai num pagamento que não existe
 * deste lado — 404.
 *
 * E o 404 **não pode** virar erro: o Mercado Pago reentrega até receber 200, e
 * um 404 que responde 5xx é uma fila infinita de reentrega para um pagamento
 * que nunca vai aparecer. Devolver `null` faz o webhook responder 200 e
 * encerrar o assunto, que é o certo: não é nosso, não é para nós.
 *
 * Qualquer outro erro (rede, 5xx deles) continua subindo: esse **vale**
 * reentrega, e engolir ele perderia pagamento de verdade.
 */
async function consultarSemMorrer(c: ContextoApp, dataId: string) {
  try {
    return await mercadoPago.consultarPagamento(c.env, dataId);
  } catch (erro) {
    if (erro instanceof AppError && erro.code === 'pagamento_desconhecido') return null;
    throw erro;
  }
}
