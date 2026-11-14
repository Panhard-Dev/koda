/**
 * Quanto custa em moedas — a tabela e a conta.
 *
 * É o **único** lugar onde token vira moeda. A tabela de preços da área de Planos lê daqui para
 * dizer quanto custa cada modelo; a ficha da resposta lê daqui para dizer quanto aquela resposta
 * gastou. Duas cópias dessa conta divergiriam, e a pessoa veria um número na página e outro na
 * conversa.
 */

/**
 * Quanto custa um milhão de tokens, **por modelo**.
 *
 * Era por **porte**, deduzido do nome (`nano`/`mini` pequenos, `layze-2` grande, o resto médio),
 * e o dono viu o defeito na tela: `liz-3-flash`, `liz-4` e `koda-1` caíam no mesmo degrau e
 * saíam pelo mesmo preço — «o flash tá competindo com a liz 4, o koda também». Preço é decisão
 * dele, e modelo nenhum é igual a outro: a tabela virou explícita, um id por linha.
 *
 * Com o catálogo novo do `host/gateway-local` (02/11/2026), os preços foram mantidos nos
 * degraus equivalentes: o Claude Haiku 5.5 herdou o degrau do antigo `liz-4` (10,5), e os
 * três Flash herdaram o degrau do antigo `liz-3-flash` (7). O Haiku saiu do seletor a
 * pedido do dono, mas o preço dele fica aqui: conversas antigas ainda podem ter gasto
 * nesse modelo, e apagar a linha faria a ficha dessas respostas cobrar o `PRECO_PADRAO`.
 * O `PRECO_PADRAO` continua cobrindo modelo novo que apareça no seletor antes de ter preço.
 */
export const MOEDAS_POR_MILHAO: Record<string, number> = {
  'claude-haiku-5.5': 10.5,
  'glm-5.3-flash': 7,
  'qwen-3.8-flash': 7,
  'qwen-3.8-flash-legacy': 7,
}

/**
 * O preço de um modelo que **não está** na tabela.
 *
 * Acontece de verdade: o host publica o catálogo, e um modelo novo pode aparecer no seletor
 * antes de alguém pôr preço nele. Cobrar zero seria dar de graça o que ninguém decidiu dar —
 * e é um erro que não aparece na tela, porque resposta de graça não parece defeito. Fica no
 * degrau mais caro conhecido até o dono dizer o preço dele.
 */
const PRECO_PADRAO = 14

/** Quanto custa um milhão de tokens neste modelo. */
export function precoDoModelo(modelo: string): number {
  return MOEDAS_POR_MILHAO[modelo] ?? PRECO_PADRAO
}

/**
 * Quanto se gasta numa conversa, em tokens.
 *
 * **Medido**, não estimado: uma resposta do agente com um passo gastou 16.173 de contexto e
 * 1.572 de saída. Como cada passo **reenvia o contexto inteiro**, uma conversa normal fica em
 * torno de 100 mil tokens — é esse o número que a régua das conversas usa. O quanto isso vale
 * em moedas sai da tabela de cima, e por isso não é escrito aqui: mudou o preço, mudou a conta.
 */
export const TOKENS_POR_CONVERSA = 100_000

/**
 * O modelo que serve de régua para «quantas conversas».
 *
 * Com preço por modelo **não existe mais «o modelo médio»** — a régua virou um modelo nomeado, e
 * a frase que mostra o número diz qual é. Ele é o padrão do app de propósito: serve para dar
 * ordem de grandeza, e a régua não pode mudar de uma conversa para outra.
 */
export const MODELO_DE_REFERENCIA = 'glm-5.3-flash'

/** Quantas moedas custa um tanto de tokens, num modelo. */
export function moedasDeTokens(tokens: number, modelo: string): number {
  return (tokens / 1_000_000) * precoDoModelo(modelo)
}

/**
 * As moedas de um gasto **separado por modelo** — o formato que a tela de Uso recebe.
 *
 * O servidor manda tokens por modelo (o dado bruto); a conta que os transforma em moeda é esta,
 * e é aqui de propósito: preço é decisão de produto e mora num lugar só. O servidor ter uma
 * segunda cópia da tabela seria a garantia de que um dia os dois números divergem.
 *
 * Soma **depois** de converter, e não antes: `moedasDeTokens` não arredonda, então somar os
 * totais primeiro e converter depois daria o mesmo — mas só enquanto o preço for linear. Somar
 * moeda por modelo é o que continua certo se um dia a conta ganhar um degrau.
 */
export function moedasDeTokensPorModelo(tokensPorModelo: Record<string, number>): number {
  let total = 0
  for (const [modelo, tokens] of Object.entries(tokensPorModelo)) {
    total += moedasDeTokens(tokens, modelo)
  }
  return total
}

/**
 * Quantas conversas cabem num tanto de moedas, no modelo de referência.
 *
 * O `floor` é para não prometer uma conversa que o saldo não fecha.
 */
export function conversasCom(moedas: number): number {
  const porConversa = (TOKENS_POR_CONVERSA / 1_000_000) * precoDoModelo(MODELO_DE_REFERENCIA)
  return Math.floor(moedas / porConversa)
}

/**
 * As moedas como se lê: inteiro quando é inteiro, uma casa quando tem fração.
 *
 * A fração é real e não um resto de arredondamento: o preço é por **milhão** de tokens, então
 * quase toda resposta custa menos de uma moeda inteira. A vírgula é decimal — `10,5` é dez e
 * meio, e não dez mil e quinhentos.
 *
 * A regra já existia solta na ficha da resposta (`MessageFooter`). Está aqui porque a tabela de
 * preços precisa da mesma, e duas cópias dessa formatação divergem no dia em que alguém mexer
 * numa delas.
 */
export function moedasLegiveis(moedas: number): string {
  return Number.isInteger(moedas) ? `${moedas}` : moedas.toFixed(1).replace('.', ',')
}
