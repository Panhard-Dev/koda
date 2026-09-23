import { useEffect, useMemo, useRef, useState } from 'react'
import Composer from './components/Composer'
import type { SendPayload } from './components/Composer'
import Header from './components/Header'
import type { ConversationSummary } from './components/Header'
import KodaLogo from './components/KodaLogo'
import SettingsScreen from './components/SettingsScreen'
import RichText from './components/RichText'
import ThinkingMark from './components/ThinkingMark'
import ToolSteps from './components/ToolSteps'
import type { SettingsSection } from './components/SettingsScreen'
import { findModel, MODELO_PADRAO, PROJECTS, projectName } from './models'
import type { RemoteModel } from './models'
import { PLAN, dayKey, monthStart, weekStart } from './plan'
import { DEFAULT_APPEARANCE } from './appearance'
import type { Appearance } from './appearance'
import { INITIAL_ACCOUNT } from './account'
import type { Account } from './account'
import {
  apiUrl,
  fetchAccount,
  fetchUsage,
  getConversation,
  health,
  listConversations,
  listModels,
  patchAccount,
  signOut,
  streamChat,
} from './api/client'
import type {
  ApiConversationSummary,
  ApiMessage,
  ApiUsage,
  Health,
  ToolStep,
} from './api/client'

type Message = {
  id: string
  role: 'user' | 'assistant'
  text: string
  attachments?: string[]
  /** Tempo de processamento mostrado acima da resposta do Koda. */
  elapsedMs?: number
  /** Quando a mensagem entrou na sessão, para as cotas de uso. */
  at: number
  /** Ferramentas chamadas nesta resposta (modo agente). */
  steps?: ToolStep[]
  /**
   * O que o modelo pensou antes de escrever, quando ele pensa em voz alta.
   *
   * Vem em evento próprio e **não** faz parte da resposta: é o que evita a tela ficar
   * parada por minutos enquanto o modelo não escreve a primeira palavra.
   */
  reasoning?: string
}

const EASE = 'ease-[cubic-bezier(0.22,1,0.36,1)]'

const newId = () => crypto.randomUUID()

type Conversation = {
  id: string
  title: string
  preview: string
  /** Vazio quando a conversa veio do servidor e ainda não foi aberta. */
  messages: Message[]
}

const formatDuration = (ms: number) =>
  ms < 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`

const titleFor = (list: Message[]) => {
  const first = list.find((message) => message.role === 'user')?.text ?? ''
  return first.replace(/\s+/g, ' ').slice(0, 40).trim() || 'Nova conversa'
}

const previewFor = (list: Message[]) =>
  (list.at(-1)?.text ?? 'Sem mensagens').replace(/\s+/g, ' ').slice(0, 64)

/** Resposta usada só quando o backend está fora do ar. */
function buildReply(payload: SendPayload): string {
  const blocks: string[] = [
    'Esta resposta é simulada no próprio navegador — o backend em Python não respondeu a esta tela.',
    [
      `Modelo: ${payload.model}`,
      `Reasoning ${payload.reasoning ? 'ativado' : 'desativado'}`,
      payload.web ? 'busca na Web ativada' : 'sem busca na Web',
      payload.project ? `projeto ${payload.project}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
  ]

  if (payload.attachments.length > 0) {
    blocks.push(`Anexos recebidos: ${payload.attachments.join(', ')}.`)
  }


  blocks.push(
    `Suba a API para ter resposta de verdade e histórico no banco: \`cd backend && uv run uvicorn app.main:app --port 8787\` (esperado em ${apiUrl}).`,
  )

  return blocks.join('\n\n')
}

const fromApiMessage = (message: ApiMessage): Message => ({
  id: message.id,
  role: message.role,
  text: message.text,
  attachments: message.attachments,
  elapsedMs: message.elapsed_ms ?? undefined,
  at: message.at,
  steps: message.steps,
})

const fromApiSummary = (conversation: ApiConversationSummary): Conversation => ({
  id: conversation.id,
  title: conversation.title,
  preview: conversation.preview,
  messages: [],
})

