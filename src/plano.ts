/**
 * O que cada plano dá — em **um lugar só**.
 *
 * Os mesmos números aparecem em dois pontos da tela: na aba da caixa de escrever e na ficha do
 * plano. Número repetido em dois arquivos é número que um dia diverge — um lado mostra 3 horas
 * e o outro 2, e ninguém sabe qual está certo. Aqui é a única fonte.
 *
 * Hoje só o **Free** existe, com os números que o dono definiu: **1 hora por dia** e **100
 * moedas por mês**. Quando os planos vierem do servidor, é este módulo que some — quem manda
 * passa a ser a conta, e não uma constante.
 *
 * Os **períodos são diferentes** de propósito, e o nome do campo carrega isso: o tempo é do
 * dia e as moedas são do mês. Chamar as moedas só de «moedas» foi o que me fez escrever a
 * linha errada na tela — o período é a informação, não um detalhe dela.
 */

export type Plano = {
  nome: string
  /** Quanto o dia dá, em horas. A contagem volta ao começo à meia-noite. */
  horasPorDia: number
  /** As moedas do **mês**. Entram quando o tempo do dia acaba. */
  moedasPorMes: number
  /**
   * Em que dia do mês as moedas voltam.
   *
   * É **mês de calendário**, e não trinta dias desde que a pessoa entrou: a virada é a mesma
   * para todo mundo, à meia-noite do dia 1º. O dia é dado do plano, e não um `1` solto no
   * meio de uma frase — se um plano futuro virar noutro dia, muda aqui e a frase acompanha.
   */
  moedasRenovamNoDia: number
}

export const PLANO_FREE: Plano = {
  nome: 'Free',
  horasPorDia: 1,
  moedasPorMes: 100,
  moedasRenovamNoDia: 1,
}

/** Um plano que se assina: o que ele dá, mais o que ele custa. */
export type PlanoPago = Plano & {
  /**
   * O identificador do plano **no servidor**.
   *
   * É ele que a tela manda na cobrança — nunca o preço. Quem decide quanto cobrar é o
   * servidor, que lê o valor do banco; se a tela pudesse dizer o valor, o cliente escolheria
   * quanto pagar. O `preco` daqui serve para **mostrar**, e só.
   */
  id: string
  /** Em reais, por mês. Número, e não texto: quem formata é `precoEmTexto`. */
  preco: number
  /**
   * As moedas que entram **a cada dia**, por cima das do mês.
   *
   * São duas fontes, e os períodos são diferentes de propósito: o mês é o que o plano dá, e o
   * dia repõe o que o dia consumiu. O nome de cada campo carrega o período dele — «moedas»
   * sozinho foi o que já me fez escrever a linha errada na tela uma vez.
   */
  moedasPorDia: number
}

/**
 * Os três planos da área **Planos**, na ordem em que aparecem — do mais barato ao mais caro.
 *
 * **Nenhum deles é o Free** — o Free é o degrau de baixo, e fica na vista dele. Estes três são
 * o que se assina.
 *
 * As horas são **por dia**, e as moedas vêm de **duas** fontes: o bolo do mês e a recarga do
 * dia. Três períodos diferentes convivendo, e é por isso que o nome de cada campo diz o dele —
 * `moedasPorMes` e `moedasPorDia` não são a mesma coisa em escalas diferentes, são coisas
 * diferentes que somam.
 */
export const PLANOS_PAGOS: PlanoPago[] = [
  {
    id: 'base',
    nome: 'Koda Base',
    preco: 19.99,
    horasPorDia: 2,
    moedasPorMes: 350,
    moedasPorDia: 20,
    moedasRenovamNoDia: 1,
  },
  {
    id: 'plus',
    nome: 'Koda Plus',
    preco: 39.99,
    horasPorDia: 4,
    moedasPorMes: 660,
    moedasPorDia: 66,
    moedasRenovamNoDia: 1,
  },
  {
    id: 'pro',
    nome: 'Koda Pro',
    preco: 59.99,
    horasPorDia: 8,
    moedasPorMes: 1425,
    moedasPorDia: 152,
    moedasRenovamNoDia: 1,
  },
]

/**
 * Os pacotes de crédito avulso.
 *
 * **Não são planos.** Eles não dão hora nenhuma — são o excedente de quem já assina e estourou o
 * crédito do mês. Por isso o preço por crédito aqui é o do plano **Base** (R$ 0,022) e nunca
 * menor: se o avulso saísse mais barato que a assinatura, ninguém teria motivo para assinar. E
 * o pacote também não pode ser mais caro que todos — um pacote que ninguém compra não serve
 * para nada.
 *
 * **O preço acompanha o do Base.** Se um dia o Base subir, estes sobem junto — senão o avulso
 * fica mais barato que o plano e a indução se inverte.
 */
export const PACOTES_DE_CREDITOS = [
  { creditos: 250, preco: 5.49 },
  { creditos: 500, preco: 10.99 },
  { creditos: 1000, preco: 21.99 },
  { creditos: 2000, preco: 43.99 },
  { creditos: 5000, preco: 109.99 },
] as const

/**
 * Quanto custa um crédito no avulso — a régua do **valor livre**.
 *
 * É o mesmo preço por crédito do pacote de 250 (R$ 5,49 ÷ 250), arredondado: assim o campo
 * «escolha o valor» não é nem mais barato nem mais caro que os pacotes, e ninguém descobre um
 * jeito de pagar menos digitando um número esquisito.
 */
export const PRECO_DO_CREDITO_AVULSO = 0.022

/**
 * O mínimo da compra avulsa.
 *
 * Abaixo disso a taxa do Mercado Pago come uma fatia grande demais do valor — e um crédito
 * fracionado não serve para nada. Cinco reais dá ~227 créditos, que já é uma sessão de trabalho.
 */
export const VALOR_MINIMO_DO_PACOTE = 5

/**
 * Quantos dias um crédito comprado avulso vale.
 *
 * Sem validade, quem estoca numa promoção nunca mais assina — e o pacote, que existe para ser
 * a válvula de escape do mês apertado, viraria uma assinatura mais barata.
 */
export const DIAS_DE_VALIDADE_DO_PACOTE = 90

/**
 * Quantos dias tem o mês da conta.
 *
 * **Trinta é a régua, não o calendário.** A recarga é diária e o bolo do mês renova no dia 1º,
 * então um mês de 31 dias rende mais que um de fevereiro. O que a tela compara são os planos
 * entre si, e essa comparação não pode mudar conforme o mês em que a pessoa abriu a página —
 * por isso o total sai com um `≈`, e não como se fosse exato.
 */
export const DIAS_DO_MES = 30

/** O que o plano entrega num mês cheio: o bolo do mês mais a recarga de todos os dias. */
export function moedasTotaisNoMes(plano: PlanoPago): number {
  return plano.moedasPorMes + plano.moedasPorDia * DIAS_DO_MES
}

/** O preço como se lê: `R$ 39,99`. O `/mês` fica na tela, que é onde ele é uma frase. */
export function precoEmTexto(preco: number): string {
  return preco.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

/**
 * As moedas em texto, sempre com quatro dígitos.
 *
 * O preenchimento não é enfeite: a aba da caixa se dimensiona pelo próprio conteúdo e a
 * silhueta segue a largura dela — sem ele, a cada moeda gasta a aba estreitaria e a caixa
 * inteira dançaria junto.
 */
export function moedasEmTexto(moedas: number): string {
  return String(moedas).padStart(4, '0')
}
