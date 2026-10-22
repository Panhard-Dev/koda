/**
 * Os pacotes de crédito avulso — a régua do dinheiro.
 *
 * ## Por que a lista mora aqui, e não só no app
 *
 * O app tem uma cópia desta lista para desenhar as caixas (`src/plano.ts`), e ela é só isso:
 * **desenho**. Quem decide quantos créditos uma cobrança credita é este arquivo, porque crédito
 * é dinheiro — e uma regra de dinheiro que só existe no cliente é uma regra que qualquer um
 * contorna chamando a API com o valor que quiser.
 *
 * ## A régua do valor livre
 *
 * `PRECO_DO_CREDITO` é o preço por crédito do pacote de 250 (549 ÷ 250, arredondado). O campo
 * «escolha o valor» usa a mesma régua dos pacotes de propósito: se o valor livre saísse mais
 * barato por crédito, ninguém clicaria num pacote — bastaria digitar o número certo.
 */

/** Centavos por crédito no valor livre. 2,2 centavos = R$ 0,022. */
export const CENTAVOS_POR_CREDITO = 2.2;

/** O menor valor que se pode comprar, em centavos. Abaixo disso a taxa do meio de pagamento come o valor. */
export const MINIMO_EM_CENTAVOS = 500;

/** O maior, para uma dedicação de teclado não virar uma cobrança de mil reais. */
export const MAXIMO_EM_CENTAVOS = 100_000;

/**
 * Quantos dias o crédito comprado vale.
 *
 * Sem validade, quem estoca numa promoção nunca mais assina — e o pacote, que existe para ser a
 * válvula de escape do mês apertado, viraria uma assinatura mais barata.
 */
export const DIAS_DE_VALIDADE = 90;

export interface Pacote {
  creditos: number;
  centavos: number;
}

/**
 * Os pacotes fechados.
 *
 * O preço é o do app arredondado — e é **ele** que manda, não a multiplicação: 250 créditos
 * custam R$ 5,49 e não R$ 5,50, porque preço redondo é o que se lê. A diferença de um centavo
 * não muda a régua do valor livre, que é uma aproximação por definição.
 */
export const PACOTES: Pacote[] = [
  { creditos: 250, centavos: 549 },
  { creditos: 500, centavos: 1099 },
  { creditos: 1000, centavos: 2199 },
  { creditos: 2000, centavos: 4399 },
  { creditos: 5000, centavos: 10999 },
];

/**
 * Quantos créditos um valor compra.
 *
 * Um pacote fechado vale exatamente os créditos dele (o arredondamento do preço não deve tirar
 * crédito de ninguém). Qualquer outro valor cai na régua, arredondando **para baixo** — para
 * baixo porque creditar a mais é dar dinheiro, e creditar um a menos é irrelevante.
 *
 * `null` quando o valor está fora da faixa: é o servidor dizendo não, e não um zero silencioso.
 */
export function creditosDoValor(centavos: number): number | null {
  const pacote = PACOTES.find((item) => item.centavos === centavos);
  if (pacote) return pacote.creditos;
  if (centavos < MINIMO_EM_CENTAVOS || centavos > MAXIMO_EM_CENTAVOS) return null;
  return Math.floor(centavos / CENTAVOS_POR_CREDITO);
}
