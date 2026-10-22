import type { Env } from '../config/env.js';
import { erroApi } from '../utils/errors.js';
import { hmacSha256, timingSafeEqualStr, toHex, utf8 } from '../utils/crypto.js';

/**
 * O cliente do Mercado Pago.
 *
 * ## O Access Token não sai daqui
 *
 * Ele vem dos segredos do Worker (`wrangler secret` em produção, `.dev.vars`
 * local) e é usado só nesta camada. Ele **não** entra em log, **não** volta em
 * resposta e **não** é passado para o app: o app fala com o nosso Worker, e o
 * Worker fala com o Mercado Pago. Se este token vazar, qualquer pessoa cobra e
 * estorna na conta — é o segredo mais caro deste projeto.
 *
 * ## O que é conferido, e o que não é
 *
 * O corpo do pagamento é montado **aqui**, campo a campo. O app manda o id do
 * plano, o nome e o CPF; o **valor** vem do banco (ver `models/plans.ts`) e a
 * descrição é montada por nós. Nada que o cliente envie entra direto no corpo
 * — um campo repassado cru é um campo que o cliente escolhe.
 *
 * ## Toda cobrança leva `external_reference`
 *
 * É o **nosso** id da cobrança. O Mercado Pago devolve esse campo na consulta do
 * pagamento, e é por ele que o webhook reencontra a linha certa mesmo quando o
 * `mp_payment_id` ainda não chegou a ser gravado do nosso lado.
 */

const BASE = 'https://api.mercadopago.com';

/** O Mercado Pago é rápido, mas não é instantâneo: 15 s é folga sem segurar o Worker. */
const TEMPO_LIMITE_MS = 15_000;

export interface Pagador {
  /** O e-mail da conta. O Mercado Pago exige um, e este é o que temos — não pedimos de novo. */
  email: string;
  nome: string;
  /** Só dígitos. */
  documento: string;
}

export type TipoDocumento = 'CPF' | 'CNPJ';

/** O que interessa da resposta do `/v1/payments`. O resto é ignorado de propósito. */
export interface PagamentoDoMercadoPago {
  id: number;
  status: string;
  status_detail?: string | null;
  external_reference?: string | null;
  transaction_amount?: number | null;
  point_of_interaction?: {
    transaction_data?: {
      qr_code?: string | null;
      qr_code_base64?: string | null;
      expiration_date?: string | null;
    } | null;
  } | null;
}

interface ErroDoMercadoPago {
  message?: string;
  error?: string;
  cause?: { code?: string; description?: string }[] | null;
}

function token(env: Env): string {
  const valor = (env.MP_ACCESS_TOKEN ?? '').trim();
  if (valor === '') {
    // Fail-closed, como a chave do host: sem token não existe cobrança. Mesmo código do 401
    // do Mercado Pago — para quem usa a tela, os dois são a mesma coisa: o pagamento não está
    // ligado do nosso lado, e tentar de novo não muda nada.
    throw erroApi(
      'pagamento_sem_credencial',
      503,
      'O pagamento nao esta configurado',
      'MP_ACCESS_TOKEN ausente',
    );
  }
  return valor;
}

/**
 * Traduz o erro do Mercado Pago para um erro nosso.
 *
 * A distinção que importa é **de quem é a culpa**:
 *
 *   401/403  a credencial é nossa e está errada. O cliente não tem o que fazer
 *            — vira 503 sem detalhe, e o detalhe fica no log.
 *   400/422  o Mercado Pago recusou os dados. Pode ser token de cartão vencido
 *            ou CPF inválido; a pessoa tem o que corrigir.
 *   404      o pagamento **não existe neste ambiente**. Acontece de verdade:
 *            o painel pode mandar a notificação de teste para um Worker que
 *            tem a credencial de produção, e aí o pagamento de teste não está
 *            do lado de cá. Código próprio para quem chama poder distinguir
 *            «não é meu» de «deu ruim».
 *   429      estamos batendo demais. Vale tentar de novo.
 *   resto    rede ou erro deles: 502.
 */
function erroTraduzido(status: number, corpo: unknown): Error {
  const detalhe = detalheDoErro(corpo);

  if (status === 401 || status === 403) {
    // Credencial nossa, errada. **Não é indisponibilidade** e não adianta tentar de novo: é
    // configuração. O código é próprio para a tela poder dizer isso em vez de prometer que
    // uma nova tentativa resolve — foi o que aconteceu com uma credencial de usuário de
    // teste, que o Mercado Pago recusa com «Unauthorized use of live credentials» em
    // `/v1/payments` (e aceita em `/checkout/preferences`, que é o Checkout Pro).
    return erroApi(
      'pagamento_sem_credencial',
      503,
      'O pagamento nao esta configurado',
      `mercadopago ${status}: ${detalhe}`,
    );
  }
  if (status === 400 || status === 422) {
    return erroApi('pagamento_nao_aceito', 400, 'O Mercado Pago recusou os dados do pagamento', detalhe);
  }
  if (status === 404) {
    return erroApi('pagamento_desconhecido', 404, 'Pagamento nao encontrado', detalhe);
  }
  if (status === 429) {
    return erroApi('pagamento_indisponivel', 429, 'Muitas cobranças em pouco tempo. Tente de novo em instantes.', detalhe);
  }
  return erroApi('pagamento_indisponivel', 502, 'O Mercado Pago nao respondeu. Tente de novo.', detalhe);
}

