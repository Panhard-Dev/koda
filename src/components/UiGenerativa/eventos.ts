/**
 * Os eventos da UI generativa — reconhecer o `setX(...)` sem `eval`.
 *
 * A IA escreve `onClick={() => setCount(count + 1)}` ou
 * `onChange={(e) => setUsuarios(Number(e.target.value))}`. Quem monta a interface
 * precisa de duas coisas daqui: **qual** estado mudar e **com que** expressão. Fica
 * separado do `index.tsx` (que é JSX) de propósito — assim dá pra testar sozinho, sem
 * DOM, e o parser/avaliador continuam puros.
 */

/** O corpo de um evento, na forma `… => setNome(expressão)`. */
const SETTER = /=>\s*set(\w+)\((.+)\)\s*$/

/** O estado que o evento muda e a expressão que calcula o novo valor. */
export type Evento = { alvo: string; expr: string }

/** Extrai o `setNome(expressão)` do corpo do evento, ou `null` se não casar. */
export function alvoDoEvento(corpo: string): Evento | null {
  const m = corpo.match(SETTER)
  if (!m) return null
  return { alvo: m[1] ?? '', expr: (m[2] ?? '').trim() }
}

/**
 * O nome do estado que o setter aponta.
 *
 * A convenção do React capitaliza a primeira letra: o estado `usuarios` tem o setter
 * `setUsuarios`. O regex captura `Usuarios` (com maiúscula), e gravar nesse nome criava
 * uma chave **nova** — o estado de verdade nunca mudava, o slider não saía do lugar e
 * os números não recalculavam (visto em 17/10/2026, no simulador de receita: arrastar o
 * slider não fazia nada). Esta volta pra minúscula casa o setter com o estado certo.
 */
export function nomeDoEstado(alvoCru: string, chaves: string[]): string {
  if (chaves.includes(alvoCru)) return alvoCru
  const igual = chaves.find((k) => k.toLowerCase() === alvoCru.toLowerCase())
  return igual ?? alvoCru
}

/** O evento quer número (`Number(e.target.value)`) em vez do texto cru do controle? */
export function querNumero(expr: string): boolean {
  return /\bNumber\s*\(/.test(expr)
}
