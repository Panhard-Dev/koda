/**
 * Cliente do backend Python (`backend/`).
 *
 * O app funciona sem ele: quando a API não responde, `App.tsx` cai na resposta
 * simulada local. Por isso tudo aqui lança em caso de falha e quem chama decide.
 */

const rawBase = import.meta.env.VITE_API_URL as string | undefined
export const apiUrl = (rawBase ?? 'http://localhost:8787').replace(/\/+$/, '')

export type Health = {
  status: 'ok'
  provider: string
  provider_ready: boolean
  model: string
  database: string
  version: string
  /** Pasta onde as ferramentas do modo agente trabalham. */
  workspace: string
  /** O provedor atual sabe chamar ferramentas? */
  tools_ready: boolean
  /** Ferramentas disponíveis nesta configuração. */
  tools: string[]
  /** Teto de contexto em tokens: passando dele, o histórico compacta sozinho. 0 = sem teto. */
  contexto_tokens: number
  /** Estado da nuvem, já resumido pelo backend (vem junto, sem outra requisição). */
  cloud: ApiCloud
}

/** Canal de publicação seguido na nuvem. */
export type CloudCanal = 'stable' | 'beta'

/**
 * Resumo da nuvem que acompanha o `/api/health`. É curto de propósito: a tela
 * carrega esse valor ao abrir e só busca o resto (changelog, notas) quando entra
 * na seção Nuvem.
 */
export type ApiCloud = {
  /** Existe endereço de nuvem configurado no backend? */
  ativo: boolean
  /** A última consulta à nuvem funcionou? */
  disponivel: boolean
  canal: CloudCanal | string
  update_available: boolean
  latest_version: string | null
  download_url: string | null
  /** Host do serviço na nuvem (só o domínio, sem esquema nem caminho). */
  servico: string | null
}

/** Uma versão publicada, como o changelog da nuvem devolve. */
export type ApiCloudRelease = {
  versao: string
  notas: string | null
  publicado_em: string | null
  obrigatoria: boolean
}

/** O aviso de atualização em si (`/api/public/version` na nuvem). */
export type ApiCloudAtualizacao = {
  update_available: boolean
  latest_version: string | null
  download_url: string | null
  update_required: boolean
  mandatory: boolean
  channel: string
  notes: string | null
  published_at: string | null
  checked_version: string | null
}

/** Resposta completa de `/api/cloud/update` (o backend já higieniza o link). */
export type ApiCloudUpdate = {
  ativo: boolean
  disponivel: boolean
  canal: CloudCanal | string
  atualizado_em: number | null
  erro: string | null
  atualizacao: ApiCloudAtualizacao | null
}

/** Uma ferramenta que o modelo chamou durante a resposta. */
export type ToolStep = {
  name: string
  arguments: Record<string, unknown>
  output: string
  duration_ms: number
  call_id: string
  ok: boolean
}

/**
 * Um item da lista de tarefas do agente (o plano da tarefa grande).
 *
 * `feito` é histórico — a ferramenta daquele item já rodou; `atual` é o que ele está
 * executando agora. Os dois nunca são verdadeiros no mesmo item.
 */
export type ApiTodo = {
  texto: string
  feito: boolean
  atual: boolean
}

export type ApiMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  attachments: string[]
  model: string | null
  elapsed_ms: number | null
  /** Tokens que a resposta custou; `null` quando o provedor não conta. */
  tokens: number | null
  /** Contexto do último passo (tokens de entrada) — o medidor ao lado do modelo. */
  contexto: number | null
  at: number
  steps: ToolStep[]
  /** Lista de tarefas da resposta, quando o agente montou uma. */
  todos: ApiTodo[]
}

export type ApiConversationSummary = {
  id: string
  title: string
  preview: string
  message_count: number
  updated_at: number
}

export type ApiConversation = ApiConversationSummary & { messages: ApiMessage[] }

export type UsageWindow = { used: number; limit: number }