function detalheDoErro(corpo: unknown): string {
  if (typeof corpo !== 'object' || corpo === null) return 'resposta sem corpo';
  const erro = corpo as ErroDoMercadoPago;
  const daCausa = (erro.cause ?? [])
    .map((item) => item?.description ?? item?.code ?? '')
    .filter((item) => item !== '')
    .join('; ');
  return daCausa !== '' ? daCausa : (erro.message ?? erro.error ?? 'sem detalhe');
}

async function pedir<T>(env: Env, caminho: string, init: RequestInit): Promise<T> {
  const cabecalhos = new Headers(init.headers);
  cabecalhos.set('Authorization', `Bearer ${token(env)}`);
  cabecalhos.set('Content-Type', 'application/json');

  let resposta: Response;
  try {
    resposta = await fetch(`${BASE}${caminho}`, { ...init, headers: cabecalhos, signal: AbortSignal.timeout(TEMPO_LIMITE_MS) });
  } catch (erro) {
    throw erroApi('pagamento_indisponivel', 502, 'O Mercado Pago nao respondeu. Tente de novo.', String(erro));
  }

  const texto = await resposta.text();
  let corpo: unknown = null;
  try {
    corpo = texto === '' ? null : JSON.parse(texto);
  } catch {
    corpo = null;
  }

  if (!resposta.ok) throw erroTraduzido(resposta.status, corpo);
  return corpo as T;
}

/**
 * O nome em duas partes.
 *
 * O Mercado Pago pede `first_name` e `last_name` separados, e a nossa tela
 * pergunta «nome completo» em um campo só — pedir em dois campos por causa do
 * formato de quem recebe seria desenhar a tela para a API. Com um nome de uma
 * palavra só, ela vai nos dois: o dado que identifica a cobrança é o CPF.
 */
function partesDoNome(nome: string): { first_name: string; last_name: string } {
  const limpo = nome.trim().replace(/\s+/g, ' ');
  const corte = limpo.lastIndexOf(' ');
  if (corte <= 0) return { first_name: limpo, last_name: limpo };
  return { first_name: limpo.slice(0, corte), last_name: limpo.slice(corte + 1) };
}

interface ComumDaCobranca {
  valorCentavos: number;
  descricao: string;
  pagador: Pagador;
  tipoDocumento: TipoDocumento;
  /** O nosso id da cobrança. Volta na consulta e é o que o webhook usa. */
  referencia: string;
  /** A chave que o Mercado Pago usa para não criar a mesma cobrança duas vezes. */
  chaveIdempotencia: string;
  /**
   * Para onde o Mercado Pago deve avisar. **Omitido** quando não há um endereço HTTPS — ele
   * recusa HTTP neste campo, e nesse caso passa a valer a URL configurada no painel.
   */
  urlDeNotificacao: string | undefined;
}

function corpoComum(dados: ComumDaCobranca) {
  return {
    // Centavos -> reais. `toFixed` antes do Number porque 1499/100 em ponto
    // flutuante não é exatamente 14.99, e o Mercado Pago compara valor.
    transaction_amount: Number((dados.valorCentavos / 100).toFixed(2)),
    description: dados.descricao,
    external_reference: dados.referencia,
    ...(dados.urlDeNotificacao ? { notification_url: dados.urlDeNotificacao } : {}),
    payer: {
      email: dados.pagador.email,
      ...partesDoNome(dados.pagador.nome),
      identification: { type: dados.tipoDocumento, number: dados.pagador.documento },
    },
  };
}

/** Cria a cobrança PIX. O QR e o copia-e-cola vêm na resposta. */
export async function criarPix(env: Env, dados: ComumDaCobranca): Promise<PagamentoDoMercadoPago> {
  return pedir<PagamentoDoMercadoPago>(env, '/v1/payments', {
    method: 'POST',
    headers: { 'X-Idempotency-Key': dados.chaveIdempotencia },
    body: JSON.stringify({ ...corpoComum(dados), payment_method_id: 'pix' }),
  });
}

/**
 * Cria a cobrança no cartão.
 *
 * O `token` é o **card token** — o número do cartão é trocado por ele no
 * Mercado Pago, do lado do app, com a Public Key. O número do cartão nunca
 * passa por este Worker: guardar número de cartão nos colocaria dentro do
 * escopo do PCI, e não há motivo para isso.
 *
 * `paymentMethodId` é a bandeira. Vai quando o app a conhece (a resposta do
 * card token traz), porque sem ela o Mercado Pago precisa deduzi-la do token.
 */
