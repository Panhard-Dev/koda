import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import {
  ArrowUp,
  BrainCircuit,
  ChevronDown,
  CircleDot,
  FolderKanban,
  FolderOpen,
  FolderPlus,
  Gauge,
  Globe,
  Hand,
  Image as ImageIcon,
  Mic,
  Paperclip,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Square,
  X,
} from 'lucide-react'
import Menu from './Menu'
import type { MenuOption } from './Menu'
import ApprovalCard from './ApprovalCard'
import ContextRing from './ContextRing'
import { EFFORT_MENU, EFFORT_PADRAO, effortDoModelo, effortLabel } from '../effort'
import type { Effort } from '../effort'
import { findModel, modelMenu, MODELO_PADRAO } from '../models'
import type { RemoteModel } from '../models'
import { MODOS_PERMISSAO, modoDe } from '../permissao'

/**
 * Ícone de cada modo — fica aqui porque ícone é JSX, e o módulo de modos é TS puro.
 *
 * O automático usa **escudo com exclamação**, não raio: ele é o modo em que o agente não
 * pergunta nada, e o ícone tem de dizer isso — raio dizia "rápido", que não é o risco.
 */
export const ICONE_DO_MODO: Record<ModoPermissao, ReactNode> = {
  manual: <Hand className="h-3.5 w-3.5 text-emerald-400" strokeWidth={1.7} />,
  default: <ShieldCheck className="h-3.5 w-3.5 text-amber-300" strokeWidth={1.7} />,
  auto: <ShieldAlert className="h-3.5 w-3.5 text-red-400" strokeWidth={1.7} />,
}

/**
 * A cor de cada modo no gatilho: verde, amarelo, vermelho.
 *
 * É a única diferença entre os três — o contorno saiu. Quem olha de longe precisa ver a
 * cor, não decifrar um anel em volta do botão.
 */
const COR_DO_MODO: Record<ModoPermissao, string> = {
  manual: 'text-emerald-400',
  default: 'text-amber-300',
  auto: 'text-red-400',
}
import type {
  ApiProject,
  DecisaoPermissao,
  ModoPermissao,
  PedidoPermissao,
} from '../api/client'

export type SendPayload = {
  text: string
  attachments: string[]
  model: string
  reasoning: boolean
  web: boolean
  /** Esforço de raciocínio do modelo escolhido (`auto` deixa o Reasoning decidir). */
  effort: Effort
  /** Pasta de trabalho (caminho completo) escolhida no seletor de projeto. */
  project_path: string | null
}


const PLUS_ACTIONS = [
  {
    value: 'image',
    label: 'Enviar imagem',
    hint: 'PNG, JPG ou captura de tela',
    icon: <ImageIcon className="h-4 w-4" strokeWidth={1.7} />,
  },
  {
    value: 'file',
    label: 'Anexar arquivo',
    hint: 'Código, PDF, planilha ou texto',
    icon: <Paperclip className="h-4 w-4" strokeWidth={1.7} />,
  },
]

/** Menu de comandos do "/": visual, igual ao print de referência — sem execução. */
const COMANDOS = [
  { nome: '/goal', descricao: 'Show or set the current session goal.' },
  { nome: '/workflow', descricao: 'Design and launch a dynamic workflow for a task.' },
  {
    nome: '/compact',
    descricao: 'Compact the current conversation with optional instructions.',
  },
  { nome: '/init', descricao: 'Create or update workspace AGENTS.md instructions.' },
  { nome: '/plan', descricao: 'Switch to Plan mode and optionally send a task.' },
]

type SpeechResult = {
  isFinal: boolean
  0: { transcript: string }
}

type SpeechEvent = {
  resultIndex: number
  results: { length: number } & Record<number, SpeechResult>
}

type Recognition = {
  lang: string
  interimResults: boolean
  continuous: boolean
  start: () => void
  stop: () => void
  onresult: ((event: SpeechEvent) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
}

const getRecognition = (): Recognition | null => {
  if (typeof window === 'undefined') return null
  const globalWindow = window as unknown as {
    SpeechRecognition?: new () => Recognition
    webkitSpeechRecognition?: new () => Recognition
  }
  const Ctor = globalWindow.SpeechRecognition ?? globalWindow.webkitSpeechRecognition
  return Ctor ? new Ctor() : null
}

type TogglePillProps = {
  label: string
  active: boolean
  onClick: () => void
  children: ReactNode
}

const PILL_BASE =
  'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium ring-1 transition-colors duration-150 focus-visible:ring-koda-accent focus-visible:outline-none'

function TogglePill({ label, active, onClick, children }: TogglePillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={active ? `${label} ativado` : `${label} desativado`}
      className={[
        PILL_BASE,
        active
          ? 'bg-koda-accent/12 text-koda-accent ring-koda-accent/35'
          : 'text-koda-fg/55 ring-transparent hover:bg-koda-fg/8 hover:text-koda-fg',
      ].join(' ')}
    >
      {children}
      {label}
    </button>
  )
}