export type ApiUsage = {
  daily: UsageWindow
  weekly: UsageWindow
  monthly: UsageWindow
  conversations: number
  messages: number
  /**
   * Mensagens por dia (`AAAA-MM-DD` no fuso de quem perguntou), para o mapa do ano.
   *
   * Só os dias com uso: o mapa percorre os 365 dias e procura aqui.
   */
  dias: Record<string, number>
}

export type ApiModel = {
  value: string
  label: string
  hint: string | null
}

export type ApiSkill = {
  name: string
  description: string
  /** `projeto` = dentro do workspace (o agente consegue ler); `global` = da máquina. */
  scope: 'projeto' | 'global'
  /** Caminho do SKILL.md — relativo ao workspace quando for do projeto. */
  path: string
  /** Desligada, a skill sai do prompt do agente (o arquivo continua em disco). */
  enabled: boolean
}

export type ApiMcp = {
  name: string
  description: string
  enabled: boolean
}

export type ApiAccount = {
  name: string
  plan: string
  phone: string | null
  google: boolean
  email: string | null
}

export type ChatPayload = {
  text: string
  model: string
  reasoning: boolean
  /** Esforço de raciocínio do seletor ao lado do modelo (`auto` = quem decide é o Reasoning). */
  effort: string
  web: boolean
  /** Caminho completo da pasta escolhida no prompt box (projeto). */
  project_path: string | null
  attachments: string[]
  conversation_id: string | null
  tz_offset_minutes: number
}

/**
 * Falha de uma rota do backend.
 *
 * Quando a rota explica o motivo (`{"detail": {"codigo", "mensagem"}}`), a frase vem no
 * `message` — é ela que a tela mostra. O `codigo` é estável e serve para o código decidir,
 * nunca para exibir.
 */
export class ApiError extends Error {
  readonly status: number
  readonly codigo: string | null
  /**
   * A frase que o backend mandou para ser mostrada, sem o "respondeu 422" do caminho.
   *
   * É ela que a tela usa — separada do `message` porque o `message` precisa continuar
   * legível no log, com o caminho junto.
   */
  readonly motivo: string | null

  constructor(
    status: number,
    path: string,
    codigo: string | null = null,
    mensagem: string | null = null,
  ) {
    super(mensagem ?? `${path} respondeu ${status}`)
    this.status = status
    this.codigo = codigo
    this.motivo = mensagem
  }
}

/** Nome do campo do pedido como quem está usando a tela conhece. */
const CAMPOS: Record<string, string> = {
  text: 'a mensagem',
  model: 'o modelo',
  reasoning: 'o raciocínio',
  effort: 'o esforço',
  web: 'a busca na web',
  attachments: 'os anexos',
  conversation_id: 'a conversa',
  project_path: 'a pasta do projeto',
  tz_offset_minutes: 'o fuso do relógio',
}

/**
 * Traduz o `detail` de validação do FastAPI (lista de erros do pydantic) numa frase.
 *
 * Sem isto, um `422` chegava na tela como "respondeu 422" e mais nada — nem qual campo
 * era, nem por quê. Foi assim que o teto de 8 mil caracteres da caixa de mensagem
 * apareceu como "o backend não subiu", meses depois de o backend estar no ar.
 */
function fraseDaValidacao(detalhe: unknown): string | null {
  if (!Array.isArray(detalhe) || detalhe.length === 0) return null
  const itens = detalhe.filter(
    (item): item is { loc?: unknown; msg?: unknown; type?: unknown } =>
      typeof item === 'object' && item !== null,
  )
  if (itens.length === 0) return null

  return itens
    .slice(0, 3)
    .map((item) => {
      const loc = Array.isArray(item.loc)
        ? item.loc.filter((parte) => parte !== 'body').map(String)
        : []
      const ultimo = loc.at(-1) ?? ''
      const campo = ultimo ? (CAMPOS[ultimo] ?? `o campo «${ultimo}»`) : 'o pedido'
      const tipo = typeof item.type === 'string' ? item.type : ''
      const msg = typeof item.msg === 'string' ? item.msg : ''

      if (tipo === 'string_too_long') {
        const limite = /at most (\d+)/.exec(msg)?.[1]
        const teto = limite ? ` (${Number(limite).toLocaleString('pt-BR')} caracteres)` : ''
        return `${campo} passou do tamanho que o serviço aceita${teto}`
      }
      if (tipo === 'string_too_short' || tipo === 'missing') return `${campo} ficou em branco`
      return `${campo}: ${msg || tipo || 'não passou na validação'}`
    })
    .join('; ')
}

