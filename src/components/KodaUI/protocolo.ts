/**
 * O contrato do Koda UI Protocol no cliente.
 *
 * O servidor já validou o documento antes de mandá-lo (ver `backend/app/ui_documento.py`).
 * Aqui a validação é a **segunda barreira**: o que chega de uma conversa gravada, de um
 * documento antigo ou de um cliente adulterado não pode virar HTML, CSS ou JavaScript no
 * app. Tudo o que não passa vira fallback — nunca execução.
 *
 * A árvore é JSON puro: `{id, type, props, children}`. Nenhum campo carrega função. As
 * ações são nomes (`state.increment`, `copy`, `openUrl`…) que o dispatcher implementa em
 * código confiável.
 */

export const LIMITES = {
  profundidade: 12,
  nos: 250,
  bytes: 256 * 1024,
  itens: 100,
  linhasTabela: 500,
  pontosGrafico: 200,
} as const

/** Os tipos que o renderer conhece. Nome canônico, como o servidor normaliza. */
export const TIPOS = new Set([
  'KodaBox', 'KodaRow', 'KodaColumn', 'KodaGrid', 'KodaCard',
  'KodaTitle', 'KodaText', 'KodaParagraph', 'KodaCaption', 'KodaLabel',
  'KodaBadge', 'KodaAlert', 'KodaCallout', 'KodaDivider', 'KodaSpacer',
  'KodaList', 'KodaLink', 'KodaCodeBlock', 'KodaImage', 'KodaTable',
  'KodaMetric', 'KodaProgress', 'KodaButton', 'KodaInput', 'KodaTextarea',
  'KodaCheckbox', 'KodaRadioGroup', 'KodaSelect', 'KodaSlider',
  'KodaSegmentedControl', 'KodaForm', 'KodaPressable', 'KodaChart',
  'KodaTabs', 'KodaSteps', 'KodaAccordion', 'KodaCarousel', 'KodaPopover',
  'KodaDatePicker', 'KodaToggle', 'KodaSuggestion', 'KodaQuote', 'KodaDiff',
  'KodaSourceList', 'KodaVideo', 'KodaIcon', 'KodaSvg', 'KodaDiagram',
  'KodaMap', 'KodaWritingBlock', 'KodaSandbox', 'KodaAppBlock',
  'KodaAlgorithm', 'KodaCitation', 'KodaEntity', 'KodaCalculator',
])

/** As ações declarativas. O JSON nunca traz uma função; o dispatcher é que age. */
export const ACOES = new Set([
  'state.set', 'state.toggle', 'state.increment', 'state.calc', 'ui.setTab',
  'copy', 'openUrl', 'issueNewTurn', 'form.submit',
])

export type KodaNo = {
  id: string
  type: string
  props: Record<string, unknown>
  children: KodaNo[]
}

export type KodaAcao = {
  kind: string
  key?: string
  value?: unknown
  amount?: number
  text?: string
  fromState?: string
  url?: string
  mensagem?: string
  expression?: string
}

export type KodaDocumento = {
  schemaVersion: '1.0'
  documentId: string
  messageId: string
  revision: number
  state: Record<string, unknown>
  actions: Record<string, KodaAcao>
  root: KodaNo
  dataRefs: unknown[]
  fallbackText: string
}

export type ResultadoValidacao =
  | { ok: true; documento: KodaDocumento }
  | { ok: false; erro: string }

const CHAVE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const ID = /^[A-Za-z0-9_-]{1,80}$/

function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
}

/** URL segura: http/https/mailto; imagem também aceita data:image. */
export function urlSegura(valor: unknown, { imagem = false } = {}): string | null {
  if (typeof valor !== 'string') return null
  const texto = valor.trim()
  if (!texto || texto.length > 2000) return null
  if (imagem && /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(texto)) {
    return texto.length > 200 * 1024 ? null : texto
  }
  try {
    const url = new URL(texto)
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return null
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.hostname) return null
    if (url.username || url.password) return null
    return texto
  } catch {
    return null
  }
}

/**
 * Valida e normaliza um documento vindo de qualquer lugar.
 *
 * A validação é deliberadamente conservadora: tipo desconhecido derruba a interface
 * inteira com uma mensagem clara, em vez de desenhar metade e esconder o resto. Um
 * componente que o servidor conhece e o cliente não (versão futura) cai no fallback
 * local — o documento continua legível.
 */
