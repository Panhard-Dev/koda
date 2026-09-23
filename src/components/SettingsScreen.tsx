import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  ArrowLeft,
  Activity,
  ChevronDown,
  ChevronRight,
  CircleUser,
  Info,
  Moon,
  Palette,
  Sliders,
  Sun,
  SunMoon,
} from 'lucide-react'
import AccountSection from './AccountSection'
import KodaLogo from './KodaLogo'
import Menu from './Menu'
import { findModel, modelMenu, PROJECTS } from '../models'
import type { RemoteModel } from '../models'
import {
  PLAN,
  dailyReset,
  dayKey,
  monthlyReset,
  percentUsed,
  remaining,
  weeklyReset,
} from '../plan'
import { ACCENTS, FONTS, SCALES, THEMES } from '../appearance'
import type { Appearance, ThemeId } from '../appearance'
import type { Account } from '../account'

export type UsageSummary = {
  conversations: number
  messages: number
  /** Mensagens dentro da janela de cada cota. */
  todayMessages: number
  weekMessages: number
  monthMessages: number
  /** Tetos das cotas: vêm do backend quando ele está no ar. */
  limits: { daily: number; weekly: number; monthly: number }
  model: string
  project: string
}

/** Estado do backend Python, mostrado em Sobre. */
export type BackendSummary = {
  url: string
  provider: string | null
  ready: boolean
  model: string | null
  /** Pasta onde as ferramentas do agente trabalham. */
  workspace: string | null
  toolCount: number
}

export type SettingsSection = 'geral' | 'aparencia' | 'conta' | 'uso' | 'sobre'

const SECTIONS: {
  id: SettingsSection
  label: string
  icon: ReactNode
  title: string
  subtitle: string
}[] = [
  {
    id: 'geral',
    label: 'Geral',
    icon: <Sliders className="h-4 w-4" strokeWidth={1.7} />,
    title: 'Configuração',
    subtitle: 'Preferências do Koda.',
  },
  {
    id: 'aparencia',
    label: 'Aparência',
    icon: <Palette className="h-4 w-4" strokeWidth={1.7} />,
    title: 'Aparência',
    subtitle: 'Como o Koda se parece — tema, destaque e tipografia.',
  },
  {
    id: 'conta',
    label: 'Conta',
    icon: <CircleUser className="h-4 w-4" strokeWidth={1.7} />,
    title: 'Conta',
    subtitle: 'Sua conta do Koda e o que está vinculado a ela.',
  },
  {
    id: 'uso',
    label: 'Uso',
    icon: <Activity className="h-4 w-4" strokeWidth={1.7} />,
    title: 'Uso',
    subtitle: 'O que você rodou no Koda, contado na mesma conta.',
  },
  {
    id: 'sobre',
    label: 'Sobre',
    icon: <Info className="h-4 w-4" strokeWidth={1.7} />,
    title: 'Sobre',
    subtitle: 'Informações desta build.',
  },
]

function Card({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    // Sem `overflow-hidden`: ele recortava os menus que abrem dentro do card, e a
    // parte recortada deixa de receber clique — o menu fechava sozinho ao navegar.
    <section className="rounded-2xl bg-koda-panel ring-1 ring-koda-fg/8">
      <header className="px-5 py-4">
        <h2 className="text-[15px] font-semibold text-koda-fg">{title}</h2>
        <p className="mt-1 text-[13px] leading-5 text-koda-fg/45">{description}</p>
      </header>
      {children}
    </section>
  )
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint: string
}) {
  return (
    <div className="border-t border-koda-fg/8 px-5 py-4 md:border-t-0 md:border-l md:first:border-l-0">
      <p className="text-[11px] font-semibold tracking-wider text-koda-fg/40 uppercase">
        {label}
      </p>
      <p className="mt-2 text-[26px] leading-none font-semibold text-koda-fg">{value}</p>
      <p className="mt-2 text-[12px] leading-4 text-koda-fg/45">{hint}</p>
    </div>
  )
}