/** Lê o motivo que o backend mandou, sem quebrar se o corpo não for JSON. */
async function motivoDaFalha(
  response: Response,
): Promise<{ codigo: string | null; mensagem: string | null }> {
  try {
    const corpo = (await response.json()) as { detail?: unknown }
    const detalhe = corpo?.detail
    if (detalhe && typeof detalhe === 'object' && !Array.isArray(detalhe)) {
      const { codigo, mensagem } = detalhe as { codigo?: unknown; mensagem?: unknown }
      return {
        codigo: typeof codigo === 'string' ? codigo : null,
        mensagem: typeof mensagem === 'string' ? mensagem : null,
      }
    }
    if (typeof detalhe === 'string') return { codigo: null, mensagem: detalhe }
    const traduzido = fraseDaValidacao(detalhe)
    if (traduzido) return { codigo: 'pedido_invalido', mensagem: traduzido }
  } catch {
    // Corpo sem JSON: fica o texto padrão, que já diz o status.
  }
  return { codigo: null, mensagem: null }
}

/**
 * A frase que a tela mostra quando o serviço local não atendeu.
 *
 * O `detalhe` do erro do navegador nunca vai para a tela: "Failed to fetch" não diz nada
 * a quem está lendo. Aqui ele vira uma frase sobre o que aconteceu de verdade.
 */
