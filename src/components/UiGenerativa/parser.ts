/**
 * UI generativa: a IA **descreve** uma interface, o Koda **desenha**.
 *
 * ## O problema
 *
 * Os blocos visuais (`BlocosVisuais.tsx`) são 21 formatos fixos: quiz, gráfico, tabela.
 * Eles cobrem o que se previu, e só isso. Um simulador, um contador, um editor — coisas
 * que a foto do dono mostrou — não têm formato fixo, e aí a IA fica presa: ou escreve
 * texto, ou manda JSON de um tipo que não existe e toma o cartão amarelo.
 *
 * ## A saída: Generative UI
 *
 * Em vez de acertar 21 formatos de antemão, a IA descreve a interface com uma
 * **mini-linguagem** parecida com JSX, e o Koda interpreta. São os componentes
 * `<box>`, `<button>`, `<slider>`, `<grid>`, `<chart>`… e o estado `useState`, do jeito
 * que o dono pediu. Um contador, um simulador de receita, um quiz de verdade — tudo sai
 * da mesma máquina, sem tipo fixo nenhum.
 *
 * ## A regra que não se negocia: sem `eval`
 *
 * O texto que a IA manda é **dado, nunca código executável** — é a mesma regra do
 * `RichText` (nada de HTML de fora entra na página). Nada de `new Function`, nada de
 * `eval`, nada de `dangerouslySetInnerHTML`. O parser é escrito à mão: ele lê a
 * mini-linguagem e monta uma árvore de componentes React. A **lógica** (`{@body …}`) é
 * reconhecida por padrões conhecidos — o `useState` de verdade — e o resto da expressão
 * é avaliado por um mini-interpretador fechado, não pelo JavaScript da página.
 *
 * Assim a interface da foto é possível **sem** abrir a porta de executar código
 * arbitrário: a IA compõe telas, ela não programa a página.
 */

import { avaliar, type Valor } from './avaliador.ts'

// ---------------------------------------------------------------- a árvore

/** Um nó da interface que a IA descreveu. */
type No =
  | { tag: 'box'; props: Record<string, PropValor>; filhos: No[] }
  | { tag: 'texto'; valor: string }
  | { tag: 'expressao'; corpo: string }
  | { tag: 'componente'; nome: string; props: Record<string, PropValor>; filhos: No[] }

/** O valor de um prop: literal (string/número/bool) ou expressão `{…}`. */
type PropValor = { tipo: 'literal'; valor: string | number | boolean } | { tipo: 'expr'; corpo: string }

// ---------------------------------------------------------------- o corpo {@body}

/**
 * O estado da tela: os `useState` que a IA declarou no `{@body …}`.
 *
 * `useState` é de verdade — React por baixo, com o nome que a IA deu. O parser só
 * reconhece a forma `const [x, setX] = DIL.useState(0)`; o valor inicial vira o estado,
 * e `setX` vira uma função que guarda o novo valor e re-renderiza.
 */
export type Estado = Record<string, unknown>

/** Uma lista de itens — o estado `useList([…])`, que alimenta o `<repeat>`. */
export type ListaUI = Valor[]

/**
 * Uma função que a IA declarou no `{@body}` e usa na lógica das telas.
 *
 * Ex.: `const assinantes = () => usuarios * taxa / 100`. O parser guarda o corpo, e o
 * `avaliar` o chama contra o estado atual quando a expressão tem `assinantes()`. É o que
 * faz uma conta nomeada virar peça reutilizável — sem `eval`, só o corpo conhecido.
 */
export type FuncaoUI = (estado: Estado) => Valor
export type FuncoesUI = Record<string, FuncaoUI>