function Switch({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  onChange: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-4">
      <span className="min-w-0">
        <span className="block text-[13.5px] font-medium text-koda-fg/90">{label}</span>
        <span className="mt-0.5 block text-[12.5px] leading-5 text-koda-fg/45">
          {description}
        </span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={onChange}
        className={[
          'relative h-6 w-11 shrink-0 rounded-full transition-colors duration-150',
          'focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none',
          checked ? 'bg-koda-accent-strong' : 'bg-koda-fg/12',
        ].join(' ')}
      >
        <span
          className={[
            'absolute top-1 h-4 w-4 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.35)] transition-all duration-150',
            checked ? 'left-6' : 'left-1',
          ].join(' ')}
        />
      </button>
    </div>
  )
}

/**
 * Mini interface usada dentro dos cartões de tema. As cores são fixas de propósito:
 * a prévia mostra o tema, ela não muda com o tema.
 */
function ThemeMock({ tone }: { tone: 'light' | 'dark' }) {
  const light = tone === 'light'
  const soft = light ? 'rgba(22,23,28,0.07)' : 'rgba(255,255,255,0.09)'
  const line = light ? 'rgba(22,23,28,0.2)' : 'rgba(255,255,255,0.24)'
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-1.5 px-3"
      style={{ background: light ? '#f6f6f8' : '#131316' }}
    >
      <span
        className="text-[10px] font-semibold"
        style={{ color: light ? '#16171c' : '#ffffff' }}
      >
        Koda
      </span>
      <span className="h-1.5 w-12 rounded-full" style={{ background: soft }} />
      <span
        className="mt-0.5 flex w-full items-center gap-1 rounded-md px-1.5 py-1"
        style={{ background: soft }}
      >
        <span className="h-1 w-1 shrink-0 rounded-full" style={{ background: line }} />
        <span className="h-1 flex-1 rounded-full" style={{ background: line }} />
      </span>
    </div>
  )
}