export function validarDocumento(bruto: unknown): ResultadoValidacao {
  if (typeof bruto === 'string') {
    try {
      bruto = JSON.parse(bruto)
    } catch {
      return { ok: false, erro: 'o documento não é JSON válido' }
    }
  }
  if (!ehObjeto(bruto)) return { ok: false, erro: 'o documento precisa ser um objeto' }
  const raiz = ehObjeto(bruto.documento) ? bruto.documento : bruto

  try {
    const serializado = JSON.stringify(raiz)
    if (serializado.length > LIMITES.bytes) {
      return { ok: false, erro: 'o documento passou de 256 KB' }
    }
    const versao = String(raiz.schemaVersion ?? raiz.versao ?? '1.0')
    if (versao !== '1.0') return { ok: false, erro: `versão ${versao} não suportada` }

    const estado = ehObjeto(raiz.state) ? raiz.state : ehObjeto(raiz.estado) ? raiz.estado : {}
    for (const chave of Object.keys(estado)) {
      if (!CHAVE.test(chave)) return { ok: false, erro: `chave de estado inválida: ${chave}` }
    }

    const acoesBrutas = ehObjeto(raiz.actions) ? raiz.actions : ehObjeto(raiz.acoes) ? raiz.acoes : {}
    const acoes: Record<string, KodaAcao> = {}
    for (const [id, acao] of Object.entries(acoesBrutas)) {
      if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(id)) {
        return { ok: false, erro: `id de ação inválido: ${id}` }
      }
      if (!ehObjeto(acao)) return { ok: false, erro: `a ação ${id} precisa ser um objeto` }
      const kind = String(acao.kind ?? acao.tipo ?? '')
      if (!ACOES.has(kind)) return { ok: false, erro: `ação desconhecida: ${kind}` }
      if (acao.url !== undefined && !urlSegura(acao.url)) {
        return { ok: false, erro: `a ação ${id} tem URL inválida` }
      }
      acoes[id] = { ...(acao as KodaAcao), kind }
    }

    const raizBruta = raiz.root ?? raiz.raiz
    if (!ehObjeto(raizBruta)) return { ok: false, erro: 'falta a árvore `root`' }

    const ids = new Set<string>()
    let contador = 0

    const no = (valor: unknown, profundidade: number): KodaNo => {
      if (!ehObjeto(valor)) throw new Error('nó precisa ser um objeto')
      if (profundidade > LIMITES.profundidade) throw new Error('a árvore passou de 12 níveis')
      contador += 1
      if (contador > LIMITES.nos) throw new Error('a interface passou de 250 nós')

      const type = String(valor.type ?? valor.tipo ?? '')
      if (!TIPOS.has(type)) throw new Error(`componente desconhecido: ${type || '(sem tipo)'}`)
      const id = String(valor.id ?? `n${contador}`)
      if (!ID.test(id)) throw new Error(`id inválido: ${id}`)
      if (ids.has(id)) throw new Error(`id repetido: ${id}`)
      ids.add(id)

      const props = ehObjeto(valor.props) ? valor.props : ehObjeto(valor.propriedades) ? valor.propriedades : {}
      const ehSandbox = type === 'KodaSandbox' || type === 'KodaAppBlock'
      for (const chave of Object.keys(props)) {
        if (['style', 'className', 'class', 'dangerouslySetInnerHTML', 'script'].includes(chave)) {
          throw new Error(`prop proibida: ${chave}`)
        }
        // `html` só existe dentro do sandbox de origem opaca, e com teto de tamanho.
        if (chave === 'html' && !ehSandbox) throw new Error('prop proibida: html')
      }
      if (ehSandbox) {
        const brutoSandbox = ['html', 'css', 'js']
          .map((chave) => (typeof props[chave] === 'string' ? (props[chave] as string) : ''))
          .join('')
        if (brutoSandbox.length > 120 * 1024) throw new Error('o sandbox passou de 120 KB')
      }
      const childrenBrutos = Array.isArray(valor.children) ? valor.children : Array.isArray(valor.filhos) ? valor.filhos : []
      if (childrenBrutos.length > LIMITES.itens) throw new Error('filhos demais')
      return {
        id,
        type,
        props,
        children: childrenBrutos.map((filho) => no(filho, profundidade + 1)),
      }
    }

    const arvore = no(raizBruta, 1)
    const documento: KodaDocumento = {
      schemaVersion: '1.0',
      documentId: String(raiz.documentId ?? raiz.id ?? 'documento'),
      messageId: String(raiz.messageId ?? ''),
      revision: Number(raiz.revision ?? 1) || 1,
      state: estado,
      actions: acoes,
      root: arvore,
      dataRefs: [],
      fallbackText: String(raiz.fallbackText ?? raiz.textoAlternativo ?? ''),
    }
    return { ok: true, documento }
  } catch (erro) {
    return { ok: false, erro: erro instanceof Error ? erro.message : String(erro) }
  }
}

