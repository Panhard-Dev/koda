/**
 * Os eventos da UI generativa — reconhecer o `setX(...)` sem `eval`.
 *
 * A IA escreve `onClick={() => setCount(count + 1)}` ou
 * `onChange={(e) => setUsuarios(Number(e.target.value))}`. Quem monta a interface
 * precisa de duas coisas daqui: **qual** estado mudar e **com que** expressão. Fica
 * separado do `index.tsx` (que é JSX) de propósito — assim dá pra testar sozinho, sem
 * DOM, e o parser/avaliador continuam puros.
 */

/** O estado que um evento muda e a expressão que calcula o novo valor. */
export type Evento = { alvo: string; expr: string; recebeControle?: boolean }

/**
 * Extrai uma ou mais chamadas simples `setNome(expressão)` de uma seta.
 *
 * Alguns modelos limpam um campo depois de adicionar um item usando `setLista(...)
 * + setTexto("")`. Isso continua sendo uma expressão declarativa, sem JavaScript
 * executável. Cada argumento é avaliado pelo interpretador fechado. Só aceitamos
 * setters no nível externo, separados por `;` ou `+`; blocos, chamadas arbitrárias e
 * qualquer texto restante são rejeitados.
 */
export function eventosDoCorpo(corpo: string): Evento[] | null {
  const setterDireto = corpo.trim().match(/^set(\w+)$/)
  if (setterDireto) return [{ alvo: setterDireto[1] ?? '', expr: '', recebeControle: true }]

  const seta = corpo.indexOf('=>')
  if (seta < 0) return null
  let restante = corpo.slice(seta + 2).trim()
  if (!restante || restante.startsWith('{')) return null

  const eventos: Evento[] = []
  while (restante) {
    const chamada = restante.match(/^set(\w+)\s*\(/)
    if (!chamada) return null
    const inicio = chamada[0].length
    let profundidade = 1
    let aspas = ''
    let escapado = false
    let fim = inicio
    for (; fim < restante.length && profundidade > 0; fim++) {
      const c = restante[fim] ?? ''
      if (aspas) {
        if (escapado) escapado = false
        else if (c === '\\') escapado = true
        else if (c === aspas) aspas = ''
        continue
      }
      if (c === '"' || c === "'" || c === '`') aspas = c
      else if (c === '(' || c === '[' || c === '{') profundidade++
      else if (c === ')' || c === ']' || c === '}') profundidade--
    }
    if (profundidade !== 0 || aspas) return null
    const expr = restante.slice(inicio, fim - 1).trim()
    if (!expr) return null
    eventos.push({ alvo: chamada[1] ?? '', expr })
    restante = restante.slice(fim).trimStart()
    if (!restante) break
    const separador = restante[0]
    if (separador !== '+' && separador !== ';') return null
    restante = restante.slice(1).trimStart()
    if (!restante) return null
  }
  return eventos.length ? eventos : null
}

/** Extrai o primeiro `setNome(expressão)` por compatibilidade com consumidores antigos. */
export function alvoDoEvento(corpo: string): Evento | null {
  return eventosDoCorpo(corpo)?.[0] ?? null
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
  return (
    /\bNumber\s*\(/.test(expr) ||
    /\bparse(?:Int|Float)\s*\(/.test(expr) ||
    /\+\s*\w+(?:\.target)?\.value\b/.test(expr)
  )
}