export function fraseDeFalha(erro: unknown): string {
  if (erro instanceof ApiError) {
    if (erro.motivo) return erro.motivo
    if (erro.status === 422) {
      return 'O serviço local recusou o pedido: os dados não são os que ele espera (422).'
    }
    if (erro.status === 404) {
      return 'Quem respondeu neste endereço não é o serviço desta versão do Koda (404).'
    }
    if (erro.status === 500 || erro.status === 503) {
      return `O serviço local do Koda falhou lá dentro (${erro.status}).`
    }
    return `O serviço local respondeu ${erro.status}.`
  }
  return 'O serviço local do Koda não respondeu.'
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  })
  if (!response.ok) {
    const { codigo, mensagem } = await motivoDaFalha(response)
    throw new ApiError(response.status, path, codigo, mensagem)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

/** Fuso do navegador, como o backend espera (`Date.getTimezoneOffset()`). */
export const tzOffset = () => new Date().getTimezoneOffset()

export const health = () =>
  request<Health>('/api/health', { signal: AbortSignal.timeout(1500) })

/**
 * Estado do download do instalador. Quem baixa é o backend local (ele escreve na pasta
 * de downloads da máquina); a tela só acompanha o progresso.
 */
export type ApiDownload = {
  estado: 'parado' | 'baixando' | 'concluido' | 'erro'
  recebido: number
  total: number | null
  arquivo: string | null
  pasta: string | null
  caminho: string | null
  versao: string | null
  erro: string | null
}

/**
 * Manda o backend local baixar o instalador da versão publicada.
 *
 * O endereço não vai daqui: o backend usa o link que a própria nuvem publicou. Assim o
 * app não pode ser convencido a baixar de outro lugar.
 */
export const baixarAtualizacao = () =>
  request<ApiDownload>('/api/cloud/download', { method: 'POST' })

/** Progresso do download em andamento. */
export const statusDoDownload = () => request<ApiDownload>('/api/cloud/download')

/**
 * Há versão nova? O resultado fica em cache no backend por 15 minutos; `refresh`
 * força uma consulta nova — é o que o botão "verificar de novo" da tela usa.
 */
export const cloudUpdate = (
  opcoes: { versao?: string; canal?: CloudCanal; refresh?: boolean } = {},
) => {
  const params = new URLSearchParams()
  if (opcoes.versao) params.set('versao', opcoes.versao)
  if (opcoes.canal) params.set('canal', opcoes.canal)
  if (opcoes.refresh) params.set('refresh', 'true')
  const query = params.toString()
  return request<ApiCloudUpdate>(`/api/cloud/update${query ? `?${query}` : ''}`)
}

/** Notas das versões publicadas. Lista vazia quando a nuvem não responde. */
export const cloudChangelog = (canal?: CloudCanal) =>
  request<ApiCloudRelease[]>(`/api/cloud/changelog${canal ? `?canal=${canal}` : ''}`)

export const listConversations = () => request<ApiConversationSummary[]>('/api/conversations')

export const getConversation = (id: string) =>
  request<ApiConversation>(`/api/conversations/${encodeURIComponent(id)}`)

export const deleteConversation = (id: string) =>
  request<void>(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const fetchUsage = () => request<ApiUsage>(`/api/usage?tz_offset_minutes=${tzOffset()}`)

export const fetchAccount = () => request<ApiAccount>('/api/account')

/** Modelos que o provedor atual aceita (o serviço devolve a lista dele). */
export const listModels = () => request<ApiModel[]>('/api/models')

/** Skills instaladas (do projeto e da máquina) para a seção Skills. */
export const listSkills = () => request<ApiSkill[]>('/api/skills')

/** Liga/desliga uma skill; devolve a skill atualizada. */
export const toggleSkill = (name: string) =>
  request<ApiSkill>(`/api/skills/${encodeURIComponent(name)}/toggle`, { method: 'POST' })

/** Servidores MCP configurados (o Koda ainda não conecta nenhum de verdade). */
export const listMcps = () => request<ApiMcp[]>('/api/mcps')

/** Liga/desliga um servidor MCP; devolve o servidor atualizado. */
export const toggleMcp = (name: string) =>
  request<ApiMcp>(`/api/mcps/${encodeURIComponent(name)}/toggle`, { method: 'POST' })

export const patchAccount = (patch: { phone?: string | null; google?: boolean }) =>
  request<ApiAccount>('/api/account', { method: 'PATCH', body: JSON.stringify(patch) })

export const signOut = () => request<ApiAccount>('/api/account/sign-out', { method: 'POST' })

// ------------------------------------------------------------------ projetos

/**
 * Um projeto é **uma pasta do disco**. O que fica salvo é o caminho completo: nome de
 * pasta muda de máquina para máquina, caminho abre a mesma pasta em qualquer PC.
 */
export type ApiProject = {
  id: string
  nome: string
  caminho: string
  criado_em: number
  usado_em: number | null
  /** A pasta ainda existe no disco? Pasta apagada não pode virar pasta de trabalho. */
  existe: boolean
}

export type ModoPermissao = 'manual' | 'default' | 'auto'

export type ProjectsEstado = {
  projetos: ApiProject[]
  ativo_id: string | null
  /** Pasta padrão desta máquina (a Área de Trabalho de quem está usando). */
  padrao: string
  permissao: ModoPermissao
}

export type Pasta = { nome: string; caminho: string }

export type Pastas = {
  caminho: string
  pai: string | null
  pastas: Pasta[]
  atalhos: Pasta[]
  unidades: Pasta[]
}

export type RegraPermissao = {
  id: string
  kind: string
  escopo: string
  decisao: 'sempre' | 'nunca'
  rotulo: string
  criado_em: number
}

export type Permissoes = {
  modo: ModoPermissao
  modos: ModoPermissao[]
  regras: RegraPermissao[]
}

/** As quatro respostas do cartão de permissão. */
export type DecisaoPermissao = 'sim' | 'sempre' | 'nao' | 'nunca'

/** O que o agente quer fazer na máquina, e por que isso pede permissão. */
export type PedidoPermissao = {
  id: string
  kinds: string[]
  escopos: Record<string, string>
  titulo: string
  resumo: string
  explicacao: string
  /** O que «sempre/nunca permitir» passa a valer. */
  lembrar: string
  risco: 'baixo' | 'medio' | 'alto'
}

export const listProjects = () => request<ProjectsEstado>('/api/projects')

export const openProject = (caminho: string, nome?: string | null) =>
  request<ProjectsEstado>('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ caminho, ...(nome ? { nome } : {}) }),
  })

export const newProject = (pastaPai: string, nome: string) =>
  request<ProjectsEstado>('/api/projects/novo', {
    method: 'POST',
    body: JSON.stringify({ pasta_pai: pastaPai, nome }),
  })

export const activateProject = (id: string) =>
  request<ProjectsEstado>(`/api/projects/${encodeURIComponent(id)}/ativo`, {
    method: 'POST',
  })

export const releaseProject = () =>
  request<ProjectsEstado>('/api/projects/soltar', { method: 'POST' })

export const forgetProject = (id: string) =>
  request<ProjectsEstado>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })

/** Subpastas de um caminho — é o navegador de pastas do «usar pasta existente». */
export const listFolders = (caminho?: string | null) =>
  request<Pastas>(
    `/api/fs/pastas${caminho ? `?caminho=${encodeURIComponent(caminho)}` : ''}`,
  )

export const listPermissions = () => request<Permissoes>('/api/permissions')

export const setPermissionMode = (modo: ModoPermissao) =>
  request<{ modo: ModoPermissao; regras: RegraPermissao[] }>('/api/permissions', {
    method: 'PUT',
    body: JSON.stringify({ modo }),
  })

export const forgetRule = (id: string) =>
  request<{ ok: boolean }>(`/api/permissions/regras/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })

/** Responde o pedido de permissão que está esperando o loop do agente. */
export const answerApproval = (id: string, decisao: DecisaoPermissao) =>
  request<{ ok: boolean }>('/api/chat/approval', {
    method: 'POST',
    body: JSON.stringify({ id, decisao }),
  })

type StreamData = {
  start: { conversation_id: string; at: number; tools: boolean }
  delta: { text: string }
  /** O modelo pensando: vem antes do texto e pode durar minutos. Não é a resposta. */
  reasoning: { text: string }
  tool_call: { id: string; name: string; arguments: Record<string, unknown>; step: number }
  tool_result: {
    id: string
    name: string
    output: string
    duration_ms: number
    ok: boolean
    step: number
    /** A pessoa negou a ação: o passo nem chegou a rodar. */
    negado?: boolean
  }
  /**
   * O agente registrou/atualizou a lista de tarefas (o plano da tarefa grande).
   *
   * Vem como evento próprio, e não como resultado de ferramenta: é o que a conversa
   * desenha como painel, em vez de esconder atrás de "Rodar ferramenta".
   */
  todos: { todos: ApiTodo[]; step: number }
  /** O agente parou pedindo permissão para mexer na máquina. */
  approval_request: PedidoPermissao
  done: {
    conversation_id: string
    message_id: string
    elapsed_ms: number
    steps: number
    completed?: boolean
    /** Tokens que esta resposta custou (soma dos passos); `null` se o provedor não conta. */
    tokens?: number | null
    /**
     * Contexto do último passo, em tokens de entrada — o medidor ao lado do modelo.
     *
     * Vem medido do provedor: é o `prompt_tokens` do que foi enviado, não uma estimativa.
     */
    contexto?: number | null
    usage: ApiUsage
  }
  error: { message: string }
}

export type StreamHandlers = {
  onStart?: (data: StreamData['start']) => void
  onDelta: (text: string) => void
  /** O modelo pensando, para a tela não ficar parada enquanto ele não escreve. */
  onReasoning?: (text: string) => void
  /** O modelo pediu uma ferramenta (antes de ela rodar). */
  onToolCall?: (data: StreamData['tool_call']) => void
  /** A ferramenta terminou, com a saída que voltou para o modelo. */
  onToolResult?: (data: StreamData['tool_result']) => void
  /** O agente mudou o plano: a lista de tarefas da resposta a partir daqui. */
  onTodos?: (data: StreamData['todos']) => void
  /** O agente precisa de permissão — o stream fica parado até a resposta. */
  onApprovalRequest?: (data: StreamData['approval_request']) => void
  onDone?: (data: StreamData['done']) => void
  onError?: (message: string) => void
  signal?: AbortSignal
}

/**
 * Envia a mensagem e consome o `text/event-stream` do servidor.
 * Lança em falha de rede; o evento `error` do protocolo é entregue via `onError`.
 */
export async function streamChat(payload: ChatPayload, handlers: StreamHandlers) {
  const response = await fetch(`${apiUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: handlers.signal,
  })

  if (!response.ok || !response.body) {
    // O corpo da falha é lido aqui, e não descartado: é ele que diz o que o backend
    // recusou (e um `422` sem motivo é o que faz a pessoa achar que o backend não subiu).
    const { codigo, mensagem } = await motivoDaFalha(response)
    throw new ApiError(response.status, '/api/chat', codigo, mensagem)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const dispatch = (block: string) => {
    let event = 'message'
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trim()
    }
    if (!data) return

    try {
      const parsed = JSON.parse(data) as Record<string, unknown>
      if (event === 'start') handlers.onStart?.(parsed as unknown as StreamData['start'])
      else if (event === 'delta') handlers.onDelta(String(parsed.text ?? ''))
      else if (event === 'reasoning') handlers.onReasoning?.(String(parsed.text ?? ''))
      else if (event === 'tool_call')
        handlers.onToolCall?.(parsed as unknown as StreamData['tool_call'])
      else if (event === 'tool_result')
        handlers.onToolResult?.(parsed as unknown as StreamData['tool_result'])
      else if (event === 'todos')
        handlers.onTodos?.(parsed as unknown as StreamData['todos'])
      else if (event === 'approval_request')
        handlers.onApprovalRequest?.(parsed as unknown as StreamData['approval_request'])
      else if (event === 'done') handlers.onDone?.(parsed as unknown as StreamData['done'])
      else if (event === 'error') handlers.onError?.(String(parsed.message ?? 'erro no backend'))
    } catch {
      // Bloco ilegível: segue lendo o stream em vez de derrubar a resposta.
    }
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    blocks.forEach(dispatch)
  }
  if (buffer.trim()) dispatch(buffer)
}

