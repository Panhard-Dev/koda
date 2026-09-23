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

export type ApiMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  attachments: string[]
  model: string | null
  elapsed_ms: number | null
  at: number
  steps: ToolStep[]
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
}

export type ApiModel = {
  value: string
  label: string
  hint: string | null
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
  project: string | null
  attachments: string[]
  conversation_id: string | null
  tz_offset_minutes: number
}

export class ApiError extends Error {}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  })
  if (!response.ok) {
    throw new ApiError(`${path} respondeu ${response.status}`)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

/** Fuso do navegador, como o backend espera (`Date.getTimezoneOffset()`). */
export const tzOffset = () => new Date().getTimezoneOffset()

export const health = () =>
  request<Health>('/api/health', { signal: AbortSignal.timeout(1500) })

export const listConversations = () => request<ApiConversationSummary[]>('/api/conversations')

export const getConversation = (id: string) =>
  request<ApiConversation>(`/api/conversations/${encodeURIComponent(id)}`)

export const deleteConversation = (id: string) =>
  request<void>(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const fetchUsage = () => request<ApiUsage>(`/api/usage?tz_offset_minutes=${tzOffset()}`)

export const fetchAccount = () => request<ApiAccount>('/api/account')

/** Modelos que o provedor atual aceita (o host local devolve a lista dele). */
export const listModels = () => request<ApiModel[]>('/api/models')

export const patchAccount = (patch: { phone?: string | null; google?: boolean }) =>
  request<ApiAccount>('/api/account', { method: 'PATCH', body: JSON.stringify(patch) })

export const signOut = () => request<ApiAccount>('/api/account/sign-out', { method: 'POST' })

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
  }
  done: {
    conversation_id: string
    message_id: string
    elapsed_ms: number
    steps: number
    completed?: boolean
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
    throw new ApiError(`/api/chat respondeu ${response.status}`)
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