/** O valor inicial de um `useState`: número, texto, booleano ou lista. */
function valorInicial(cru: string, comoLista = false): Valor {
  const limpo = cru.trim()
  if (limpo === 'true') return true
  if (limpo === 'false') return false
  if (limpo.startsWith('[') && limpo.endsWith(']')) {
    // Avalia só o literal fechado pela mini-linguagem (nunca JavaScript). useList
    // transforma valores simples em `{texto}` para o repeat antigo; objetos e arrays
    // continuam com sua forma, para telas como tarefas com id/feito.
    const lista = avaliar(limpo, {})
    if (!Array.isArray(lista)) return []
    return comoLista
      ? lista.map((item) =>
          item && typeof item === 'object' && !Array.isArray(item)
            ? item
            : { texto: item == null ? '' : String(item) },
        )
      : lista
  }
  if (/^-?\d+(\.\d+)?$/.test(limpo)) return Number(limpo)
  return limpo.replace(/^['"]|['"]$/g, '')
}

// ---------------------------------------------------------------- o parser

/**
 * Parser da mini-linguagem. Não é um parser de JSX completo: é o subconjunto que a IA
 * usa para descrever telas — tags, atributos `nome={…}` ou `nome="…"`, filhos de texto,
 * expressões `{…}` e o bloco `{@body …}` de estado.
 *
 * Escrito à mão de propósito: regex não casa tag aninhada, e uma biblioteca de JSX
 * entenderia JS arbitrário — que é exatamente o que a gente não pode aceitar.
 */
class Parser {
  private i = 0
  private corpo = ''

  constructor(fonte: string) {
    this.corpo = fonte
  }

  /**
   * O estado `{@body …}` (um ou vários, em qualquer ordem entre as tags), as **funções**
   * que a IA declarou, e a árvore.
   *
   * A IA pode declarar **vários** estados — um `{@body}` por `useState`, ou todos juntos.
   * Cada bloco `{@body …}` é lido e somado; o que sobra (as tags) vira a árvore. Também
   * valem as funções `const nome = (...) => expressão`, que a lógica reusa (ex:
   * `assinantes()` calculando com o estado).
   */
  parse(): { estado: Estado; funcoes: FuncoesUI; arvore: No[] } {
    const estado: Estado = {}
    const funcoes: FuncoesUI = {}
    // Varre todos os {@body …} antes das tags.
    for (;;) {
      this.pularEspaco()
      if (!this.comecaCom('{@body')) break
      // `this.i` é a posição do `{` que abre o {@body}. O `fechaChave` conta a partir
      // dele — assim um `{}` aninhado lá dentro (useState({}), toLocaleString com
      // {minimumFractionDigits}) não encerra o bloco antes da hora.
      const abreChave = this.i
      const inicio = abreChave + '{@body'.length
      const fim = this.fechaChave(abreChave)
      const trecho = this.corpo.slice(inicio, fim)
      Object.assign(estado, this.lerEstado(trecho))
      this.lerFuncoes(trecho, funcoes)
      this.i = fim + 1
    }
    const arvore = this.lerNos(0)
    return { estado, funcoes, arvore }
  }

  /** Os `const [x, setX] = DIL.useState(v)` e `DIL.useList([…])` do corpo. */
  private lerEstado(trecho: string): Estado {
    const estado: Estado = {}
    const reg =
      /const\s*\[\s*(\w+)\s*,\s*set\w+\s*\]\s*=\s*DIL\.(useState|useList)\(\s*(.+?)\s*\)/g
    let m: RegExpExecArray | null
    while ((m = reg.exec(trecho)) !== null) {
      estado[m[1]] = valorInicial(m[3] ?? '', m[2] === 'useList')
    }
    return estado
  }

  /**
   * As funções que a IA declarou: `const nome = (args) => expressão`.
   *
   * Só a forma de seta entra. O corpo vira uma função que o `avaliar` chama contra o
   * estado atual — sem `eval`. Função que a IA inventar sem declarar não existe (o
   * avaliador devolve `undefined`), o que é seguro.
   */
  private lerFuncoes(trecho: string, funcoes: FuncoesUI): void {
    // 1. `const nome = (args) => expressão` — função de verdade.
    const reg = /const\s+(\w+)\s*=\s*\([^)]*\)\s*=>\s*([^;]+)/g
    let m: RegExpExecArray | null
    while ((m = reg.exec(trecho)) !== null) {
      const nome = m[1]
      const corpo = (m[2] ?? '').trim()
      funcoes[nome] = (estado) => avaliar(corpo, estado, funcoes)
    }
    // 2. `const nome = expressão` — **constante derivada** (ex:
    //    `const receita = assinantes * preco`). Não é estado (`useState`) nem função
    //    (`=>`): é uma conta que depende do estado. Vira uma função de zero args que
    //    recalcula contra o estado atual — assim, quando o slider mexe `usuarios`, o
    //    `receita` muda junto. Sem isto, o stat pedia `receita` e o avaliador não
    //    achava: dava `undefined` → `R$ 0`/`NaN` na tela (visto em 17/10/2026).
    const regDerivada = /const\s+(\w+)\s*=\s*([^;=]+?)(?=\s*(?:const\s|\{|$))/g
    while ((m = regDerivada.exec(trecho)) !== null) {
      const nome = m[1]
      const corpo = (m[2] ?? '').trim()
      if (corpo.startsWith('(') || funcoes[nome]) continue
      if (trecho.includes(`[${nome},`) || trecho.includes(`[ ${nome} ,`)) continue
      funcoes[nome] = (estado) => avaliar(corpo, estado, funcoes)
    }
  }

  private comecaCom(pedaco: string): boolean {
    return this.corpo.startsWith(pedaco, this.i)
  }

  private pularEspaco(): void {
    while (this.i < this.corpo.length && /\s/.test(this.corpo[this.i])) this.i++
  }

  /** Lê nós até o `</` que fecha o pai (ou o fim). */
  private lerNos(_profundidade: number): No[] {
    const nos: No[] = []
    while (this.i < this.corpo.length) {
      this.pularEspaco()
      if (this.i >= this.corpo.length) break
      // Fim de um pai: </tag>. Devolve o controle.
      if (this.comecaCom('</')) {
        this.i = this.corpo.indexOf('>', this.i) + 1
        return nos
      }
      if (this.comecaCom('<')) {
        const no = this.lerTag()
        if (no) nos.push(no)
        continue
      }
      // Texto solto até a próxima tag ou expressão.
      const inicio = this.i
      while (this.i < this.corpo.length && this.corpo[this.i] !== '<' && this.corpo[this.i] !== '{') {
        this.i++
      }
      const texto = this.corpo.slice(inicio, this.i).trim()
      if (texto) nos.push({ tag: 'texto', valor: texto })
      // Expressão {…} no meio do texto. Também conta chaves: uma expressão pode ter
      // `{…}` aninhado (objeto, array de objetos).
      if (this.comecaCom('{')) {
        const fim = this.fechaChave(this.i)
        const corpo = this.corpo.slice(this.i + 1, fim)
        nos.push({ tag: 'expressao', corpo: corpo.trim() })
        this.i = fim + 1
      }
    }
    return nos
  }

  /** Lê uma tag `<box …>…</box>` e seus filhos. */
  private lerTag(): No | null {
    // Consome o '<'
    this.i++
    const inicioNome = this.i
    while (this.i < this.corpo.length && /[\w-]/.test(this.corpo[this.i])) this.i++
    const nome = this.corpo.slice(inicioNome, this.i)
    if (!nome) {
      // Tag malformada: engole o '<' e segue.
      return null
    }
    const props: Record<string, PropValor> = {}
    // Atributos até o '>'.
    while (this.i < this.corpo.length) {
      this.pularEspaco()
      if (this.comecaCom('/>')) {
        this.i += 2
        return { tag: 'componente', nome, props, filhos: [] }
      }
      if (this.corpo[this.i] === '>') {
        this.i++
        break
      }
      // nome do atributo
      const ini = this.i
      while (this.i < this.corpo.length && /[\w-]/.test(this.corpo[this.i])) this.i++
      const chave = this.corpo.slice(ini, this.i)
      if (!chave) {
        this.i++ // segurança: não trava
        continue
      }
      this.pularEspaco()
      if (this.corpo[this.i] !== '=') {
        // atributo booleano (ex: <slider disabled>)
        props[chave] = { tipo: 'literal', valor: true }
        continue
      }
      this.i++ // consome '='
      this.pularEspaco()
      if (this.corpo[this.i] === '{') {
        // O `}` que fecha a expressão não é o primeiro: dentro pode haver um array de
        // objetos (`dados={[{rotulo:"a",valor:1},…]}`), e cada objeto tem o seu `}`.
        // Conta `{`/`}` balanceados pra achar o fim de verdade — senão a lista era
        // cortada no primeiro `}` e o gráfico nascia sem dados (visto em 17/10/2026).
        const fim = this.fechaChave(this.i)
        props[chave] = { tipo: 'expr', corpo: this.corpo.slice(this.i + 1, fim).trim() }
        this.i = fim + 1
      } else {
        const aspas = this.corpo[this.i]
        if (aspas === '"' || aspas === "'") {
          const fim = this.corpo.indexOf(aspas, this.i + 1)
          props[chave] = { tipo: 'literal', valor: this.corpo.slice(this.i + 1, fim) }
          this.i = fim + 1
        }
      }
    }
    const filhos = this.lerNos(0)
    return { tag: 'componente', nome, props, filhos }
  }

  /**
   * A posição do `}` que **fecha** o `{` em `inicio`, contando os aninhados.
   *
   * `{a: {b: 1}}` tem dois `}`; o que fecha é o segundo. Sem contar, o parser cortaria
   * a expressão no primeiro e perderia o resto — o caso do array de dados do gráfico.
   */
  private fechaChave(inicio: number): number {
    let prof = 0
    for (let p = inicio; p < this.corpo.length; p++) {
      if (this.corpo[p] === '{') prof++
      else if (this.corpo[p] === '}') {
        prof--
        if (prof === 0) return p
      }
    }
    return this.corpo.length
  }
}

/** Parseia a mini-linguagem em estado, funções e árvore. Nunca lança. */
export function parseUi(fonte: string): { estado: Estado; funcoes: FuncoesUI; arvore: No[] } {
  try {
    return new Parser(fonte).parse()
  } catch {
    return { estado: {}, funcoes: {}, arvore: [] }
  }
}

/** A fonte é um bloco `koda-ui`? (a IA cerca com a linguagem). */
export function ehBlocoUi(linguagem: string): boolean {
  return linguagem === 'koda-ui'
}

export type { No, PropValor }