/** `{{chave}}` vira o valor vivo do estado. Texto puro — nunca HTML. */
export function interpolar(texto: string, estado: Record<string, unknown>): string {
  return texto.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, chave: string) => {
    const valor = estado[chave]
    if (valor === null || valor === undefined) return ''
    if (typeof valor === 'object') {
      try {
        return JSON.stringify(valor)
      } catch {
        return ''
      }
    }
    return String(valor)
  })
}

/** Uma chave de estado, de `valueBinding` (string ou `{scope,key}`). */
export function chaveDoBinding(valor: unknown): string | null {
  if (typeof valor === 'string' && CHAVE.test(valor)) return valor
  if (ehObjeto(valor) && typeof valor.key === 'string' && CHAVE.test(valor.key)) return valor.key
  return null
}

/** O contexto que cada componente recebe do documento. */
export type Ctx = {
  estado: Record<string, unknown>
  acoes: Record<string, KodaAcao>
  definir: (chave: string, valor: unknown) => void
  alternar: (chave: string) => void
  incrementar: (chave: string, quanto: number) => void
  despachar: (actionId: string) => void
  executando: string | null
}

/**
 * Avalia uma expressão aritmética simples sobre o estado — sem `eval`.
 *
 * Aceita números, `+ - * / %`, parênteses e nomes de chaves de `state`. É o motor das
 * calculadoras e de `state.calc`. Qualquer coisa fora dessa gramática devolve `null`.
 */
export function avaliarExpressao(
  expressao: string,
  estado: Record<string, unknown>,
): number | null {
  if (!expressao || expressao.length > 300) return null
  if (!/^[0-9A-Za-z_+\-*/%().\s]+$/.test(expressao)) return null
  const s = expressao
  let i = 0
  const pularEspaco = () => {
    while (i < s.length && /\s/.test(s[i])) i += 1
  }
  const primario = (): number | null => {
    pularEspaco()
    if (s[i] === '(') {
      i += 1
      const valor = soma()
      pularEspaco()
      if (s[i] !== ')') return null
      i += 1
      return valor
    }
    if (s[i] === '-') {
      i += 1
      const valor = primario()
      return valor === null ? null : -valor
    }
    if (s[i] === '+') {
      i += 1
      return primario()
    }
    const numero = /^[0-9]+(?:\.[0-9]+)?/.exec(s.slice(i))
    if (numero) {
      i += numero[0].length
      return Number(numero[0])
    }
    const nome = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i))
    if (nome) {
      i += nome[0].length
      const valor = Number(estado[nome[0]])
      return Number.isFinite(valor) ? valor : null
    }
    return null
  }
  const produto = (): number | null => {
    let valor = primario()
    if (valor === null) return null
    while (true) {
      pularEspaco()
      const operador = s[i]
      if (operador !== '*' && operador !== '/' && operador !== '%') break
      i += 1
      const direito = primario()
      if (direito === null) return null
      if ((operador === '/' || operador === '%') && direito === 0) return null
      valor =
        operador === '*' ? valor * direito : operador === '/' ? valor / direito : valor % direito
    }
    return valor
  }
  const soma = (): number | null => {
    let valor = produto()
    if (valor === null) return null
    while (true) {
      pularEspaco()
      const operador = s[i]
      if (operador !== '+' && operador !== '-') break
      i += 1
      const direito = produto()
      if (direito === null) return null
      valor = operador === '+' ? valor + direito : valor - direito
    }
    return valor
  }
  const resultado = soma()
  pularEspaco()
  if (i !== s.length || resultado === null || !Number.isFinite(resultado)) return null
  return resultado
}