/**
 * A sessão da conta que o backend apresenta ao host dos modelos.
 *
 * O app não tem chave de API: quem autoriza o host é a conta que está logada, e o token é
 * o mesmo que o painel emitiu. `null` limpa a credencial — é o que acontece ao sair.
 *
 * O backend guarda em memória e reescolhe o provider na hora. Sem isso, um backend que
 * subiu antes de alguém entrar ficaria com o provider local, que não sabe chamar
 * ferramenta, e o agente sumiria da interface mesmo depois do login.
 *
 * O nome e o e-mail vão junto porque é o que a tela já tem: servem para o assistente saber
 * com quem está falando, em vez de responder que "não tem acesso aos dados da conta".
 * Nada disso é gravado em disco.
 *
 * O estado volta para quem chamou porque é ele que diz se o modelo da conta entrou mesmo no
 * lugar: com a credencial recusada, o backend fica no provider local e a tela precisa saber
 * disso na hora — não daqui a dez minutos, quando o próximo envio acontecer.
 */
export type EstadoDoHost = {
  autenticado: boolean
  conta: string | null
  provider: string
  provider_ready: boolean
  tools_ready: boolean
}

export async function definirSessaoDoHost(
  token: string | null,
  conta?: { nome?: string | null; email?: string | null } | null,
): Promise<EstadoDoHost> {
  const response = await fetch(`${apiUrl}/api/host/sessao`, {
    method: token ? 'POST' : 'DELETE',
    headers: { 'content-type': 'application/json' },
    ...(token
      ? { body: JSON.stringify({ token, nome: conta?.nome ?? null, email: conta?.email ?? null }) }
      : {}),
  })
  if (!response.ok) throw new ApiError(response.status, '/api/host/sessao')
  return (await response.json()) as EstadoDoHost
}