export async function criarCartao(
  env: Env,
  dados: ComumDaCobranca & { tokenDoCartao: string; paymentMethodId?: string | null },
): Promise<PagamentoDoMercadoPago> {
  return pedir<PagamentoDoMercadoPago>(env, '/v1/payments', {
    method: 'POST',
    headers: { 'X-Idempotency-Key': dados.chaveIdempotencia },
    body: JSON.stringify({
      ...corpoComum(dados),
      token: dados.tokenDoCartao,
      // Assinatura mensal não parcela: ver o comentário no `CheckoutScreen`.
      installments: 1,
      ...(dados.paymentMethodId ? { payment_method_id: dados.paymentMethodId } : {}),
    }),
  });
}

/** Consulta um pagamento pelo id do Mercado Pago. */
export async function consultarPagamento(env: Env, mpPaymentId: string): Promise<PagamentoDoMercadoPago> {
  return pedir<PagamentoDoMercadoPago>(env, `/v1/payments/${encodeURIComponent(mpPaymentId)}`, { method: 'GET' });
}

export interface EstornoDoMercadoPago {
  id: number;
  payment_id?: number | null;
  status: string;
  amount?: number | null;
}

/**
 * Estorna a cobrança **inteira**.
 *
 * Sem corpo com valor, o Mercado Pago devolve tudo — que é o que um cancelamento de assinatura
 * significa aqui: a pessoa cancela, o mês que ela pagou volta. Estorno parcial exigiria uma
 * regra de quanto devolver, e essa regra não existe.
 *
 * A chave de idempotência é fixa por pagamento (`estorno-<id>`): um retry nosso devolve o
 * **mesmo** estorno em vez de tentar devolver o dinheiro duas vezes.
 */
export async function estornarPagamento(env: Env, mpPaymentId: string): Promise<EstornoDoMercadoPago> {
  return pedir<EstornoDoMercadoPago>(env, `/v1/payments/${encodeURIComponent(mpPaymentId)}/refunds`, {
    method: 'POST',
    headers: { 'X-Idempotency-Key': `estorno-${mpPaymentId}` },
    body: JSON.stringify({}),
  });
}

/**
 * A assinatura do webhook confere?
 *
 * O manifesto é montado **na ordem e com os separadores** que o SDK oficial
 * usa (`sdk-go/pkg/webhook`), e o que chega no cabeçalho é `ts=...,v1=...`:
 *
 *     id:<data.id>;request-id:<x-request-id>;ts:<ts>;
 *
 * Pares de valor vazio saem do manifesto. O `data.id` entra em minúsculas. A
 * chave é o segredo de assinatura configurado no painel do Mercado Pago, e a
 * comparação é de tempo constante — comparar segredo com `===` entrega o
 * tamanho do prefixo certo por diferença de tempo.
 *
 * **Sem segredo configurado, ninguém entra.** Fail-closed, como a chave do
 * host: um webhook que a gente não sabe conferir é um webhook que qualquer um
 * pode forjar, e por ele se ativa assinatura de graça.
 */
export async function assinaturaDoWebhookConfere(
  env: Env,
  cabecalhos: { xSignature: string | null; xRequestId: string | null; dataId: string | null },
): Promise<boolean> {
  const segredo = (env.MP_WEBHOOK_SECRET ?? '').trim();
  if (segredo === '') return false;

  const xSignature = (cabecalhos.xSignature ?? '').trim();
  if (xSignature === '') return false;

  const partes = new Map<string, string>();
  for (const pedaco of xSignature.split(',')) {
    const corte = pedaco.indexOf('=');
    if (corte <= 0) continue;
    partes.set(pedaco.slice(0, corte).trim().toLowerCase(), pedaco.slice(corte + 1).trim());
  }

  const ts = partes.get('ts');
  const recebido = partes.get('v1');
  if (!ts || !recebido) return false;

  const dataId = (cabecalhos.dataId ?? '').trim().toLowerCase();
  const xRequestId = (cabecalhos.xRequestId ?? '').trim();

  const manifesto = [
    ...(dataId !== '' ? [`id:${dataId}`] : []),
    ...(xRequestId !== '' ? [`request-id:${xRequestId}`] : []),
    `ts:${ts}`,
  ].join(';');

  const calculado = toHex(await hmacSha256(utf8(segredo), utf8(`${manifesto};`)));
  return timingSafeEqualStr(calculado, recebido);
}

/**
 * A Public Key, para o app trocar o número do cartão por um token.
 *
 * Ela é **pública de propósito** — o nome diz. Vai nesta resposta porque o app
 * precisa dela para falar com o Mercado Pago sem passar por nós; o que não pode
 * sair daqui de jeito nenhum é o Access Token, e esse não sai.
 */
export function publicKey(env: Env): string | null {
  const valor = (env.MP_PUBLIC_KEY ?? '').trim();
  return valor === '' ? null : valor;
}

/** Guarda contra um id de pagamento que não é id: o webhook recebe texto livre. */
export function idDePagamentoValido(valor: string): boolean {
  return /^\d{1,20}$/.test(valor);
}