/** Cartões de tema com prévia — o "Sistema" aparece cortado na diagonal. */
function ThemeCards({
  value,
  onChange,
}: {
  value: ThemeId
  onChange: (value: ThemeId) => void
}) {
  return (
    <div role="radiogroup" aria-label="Tema" className="grid grid-cols-3 gap-3 px-5 py-4">
      {THEMES.map((option) => {
        const active = option.value === value
        const Icon =
          option.value === 'light' ? Sun : option.value === 'system' ? SunMoon : Moon
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={[
              'flex flex-col gap-2 rounded-xl p-2 transition-all duration-150',
              'focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none',
              active
                ? 'bg-koda-accent/10 ring-2 ring-koda-accent'
                : 'ring-1 ring-koda-fg/8 hover:bg-koda-fg/4 hover:ring-koda-fg/16',
            ].join(' ')}
          >
            <span
              aria-hidden
              className="relative block h-[72px] w-full overflow-hidden rounded-lg ring-1 ring-koda-fg/8"
            >
              {option.value === 'system' ? (
                <>
                  <span
                    className="absolute inset-0"
                    style={{ clipPath: 'polygon(0 0, 58% 0, 42% 100%, 0 100%)' }}
                  >
                    <ThemeMock tone="light" />
                  </span>
                  <span
                    className="absolute inset-0"
                    style={{ clipPath: 'polygon(58% 0, 100% 0, 100% 100%, 42% 100%)' }}
                  >
                    <ThemeMock tone="dark" />
                  </span>
                </>
              ) : (
                <ThemeMock tone={option.value === 'light' ? 'light' : 'dark'} />
              )}
            </span>
            <span
              className={[
                'flex items-center justify-center gap-1.5 pb-0.5 text-[12.5px] font-medium',
                active ? 'text-koda-fg' : 'text-koda-fg/70',
              ].join(' ')}
            >
              <Icon className="h-3.5 w-3.5" strokeWidth={1.8} />
              {option.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** Linha de ajuste com o valor atual e um menu à direita (rótulo … valor ⌄). */
function SelectRow<T extends string>({
  label,
  description,
  options,
  value,
  onChange,
  valueFontStack,
}: {
  label: string
  description: string
  options: { value: T; label: string; hint?: string; stack?: string }[]
  value: T
  onChange: (value: T) => void
  /** Escreve o valor com a fonte que ele representa (usado na linha de fonte). */
  valueFontStack?: string
}) {
  const active = options.find((option) => option.value === value)
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3.5">
      <span className="min-w-0">
        <span className="block text-[13.5px] font-medium text-koda-fg/90">{label}</span>
        <span className="mt-0.5 block text-[12.5px] leading-5 text-koda-fg/45">
          {description}
        </span>
      </span>
      <Menu
        options={options}
        value={value}
        // O menu devolve `string`; aqui ele só pode devolver uma das opções dadas.
        onSelect={(next) => onChange(next as T)}
        align="end"
        direction="down"
        label={label}
        panelClassName="min-w-56"
        triggerClassName="flex shrink-0 items-center gap-1.5 rounded-xl bg-koda-fg/6 px-3 py-2 text-[13px] text-koda-fg/85 transition-colors duration-150 hover:bg-koda-fg/10 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
      >
        <span style={valueFontStack ? { fontFamily: valueFontStack } : undefined}>
          {active?.label}
        </span>
        <ChevronDown className="h-3.5 w-3.5 text-koda-fg/45" strokeWidth={1.7} />
      </Menu>
    </div>
  )
}

/** Linha de ajuste com amostras de cor redondas (cor de destaque). */
function Swatches<T extends string>({
  label,
  description,
  options,
  value,
  onChange,
}: {
  label: string
  description: string
  options: { value: T; label: string; swatch?: string }[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <span className="min-w-0">
        <span className="block text-[13.5px] font-medium text-koda-fg/90">{label}</span>
        <span className="mt-0.5 block text-[12.5px] leading-5 text-koda-fg/45">
          {description}
        </span>
      </span>
      <div role="radiogroup" aria-label={label} className="flex shrink-0 items-center gap-2">
        {options.map((option) => {
          const active = option.value === value
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={option.label}
              title={option.label}
              onClick={() => onChange(option.value)}
              style={{
                background: option.swatch,
                boxShadow: active
                  ? `0 0 0 2px var(--koda-panel), 0 0 0 4px ${option.swatch}`
                  : undefined,
              }}
              className={[
                'h-6 w-6 rounded-full transition-transform duration-150 hover:scale-110',
                'focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none',
              ].join(' ')}
            />
          )
        })}
      </div>
    </div>
  )
}

/**
 * Hash com avalanche final. Sem essa etapa, dias vizinhos caem no mesmo nível e o
 * gráfico aparece em blocos por mês em vez de espalhado.
 */
const rand = (value: string) => {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  result ^= result >>> 15
  result = Math.imul(result, 2246822507)
  result ^= result >>> 13
  result = Math.imul(result, 3266489909)
  result ^= result >>> 16
  return (result >>> 0) / 4294967296
}

// Segue a cor de destaque escolhida em Aparência, por opacidade crescente.
const LEVELS = [
  'bg-koda-fg/6',
  'bg-koda-accent/25',
  'bg-koda-accent/45',
  'bg-koda-accent/70',
  'bg-koda-accent',
]

/** Nível 0 = sem uso; -1 = dia que ainda não chegou (fica fora do gráfico). */
const levelFor = (date: Date, todayKey: string, todayMessages: number) => {
  const key = dayKey(date)
  if (key === todayKey) return todayMessages === 0 ? 0 : Math.min(4, todayMessages)
  if (key > todayKey) return -1
  const roll = rand(key)
  if (roll < 0.55) return 0
  if (roll < 0.7) return 1
  if (roll < 0.82) return 2
  if (roll < 0.93) return 3
  return 4
}

const describeDay = (date: Date, level: number) => {
  const label = date.toLocaleDateString('pt-BR')
  if (level === 0) return `${label} · sem uso`
  if (level === 1) return `${label} · 1 mensagem`
  return `${label} · ${level >= 4 ? '4+' : level} mensagens`
}

/**
 * Cartão de cota no estilo do print: rótulo + porcentagem, "Ver detalhes",
 * barra de progresso e o rodapé com a série e a data de reinício.
 */
function UsageLimit({
  title,
  used,
  limit,
  series,
  seriesClass,
  resetsOn,
  detail,
}: {
  title: string
  used: number
  limit: number
  series: string
  seriesClass: string
  resetsOn: string
  detail: string
}) {
  const [open, setOpen] = useState(false)
  const percent = percentUsed(used, limit)

  return (
    <section className="flex flex-col rounded-2xl bg-koda-panel p-4 ring-1 ring-koda-fg/8">
      <div className="flex items-start justify-between gap-3">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[13px] text-koda-fg/70">
          {title}
          <span className="text-[13.5px] font-semibold text-koda-fg">
            {percent.toFixed(2)}%
          </span>
        </p>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="shrink-0 rounded-lg bg-koda-fg/8 px-2.5 py-1 text-[12px] font-medium text-koda-fg/80 transition-colors duration-150 hover:bg-koda-fg/12 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
        >
          Ver detalhes
        </button>
      </div>

      <div
        role="progressbar"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        className="mt-3 h-2 w-full overflow-hidden rounded-full bg-koda-fg/10"
      >
        <div
          className={['bar-grow h-full rounded-full', seriesClass].join(' ')}
          style={{ width: `${percent}%` }}
        />
      </div>

      {open ? (
        <p className="mt-2 text-[12px] leading-4 text-koda-fg/50">{detail}</p>
      ) : null}

      <div className="mt-3 flex items-center justify-between gap-3 text-[12px]">
        <span className="flex min-w-0 items-center gap-1.5 text-koda-fg/70">
          <span className={['h-2.5 w-2.5 shrink-0 rounded-[3px]', seriesClass].join(' ')} />
          <span className="truncate">{series}</span>
        </span>
        <span className="shrink-0 text-koda-fg/45">Reinicia em {resetsOn}</span>
      </div>
    </section>
  )
}

function ActivityHeatmap({ todayMessages }: { todayMessages: number }) {
  const { weeks, monthLabels, todayKey } = useMemo(() => {
    const today = new Date()
    // A última coluna é a semana atual: recua até a segunda-feira dela e volta 52 semanas.
    const start = new Date(today)
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
    start.setDate(start.getDate() - 52 * 7)

    const weeks: Date[][] = []
    for (let week = 0; week < 53; week += 1) {
      const column: Date[] = []
      for (let day = 0; day < 7; day += 1) {
        const date = new Date(start)
        date.setDate(start.getDate() + week * 7 + day)
        column.push(date)
      }
      weeks.push(column)
    }

    const labels = weeks.map((column, index) => {
      const first = column[0]
      const previous = index > 0 ? weeks[index - 1][0] : null
      if (previous && previous.getMonth() === first.getMonth()) return ''
      return first.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '')
    })

    return { weeks, monthLabels: labels, todayKey: dayKey(today) }
  }, [])

  return (
    <div className="px-5 pb-5">
      <div className="overflow-x-auto">
        <div
          role="img"
          aria-label={`Mapa de atividade de ${weeks.length} semanas`}
          className="inline-flex flex-col gap-1.5"
        >
          <div className="flex gap-[3px] pl-9">
            {monthLabels.map((label, index) => (
              <span
                key={`${label}-${index}`}
                className="w-[11px] text-[10px] whitespace-nowrap text-koda-fg/35"
              >
                {label}
              </span>
            ))}
          </div>

          <div className="flex gap-[3px]">
            <div className="flex w-9 flex-col gap-[3px] pr-1.5 text-right text-[10px] text-koda-fg/35">
              {['Seg', '', 'Qua', '', 'Sex', '', ''].map((label, index) => (
                <span key={index} className="h-[11px] leading-[11px]">
                  {label}
                </span>
              ))}
            </div>

            {weeks.map((column, weekIndex) => (
              <div
                key={weekIndex}
                className="heat-col flex flex-col gap-[3px]"
                // Onda da esquerda para a direita, uma coluna por vez.
                style={{ animationDelay: `${weekIndex * 8}ms` }}
              >
                {column.map((date) => {
                  const level = levelFor(date, todayKey, todayMessages)
                  const upcoming = level < 0
                  return (
                    <span
                      key={dayKey(date)}
                      title={upcoming ? undefined : describeDay(date, level)}
                      className={[
                        'h-[11px] w-[11px] rounded-[3px]',
                        upcoming ? 'bg-transparent' : LEVELS[level],
                      ].join(' ')}
                    />
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-4 text-[11.5px] text-koda-fg/45">
        <span className="flex items-center gap-1.5">
          <span className="h-[11px] w-[11px] rounded-[3px] bg-koda-accent/70" />
          Uso
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-[11px] w-[11px] rounded-[3px] bg-koda-fg/6" />
          Sem uso
        </span>
      </div>
    </div>
  )
}

export function SettingsScreen({
  onClose,
  usage,
  project,
  onProjectChange,
  model,
  onModelChange,
  showProcessed,
  onToggleProcessed,
  appearance,
  onAppearanceChange,
  account,
  onLinkPhone,
  onUnlinkPhone,
  onToggleGoogle,
  onSignOut,
  initialSection,
  backend,
  remoteModels = [],
}: {
  onClose: () => void
  usage: UsageSummary
  backend: BackendSummary
  project: string
  onProjectChange: (value: string) => void
  model: string
  onModelChange: (value: string) => void
  showProcessed: boolean
  onToggleProcessed: () => void
  appearance: Appearance
  onAppearanceChange: (patch: Partial<Appearance>) => void
  account: Account
  onLinkPhone: (value: string) => void
  onUnlinkPhone: () => void
  onToggleGoogle: (connected: boolean) => void
  onSignOut: () => void
  /** Seção aberta ao entrar na tela (ex.: Conta, vindo do menu do header). */
  initialSection?: SettingsSection
  /** Modelos que vieram do backend, além dos da casa. */
  remoteModels?: RemoteModel[]
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection ?? 'geral')
  const current = SECTIONS.find((item) => item.id === section) ?? SECTIONS[0]
  const activeModel = findModel(model, remoteModels)
  const activeProject =
    PROJECTS.find((option) => option.value === project)?.label ?? 'Nenhum projeto'

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-60 shrink-0 flex-col border-r border-koda-fg/8 p-3">
        <div className="mb-3 flex items-center gap-2 px-2.5 py-1.5">
          <KodaLogo className="h-4 w-auto" />
          <span className="text-[13.5px] font-semibold text-koda-fg">Koda</span>
          <span className="ml-auto text-[10.5px] font-semibold tracking-wider text-koda-fg/35 uppercase">
            Ajustes
          </span>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="mb-2 flex items-center gap-2 rounded-xl px-2.5 py-2 text-[13px] text-koda-fg/60 transition-colors duration-150 hover:bg-koda-fg/6 hover:text-koda-fg focus-visible:outline-none"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.8} />
          Voltar para o chat
        </button>

        <nav className="flex flex-col gap-0.5">
          {SECTIONS.map((item) => {
            const active = item.id === section
            return (
              <button
                key={item.id}
                type="button"
                aria-current={active}
                onClick={() => setSection(item.id)}
                className={[
                  'flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-[13.5px] font-medium',
                  'transition-colors duration-150 focus-visible:outline-none',
                  active
                    ? 'bg-koda-accent/12 text-koda-fg'
                    : 'text-koda-fg/55 hover:bg-koda-fg/5 hover:text-koda-fg/90',
                ].join(' ')}
              >
                <span className={active ? 'text-koda-accent' : 'text-koda-fg/45'}>
                  {item.icon}
                </span>
                {item.label}
              </button>
            )
          })}
        </nav>

        <button
          type="button"
          aria-current={section === 'conta'}
          onClick={() => setSection('conta')}
          className={[
            'mt-auto flex w-full flex-col items-start rounded-xl p-3 text-left',
            'transition-colors duration-150 focus-visible:outline-none',
            section === 'conta' ? 'bg-koda-accent/12' : 'bg-koda-fg/4 hover:bg-koda-fg/8',
          ].join(' ')}
        >
          <span className="flex w-full items-center gap-2 text-[13px] font-medium text-koda-fg/90">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-koda-accent to-koda-accent-strong text-[11px] font-semibold text-white">
              KA
            </span>
            Conta Koda
            <ChevronRight className="ml-auto h-3.5 w-3.5 text-koda-fg/40" strokeWidth={1.8} />
          </span>
          <span className="mt-1.5 text-[11.5px] text-koda-fg/40">Plano Free</span>
        </button>
      </aside>      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-7">
        <div
          // `key` remonta a coluna a cada troca de seção, e o `stagger` reaproveita
          // isso para a entrada em cascata acontecer de novo.
          key={section}
          className={[
            'stagger mx-auto flex flex-col gap-6',
              // O mapa do ano pede mais largura; a conta fica numa coluna estreita.
              section === 'uso' ? 'max-w-5xl' : section === 'conta' ? 'max-w-2xl' : 'max-w-3xl',
            ].join(' ')}
          >
          <div>
            <h1 className="text-[22px] font-semibold text-koda-fg">{current.title}</h1>
            <p className="mt-1 text-[13px] text-koda-fg/45">{current.subtitle}</p>
          </div>

          {section === 'geral' ? (
            <Card
              title="Preferências"
              description="Padrões usados no prompt box e nas respostas."
            >
              <div className="divide-y divide-koda-fg/8 border-t border-koda-fg/8">
                <Switch
                  label="Mostrar tempo de processamento"
                  description="Exibe a linha “Processed” acima de cada resposta."
                  checked={showProcessed}
                  onChange={onToggleProcessed}
                />

                <div className="flex items-center justify-between gap-4 px-5 py-4">
                  <span>
                    <span className="block text-[13.5px] font-medium text-koda-fg/90">
                      Modelo padrão
                    </span>
                    <span className="mt-0.5 block text-[12.5px] text-koda-fg/45">
                      Usado nas próximas mensagens.
                    </span>
                  </span>
                  <Menu
                    options={modelMenu(remoteModels)}
                    value={model}
                    onSelect={onModelChange}
                    align="end"
                    direction="down"
                    label="Escolher modelo padrão"
                    triggerClassName="flex items-center gap-2 rounded-xl bg-koda-fg/6 px-3 py-2 text-[13px] text-koda-fg/80 transition-colors duration-150 hover:bg-koda-fg/10 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
                  >
                    <span className="text-koda-fg/60">{activeModel.icon}</span>
                    {activeModel.label}
                  </Menu>
                </div>

                <div className="flex items-center justify-between gap-4 px-5 py-4">
                  <span>
                    <span className="block text-[13.5px] font-medium text-koda-fg/90">
                      Projeto padrão
                    </span>
                    <span className="mt-0.5 block text-[12.5px] text-koda-fg/45">
                      Contexto de código enviado junto das mensagens.
                    </span>
                  </span>
                  <Menu
                    options={PROJECTS}
                    value={project}
                    onSelect={onProjectChange}
                    align="end"
                    direction="down"
                    label="Escolher projeto padrão"
                    panelClassName="w-72"
                    triggerClassName="flex items-center gap-2 rounded-xl bg-koda-fg/6 px-3 py-2 text-[13px] text-koda-fg/80 transition-colors duration-150 hover:bg-koda-fg/10 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
                  >
                    {activeProject}
                  </Menu>
                </div>
              </div>
            </Card>
          ) : null}

          {section === 'aparencia' ? (
            <>
              <Card
                title="Tema"
                description="Vale para a tela inteira, inclusive durante a conversa."
              >
                <div className="divide-y divide-koda-fg/8 border-t border-koda-fg/8">
                  <ThemeCards
                    value={appearance.theme}
                    onChange={(theme) => onAppearanceChange({ theme })}
                  />
                  <Swatches
                    label="Cor de destaque"
                    description="Botões, seleção, foco e o mapa de atividade."
                    options={ACCENTS}
                    value={appearance.accent}
                    onChange={(accent) => onAppearanceChange({ accent })}
                  />
                </div>
              </Card>

              <Card
                title="Tipografia"
                description="Fonte e tamanho usados em todo o app."
              >
                <div className="divide-y divide-koda-fg/8 border-t border-koda-fg/8">
                  <SelectRow
                    label="Fonte"
                    description={
                      FONTS.find((option) => option.value === appearance.font)?.hint ?? ''
                    }
                    options={FONTS}
                    value={appearance.font}
                    valueFontStack={
                      FONTS.find((option) => option.value === appearance.font)?.stack
                    }
                    onChange={(font) => onAppearanceChange({ font })}
                  />
                  <SelectRow
                    label="Tamanho"
                    description={
                      SCALES.find((option) => option.value === appearance.scale)?.hint ?? ''
                    }
                    options={SCALES}
                    value={appearance.scale}
                    onChange={(scale) => onAppearanceChange({ scale })}
                  />
                  <div className="px-5 py-4">
                    <p className="text-[11px] font-semibold tracking-wider text-koda-fg/40 uppercase">
                      Prévia
                    </p>
                    <p className="mt-2 text-[15px] leading-6 text-koda-fg/85">
                      Oi! No que posso te ajudar hoje?
                    </p>
                  </div>
                  <Switch
                    label="Reduzir animações"
                    description="Desliga transições e as animações de entrada das mensagens."
                    checked={appearance.reducedMotion}
                    onChange={() =>
                      onAppearanceChange({ reducedMotion: !appearance.reducedMotion })
                    }
                  />
                </div>
              </Card>
            </>
          ) : null}

          {section === 'conta' ? (
            <AccountSection
              account={account}
              onLinkPhone={onLinkPhone}
              onUnlinkPhone={onUnlinkPhone}
              onToggleGoogle={onToggleGoogle}
              onSignOut={onSignOut}
            />
          ) : null}

          {section === 'uso' ? (
            <>
              <Card
                title="Seu uso"
                description="Tudo que você rodou no Koda, contado na mesma conta."
              >
                <div className="grid border-t border-koda-fg/8 md:grid-cols-4">
                  <Stat
                    label="Mensagens"
                    value={String(usage.messages)}
                    hint="Total enviado e recebido no Koda."
                  />
                  <Stat
                    label="Conversas"
                    value={String(usage.conversations)}
                    hint="Chats abertos, incluindo o atual."
                  />
                  <Stat
                    label="Modelo ativo"
                    value={usage.model}
                    hint="Usado nas próximas respostas."
                  />
                  <Stat
                    label="Projeto"
                    value={usage.project}
                    hint="Contexto selecionado agora."
                  />
                </div>
              </Card>

              <Card
                title="Atividade"
                description="Últimos 365 dias, no fuso local. Hoje usa a atividade real desta sessão; o histórico é ilustrativo."
              >
                <ActivityHeatmap todayMessages={usage.todayMessages} />
              </Card>

              <div className="flex flex-col gap-3">
                <p className="px-1 text-[12.5px] text-koda-fg/45">Progresso de uso</p>
                <div className="grid gap-3 md:grid-cols-3">
                  <UsageLimit
                    title="Uso diário"
                    used={usage.todayMessages}
                    limit={usage.limits.daily}
                    series={`Koda ${PLAN.name} · hoje`}
                    seriesClass="bg-koda-accent"
                    resetsOn={dailyReset()}
                    detail={`${usage.todayMessages} de ${usage.limits.daily} mensagens hoje · restam ${remaining(usage.todayMessages, usage.limits.daily)}.`}
                  />
                  <UsageLimit
                    title="Uso semanal"
                    used={usage.weekMessages}
                    limit={usage.limits.weekly}
                    series={`Koda ${PLAN.name} · semana`}
                    seriesClass="bg-koda-accent/70"
                    resetsOn={weeklyReset()}
                    detail={`${usage.weekMessages} de ${usage.limits.weekly} mensagens nesta semana · restam ${remaining(usage.weekMessages, usage.limits.weekly)}.`}
                  />
                  <UsageLimit
                    title="Uso mensal"
                    used={usage.monthMessages}
                    limit={usage.limits.monthly}
                    series={`Koda ${PLAN.name} · mês`}
                    seriesClass="bg-koda-accent/45"
                    resetsOn={monthlyReset()}
                    detail={`${usage.monthMessages} de ${usage.limits.monthly} mensagens neste mês · restam ${remaining(usage.monthMessages, usage.limits.monthly)}.`}
                  />
                </div>
              </div>
            </>
          ) : null}

          {section === 'sobre' ? (
            <Card title="Sobre" description="Informações desta build.">
              <dl className="border-t border-koda-fg/8 text-[13px]">
                {[
                  ['Aplicação', 'Koda — shell de interface de chat'],
                  ['Stack', 'React 19 · Vite · Tailwind 4 · lucide-react'],
                  ['Backend', backend.url],
                  [
                    'Status',
                    backend.provider
                      ? `Online · provider ${backend.provider}${backend.ready ? '' : ' (sem API key: responde offline)'}`
                      : 'Fora do ar — as respostas são simuladas no navegador',
                  ],
                  [
                    'Dados',
                    backend.provider
                      ? 'SQLite no servidor (conversas, mensagens, conta)'
                      : 'Apenas em memória nesta sessão',
                  ],
                  [
                    'Ferramentas',
                    backend.toolCount > 0
                      ? `${backend.toolCount} disponíveis — o modelo usa quando precisa`
                      : 'Indisponíveis neste provedor',
                  ],
                  [
                    'Pasta de trabalho',
                    backend.workspace ?? '— (as ferramentas rodam nesta pasta)',
                  ],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="flex flex-col gap-1 border-b border-koda-fg/8 px-5 py-3.5 last:border-b-0 sm:flex-row sm:items-center sm:gap-4"
                  >
                    <dt className="w-32 shrink-0 text-koda-fg/45">{label}</dt>
                    <dd className="text-koda-fg/85">{value}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export default SettingsScreen
