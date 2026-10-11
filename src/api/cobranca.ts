import { ErroDaConta, pedir, sessaoParaOHost } from './cloud'

/**
 * A cobrança da assinatura.
 *
 * ## O que sai daqui, e o que não sai
 *
 * O app manda o **id do plano** — nunca o preço. Quem decide quanto cobrar é o servidor, que lê
 * o valor do banco; se a tela pudesse dizer o valor, o cliente escolheria quanto pagar.
 *
 * E o app **não vê chave nenhuma**. Nem o Access Token do Mercado Pago (esse existe só no
 * Worker) nem o segredo do webhook. O que ele precisa para falar com o Mercado Pago — a Public
 * Key, para trocar o cartão por um token — vem na resposta, porque é pública de propósito.
 *
 * ## A chave de idempotência nasce na tela
 *
 * Ela é criada quando a pessoa começa uma assinatura e **reusada** se a tentativa falhar e ela
 * tentar de novo. É o que faz um retry devolver **a mesma cobrança** em vez de criar uma
 * segunda: cobrar duas vezes é o único erro desta tela que a pessoa vê no extrato. Por isso a
 * chave não é gerada aqui dentro de `assinarComPix` — quem chama é que sabe o que é "a mesma
 * tentativa".
 */

export type PlanoDaCobranca = {
  id: string
  nome: string
  /** Centavos. 3999 = R$ 39,99. Quem formata é a tela. */
  preco_centavos: number
  horas_por_dia: number
  moedas_por_mes: number
  moedas_por_dia: number
}

export type Cobranca = {
  id: string
  metodo: 'cartao' | 'pix'
  status: string
  status_detalhe: string | null
  valor_centavos: number
  /** O código copia-e-cola do PIX. */
  qr_code: string | null
  /** A imagem do QR em base64, sem o prefixo `data:`. */
  qr_code_base64: string | null
  expira_em: string | null
}

export type Assinatura = {
  plano_id: string
  status: 'pendente' | 'ativa' | 'atrasada' | 'cancelada'
  renova_em: string | null
} | null

/**
 * O token da sessão — ou o erro certo quando não há.
 *
 * São três motivos diferentes para não ter token, e a frase de cada um é outra: sem sessão
 * nesta máquina a pessoa entra de novo; com a sessão recusada, também; sem rede, o certo é
 * tentar de novo. Um `null` só para os três faria a tela pedir login por causa de Wi-Fi.
 */
async function comSessao(): Promise<string> {
  const sessao = await sessaoParaOHost()
  if (sessao.estado === 'pronta') return sessao.token
  if (sessao.estado === 'sem-sessao') {
    throw new ErroDaConta('missing_token', 'Sua sessão expirou. Entre de novo.', 401)
  }
  if (sessao.estado === 'morta') {
    throw new ErroDaConta('token_revoked', 'Sua sessão expirou. Entre de novo.', 401)
  }
  throw new ErroDaConta('sem_conexao', 'Não consegui falar com o painel do Koda. Confira a internet.')
}

/**
 * Uma chave de cobrança nova.
 *
 * `crypto.getRandomValues` e não `crypto.randomUUID`: o segundo só existe em contexto seguro, e
 * o app roda no webview do Tauri, onde isso não é garantido. Trinta e dois caracteres
 * hexadecimais colidem menos do que o problema que eles evitam.
 */
export function novaChaveDeCobranca(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Cria a cobrança PIX e devolve o QR. */
export async function assinarComPix(dados: {
  planoId: string
  nome: string
  documento: string
  chave: string
}): Promise<{ plano: PlanoDaCobranca; pagamento: Cobranca }> {
  return pedir<{ plano: PlanoDaCobranca; pagamento: Cobranca }>('/api/assinatura/pix', {
    metodo: 'POST',
    token: await comSessao(),
    corpo: {
      plano_id: dados.planoId,
      nome: dados.nome,
      documento: dados.documento,
      chave_idempotencia: dados.chave,
    },
  })
}

/** Por que o dinheiro não voltou, quando não voltou. */
export type MotivoSemEstorno = 'sem_pagamento' | 'prazo_expirado'

/**
 * Cancela a assinatura e, se ainda estiver no prazo, devolve o dinheiro.
 *
 * O estorno é do servidor: o app não tem (nem deve ter) como devolver pagamento — o que ele faz
 * é pedir, e a resposta diz se o dinheiro voltou. O **prazo** também é conferido lá: aqui a gente
 * só mostra a data.
 *
 * `estorno_motivo` explica a recusa quando ela acontece — `prazo_expirado` (passou dos sete
 * dias) ou `sem_pagamento` (nunca houve cobrança aprovada). Os dois são estados normais, não
 * erro, e a tela diz qual dos dois foi.
 */
export async function cancelarAssinatura(): Promise<{
  estorno: { id: number; status: string } | null
  estorno_motivo: MotivoSemEstorno | null
}> {
  return pedir<{ estorno: { id: number; status: string } | null; estorno_motivo: MotivoSemEstorno | null }>(
    '/api/assinatura/cancelar',
    { metodo: 'POST', token: await comSessao() },
  )
}

/**
 * Compra crédito avulso.
 *
 * O app manda o **valor em centavos**, e não a quantidade de créditos: quantos créditos um
 * valor compra é conta do servidor. Se fosse o contrário, o cliente estaria escolhendo quanto
 * levar por um preço — a mesma inversão que a cobrança de plano evita ao não aceitar preço.
 */
export async function comprarCreditos(dados: {
  valorCentavos: number
  nome: string
  documento: string
  chave: string
}): Promise<{ creditos: number; pagamento: Cobranca }> {
  return pedir<{ creditos: number; pagamento: Cobranca }>('/api/creditos/pix', {
    metodo: 'POST',
    token: await comSessao(),
    corpo: {
      valor_centavos: dados.valorCentavos,
      nome: dados.nome,
      documento: dados.documento,
      chave_idempotencia: dados.chave,
    },
  })
}

/**
 * O saldo de crédito avulso — e a sonda da compra.
 *
 * Depois de pagar o PIX a tela pergunta aqui até o saldo subir. Quem credita é o webhook, e ele
 * pode chegar antes ou depois do app olhar; a tela não precisa saber qual dos dois, só o saldo.
 */
export async function meusCreditos(): Promise<{ creditos: number; vencendo_em: string | null }> {
  return pedir<{ creditos: number; vencendo_em: string | null }>('/api/creditos', {
    token: await comSessao(),
  })
}

/**
 * Em que plano a conta está, e o que ficou em aberto.
 *
 * É também a sonda do pagamento: o PIX é pago **fora** do app (no banco, no app do banco), e a
 * única forma de saber que ele caiu é perguntar. Quem confirma de verdade é o webhook; isto
 * aqui só olha o resultado.
 */
export async function minhaAssinatura(): Promise<{
  assinatura: Assinatura
  cobrancas_abertas: Cobranca[]
  public_key: string | null
}> {
  return pedir<{ assinatura: Assinatura; cobrancas_abertas: Cobranca[]; public_key: string | null }>(
    '/api/assinatura',
    { token: await comSessao() },
  )
}
