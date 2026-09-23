import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import {
  ArrowUp,
  BrainCircuit,
  ChevronDown,
  FolderKanban,
  Gauge,
  Globe,
  Image as ImageIcon,
  Mic,
  Paperclip,
  Plus,
  Square,
  X,
} from 'lucide-react'
import Menu from './Menu'
import { EFFORT_MENU, EFFORT_PADRAO, effortDoModelo, effortLabel } from '../effort'
import type { Effort } from '../effort'
import { findModel, modelMenu, MODELO_PADRAO, PROJECTS, projectName } from '../models'
import type { RemoteModel } from '../models'

export type SendPayload = {
  text: string
  attachments: string[]
  model: string
  reasoning: boolean
  web: boolean
  /** Esforço de raciocínio do modelo escolhido (`auto` deixa o Reasoning decidir). */
  effort: Effort
  project: string | null
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
  project = 'sem-projeto',
  onProjectChange,
  model = MODELO_PADRAO,
  onModelChange,
  remoteModels = [],
}: {
  onSend?: (payload: SendPayload) => void
  onStop?: () => void
  busy?: boolean
  variant?: 'home' | 'chat'
  project?: string
  onProjectChange?: (value: string) => void
  model?: string
  onModelChange?: (value: string) => void
  /** Modelos que vieram do backend, além dos da casa. */
  remoteModels?: RemoteModel[]
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
  const activeProject = PROJECTS.find((item) => item.value === project)
  const projectLabel =
    project === 'sem-projeto' ? 'Selecionar projeto' : activeProject?.label

  const send = () => {
    if (!canSend) return
    onSend?.({
      text: message.trim(),
      attachments,
      model,
      reasoning,
      web,
      effort,
      project: projectName(project),
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
    project === 'sem-projeto' ? 'text-koda-fg/45 hover:text-koda-fg/75' : 'text-koda-accent',
    'transition-colors duration-150 focus-visible:outline-none',
  ].join(' ')
  const handleProjectSelect = (value: string) => onProjectChange?.(value)

  return (
    <div
      className={[
        'w-full max-w-3xl shadow-[0_30px_60px_-30px_var(--koda-shadow)] ring-1',
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

          </div>

          <div className="flex items-center gap-1">
            <Menu
              options={modelMenu(remoteModels)}
              value={model}
              onSelect={(value) => onModelChange?.(value)}
              align="end"
              direction="up"
              label="Escolher modelo"
              triggerClassName="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] text-koda-fg/50 transition-colors duration-150 hover:bg-koda-fg/8 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
            >
              <span className="text-koda-fg/60">{activeModel.icon}</span>
              <span className="hidden sm:inline">{activeModel.label}</span>
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
            options={PROJECTS}
            value={project}
            onSelect={handleProjectSelect}
            align="start"
            direction="up"
            label="Selecionar projeto"
            className="w-full"
            panelClassName="w-72"
            triggerClassName={projectTriggerClass}
          >
            <FolderKanban className="h-4 w-4" strokeWidth={1.6} />
            {projectLabel}
            <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.6} />
          </Menu>
        </div>
      )}
    </div>
  )
}

export default Composer