/**
 * `home` reproduz a caixa da tela inicial (com a faixa de projeto embaixo).
 * `chat` é a caixa única usada depois que a conversa começa.
 */
export function Composer({
  onSend,
  onStop,
  busy = false,
  variant = 'home',
  projects = [],
  projectId = null,
  pastaPadrao = '',
  onProjectChange,
  onOpenFolders,
  permissionMode = 'default',
  onPermissionModeChange,
  pedido = null,
  respondendoPermissao = false,
  erroPermissao = null,
  onDecidirPermissao,
  model = MODELO_PADRAO,
  onModelChange,
  remoteModels = [],
  contextoPorModelo = {},
  contextoJanela = null,
}: {
  onSend?: (payload: SendPayload) => void
  onStop?: () => void
  busy?: boolean
  variant?: 'home' | 'chat'
  /** Pastas registradas nesta máquina (o projeto é sempre uma pasta de verdade). */
  projects?: ApiProject[]
  /** Id da pasta aberta agora; `null` = conversa solta. */
  projectId?: string | null
  /** Pasta usada quando não há projeto aberto (a Área de Trabalho desta máquina). */
  pastaPadrao?: string
  onProjectChange?: (id: string | null) => void
  /** Abre o escolhedor de pasta (existente ou nova). */
  onOpenFolders?: () => void
  permissionMode?: ModoPermissao
  onPermissionModeChange?: (modo: ModoPermissao) => void
  /** Pedido de permissão esperando resposta (o agente está parado nele). */
  pedido?: PedidoPermissao | null
  respondendoPermissao?: boolean
  erroPermissao?: string | null
  onDecidirPermissao?: (decisao: DecisaoPermissao) => void
  model?: string
  onModelChange?: (value: string) => void
  /** Modelos que vieram do backend, além dos da casa. */
  remoteModels?: RemoteModel[]
  /**
   * Contexto já usado, por modelo, em tokens de entrada (o `prompt_tokens` do último
   * passo da última resposta daquele modelo). Vazio = nada medido ainda.
   */
  contextoPorModelo?: Record<string, number>
  /** Teto de contexto (a janela) que o backend aplica — o denominador do anel. */
  contextoJanela?: number | null
}) {
  const [message, setMessage] = useState('')
  const [reasoning, setReasoning] = useState(true)
  const [web, setWeb] = useState(false)
  const [efforts, setEfforts] = useState<Record<string, Effort>>({})
  const [attachments, setAttachments] = useState<string[]>([])
  const [listening, setListening] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const recognitionRef = useRef<Recognition | null>(null)

  const isChat = variant === 'chat'
  /** Digitar "/" abre o menu de comandos acima da caixa (só visual). */
  const mostrarComandos = message.startsWith('/')
  const micAvailable =
    typeof window !== 'undefined' &&
    Boolean(
      (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition ??
        (window as unknown as { webkitSpeechRecognition?: unknown })
          .webkitSpeechRecognition,
    )

  useEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 192)}px`
  }, [message])

  const canSend = !busy && (message.trim().length > 0 || attachments.length > 0)
  const activeModel = findModel(model, remoteModels)
  const effort = effortDoModelo(efforts, model)
  const ativo = projects.find((item) => item.id === projectId) ?? null
  const projetoLabel = ativo ? ativo.nome : 'Selecionar projeto'
  const modo = modoDe(permissionMode)

  /**
   * Cada modelo do seletor ganha o medidor de contexto à direita.
   *
   * O anel é montado aqui e não em `models.tsx` porque ícone/anel é JSX — lá o módulo é
   * dado puro. A recursão cobre as categorias (Liz, Koda, Layze), que são submenus.
   */
  const comMedidor = (opcoes: MenuOption[]): MenuOption[] =>
    opcoes.map((opcao) =>
      opcao.options
        ? { ...opcao, options: comMedidor(opcao.options) }
        : {
            ...opcao,
            trailing: (
              <ContextRing
                usado={contextoPorModelo[opcao.value] ?? 0}
                janela={contextoJanela}
                trabalhando={busy && opcao.value === model}
                className="text-koda-fg/60"
              />
            ),
          },
    )

  /** O seletor lista as pastas salvas e as duas formas de escolher uma nova. */
  const projectOptions: MenuOption[] = [
    {
      value: 'sem-projeto',
      label: 'Nenhum projeto',
      hint: pastaPadrao
        ? `Conversa solta, trabalhando em ${pastaPadrao}`
        : 'Conversa solta, sem contexto de código',
    },
    ...projects.map((item) => ({
      value: item.id,
      label: item.nome,
      hint: item.existe ? item.caminho : `${item.caminho} · pasta não encontrada`,
    })),
    {
      value: 'abrir-pasta',
      label: 'Usar pasta existente',
      hint: 'Escolher uma pasta que já está no disco',
      icon: <FolderOpen className="h-4 w-4" strokeWidth={1.7} />,
    },
    {
      value: 'nova-pasta',
      label: 'Começar do zero',
      hint: 'Criar uma pasta nova e trabalhar nela',
      icon: <FolderPlus className="h-4 w-4" strokeWidth={1.7} />,
    },
  ]

  const handleProjectSelect = (value: string) => {
    if (value === 'abrir-pasta' || value === 'nova-pasta') {
      onOpenFolders?.()
      return
    }
    onProjectChange?.(value === 'sem-projeto' ? null : value)
  }

  const send = () => {
    if (!canSend) return
    onSend?.({
      text: message.trim(),
      attachments,
      model,
      reasoning,
      web,
      effort,
      project_path: ativo?.caminho ?? null,
    })
    setMessage('')
    setAttachments([])
    textareaRef.current?.focus()
  }

  const toggleMic = () => {
    if (listening) {
      recognitionRef.current?.stop()
      setListening(false)
      return
    }

    const recognition = getRecognition()
    if (!recognition) return

    recognition.lang = 'pt-BR'
    recognition.interimResults = false
    recognition.continuous = false
    recognition.onresult = (event) => {
      let transcript = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        if (result?.isFinal) transcript += result[0].transcript
      }
      const text = transcript.trim()
      if (text) {
        setMessage((current) => (current ? `${current.trim()} ${text}` : text))
      }
    }
    recognition.onend = () => setListening(false)
    recognition.onerror = () => setListening(false)
    recognitionRef.current = recognition
    recognition.start()
    setListening(true)
  }

  const addFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const names = Array.from(event.target.files ?? []).map((file) => file.name)
    if (names.length > 0) {
      setAttachments((current) => Array.from(new Set([...current, ...names])))
    }
    event.target.value = ''
  }

  const projectTriggerClass = [
    'flex w-full items-center gap-2 rounded-lg py-1 text-[13px]',
    projectId === null ? 'text-koda-fg/45 hover:text-koda-fg/75' : 'text-koda-accent',
    'transition-colors duration-150 focus-visible:outline-none',
  ].join(' ')

  return (
    <div className="w-full max-w-3xl">
      {/* O agente está parado esperando permissão: o cartão fica logo acima da caixa. */}
      {pedido ? (
        <ApprovalCard
          pedido={pedido}
          respondendo={respondendoPermissao}
          erro={erroPermissao}
          onDecidir={(decisao) => onDecidirPermissao?.(decisao)}
        />
      ) : null}

      <div
        className={[
          'w-full shadow-[0_30px_60px_-30px_var(--koda-shadow)] ring-1',
          isChat ? 'rounded-3xl bg-koda-input p-4 ring-koda-fg/8' : 'rounded-3xl ring-koda-fg/5',
        ].join(' ')}
      >
      <div className={isChat ? '' : 'rounded-t-3xl bg-koda-input p-4 pb-3'}>
        {attachments.length > 0 ? (
          <ul className="mb-2 flex flex-wrap gap-1.5 px-1">
            {attachments.map((name) => (
              <li
                key={name}
                className="flex items-center gap-1.5 rounded-lg bg-koda-fg/6 py-1 pr-1.5 pl-2.5 text-[12px] text-koda-fg/75"
              >
                <Paperclip className="h-3.5 w-3.5 text-koda-fg/45" strokeWidth={1.8} />
                <span className="max-w-44 truncate">{name}</span>
                <button
                  type="button"
                  aria-label={`Remover ${name}`}
                  onClick={() =>
                    setAttachments((current) => current.filter((item) => item !== name))
                  }
                  className="flex h-4 w-4 items-center justify-center rounded text-koda-fg/45 transition-colors hover:bg-koda-fg/10 hover:text-koda-fg"
                >
                  <X className="h-3 w-3" strokeWidth={2.2} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {mostrarComandos ? (
          <div className="mb-1">
            <p className="px-1 pb-1.5 text-[11px] font-semibold tracking-wider text-koda-fg/40 uppercase">
              Commands
            </p>
            <div className="max-h-60 overflow-y-auto">
              {COMANDOS.map((comando, index) => (
                <div
                  key={comando.nome}
                  className={[
                    'flex items-baseline gap-2 px-1 py-2 text-[13.5px]',
                    index === 0 ? 'bg-koda-fg/6' : '',
                  ].join(' ')}
                >
                  <span className="shrink-0 font-semibold text-koda-fg">{comando.nome}</span>
                  <span className="min-w-0 truncate text-koda-fg/45">{comando.descricao}</span>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 border-t border-koda-fg/8 pt-2.5 pb-1 text-[12.5px] text-koda-fg/45">
              <CircleDot className="h-3.5 w-3.5 shrink-0" strokeWidth={1.7} />
              Type to search commands, skills, or agents
            </div>
          </div>
        ) : null}

        <label htmlFor="koda-input" className="sr-only">
          Message Koda
        </label>
        <textarea
          ref={textareaRef}
          id="koda-input"
          rows={2}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              send()
            }
          }}
          placeholder="Message Koda"
          className={[
            'min-h-[72px] w-full resize-none overflow-y-auto bg-transparent px-1',
            'text-[15px] leading-6 text-koda-fg placeholder:text-koda-fg/40 focus:outline-none',
          ].join(' ')}
        />

        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={addFiles}
        />
        <input ref={fileInputRef} type="file" multiple hidden onChange={addFiles} />

        <div
          className={[
            'flex items-center justify-between gap-3',
            isChat ? 'mt-2 flex-wrap gap-2' : 'mt-1 px-1',
          ].join(' ')}
        >
          <div className="flex flex-wrap items-center gap-1">
            <Menu
              options={PLUS_ACTIONS}
              onSelect={(value) => {
                if (value === 'image') imageInputRef.current?.click()
                else fileInputRef.current?.click()
              }}
              align="start"
              direction="up"
              label="Adicionar"
              triggerClassName="flex h-8 w-8 items-center justify-center rounded-lg text-koda-fg/55 transition-colors duration-150 hover:bg-koda-fg/8 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
            >
              <Plus className="h-[18px] w-[18px]" strokeWidth={1.7} />
            </Menu>

            <TogglePill
              label="Reasoning"
              active={reasoning}
              onClick={() => setReasoning((value) => !value)}
            >
              <BrainCircuit className="h-4 w-4" strokeWidth={1.7} />
            </TogglePill>
            <TogglePill label="Web" active={web} onClick={() => setWeb((value) => !value)}>
              <Globe className="h-4 w-4" strokeWidth={1.7} />
            </TogglePill>

            {/* Quanto o agente pode fazer sozinho. A cor é a mensagem: verde = pergunta
                tudo, amarelo = o comum sozinho, vermelho = não pergunta nada. Sem
                contorno e sem ícone — quem olha de longe precisa ver a cor. */}
            <Menu
              options={MODOS_PERMISSAO.map((item) => ({
                value: item.id,
                label: item.label,
                hint: item.hint,
                icon: ICONE_DO_MODO[item.id],
              }))}
              value={permissionMode}
              onSelect={(value) => onPermissionModeChange?.(value as ModoPermissao)}
              align="start"
              direction="up"
              label={`Permissão: ${modo.label}`}
              panelClassName="w-72"
              triggerClassName={[
                'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium',
                'transition-colors duration-150 hover:bg-koda-fg/8',
                'focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none',
                COR_DO_MODO[modo.id],
              ].join(' ')}
            >
              {modo.curto}
              <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.7} />
            </Menu>

          </div>

          <div className="flex items-center gap-1">
            <Menu
              options={comMedidor(modelMenu(remoteModels))}
              value={model}
              onSelect={(value) => onModelChange?.(value)}
              align="end"
              direction="up"
              label="Escolher modelo"
              triggerClassName="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] text-koda-fg/50 transition-colors duration-150 hover:bg-koda-fg/8 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
            >
              <span className="text-koda-fg/60">{activeModel.icon}</span>
              <span className="hidden sm:inline">{activeModel.label}</span>
              {/* O contexto do modelo escolhido, ao lado do nome dele. */}
              <ContextRing
                usado={contextoPorModelo[model] ?? 0}
                janela={contextoJanela}
                trabalhando={busy}
                className="text-koda-fg/70"
              />
              <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.7} />
            </Menu>

            {/* Esforço do modelo escolhido: cada um guarda o seu. */}
            <Menu
              options={EFFORT_MENU}
              value={effort}
              onSelect={(value) =>
                setEfforts((current) => ({ ...current, [model]: value as Effort }))
              }
              align="end"
              direction="up"
              label={`Esforço de raciocínio (${effortLabel(effort).toLowerCase()})`}
              panelClassName="w-64"
              triggerClassName={[
                'flex items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] transition-colors duration-150',
                'hover:bg-koda-fg/8 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none',
                effort === EFFORT_PADRAO ? 'text-koda-fg/40' : 'text-koda-accent',
              ].join(' ')}
            >
              <Gauge
                className={effort === EFFORT_PADRAO ? 'h-3.5 w-3.5' : 'h-3.5 w-3.5 text-koda-accent'}
                strokeWidth={1.7}
              />
              {/* O rótulo fica visível sempre que o esforço não é o padrão: no celular,
                  o ícone sozinho não conta que o nível foi trocado. */}
              <span className={effort === EFFORT_PADRAO ? 'hidden sm:inline' : ''}>
                {effortLabel(effort)}
              </span>
              <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.7} />
            </Menu>

            {isChat ? (
              <button
                type="button"
                aria-label={listening ? 'Parar de ouvir' : 'Falar em vez de digitar'}
                title={
                  micAvailable
                    ? listening
                      ? 'Parar de ouvir'
                      : 'Falar em vez de digitar'
                    : 'Entrada de voz indisponível neste navegador'
                }
                disabled={!micAvailable}
                aria-pressed={listening}
                onClick={toggleMic}
                className={[
                  'flex h-8 w-8 items-center justify-center rounded-lg transition-colors duration-150',
                  'focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none',
                  !micAvailable
                    ? 'cursor-not-allowed text-koda-fg/25'
                    : listening
                      ? 'bg-koda-accent/15 text-koda-accent'
                      : 'text-koda-fg/55 hover:bg-koda-fg/8 hover:text-koda-fg',
                ].join(' ')}
              >
                <Mic className="h-[17px] w-[17px]" strokeWidth={1.7} />
              </button>
            ) : (
              <button
                type="button"
                aria-label="Anexar arquivo"
                title="Anexar arquivo"
                onClick={() => fileInputRef.current?.click()}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-koda-fg/55 transition-colors duration-150 hover:bg-koda-fg/8 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
              >
                <Paperclip className="h-[17px] w-[17px]" strokeWidth={1.7} />
              </button>
            )}

            {isChat && busy ? (
              <button
                type="button"
                aria-label="Parar geração"
                title="Parar geração"
                onClick={() => onStop?.()}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-koda-fg/15 text-koda-fg transition-colors duration-150 hover:bg-koda-fg/25 focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
              >
                <Square className="h-3 w-3 fill-current" strokeWidth={0} />
              </button>
            ) : (
              <button
                type="button"
                aria-label="Enviar mensagem"
                title="Enviar mensagem"
                disabled={!canSend}
                onClick={send}
                className={[
                  'flex h-8 w-8 items-center justify-center rounded-full transition-all duration-150',
                  canSend
                    ? 'bg-koda-accent-strong text-white hover:bg-koda-accent-strong/85 active:scale-95'
                    : 'cursor-not-allowed bg-koda-fg/8 text-koda-fg/40',
                ].join(' ')}
              >
                <ArrowUp className="h-[17px] w-[17px]" strokeWidth={2} />
              </button>
            )}
          </div>
        </div>
      </div>

      {isChat ? null : (
        <div className="rounded-b-3xl bg-koda-panel px-4 py-2.5">
          <Menu
            options={projectOptions}
            value={projectId ?? 'sem-projeto'}
            onSelect={handleProjectSelect}
            align="start"
            direction="up"
            label="Selecionar projeto"
            className="w-full"
            panelClassName="w-80"
            triggerClassName={projectTriggerClass}
          >
            <FolderKanban className="h-4 w-4" strokeWidth={1.6} />
            {projetoLabel}
            <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.6} />
          </Menu>
        </div>
      )}
      </div>
    </div>
  )
}

export default Composer
