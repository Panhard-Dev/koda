/**
 * O avaliador de expressões — o coração da lógica sem `eval`.
 *
 * A IA escreve `{count + 1}` num botão, ou `{usuarios * preco}` num texto. Isso é
 * **expressão**, não programa: e o Koda a avalia com um interpretador fechado, escrito
 * à mão, que só sabe o que a UI generativa precisa:
 *
 * - ler um estado: `count`, `usuarios`
 * - números, strings (`"R$"`), true/false
 * - aritmética: `+ - * /` e parênteses
 * - comparar: `>= <= > < == !=`
 * - concatenar string: `"R$ " + total`
 * - formatar número: `.toFixed(2)`
 *
 * **O que ele NÃO sabe fazer** — e é a fronteira de segurança: nada de `new Function`,
 * `eval`, acesso a `window`, `document`, `fetch`, `require`, ou qualquer identificador
 * que não seja um estado conhecido. Identificador desconhecido é `undefined`, não uma
 * fuga. Assim a IA **compõe** interfaces, ela não **programa** a página.
 *
 * O parser é um descendente recursivo simples (Shunting-yard para a aritmética). Não é
 * um motor de JavaScript: é a calculadora da interface, e só.
 */

import type { Estado, FuncoesUI } from './parser'

/** Uma função que a IA declarou no `{@body}` e usa na lógica (ex: `assinantes()`). */
// (FuncoesUI é definido no parser e reexportado; fica aqui só a nota.)

/** Um valor que o avaliador pode devolver: escalar, lista ou objeto. */
export type Valor =
  | number
  | string
  | boolean
  | undefined
  | Valor[]
  | { [chave: string]: Valor }

/** O valor de um `Valor`, já serializado pra string (undefined vira vazio). */
function paraTexto(v: Valor): string {
  if (v === undefined) return ''
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return String(v)
  return String(v)
}

/**
 * Avalia um template string `` `${expr} texto ${expr2}` ``: concatena o texto fixo com o
 * resultado de cada `${…}`. É o jeito que a IA escreve quando mistura texto e conta.
 */
function avaliarTemplate(dentro: string, estado: Estado, funcoes: FuncoesUI): string {
  let saida = ''
  let i = 0
  while (i < dentro.length) {
    if (dentro[i] === '$' && dentro[i + 1] === '{') {
      // acha o `}` que fecha (contando aninhados)
      let prof = 1
      let j = i + 2
      while (j < dentro.length && prof > 0) {
        if (dentro[j] === '{') prof++
        else if (dentro[j] === '}') prof--
        if (prof === 0) break
        j++
      }
      const expr = dentro.slice(i + 2, j)
      saida += paraTexto(avaliar(expr, estado, funcoes))
      i = j + 1
    } else {
      saida += dentro[i]
      i++
    }
  }
  return saida
}

/**
 * Avalia uma expressão contra o estado atual. Devolve o valor, ou `undefined` quando a
 * expressão não é válida (aí a interface mostra vazio, não quebra).
 */