/** Uma rodada de leitura no servidor: estado, cotas, histórico e conta. */
async function loadSession() {    const [info, usage, conversations, account, models] = await Promise.all([
    health(),
    fetchUsage(),
    listConversations(),
    fetchAccount(),
    listModels(),
  ])
  return { info, usage, conversations, account, models }
}

function App() {
  const [messages, setMessages] = useState<Message[]>([])
  const [busy, setBusy] = useState(false)
  const [interrupted, setInterrupted] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [project, setProject] = useState('sem-projeto')
  const [showProcessed, setShowProcessed] = useState(true)
  const [history, setHistory] = useState<Conversation[]>([])
  const [view, setView] = useState<'chat' | 'settings'>('chat')
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('geral')
  const [model, setModel] = useState(MODELO_PADRAO)
  const [appearance, setAppearance] = useState<Appearance>(DEFAULT_APPEARANCE)
  const [account, setAccount] = useState<Account>(INITIAL_ACCOUNT)
  /** `null` = backend fora do ar: as respostas voltam a ser simuladas no navegador. */
  const [backend, setBackend] = useState<Health | null>(null)
  const [remoteUsage, setRemoteUsage] = useState<ApiUsage | null>(null)
  /** Catálogo do provedor (o host local lista os modelos dele em /v1/models). */
  const [remoteModels, setRemoteModels] = useState<RemoteModel[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)
  const timersRef = useRef<number[]>([])
  const runIdRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const conversationIdRef = useRef<string | null>(null)

  const hasMessages = messages.length > 0
  const normalizedQuery = query.trim().toLowerCase()
  const searching = searchOpen && normalizedQuery.length > 0
  const lastMessage = messages.at(-1)
  /** Spinner só enquanto a resposta ainda não começou a chegar. */
  const waiting = busy && !(lastMessage?.role === 'assistant' && lastMessage.text.length > 0)

  const matchingIds = useMemo(() => {
    if (!searching) return new Set<string>()
    return new Set(
      messages
        .filter((message) =>
          [message.text, ...(message.attachments ?? [])]
            .join(' ')
            .toLowerCase()
            .includes(normalizedQuery),
        )
        .map((message) => message.id),
    )
  }, [messages, normalizedQuery, searching])

  const lastText = messages.at(-1)?.text
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, busy, lastText])

  // A aparência vive em atributos do <html>: o CSS troca os tokens e nada disso
  // passa pelo React, então a conversa não re-renderiza ao mudar de tema.
  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = appearance.theme
    root.dataset.accent = appearance.accent
    root.dataset.font = appearance.font
    root.dataset.scale = appearance.scale
    root.dataset.motion = appearance.reducedMotion ? 'reduced' : 'full'
  }, [appearance])

  useEffect(() => {
    const timers = timersRef.current
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer))
    }
  }, [])

  // Ao abrir a tela, pergunta ao backend se ele está de pé. Se estiver, a sessão passa a
  // ser dele: histórico, cotas e conta vêm do SQLite.
  useEffect(() => {
    let cancelled = false

    const connect = async () => {
      try {
        const { info, usage, conversations, account: remoteAccount, models } =
          await loadSession()
        if (cancelled) return
        setBackend(info)
        setRemoteUsage(usage)
        setHistory(conversations.map(fromApiSummary))
        setAccount({ phone: remoteAccount.phone, google: remoteAccount.google })
        setRemoteModels(models)
      } catch {
        if (!cancelled) setBackend(null)
      }
    }

    void connect()
    return () => {
      cancelled = true
    }
  }, [])

  // Contagem local, usada quando não há backend (e como base do modo offline).
  const usageCounts = useMemo(() => {
    const all = [...history.flatMap((conversation) => conversation.messages), ...messages]
    const today = dayKey(new Date())
    const weekFrom = weekStart().getTime()
    const monthFrom = monthStart().getTime()
    return {
      messages: all.length,
      todayMessages: all.filter((message) => dayKey(new Date(message.at)) === today).length,
      weekMessages: all.filter((message) => message.at >= weekFrom).length,
      monthMessages: all.filter((message) => message.at >= monthFrom).length,
      conversations: history.length + (messages.length > 0 ? 1 : 0),
    }
  }, [history, messages])

  const conversationSummaries = useMemo<ConversationSummary[]>(
    () =>
      history.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        preview: conversation.messages.at(-1)
          ? previewFor(conversation.messages)
          : conversation.preview,
      })),
    [history],
  )

  /** Guarda a conversa atual no histórico local (modo offline). */
  const archivedCurrent = (rest: Conversation[]): Conversation[] =>
    messages.length > 0
      ? [
          {
            id: conversationIdRef.current ?? newId(),
            title: titleFor(messages),
            preview: previewFor(messages),
            messages,
          },
          ...rest,
        ]
      : rest

  const resetRun = () => {
    runIdRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    timersRef.current.forEach((timer) => window.clearTimeout(timer))
    timersRef.current = []
  }

  const refreshUsage = async () => {
    try {
      setRemoteUsage(await fetchUsage())
    } catch {
      setBackend(null)
    }
  }

  const refreshHistory = async () => {
    try {
      setHistory((await listConversations()).map(fromApiSummary))
    } catch {
      // mantém o que já está na tela
    }
  }

  const handleToggleSearch = () => {
    const next = !searchOpen
    setSearchOpen(next)
    if (!next) setQuery('')
  }

  const handleNewChat = () => {
    resetRun()
    conversationIdRef.current = null
    if (backend) void refreshHistory()
    else setHistory((current) => archivedCurrent(current))
    setMessages([])
    setBusy(false)
    setInterrupted(false)
    setQuery('')
    setSearchOpen(false)
  }

  const handleOpenConversation = (id: string) => {
    resetRun()
    setBusy(false)
    setInterrupted(false)
    setQuery('')
    setSearchOpen(false)

    if (backend) {
      void (async () => {
        try {
          const conversation = await getConversation(id)
          setMessages(conversation.messages.map(fromApiMessage))
          conversationIdRef.current = conversation.id
        } catch {
          // servidor caiu no meio: mantém a conversa que está na tela
        }
      })()
      return
    }

    const target = history.find((conversation) => conversation.id === id)
    if (!target) return
    setHistory((current) =>
      archivedCurrent(current.filter((conversation) => conversation.id !== id)),
    )
    setMessages(target.messages)
    conversationIdRef.current = target.id
  }

  const handleStop = () => {
    resetRun()
    setBusy(false)
    setInterrupted(true)
  }

  const openSettings = (section: SettingsSection = 'geral') => {
    setSettingsSection(section)
    setView('settings')
  }

  /** Sair da conta limpa o que era daquela conta: conversa, histórico e vínculos. */
  const handleSignOut = () => {
    resetRun()
    conversationIdRef.current = null
    setMessages([])
    setHistory([])
    setBusy(false)
    setInterrupted(false)
    setQuery('')
    setSearchOpen(false)
    setAccount(INITIAL_ACCOUNT)
    setRemoteUsage(null)
    setView('chat')

    if (backend) {
      void (async () => {
        try {
          const signedOut = await signOut()
          setAccount({ phone: signedOut.phone, google: signedOut.google })
          setRemoteUsage(await fetchUsage())
        } catch {
          // offline: o estado local já foi limpo
        }
      })()
    }
  }

  const patchAccountRemote = async (patch: { phone?: string | null; google?: boolean }) => {
    if (!backend) return
    try {
      const updated = await patchAccount(patch)
      setAccount({ phone: updated.phone, google: updated.google })
    } catch {
      // mantém o valor local para a tela não piscar
    }
  }

  const handleSend = async (payload: SendPayload) => {
    setInterrupted(false)
    setMessages((current) => [
      ...current,
      {
        id: newId(),
        role: 'user',
        text: payload.text,
        attachments: payload.attachments,
        at: Date.now(),
      },
    ])
    setBusy(true)
    const startedAt = performance.now()

    // Sem backend: antes de simular, tenta de novo — assim subir a API depois de
    // abrir a tela passa a valer já na próxima mensagem, sem recarregar a página.
    let online = backend !== null
    if (!online) {
      try {
        const { info, usage, conversations, account: remoteAccount, models } =
          await loadSession()
        setBackend(info)
        setRemoteUsage(usage)
        setHistory(conversations.map(fromApiSummary))
        setAccount({ phone: remoteAccount.phone, google: remoteAccount.google })
        setRemoteModels(models)
        online = true
      } catch {
        online = false
      }
    }

    // Sem backend: mantém o comportamento antigo, com resposta simulada.
    if (!online) {
      const currentRun = runIdRef.current
      const timer = window.setTimeout(() => {
        if (currentRun !== runIdRef.current) return
        setMessages((current) => [
          ...current,
          {
            id: newId(),
            role: 'assistant',
            text: buildReply(payload),
            elapsedMs: performance.now() - startedAt,
            at: Date.now(),
          },
        ])
        setBusy(false)
      }, 800)
      timersRef.current.push(timer)
      return
    }

    const assistantId = newId()
    setMessages((current) => [
      ...current,
      { id: assistantId, role: 'assistant', text: '', at: Date.now(), steps: [] },
    ])
    const patchAssistant = (patch: (message: Message) => Message) =>
      setMessages((current) =>
        current.map((message) => (message.id === assistantId ? patch(message) : message)),
      )
    /** Ferramenta anunciada: entra na lista como "rodando" até o resultado voltar. */
    const abrirPasso = (id: string, name: string, argumentos: Record<string, unknown>) =>
      patchAssistant((message) => ({
        ...message,
        steps: [
          ...(message.steps ?? []),
          {
            name,
            arguments: argumentos,
            output: '',
            duration_ms: 0,
            call_id: id,
            ok: true,
          },
        ],
      }))
    const fecharPasso = (patch: {
      id: string
      output: string
      duration_ms: number
      ok: boolean
    }) =>
      patchAssistant((message) => ({
        ...message,
        steps: (message.steps ?? []).map((step) =>
          step.call_id === patch.id
            ? {
                ...step,
                output: patch.output,
                duration_ms: patch.duration_ms,
                ok: patch.ok,
              }
            : step,
        ),
      }))

    const controller = new AbortController()
    abortRef.current = controller

    try {
      await streamChat(
        {
          text: payload.text,
          model: payload.model,
          reasoning: payload.reasoning,
          effort: payload.effort,
          web: payload.web,
          project: projectName(payload.project ?? 'sem-projeto'),
          attachments: payload.attachments,
          conversation_id: conversationIdRef.current,
          tz_offset_minutes: new Date().getTimezoneOffset(),
        },
        {
          signal: controller.signal,
          onStart: (data) => {
            conversationIdRef.current = data.conversation_id
          },
          onDelta: (text) => patchAssistant((message) => ({ ...message, text: message.text + text })),
          onReasoning: (text) =>
            patchAssistant((message) => ({
              ...message,
              reasoning: (message.reasoning ?? '') + text,
            })),
          onToolCall: (data) => abrirPasso(data.id, data.name, data.arguments),
          onToolResult: (data) => fecharPasso(data),
          onDone: (data) => {
            patchAssistant((message) => ({
              ...message,
              elapsedMs: data.elapsed_ms,
              at: Date.now(),
            }))
            setBusy(false)
            void refreshUsage()
            void refreshHistory()
          },
          onError: (message) =>
            patchAssistant((current) => ({
              ...current,
              text: current.text ? `${current.text}\n\n${message}` : message,
            })),
        },
      )
    } catch (error) {
      if (controller.signal.aborted) {
        setInterrupted(true)
      } else {
        // Backend caiu durante a resposta: a próxima já cai na simulação local.
        setBackend(null)
        const detail = error instanceof Error ? error.message : 'falha desconhecida'
        patchAssistant((current) => ({
          ...current,
          text: current.text
            ? `${current.text}\n\n[Conexão com o backend caiu: ${detail}]`
            : `Não consegui falar com o backend (${detail}). Suba a API com \`cd backend && uv run uvicorn app.main:app --port 8787\`.`,
        }))
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setBusy(false)
    }
  }

  return (
    // `--koda-zoom` escala a interface inteira; dividir as medidas da viewport
    // por ele mantém o app exatamente do tamanho da janela em qualquer escala.
    <div className="flex h-[calc(100vh/var(--koda-zoom))] w-[calc(100vw/var(--koda-zoom))] flex-col overflow-hidden bg-koda-bg">
      {/* A tela de configuração ocupa a janela inteira: sem header do chat. */}
      {view === 'chat' ? (
        <Header
          searchOpen={searchOpen}
          searchQuery={query}
          resultLabel={searching ? `${matchingIds.size} de ${messages.length}` : null}
          project={project}
          conversations={conversationSummaries}
          onToggleSearch={handleToggleSearch}
          onSearchQueryChange={setQuery}
          onNewChat={handleNewChat}
          onProjectChange={setProject}
          onOpenConversation={handleOpenConversation}
          onOpenSettings={openSettings}
        />
      ) : null}

      {view === 'settings' ? (
        <SettingsScreen
          onClose={() => setView('chat')}
          usage={{
            messages: remoteUsage?.messages ?? usageCounts.messages,
            todayMessages: remoteUsage?.daily.used ?? usageCounts.todayMessages,
            weekMessages: remoteUsage?.weekly.used ?? usageCounts.weekMessages,
            monthMessages: remoteUsage?.monthly.used ?? usageCounts.monthMessages,
            conversations: remoteUsage?.conversations ?? usageCounts.conversations,
            limits: {
              daily: remoteUsage?.daily.limit ?? PLAN.dailyMessages,
              weekly: remoteUsage?.weekly.limit ?? PLAN.weeklyMessages,
              monthly: remoteUsage?.monthly.limit ?? PLAN.monthlyMessages,
            },
            model: findModel(model, remoteModels).label,
            project: PROJECTS.find((option) => option.value === project)?.label ?? 'Nenhum projeto',
          }}
          backend={{
            url: apiUrl,
            provider: backend?.provider ?? null,
            ready: backend?.provider_ready ?? false,
            model: backend?.model ?? null,
            workspace: backend?.workspace ?? null,
            toolCount: backend?.tools.length ?? 0,
          }}
          project={project}
          onProjectChange={setProject}
          model={model}
          onModelChange={setModel}
          remoteModels={remoteModels}
          showProcessed={showProcessed}
          onToggleProcessed={() => setShowProcessed((value) => !value)}
          appearance={appearance}
          onAppearanceChange={(patch) =>
            setAppearance((current) => ({ ...current, ...patch }))
          }
          account={account}
          onLinkPhone={(value) => {
            setAccount((current) => ({ ...current, phone: value }))
            void patchAccountRemote({ phone: value })
          }}
          onUnlinkPhone={() => {
            setAccount((current) => ({ ...current, phone: null }))
            void patchAccountRemote({ phone: null })
          }}
          onToggleGoogle={(connected) => {
            setAccount((current) => ({ ...current, google: connected }))
            void patchAccountRemote({ google: connected })
          }}
          onSignOut={handleSignOut}
          initialSection={settingsSection}
        />
      ) : (
        <main className="flex min-h-0 flex-1 flex-col">
        <div
          className={[
            'min-h-0 overflow-y-auto transition-all duration-500',
            EASE,
            hasMessages ? 'flex-1 opacity-100' : 'flex-none opacity-0',
          ].join(' ')}
        >
          <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6">
            {messages.map((message) => {
              const dimmed = searching && !matchingIds.has(message.id)
              // No modo agente a resposta nasce vazia (só as ferramentas aparecem
              // primeiro): sem conteúdo ainda, quem representa a espera é a linha
              // "Koda está pensando…" — não uma coroa solta no vazio.
              const semNada =
                message.role === 'assistant' &&
                !message.text &&
                !message.elapsedMs &&
                !message.reasoning &&
                !(message.steps && message.steps.length > 0)
              if (semNada) return null
              return message.role === 'user' ? (
                <div
                  key={message.id}
                  className={[
                    'flex justify-end transition-opacity duration-300 msg-in',
                    dimmed ? 'opacity-20' : 'opacity-100',
                  ].join(' ')}
                >
                  <div className="max-w-[80%] rounded-2xl rounded-tr-md bg-koda-input px-4 py-2.5 text-[15px] leading-6 whitespace-pre-wrap text-koda-fg/90 ring-1 ring-koda-fg/5">
                    {message.text}
                    {message.attachments && message.attachments.length > 0 ? (
                      <ul className="mt-2 flex flex-wrap gap-1.5">
                        {message.attachments.map((name) => (
                          <li
                            key={name}
                            className="rounded-md bg-koda-fg/8 px-2 py-0.5 text-[12px] text-koda-fg/70"
                          >
                            {name}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div
                  key={message.id}
                  className={[
                    'flex flex-col gap-1.5 transition-opacity duration-300 msg-in',
                    dimmed ? 'opacity-20' : 'opacity-100',
                  ].join(' ')}
                >
                  {showProcessed && message.elapsedMs ? (
                    <p className="text-[12px] text-koda-fg/40">
                      Processed{' '}
                      <span className="text-koda-fg/60">
                        {formatDuration(message.elapsedMs)}
                      </span>
                    </p>
                  ) : null}
                  {message.steps && message.steps.length > 0 ? (
                    <ToolSteps steps={message.steps} />
                  ) : null}
                  {message.reasoning ? (
                    // Fechado por padrão, mas com o contador vivo: o número subindo é o
                    // sinal de que o modelo está trabalhando, mesmo antes da 1a palavra.
                    <details className="rounded-xl bg-koda-fg/5 px-3 py-2 ring-1 ring-koda-fg/8">
                      <summary className="cursor-pointer text-[12px] text-koda-fg/45 select-none">
                        Raciocínio
                        <span className="text-koda-fg/30">
                          {' · '}
                          {message.reasoning.length.toLocaleString('pt-BR')} caracteres
                        </span>
                      </summary>
                      <div className="mt-2 max-h-56 overflow-y-auto text-[12.5px] leading-5 whitespace-pre-wrap text-koda-fg/50">
                        {message.reasoning}
                      </div>
                    </details>
                  ) : null}
                  {message.text ? (
                    <div className="flex items-start gap-3">
                      <KodaLogo
                        className="mt-1.5 h-3.5 w-auto shrink-0 text-koda-fg/70"
                        color="currentColor"
                      />
                      <RichText
                        text={message.text}
                        className="max-w-[85%] text-[15px] text-koda-fg/85"
                      />
                    </div>
                  ) : null}
                </div>
              )
            })}

            {interrupted && !busy ? (
              <p className="text-[13px] text-koda-fg/35 msg-in">Geração interrompida</p>
            ) : null}

            {waiting ? (
              <div className="flex items-center gap-3 msg-in">
                <ThinkingMark className="h-3.5 w-auto shrink-0 text-koda-fg/70" />
                <span className="text-[13px] text-koda-fg/45">Koda está pensando…</span>
              </div>
            ) : null}

            <div ref={bottomRef} />
          </div>
        </div>

        <div
          className={[
            'flex flex-col items-center px-6 pb-6 transition-all duration-500',
            EASE,
            hasMessages ? '' : 'flex-1 justify-center',
          ].join(' ')}
        >
          <div
            className={[
              'flex w-full flex-col items-center overflow-hidden transition-all duration-500',
              EASE,
              hasMessages ? 'mb-0 max-h-0 opacity-0' : 'mb-6 max-h-72 opacity-100',
            ].join(' ')}
          >
            <KodaLogo className="mx-auto h-14 w-auto" />
            <h1 className="mt-6 text-center text-2xl leading-tight font-semibold tracking-tight text-koda-fg sm:text-[32px]">
              Oi! No que posso te ajudar hoje?
            </h1>
          </div>

          <div className="w-full max-w-3xl">
            <Composer
              onSend={handleSend}
              onStop={handleStop}
              busy={busy}
              variant={hasMessages ? 'chat' : 'home'}
              project={project}
              onProjectChange={setProject}
              model={model}
              onModelChange={setModel}
              remoteModels={remoteModels}
            />
          </div>
        </div>
        </main>
      )}
    </div>
  )
}

export default App