export function avaliar(corpo: string, estado: Estado, funcoes: FuncoesUI = {}): Valor {
  // **Template string** `` `${expr} texto ${expr2}` `` — o jeito que a IA escreve quando
  // mistura texto e conta (`"5% de 1.000"`). O avaliador não entende `${}` nativamente;
  // aqui a crase vira concatenação de string: cada `${…}` é avaliado e concatenado ao
  // texto fixo em volta. Sem isto, o `variacao` de um stat virava `{}` → `[object
  // Object]` na tela (visto em 17/10/2026).
  const bruto = corpo.trim()
  if (bruto.startsWith('`') && bruto.endsWith('`')) {
    return avaliarTemplate(bruto.slice(1, -1), estado, funcoes)
  }
  try {
    const tokens = tokenizar(corpo)
    const p = new Descendente(tokens, estado, funcoes)
    return p.expressao()
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- o tokenizador

type Token =
  | { tipo: 'num'; valor: number }
  | { tipo: 'str'; valor: string }
  | { tipo: 'id'; nome: string }
  | { tipo: 'chamada'; nome: string; argumento: string }
  | { tipo: 'marcador'; receptorGrupo: string; metodo: string; argumento: string }
  | { tipo: 'array'; itens: string[] }
  | { tipo: 'objeto'; campos: Array<[string, string]> }
  | { tipo: 'op'; valor: string }
  | { tipo: 'tern'; valor: string }

const OPS = new Set(['+', '-', '*', '/', '(', ')', '>=', '<=', '>', '<', '==', '!=', '&&', '||'])

/** Divide o interior de um array `a, b, {…}, c` nos itens, respeitando `{}` e `[]`. */
function dividirArray(dentro: string): string[] {
  const pedacos: string[] = []
  let prof = 0
  let atual = ''
  let aspas = ''
  let escapado = false
  for (const c of dentro) {
    if (aspas) {
      atual += c
      if (escapado) escapado = false
      else if (c === '\\') escapado = true
      else if (c === aspas) aspas = ''
      continue
    }
    if (c === '"' || c === "'") aspas = c
    else if (c === '{' || c === '[' || c === '(') prof++
    else if (c === '}' || c === ']' || c === ')') prof--
    if (c === ',' && prof === 0 && !aspas) {
      pedacos.push(atual.trim())
      atual = ''
    } else {
      atual += c
    }
  }
  if (atual.trim()) pedacos.push(atual.trim())
  return pedacos
}

/** Divide o interior de um objeto `rotulo:"a", valor:1` nos pares `chave, valor`. */
function dividirCampos(dentro: string): Array<[string, string]> {
  const campos: Array<[string, string]> = []
  for (const pedaco of dividirArray(dentro)) {
    // **Spread de objeto** (`{...item, feito: true}`): não tem `chave: valor` — é o
    // `...item` que espalha os campos de outro objeto. Marca com a chave especial `...`
    // pra o átomo expandir. Sem isto, editar um item (`{...a, nota: 10}`) perdia os
    // outros campos do item (visto em 17/10/2026).
    if (pedaco.startsWith('...')) {
      campos.push(['...', pedaco.slice(3).trim()])
      continue
    }
    const idx = pedaco.indexOf(':')
    if (idx > 0) {
      const chave = pedaco.slice(0, idx).trim().replace(/^['"]|['"]$/g, '')
      const valor = pedaco.slice(idx + 1).trim()
      campos.push([chave, valor])
    }
  }
  return campos
}

function tokenizar(corpo: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < corpo.length) {
    const c = corpo[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '"' || c === "'") {
      let fim = i + 1
      while (fim < corpo.length && corpo[fim] !== c) fim++
      tokens.push({ tipo: 'str', valor: corpo.slice(i + 1, fim) })
      i = fim + 1
      continue
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(corpo[i + 1] ?? ''))) {
      let fim = i
      while (fim < corpo.length && /[0-9.]/.test(corpo[fim])) fim++
      tokens.push({ tipo: 'num', valor: Number(corpo.slice(i, fim)) })
      i = fim
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let fim = i
      // Um identificador pode ser `base.metodo` (toFixed, toLocaleString, length) e pode
      // ser seguido de `(` — a chamada `assinantes()`, `Math.round(...)`. Engole o nome,
      // o(s) ponto(s) e o que vem depois pra o avaliador decidir.
      while (fim < corpo.length && /[\w.]/.test(corpo[fim])) fim++
      tokens.push({ tipo: 'id', nome: corpo.slice(i, fim) })
      i = fim
      // `(` imediatamente depois do id: é uma chamada. Guarda o argumento cru num token
      // de chamada, e trata o **encadeamento** `.toLocaleString(...)` depois do `)` —
      // é o `Math.round(x).toLocaleString('pt-BR')` que a IA escreve pra formatar.
      if (corpo[i] === '(') {
        // acha o `)` que fecha e guarda o argumento cru junto do id, num token de chamada
        let prof = 1
        let j = i + 1
        while (j < corpo.length && prof > 0) {
          if (corpo[j] === '(') prof++
          else if (corpo[j] === ')') prof--
          j++
        }
        const argumento = corpo.slice(i + 1, j - 1)
        // reescreve o último token id como uma chamada com o argumento
        const anterior = tokens[tokens.length - 1]
        tokens[tokens.length - 1] = {
          tipo: 'chamada',
          nome: anterior.tipo === 'id' ? anterior.nome : '',
          argumento,
        }
        i = j
        // encadeamento: `.metodo(args)` colado no `)` — junta numa única chamada cujo
        // `nome` é o método e cujo `argumento` guarda a cadeia inteira como receptor.
        while (corpo[i] === '.' && /[A-Za-z_]/.test(corpo[i + 1] ?? '')) {
          let k = i + 1
          while (k < corpo.length && /\w/.test(corpo[k])) k++
          const metodo = corpo.slice(i + 1, k)
          if (corpo[k] === '(') {
            let prof2 = 1
            let l = k + 1
            while (l < corpo.length && prof2 > 0) {
              if (corpo[l] === '(') prof2++
              else if (corpo[l] === ')') prof2--
              l++
            }
            const arg2 = corpo.slice(k + 1, l - 1)
            const receptor = tokens[tokens.length - 1]
            const receptorNome =
              receptor.tipo === 'chamada' ? `(${receptor.nome}(${receptor.argumento}))` : ''
            tokens[tokens.length - 1] = {
              tipo: 'chamada',
              nome: `${receptorNome}__m__${metodo}`,
              argumento: arg2,
            }
            i = l
          } else {
            // `.length` sem parênteses
            const receptor = tokens[tokens.length - 1]
            tokens[tokens.length - 1] = {
              tipo: 'chamada',
              nome: `${receptor.tipo === 'chamada' ? `(${receptor.nome}(${receptor.argumento}))` : ''}__m__${metodo}`,
              argumento: '',
            }
            i = k
          }
        }
      }
      continue
    }
    // `?` e `:` — o ternário (cond ? a : b). Viram tokens próprios.
    if (c === '?' || c === ':') {
      tokens.push({ tipo: 'tern', valor: c })
      i++
      continue
    }
    // `.` solto depois de `)` (ex: `(expr).toLocaleString(...)`): o tokenizador não sabe
    // remontar o receptor, então o átomo trata — mas só o `.` vira token; o método e o
    // argumento cru são lidos pelo átomo de volta ao texto original por posição. Pra isso
    // o `.` guarda a posição no texto.
    if (c === '.') {
      tokens.push({ tipo: 'op', valor: '.' })
      i++
      continue
    }
    // `(` de agrupamento: acha o `)` que fecha. Se logo depois vier `.metodo(...)`, é
    // encadeamento sobre o grupo — absorve o método e o argumento cru (com o objeto
    // `{minimumFractionDigits:2}` intacto) num token de chamada `__m__`.
    if (c === '(') {
      const inicioGrupo = i
      let prof = 1
      let j = i + 1
      while (j < corpo.length && prof > 0) {
        if (corpo[j] === '(') prof++
        else if (corpo[j] === ')') prof--
        j++
      }
      const grupo = corpo.slice(inicioGrupo + 1, j - 1)
      tokens.push({ tipo: 'op', valor: '(' })
      // tokeniza o grupo por dentro
      const dentro = tokenizar(grupo)
      tokens.push(...dentro)
      tokens.push({ tipo: 'op', valor: ')' })
      i = j
      // `.metodo(...)` colado no `)` do grupo
      while (corpo[i] === '.' && /[A-Za-z_]/.test(corpo[i + 1] ?? '')) {
        let k = i + 1
        while (k < corpo.length && /\w/.test(corpo[k])) k++
        const metodo = corpo.slice(i + 1, k)
        if (corpo[k] === '(') {
          let prof2 = 1
          let l = k + 1
          while (l < corpo.length && prof2 > 0) {
            if (corpo[l] === '(') prof2++
            else if (corpo[l] === ')') prof2--
            l++
          }
          const arg2 = corpo.slice(k + 1, l - 1)
          // marca: o receptor é o grupo; empilha um token especial que o átomo usa.
          tokens.push({ tipo: 'marcador', receptorGrupo: grupo, metodo, argumento: arg2 })
          i = l
        } else {
          tokens.push({ tipo: 'marcador', receptorGrupo: grupo, metodo, argumento: '' })
          i = k
        }
      }
      continue
    }
    // `[` — array literal (`dados={[{rotulo,valor},…]}`). Acha o `]` que fecha e guarda o
    // cru num token; o átomo converte em itens (cada um avaliado). Sem isto, o gráfico
    // com array de objetos nascia sem dados.
    if (c === '[') {
      let prof = 0
      let j = i
      while (j < corpo.length) {
        if (corpo[j] === '[') prof++
        else if (corpo[j] === ']') {
          prof--
          if (prof === 0) break
        }
        j++
      }
      const dentro = corpo.slice(i + 1, j)
      tokens.push({ tipo: 'array', itens: dividirArray(dentro) })
      i = j + 1
      continue
    }
    // `{` — objeto literal (`{rotulo:"a", valor:1}`). Só entra quando **não** é o corpo de
    // uma expressão (o avaliador é chamado com o corpo já fora das chaves). Acha o `}`
    // balanceado e guarda os pares chave:valor crus.
    if (c === '{') {
      let prof = 0
      let j = i
      while (j < corpo.length) {
        if (corpo[j] === '{') prof++
        else if (corpo[j] === '}') {
          prof--
          if (prof === 0) break
        }
        j++
      }
      const dentro = corpo.slice(i + 1, j)
      tokens.push({ tipo: 'objeto', campos: dividirCampos(dentro) })
      i = j + 1
      continue
    }
    // operador (dois chars antes de um)
    const dois = corpo.slice(i, i + 2)
    if (OPS.has(dois)) {
      tokens.push({ tipo: 'op', valor: dois })
      i += 2
      continue
    }
    if (OPS.has(c)) {
      tokens.push({ tipo: 'op', valor: c })
      i++
      continue
    }
    // caractere que não pertence à linguagem: ignora
    i++
  }
  return tokens
}

// ---------------------------------------------------------------- o avaliador

/** Precedência: `||` < `&&` < comparação < soma < multiplicação. */
const PREC: Record<string, number> = { '||': 1, '&&': 2, '>=': 3, '<=': 3, '>': 3, '<': 3, '==': 3, '!=': 3, '+': 4, '-': 4, '*': 5, '/': 5 }

/** Valor de verdade de um resultado (pra `&&`/`||`). */
function verdadeiro(v: unknown): boolean {
  return v === true || (typeof v === 'number' && v !== 0) || (typeof v === 'string' && v !== '')
}

class Descendente {
  private pos = 0
  private tokens: Token[]
  private estado: Estado
  private funcoes: FuncoesUI

  constructor(tokens: Token[], estado: Estado, funcoes: FuncoesUI = {}) {
    this.tokens = tokens
    this.estado = estado
    this.funcoes = funcoes
  }

  /** Ponto de entrada: uma expressão completa. */
  expressao(): Valor {
    // Ternário associativo à direita: `cond ? a : b` e `a ? x : b ? y : z`.
    const cond = this.soma(0)
    const tok = this.tokens[this.pos]
    if (tok && tok.tipo === 'tern' && tok.valor === '?') {
      this.pos++
      const seSim = this.expressao()
      const dpts = this.tokens[this.pos]
      if (dpts && dpts.tipo === 'tern' && dpts.valor === ':') this.pos++
      const seNao = this.expressao()
      return verdadeiro(cond) ? seSim : seNao
    }
    // sem ternário: só devolve o que a soma já calculou (evita re-consumir)
    return cond
  }

  /** Soma/subtração e tudo que tem precedência maior. */
  private soma(minPrec: number): Valor {
    let esq = this.atomo()
    while (this.pos < this.tokens.length) {
      const tok = this.tokens[this.pos]
      if (tok.tipo !== 'op' || !(tok.valor in PREC)) break
      if (PREC[tok.valor] < minPrec) break
      this.pos++
      const direita = this.soma(PREC[tok.valor] + 1)
      esq = this.aplicar(tok.valor, esq, direita)
    }
    return esq
  }

  /** O átomo: número, string, identificador (estado), chamada, grupo, array ou objeto. */
  private atomo(): Valor {
    let v = this.atomoBase()
    // Encadeamento de método sobre o átomo:
    // - `marcador` (depois de grupo `(expr)`): receptor cru + método + argumento cru;
    // - `.metodo(...)` solto (depois de chamada/id): o átomo relê do texto cru.
    for (;;) {
      const tok = this.tokens[this.pos]
      if (!tok) break
      if (tok.tipo === 'marcador') {
        this.pos++
        const receptor = avaliar(tok.receptorGrupo, this.estado, this.funcoes)
        v = this.aplicarMetodo(tok.metodo, receptor, tok.argumento)
        continue
      }
      if (tok.tipo === 'op' && tok.valor === '.') {
        const m = this.tokens[this.pos + 1]
        if (!m || m.tipo !== 'id') break
        this.pos += 2
        let argumento = ''
        const par = this.tokens[this.pos]
        if (par && par.tipo === 'op' && par.valor === '(') {
          this.pos++
          argumento = this.coleteAteFechaParen()
          const fecha = this.tokens[this.pos]
          if (fecha && fecha.tipo === 'op' && fecha.valor === ')') this.pos++
        }
        v = this.aplicarMetodo(m.nome, v, argumento)
        continue
      }
      break
    }
    return v
  }

  /** Aplica um método de Formatação (`toLocaleString`, `toFixed`, `length`) a um valor. */
  private aplicarMetodo(metodo: string, receptor: unknown, argumento: string): Valor {
    if (metodo === 'toLocaleString' && typeof receptor === 'number') {
      const m = argumento.match(/minimumFractionDigits:\s*(\d+)/)
      const casas = m ? Number(m[1]) : Number.isInteger(receptor) ? 0 : 2
      return receptor.toLocaleString('pt-BR', {
        minimumFractionDigits: casas,
        maximumFractionDigits: casas,
      })
    }
    if (metodo === 'toFixed' && typeof receptor === 'number') {
      const m = argumento.match(/(\d+)/)
      return receptor.toFixed(m ? Number(m[1]) : 2)
    }
    if (metodo === 'length' && (Array.isArray(receptor) || typeof receptor === 'string')) return receptor.length
    return receptor as Valor
  }

  /**
   * Recome o argumento cru entre `(` e `)` já tokenizado, devolvendo-o como texto.
   *
   * O argumento de `toLocaleString` costuma ser um objeto (`{minimumFractionDigits:2}`),
   * que o tokenizador não entende — mas ele vem como sequência de tokens simples. Aqui
   * remonta-se o texto cru juntando os tokens até o `)` que fecha, pra o regex de casas
   * decimais achar o número.
   */
  private coleteAteFechaParen(): string {
    const pedacos: string[] = []
    let prof = 1
    while (this.pos < this.tokens.length && prof > 0) {
      const t = this.tokens[this.pos]
      if (t.tipo === 'op' && t.valor === '(') prof++
      else if (t.tipo === 'op' && t.valor === ')') {
        prof--
        if (prof === 0) break
      }
      pedacos.push(
        t.tipo === 'num'
          ? String(t.valor)
          : t.tipo === 'str'
            ? t.valor
            : t.tipo === 'id'
              ? t.nome
              : t.tipo === 'chamada'
                ? `${t.nome}(${t.argumento})`
                : t.tipo === 'tern'
                  ? t.valor
                  : t.tipo === 'op'
                    ? t.valor
                    : '',
      )
      this.pos++
    }
    return pedacos.join(' ')
  }

  /** O átomo base: número, string, identificador (estado), chamada, grupo, array ou objeto. */
  private atomoBase(): Valor {
    const tok = this.tokens[this.pos]
    if (!tok) return undefined
    if (tok.tipo === 'op' && tok.valor === '-') {
      this.pos++
      const v = this.atomoBase()
      return typeof v === 'number' ? -v : 0
    }
    if (tok.tipo === 'op' && tok.valor === '(') {
      this.pos++
      const v = this.soma(0)
      const fecha = this.tokens[this.pos]
      if (fecha && fecha.tipo === 'op' && fecha.valor === ')') this.pos++
      return v
    }
    if (tok.tipo === 'num') {
      this.pos++
      return tok.valor
    }
    if (tok.tipo === 'str') {
      this.pos++
      return tok.valor
    }
    if (tok.tipo === 'array') {
      this.pos++
      // Cada item é avaliado. O **spread** (`...carrinho`) expande o array do estado —
      // é o `setCarrinho([...carrinho, item])` de adicionar. Sem tratar, o spread viraria
      // o texto "...carrinho" e o carrinho não mudava (visto em 17/10/2026).
      const saida: Valor[] = []
      for (const item of tok.itens) {
        if (item.startsWith('...')) {
          const alvo = avaliar(item.slice(3), this.estado, this.funcoes)
          if (Array.isArray(alvo)) saida.push(...alvo)
          else if (alvo !== undefined) saida.push(alvo)
        } else {
          saida.push(avaliar(item, this.estado, this.funcoes))
        }
      }
      return saida
    }
    if (tok.tipo === 'objeto') {
      this.pos++
      const obj: { [chave: string]: Valor } = {}
      for (const [chave, valor] of tok.campos) {
        // Spread de objeto: `{...item, feito: true}` expande os campos de `item` antes
        // dos campos próprios — é o editar-um-item (`{...a, nota: 10}`).
        if (chave === '...') {
          const alvo = avaliar(valor, this.estado, this.funcoes)
          if (alvo && typeof alvo === 'object' && !Array.isArray(alvo)) {
            Object.assign(obj, alvo)
          }
          continue
        }
        obj[chave] = avaliar(valor, this.estado, this.funcoes)
      }
      return obj
    }
    if (tok.tipo === 'chamada') {
      this.pos++
      return this.resolverChamada(tok.nome, tok.argumento)
    }
    if (tok.tipo === 'id') {
      this.pos++
      return this.resolverId(tok.nome)
    }
    return undefined
  }

  /**
   * Filtra uma lista por uma condição `(item) => expressão`.
   *
   * A condição mais comum é `item.chave === valor` / `!==` / `<` / `>`. Aqui cada item
   * entra no estado como `item` e `i` (índice), a condição é avaliada, e o item fica só
   * se der verdade. É o `carrinho.filter((item) => item.id !== 3)` de **remover** item —
   * sem isto, remover do carrinho/TODO não fazia nada (o avaliador não entendia `.filter`).
   */
  private filtrar(lista: Valor[], argumento: string): Valor[] {
    const seta = this.corpoDaSeta(argumento)
    if (!seta) return lista
    return lista.filter((item, i) => {
      const estadoItem: Estado = {
        ...this.estado,
        i,
        index: i,
        [seta.parametro]: item,
        ...(seta.indice ? { [seta.indice]: i } : {}),
      }
      // `item` é o alias legado quando o estado original não declarou um `item` externo.
      // Dentro de um repeat, porém, `item` pode ser a linha selecionada; um callback com
      // alias (`tarefa`) não deve apagá-la enquanto filtra por `tarefa.id !== item.id`.
      if (!('item' in this.estado) || seta.parametro === 'item') estadoItem.item = item
      return verdadeiro(avaliar(seta.expr, estadoItem, this.funcoes))
    })
  }

  /**
   * Mapeia uma lista: `arr.map((item) => ({...item, feito: true}))`.
   *
   * Cada item entra no estado como `item`; a expressão (que pode ser um objeto com
   * spread `{...item, campo: valor}`) é avaliada contra ele. É o `alunos.map((a) => ({...a,
   * nota: 10}))` de **editar** um item — mudar nota, marcar feito. O spread de objeto é
   * resolvido pelo avaliador porque o token `objeto` avalia cada campo, e `{...item, x: 1}`
   * tem o campo `...item` que precisa expandir.
   */
  private mapear(lista: Valor[], argumento: string): Valor[] {
    const seta = this.corpoDaSeta(argumento)
    if (!seta) return lista
    return lista.map((item, i) => {
      const estadoItem: Estado = {
        ...this.estado,
        i,
        index: i,
        [seta.parametro]: item,
        ...(seta.indice ? { [seta.indice]: i } : {}),
      }
      if (!('item' in this.estado) || seta.parametro === 'item') estadoItem.item = item
      return avaliar(seta.expr, estadoItem, this.funcoes)
    })
  }

  /** Extrai `(item, indice) => expressão` e mantém os nomes locais da seta. */
  private corpoDaSeta(argumento: string): { parametro: string; indice?: string; expr: string } | null {
    const m = argumento.match(/^\s*\(?\s*([\w$]+)?\s*(?:,\s*([\w$]+))?\s*\)?\s*=>\s*([\s\S]+)$/)
    return m ? { parametro: m[1] || 'item', indice: m[2], expr: (m[3] ?? '').trim() } : null
  }

  /** Encadeamento de método já tratado no `atomo`; fica aqui só a nota. */

  /**
   * Uma chamada `nome(argumento)` — as que a UI generativa entende:
   *
   * - `Math.round(x)` / `Math.floor` / `Math.ceil` / `Math.abs` — arredondamento;
   * - `x.toFixed(n)` — casas decimais;
   * - `x.toLocaleString('pt-BR')` — milhar brasileiro (1.234), com ou sem casas;
   * - `assinantes()` — função que a IA **declarou** no `{@body}` (calcula com o estado).
   *
   * O argumento de `toLocaleString`/`toFixed` pode ser um objeto (`{minimumFractionDigits:2}`)
   * ou um locale — o que importa é o número de casas, e ele sai do `minimumFractionDigits`
   * quando existe, senão de `.toFixed(n)`.
   */
  private resolverChamada(nome: string, argumento: string): Valor {
    // Conversão simples e explícita, sem expor o objeto global ao avaliador.
    if (nome === 'String') {
      const valor = avaliar(argumento, this.estado, this.funcoes)
      return valor === undefined ? 'undefined' : String(valor)
    }
    // Útil para IDs de itens; não oferece acesso a outros métodos de Date.
    if (nome === 'Date.now') return Date.now()

    // Encadeamento: `(...)__m__metodo` — o receptor é uma sub-expressão já chamada
    // (ex: `Math.round(x)`), e o método é o de Formatação (`toLocaleString`, `toFixed`).
    if (nome.includes('__m__')) {
      const idx = nome.indexOf('__m__')
      const receptorExpr = nome.slice(0, idx)
      const metodo = nome.slice(idx + '__m__'.length)
      const receptor = avaliar(receptorExpr, this.estado, this.funcoes)
      if (metodo === 'toLocaleString' && typeof receptor === 'number') {
        const m = argumento.match(/minimumFractionDigits:\s*(\d+)/)
        const casas = m ? Number(m[1]) : Number.isInteger(receptor) ? 0 : 2
        return receptor.toLocaleString('pt-BR', {
          minimumFractionDigits: casas,
          maximumFractionDigits: casas,
        })
      }
      if (metodo === 'toFixed' && typeof receptor === 'number') {
        const m = argumento.match(/(\d+)/)
        return receptor.toFixed(m ? Number(m[1]) : 2)
      }
      if (metodo === 'length' && (Array.isArray(receptor) || typeof receptor === 'string')) return receptor.length
      return undefined
    }

    const [base, metodo] = nome.split('.')
    // Math.round/floor/ceil/abs
    if (base === 'Math') {
      const valores = dividirArray(argumento).map((parte) => Number(this.somaDe(parte)))
      const n = valores[0] ?? Number.NaN
      switch (metodo) {
        case 'round':
          return Math.round(n)
        case 'floor':
          return Math.floor(n)
        case 'ceil':
          return Math.ceil(n)
        case 'abs':
          return Math.abs(n)
        case 'min':
          return valores.length ? Math.min(...valores) : undefined
        case 'max':
          return valores.length ? Math.max(...valores) : undefined
        default:
          return undefined
      }
    }
    // valor.toFixed(n) / valor.toLocaleString(...) — o receptor é um estado/expressão
    const receptor = avaliar(base, this.estado, this.funcoes)
    if (metodo === 'toFixed') {
      const n = Number(this.somaDe(argumento))
      return typeof receptor === 'number' ? receptor.toFixed(Number.isFinite(n) ? n : 2) : undefined
    }
    if (metodo === 'toLocaleString') {
      if (typeof receptor !== 'number') return undefined
      // casas: do {minimumFractionDigits: N} do argumento, se houver; senão 2 quando o
      // valor tem fração, senão 0.
      const m = argumento.match(/minimumFractionDigits:\s*(\d+)/)
      const casas = m ? Number(m[1]) : Number.isInteger(receptor) ? 0 : 2
      return receptor.toLocaleString('pt-BR', {
        minimumFractionDigits: casas,
        maximumFractionDigits: casas,
      })
    }
    if (metodo === 'length' && (Array.isArray(receptor) || typeof receptor === 'string')) return receptor.length

    // **Operações de lista** — o que faz carrinho/TODO/lista de alunos funcionar.
    // A IA escreve `setCarrinho([...carrinho, item])` (adicionar),
    // `carrinho.filter(...)` (remover), `carrinho.slice(0, -1)` (remover o último),
    // `carrinho.map(...)` (editar). Sem isto, adicionar/remover item não fazia nada:
    // o avaliador não entendia spread/filter/slice e o estado virava `undefined`.
    if (Array.isArray(receptor)) {
      if (metodo === 'slice') {
        const [ini, fim] = argumento.split(',').map((p) => Number(p.trim()))
        return receptor.slice(ini, fim === undefined && argumento.includes(',') ? undefined : fim)
      }
      if (metodo === 'concat') {
        const outro = avaliar(argumento, this.estado, this.funcoes)
        return receptor.concat(Array.isArray(outro) ? outro : [outro])
      }
      if (metodo === 'filter') {
        // `arr.filter((item) => item.id !== 3)` — extrai a condição e filtra por ela.
        // A condição mais comum: `item.chave === valor` ou `!==`. Aplica o avaliador em
        // cada item contra a condição com o `item` no estado temporário.
        return this.filtrar(receptor, argumento)
      }
      if (metodo === 'find') {
        const achado = this.filtrar(receptor, argumento)
        return achado.length ? achado[0] : undefined
      }
      if (metodo === 'map') {
        // `arr.map((item) => ({...item, feito: true}))` — devolve a lista com cada item
        // passado pela expressão. Pra editar nota de um aluno, marcar feito, etc.
        return this.mapear(receptor, argumento)
      }
      if (metodo === 'push') {
        const item = avaliar(argumento, this.estado, this.funcoes)
        return [...receptor, item]
      }
      if (metodo === 'indexOf') {
        const alvo = avaliar(argumento, this.estado, this.funcoes)
        return receptor.indexOf(alvo)
      }
    }
    // função declarada no {@body} (ex: `assinantes()`)
    const fn = this.funcoes[base]
    if (fn) return fn(this.estado)
    return undefined
  }

  /** Avalia um argumento (que pode ser expressão) contra o estado. */
  private somaDe(expr: string): Valor {
    return avaliar(expr, this.estado, this.funcoes)
  }

  /** Identificador: estado conhecido, campo de objeto, função derivada, ou `undefined`. */
  private resolverId(nome: string): Valor {
    // `itens.length` — o tamanho da lista. `itens[0]` cai no default (sem fuga).
    const [base, metodo] = nome.split('.')
    if (base !== undefined && base in this.estado) {
      const v = this.estado[base]
      if (metodo === 'toFixed' && typeof v === 'number') return v.toFixed(2)
      if (metodo === 'length' && (Array.isArray(v) || typeof v === 'string')) return v.length
      // **Campo de objeto** (`item.texto`, `aluno.nota`): quando o identificador é um
      // objeto no estado e tem um campo depois do ponto, devolve o campo. É o que faz
      // `item.texto !== "maçã"` (filter) e `item.nota` (map) funcionarem — sem isto,
      // o avaliador devolvia o objeto inteiro e o filter nunca removia nada.
      if (metodo && v && typeof v === 'object' && !Array.isArray(v)) {
        return (v as Record<string, Valor>)[metodo]
      }
      return v as Valor
    }
    // **Constante derivada** (`const receita = assinantes * preco`): o identificador
    // solto é uma conta que depende do estado. Chama a função contra o estado atual —
    // assim `receita` (sem parênteses) recalcula quando o slider mexe. `receita.toFixed`
    // funciona porque o `atomo` aplica o `.toFixed` no resultado.
    if (base !== undefined && base in this.funcoes) {
      return this.funcoes[base](this.estado)
    }
    // verdadeiro/falso/nulo são átomos da linguagem.
    if (nome === 'true') return true
    if (nome === 'false') return false
    return undefined
  }

  /** Aplica um operador binário. */
  private aplicar(op: string, a: unknown, b: unknown): number | string | boolean | undefined {
    switch (op) {
      case '+':
        if (typeof a === 'string' || typeof b === 'string') return `${a ?? ''}${b ?? ''}`
        return (Number(a) || 0) + (Number(b) || 0)
      case '-':
        return (Number(a) || 0) - (Number(b) || 0)
      case '*':
        return (Number(a) || 0) * (Number(b) || 0)
      case '/':
        return (Number(a) || 0) / (Number(b) || 1)
      case '>=':
        return Number(a) >= Number(b)
      case '<=':
        return Number(a) <= Number(b)
      case '>':
        return Number(a) > Number(b)
      case '<':
        return Number(a) < Number(b)
      case '==':
        return a === b
      case '!=':
        return a !== b
      case '&&':
        return verdadeiro(a) && verdadeiro(b) ? (b as number | string | boolean) : false
      case '||':
        return verdadeiro(a) ? (a as number | string | boolean) : (b as number | string | boolean)
      default:
        return undefined
    }
  }
}
