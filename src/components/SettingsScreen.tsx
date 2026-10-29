import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  ArrowLeft,
  Activity,
  Bot,
  Cable,
  Check,
  ChevronDown,
  ChevronRight,
  CircleUser,
  CloudDownload,
  Cpu,
  Info,
  Loader2,
  Moon,
  Palette,
  Plug,
  PlugZap,
  Plus,
  Puzzle,
  RefreshCw,
  Sliders,
  Sun,
  SunMoon,
  X,
} from 'lucide-react'
import AccountSection from './AccountSection'
import DiagnosticoLocal from './DiagnosticoLocal'
import type { Conta as ContaKoda, PlanoDaConta } from '../api/cloud'
import type { ApiAgente, ApiProject, NovoAgente } from '../api/client'
import { LOGO_DO_PROVEDOR } from '../logos-provedores'
import provedores9router from '../../backend/app/provedores_9router.json'
import KodaLogo from './KodaLogo'
import Menu from './Menu'
import { WindowControls } from './WindowControls'
import { apelidoDaConta, iniciaisDaConta } from '../account'
import { findModel, modelMenu } from '../models'
import type { RemoteModel } from '../models'
import { dailyReset, dayKey, monthlyReset, weeklyReset } from '../plan'
import { tempoCurto } from '../tempo'
import { moedasLegiveis } from '../custo'
import { ACCENTS, FONTS, SCALES, THEMES } from '../appearance'
import type { Appearance, ThemeId } from '../appearance'
import {
  baixarAtualizacao,
  cloudChangelog,
  cloudUpdate,
  cancelarLoginDoProvedor,
  concluirLoginComCodigo,
  entrarNoProvedor,
  testarContaDoProvedor,
  testarModeloDoProvedor,
  estadoDoLoginDoProvedor,
  fraseDeFalha,
  modelosDoProvedor,
  provedoresDeLogin,
  sairDoProvedor,
  statusDoDownload,
  testarProvedor,
} from '../api/client'
import type {
  ApiCloud,
  ApiProvedor,
  ApiCloudRelease,
  ApiCloudUpdate,
  ApiDownload,
  ApiMcp,
  ApiSkill,
  CloudCanal,
  NovoMcp,
  NovoSkill,
} from '../api/client'

export type UsageSummary = {
  conversations: number
  messages: number
  /**
   * O que cada janela gastou — **tempo** e **créditos**, sem teto.
   *
   * Antes eram contagens de mensagens contra um limite do plano. O limite saiu: um teto que não
   * é o que se cobra é um número que confunde mais do que informa.
   */
  daily: ResumoDaJanela
  weekly: ResumoDaJanela
  monthly: ResumoDaJanela
  /** Mensagens por dia (`AAAA-MM-DD` local): o mapa do ano é isto, não estimativa. */
  dias: Record<string, number>
  model: string
  project: string
}

/** Uma janela de uso já com as moedas contadas. */
export type ResumoDaJanela = { tempoMs: number; creditos: number }

/** Estado do backend Python, mostrado em Sobre. */
export type BackendSummary = {
  url: string
  provider: string | null
  ready: boolean
  model: string | null
  /** Versão que o backend reporta no health — é a versão local para a nuvem. */
  version: string | null
  /** Pasta onde as ferramentas do agente trabalham. */
  workspace: string | null
  toolCount: number
  /** Teto de contexto em tokens; 0 quando a compactação está desligada. */
  contextoTokens: number
}

export type SettingsSection =
  | 'geral'
  | 'aparencia'
  | 'conta'
  | 'uso'
  | 'modelos'
  | 'skills'
  | 'agents'
  | 'mcps'
  | 'nuvem'
  | 'sobre'

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
    id: 'modelos',
    label: 'Modelos e Provedores',
    icon: <Cpu className="h-4 w-4" strokeWidth={1.7} />,
    title: 'Modelos e Provedores',
    // Área criada e **vazia** de propósito: o dono pediu o lugar, não o conteúdo.
    subtitle: '',
  },
  {
    id: 'skills',
    label: 'Skills',
    icon: <Puzzle className="h-4 w-4" strokeWidth={1.7} />,
    title: 'Skills',
    subtitle: 'Capacidades extras que o agente carrega quando a tarefa pede.',
  },
  {
    id: 'agents',
    label: 'Agentes',
    icon: <Bot className="h-4 w-4" strokeWidth={1.7} />,
    title: 'Agentes',
    subtitle: 'Sub-agentes que o agente principal lança — cada um com o prompt e as ferramentas dele.',
  },
  {
    id: 'mcps',
    label: 'MCPs',
    icon: <Cable className="h-4 w-4" strokeWidth={1.7} />,
    title: 'MCPs',
    subtitle: 'Servidores externos conectados pelo Model Context Protocol.',
  },
  {
    id: 'nuvem',
    label: 'Nuvem',
    icon: <CloudDownload className="h-4 w-4" strokeWidth={1.7} />,
    title: 'Nuvem',
    subtitle: 'Atualizações e notas de versão vindas do serviço do Koda.',
  },
  {
    id: 'sobre',
    label: 'Sobre',
    icon: <Info className="h-4 w-4" strokeWidth={1.7} />,
    title: 'Sobre',
    subtitle: 'Informações desta build.',
  },
]

/** O mesmo manifesto do backend, gerado do registry e dos fluxos do 9router. */
const PROVEDORES: {
  id: string
  nome: string
  sigla: string
  cli: string
  logo?: string
}[] = provedores9router.provedores.map((item) => ({
  id: item.id,
  nome: item.nome,
  sigla: item.sigla,
  cli: item.cli,
  logo: LOGO_DO_PROVEDOR[item.id] ?? LOGO_DO_PROVEDOR[item.fonteId],
}))

function Card({
  title,
  description,
  action,
  children,
}: {
  title: string
  description: string
  /** Botão (ou o que for) alinhado à direita do título — o "Adicionar" das listas. */
  action?: ReactNode
  children: ReactNode
}) {
  return (
    // Sem `overflow-hidden`: ele recortava os menus que abrem dentro do card, e a
    // parte recortada deixa de receber clique — o menu fechava sozinho ao navegar.
    <section className="rounded-2xl bg-koda-panel ring-1 ring-koda-fg/8">
      <header className="flex items-start gap-4 px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold text-koda-fg">{title}</h2>
          <p className="mt-1 text-[13px] leading-5 text-koda-fg/45">{description}</p>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </header>
      {children}
    </section>
  )
}

/** Botão de cadastro que abre a listinha — mesmo desenho nas duas seções. */
function BotaoAdicionar({
  aberto,
  rotulo,
  onClick,
}: {
  aberto: boolean
  rotulo: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={aberto}
      className="flex items-center gap-1.5 rounded-xl bg-koda-accent/12 px-3 py-1.5 text-[12.5px] font-medium text-koda-accent transition-colors duration-150 hover:bg-koda-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-koda-accent"
    >
      {aberto ? <X className="h-3.5 w-3.5" strokeWidth={2} /> : <Plus className="h-3.5 w-3.5" strokeWidth={2} />}
      {aberto ? 'Cancelar' : rotulo}
    </button>
  )
}

/** Um campo do formulário de cadastro: rótulo em cima, entrada embaixo. */
function Campo({
  label,
  valor,
  onChange,
  placeholder,
  obrigatorio = false,
  multiline = false,
  invalido = false,
}: {
  label: string
  valor: string
  onChange: (valor: string) => void
  placeholder: string
  obrigatorio?: boolean
  multiline?: boolean
  invalido?: boolean
}) {
  const base = [
    'min-w-0 rounded-xl bg-koda-input px-3 text-[13px] text-koda-fg ring-1 outline-none',
    'placeholder:text-koda-fg/30 focus:ring-2',
    invalido
      ? 'ring-red-400/60 focus:ring-red-400'
      : 'ring-koda-fg/10 focus:ring-koda-accent',
  ].join(' ')
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold tracking-wider text-koda-fg/45 uppercase">
        {label}
        {obrigatorio ? <span className="text-koda-accent"> *</span> : null}
      </span>
      {multiline ? (
        <textarea
          value={valor}
          onChange={(evento) => onChange(evento.target.value)}
          placeholder={placeholder}
          rows={3}
          className={`${base} resize-y py-2 leading-5`}
        />
      ) : (
        <input
          value={valor}
          onChange={(evento) => onChange(evento.target.value)}
          placeholder={placeholder}
          className={`${base} h-9`}
        />
      )}
    </label>
  )
}

/**
 * Uma lista de nomes que se marca com o clique — as skills e os MCPs de um sub-agente.
 *
 * É escolha, e não digitação: o nome tem de bater com o que existe no backend, e escrever à
 * mão só criaria um agente que não alcança nada. O que **não** está marcado fica fora — o
 * poder do agente é o que está aceso aqui.
 */
function Escolha({
  titulo,
  ajuda,
  opcoes,
  escolhidos,
  onAlternar,
  vazio,
}: {
  titulo: string
  ajuda: string
  opcoes: string[]
  escolhidos: string[]
  onAlternar: (nome: string) => void
  vazio: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold tracking-wider text-koda-fg/45 uppercase">
        {titulo}
      </span>
      {opcoes.length === 0 ? (
        <p className="text-[12.5px] text-koda-fg/40">{vazio}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {opcoes.map((nome) => {
            const ativo = escolhidos.includes(nome)
            return (
              <button
                key={nome}
                type="button"
                aria-pressed={ativo}
                onClick={() => onAlternar(nome)}
                className={[
                  'flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] ring-1 transition-colors duration-150',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-koda-accent',
                  ativo
                    ? 'bg-koda-accent/15 text-koda-accent ring-koda-accent/30'
                    : 'text-koda-fg/60 ring-koda-fg/12 hover:bg-koda-fg/6 hover:text-koda-fg',
                ].join(' ')}
              >
                {ativo ? <Check className="h-3 w-3" strokeWidth={2.6} /> : null}
                {nome}
              </button>
            )
          })}
        </div>
      )}
      <p className="text-[11.5px] leading-4 text-koda-fg/35">{ajuda}</p>
    </div>
  )
}

/** Selo verde/vermelho de estado, igual ao do submenu do header. */
function StatusBadge({ on, ligado, desligado }: { on: boolean; ligado: string; desligado: string }) {
  return (
    <span
      className={[
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5',
        'text-[10.5px] font-semibold tracking-wider uppercase',
        on ? 'bg-emerald-400/10 text-emerald-400' : 'bg-red-400/10 text-red-400',
      ].join(' ')}
    >
      <span className={['h-1.5 w-1.5 rounded-full', on ? 'bg-emerald-400' : 'bg-red-400'].join(' ')} />
      {on ? ligado : desligado}
    </span>
  )
}

/** Etiqueta neutra, para o que não é estado (ex.: “obrigatória”). */
function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-full bg-koda-fg/6 px-2 py-0.5 text-[10.5px] font-semibold tracking-wider text-koda-fg/55 uppercase">
      {children}
    </span>
  )
}

/**
 * O teto de contexto em texto curto.
 *
 * Antes era sempre `tokens / 1000` + « mil », e em 1.000.000 isso virava «1.000 mil
 * tokens» — que não é número que alguém leia. Acima de um milhão, fala em milhão.
 */
function contextoEmTexto(tokens: number): string {
  if (tokens >= 1_000_000) {
    const milhoes = tokens / 1_000_000
    const numero = milhoes.toLocaleString('pt-BR', { maximumFractionDigits: 1 })
    return `${numero} ${milhoes === 1 ? 'milhão' : 'milhões'} de tokens`
  }
  return `${(tokens / 1000).toLocaleString('pt-BR')} mil tokens`
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

const CANAIS: { value: CloudCanal; label: string; hint: string }[] = [
  { value: 'stable', label: 'Estável', hint: 'Só versões prontas para todo mundo.' },
  { value: 'beta', label: 'Beta', hint: 'Antecipadas, podem quebrar.' },
]

const dataCurta = (iso: string | null) => {
  if (!iso) return null
  const data = new Date(iso)
  if (Number.isNaN(data.getTime())) return null
  return data.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })
}

const horaCurta = (ms: number) =>
  new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

/** Tamanho de arquivo curto, para a barra do download do instalador. */
const tamanhoCurto = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const unidades = ['B', 'KB', 'MB', 'GB']
  let valor = bytes
  let indice = 0
  while (valor >= 1024 && indice < unidades.length - 1) {
    valor /= 1024
    indice += 1
  }
  return `${valor.toFixed(indice === 0 || valor >= 100 ? 0 : 1)} ${unidades[indice]}`
}

/** Linha rótulo/valor do cartão de atualizações. */
function CloudRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3.5">
      <span className="min-w-0 text-[13.5px] font-medium text-koda-fg/90">{label}</span>
      <span className="flex min-w-0 shrink-0 items-center gap-2 text-[13px] text-koda-fg/70">
        {children}
      </span>
    </div>
  )
}

/**
 * Atualizações da nuvem, dentro de Geral: de onde vem o aviso, qual é a versão
 * publicada e o que mudou. Quem fala com a nuvem é o backend local; se ele não
 * responde, o cartão diz isso e o resto dos Ajustes segue igual.
 */
function Atualizacoes({ cloud, version }: { cloud: ApiCloud | null; version: string | null }) {
  const ativo = cloud?.ativo ?? false
  // Sem `cloud` não é a nuvem que falhou: é o backend local, que nunca chegou a responder.
  const semBackend = cloud === null
  const [canal, setCanal] = useState<CloudCanal>(cloud?.canal === 'beta' ? 'beta' : 'stable')
  const [detalhe, setDetalhe] = useState<ApiCloudUpdate | null>(null)
  const [releases, setReleases] = useState<ApiCloudRelease[]>([])
  // Já entra em “consultando”: a primeira coisa que o cartão faz é chamar a nuvem.
  const [carregando, setCarregando] = useState(ativo)
  const [falhou, setFalhou] = useState(false)
  const [verificadoEm, setVerificadoEm] = useState<number | null>(null)
  /** Download do instalador em curso: quem baixa é o backend local, nunca o navegador. */
  const [download, setDownload] = useState<ApiDownload | null>(null)

  const verificar = useCallback(
    async (refresh = false) => {
      if (!ativo) return
      setCarregando(true)
      try {
        const [estado, notas] = await Promise.all([
          cloudUpdate({ versao: version ?? undefined, canal, refresh }),
          cloudChangelog(canal),
        ])
        setDetalhe(estado)
        setReleases(notas)
        setFalhou(false)
        setVerificadoEm(Date.now())
      } catch {
        // Backend local fora do ar no meio do caminho: o cartão avisa, não quebra.
        setFalhou(true)
      } finally {
        setCarregando(false)
      }
    },
    [ativo, canal, version],
  )

  useEffect(() => {
    // Consulta na abertura e a cada troca de canal. Sai num `setTimeout` para a
    // montagem do cartão não encadear renders por causa do estado de carregamento.
    const timer = window.setTimeout(() => void verificar(), 0)
    return () => window.clearTimeout(timer)
  }, [verificar])

  // Enquanto o backend baixa o instalador, pergunta de tempos em tempos: é o que faz a
  // barra andar e o "salvo" aparecer sem o usuário mexer em nada.
  useEffect(() => {
    if (download?.estado !== 'baixando') return
    const timer = window.setInterval(() => {
      void statusDoDownload()
        .then(setDownload)
        .catch(() =>
          setDownload((atual) =>
            atual?.estado === 'baixando'
              ? { ...atual, estado: 'erro', erro: 'o backend local parou no meio do download' }
              : atual,
          ),
        )
    }, 400)
    return () => window.clearInterval(timer)
  }, [download?.estado])

  const disponivel = detalhe?.disponivel ?? cloud?.disponivel ?? false
  const atualizacao = detalhe?.atualizacao ?? null
  const novidade = atualizacao?.update_available ?? cloud?.update_available ?? false
  const publicada = atualizacao?.latest_version ?? cloud?.latest_version ?? null
  const baixar = atualizacao?.download_url ?? cloud?.download_url ?? null

  const baixando = download?.estado === 'baixando'
  const concluido = download?.estado === 'concluido'
  const total = download?.total ?? null
  const percentual =
    total && total > 0 && download
      ? Math.min(100, Math.round((download.recebido / total) * 100))
      : 8

  /**
   * Baixar é do backend local: ele pega o link publicado e grava o arquivo na pasta de
   * downloads da máquina, com progresso aqui. Nada de `<a target="_blank">` — dentro do
   * Tauri isso não abre nada (o clique parecia morto) e no navegador jogava o usuário
   * para fora do app.
   */
  const baixarInstalador = () => {
    baixarAtualizacao()
      .then(setDownload)
      .catch(() =>
        setDownload({
          estado: 'erro',
          recebido: 0,
          total: null,
          arquivo: null,
          pasta: null,
          caminho: null,
          versao: null,
          erro: 'não consegui falar com o backend local',
        }),
      )
  }

  return (
    <Card
      title="Atualizações"
      description="O Koda pergunta a um serviço na nuvem se há versão mais nova. Nada é baixado sem você pedir."
    >
      <div className="divide-y divide-koda-fg/8 border-t border-koda-fg/8">
        <CloudRow label="Estado">
          <StatusBadge on={disponivel} ligado="Conectada" desligado="Sem resposta" />
        </CloudRow>

        {cloud?.servico ? (
          <CloudRow label="Serviço">
            <span className="truncate font-mono text-[12px] text-koda-fg/60">
              {cloud.servico}
            </span>
          </CloudRow>
        ) : null}

        <CloudRow label="Sua versão">
          <span className="font-mono text-[12.5px] text-koda-fg/85">
            {version ? `v${version}` : '—'}
          </span>
        </CloudRow>

        <CloudRow label="Canal">
          <Menu
            options={CANAIS}
            value={canal}
            onSelect={(next) => setCanal(next as CloudCanal)}
            align="end"
            direction="down"
            label="Escolher canal de atualização"
            triggerClassName="flex items-center gap-1.5 rounded-xl bg-koda-fg/6 px-3 py-2 text-[13px] text-koda-fg/85 transition-colors duration-150 hover:bg-koda-fg/10 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
          >
            {CANAIS.find((opcao) => opcao.value === canal)?.label ?? canal}
          </Menu>
        </CloudRow>

        <CloudRow label="Publicada">
          {publicada ? (
            <>
              <span className="truncate font-mono text-[12.5px] text-koda-fg/85">
                v{publicada}
              </span>
              {atualizacao?.mandatory || atualizacao?.update_required ? (
                <Tag>Obrigatória</Tag>
              ) : null}
            </>
          ) : (
            <span className="text-koda-fg/50">nenhuma versão publicada</span>
          )}
        </CloudRow>

        <div className="flex items-center justify-between gap-4 px-5 py-4">
          <p className="min-w-0 text-[12.5px] leading-5 text-koda-fg/45">
            {carregando
              ? 'Consultando a nuvem…'
              : semBackend
                ? 'O backend local não respondeu — é ele quem consulta a nuvem.'
                : falhou
                  ? 'O backend local não respondeu a esta consulta.'
                  : verificadoEm
                    ? disponivel
                      ? `Verificado às ${horaCurta(verificadoEm)} · o resultado fica em cache por 15 minutos.`
                      : 'A nuvem não respondeu nesta consulta — a próxima abertura tenta de novo.'
                    : 'Ainda não consultado.'}
          </p>
          <button
            type="button"
            disabled={carregando || !ativo}
            onClick={() => void verificar(true)}
            className={[
              'flex shrink-0 items-center gap-1.5 rounded-xl bg-koda-fg/6 px-3 py-2',
              'text-[13px] text-koda-fg/85 transition-colors duration-150',
              'hover:bg-koda-fg/10 hover:text-koda-fg disabled:opacity-50',
              'focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none',
            ].join(' ')}
          >
            {carregando ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.8} />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.8} />
            )}
            Verificar de novo
          </button>
        </div>
      </div>

      {novidade ? (
        <div className="border-t border-koda-fg/8 bg-koda-accent/8 px-5 py-4">
          <div className="flex items-center gap-4">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-koda-accent/15 text-koda-accent">
              <CloudDownload className="h-4 w-4" strokeWidth={1.8} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-semibold text-koda-fg">
                {publicada ? `Koda ${publicada} está disponível` : 'Atualização disponível'}
              </span>
              <span className="mt-0.5 block text-[12.5px] leading-5 text-koda-fg/55">
                {atualizacao?.notes?.trim() ||
                  'Há uma versão mais nova publicada no canal escolhido.'}
              </span>
            </span>
            {baixar && !baixando && !concluido ? (
              <button
                type="button"
                onClick={baixarInstalador}
                className="shrink-0 rounded-xl bg-koda-accent-strong px-3 py-2 text-[13px] font-medium text-white transition-colors hover:bg-koda-accent-strong/85 focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
              >
                Baixar
              </button>
            ) : null}
          </div>

          {baixando ? (
            <div className="mt-3.5 flex flex-col gap-2">
              <div className="flex items-center gap-2 text-[12.5px] text-koda-fg/75">
                <Loader2
                  className="h-3.5 w-3.5 shrink-0 animate-spin text-koda-accent"
                  strokeWidth={2}
                />
                Baixando o instalador…
                <span className="ml-auto shrink-0 font-mono text-[11.5px] text-koda-fg/50">
                  {total ? `${percentual}% · ${tamanhoCurto(total)}` : tamanhoCurto(download?.recebido ?? 0)}
                </span>
              </div>
              <span className="h-1.5 w-full overflow-hidden rounded-full bg-koda-fg/10">
                <span
                  className={[
                    'block h-full rounded-full bg-koda-accent-strong transition-[width] duration-300 ease-out',
                    total ? '' : 'animate-pulse',
                  ].join(' ')}
                  style={{ width: `${percentual}%` }}
                />
              </span>
              <p className="text-[11.5px] leading-4 text-koda-fg/40">
                Direto para a pasta de downloads da máquina — sem sair do Koda.
              </p>
            </div>
          ) : concluido ? (
            <div className="mt-3.5 rounded-xl bg-koda-accent/10 px-3 py-2.5 ring-1 ring-koda-accent/25">
              <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-koda-fg">
                <Check className="h-3.5 w-3.5 shrink-0 text-koda-accent" strokeWidth={2.4} />
                Instalador salvo
              </p>
              <p
                className="mt-1 truncate font-mono text-[11px] text-koda-fg/55"
                title={download?.caminho ?? ''}
              >
                {download?.caminho ?? download?.arquivo ?? 'koda-setup.exe'}
              </p>
            </div>
          ) : download?.estado === 'erro' ? (
            <p className="mt-2 text-[12px] leading-4 text-red-400">{download.erro}</p>
          ) : null}
        </div>
      ) : null}

      {releases.length > 0 ? (
        <div className="border-t border-koda-fg/8">
          <p className="px-5 pt-4 text-[11px] font-semibold tracking-wider text-koda-fg/40 uppercase">
            Notas de versão
          </p>
          <ul className="mt-1 divide-y divide-koda-fg/8">
            {releases.map((release) => (
              <li key={`${release.versao}-${release.publicado_em ?? ''}`} className="px-5 py-3.5">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="font-mono text-[13px] font-medium text-koda-fg/90">
                    v{release.versao}
                  </span>
                  {release.obrigatoria ? <Tag>Obrigatória</Tag> : null}
                  <span className="ml-auto shrink-0 text-[12px] text-koda-fg/45">
                    {dataCurta(release.publicado_em) ?? 'sem data'}
                  </span>
                </div>
                {release.notas?.trim() ? (
                  <p className="mt-1.5 text-[12.5px] leading-5 whitespace-pre-wrap text-koda-fg/60">
                    {release.notas}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
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

// Segue a cor de destaque escolhida em Aparência, por opacidade crescente.
const LEVELS = [
  'bg-koda-fg/6',
  'bg-koda-accent/25',
  'bg-koda-accent/45',
  'bg-koda-accent/70',
  'bg-koda-accent',
]

/**
 * Nível do quadrado: 0 = sem uso, 4 = dia cheio; -1 = dia que ainda não chegou (some do
 * gráfico). As faixas são grosseiras de propósito — o mapa serve para ver **onde** houve
 * trabalho, e o número exato está no title de cada quadrado.
 */
const levelFor = (mensagens: number, futuro: boolean) => {
  if (futuro) return -1
  if (mensagens <= 0) return 0
  if (mensagens <= 2) return 1
  if (mensagens <= 5) return 2
  if (mensagens <= 10) return 3
  return 4
}

const describeDay = (date: Date, mensagens: number) => {
  const label = date.toLocaleDateString('pt-BR')
  if (mensagens === 0) return `${label} · sem uso`
  if (mensagens === 1) return `${label} · 1 mensagem`
  return `${label} · ${mensagens} mensagens`
}

/**
 * Um cartão de uso: o **tempo** e os **créditos** gastos naquela janela.
 *
 * Sem barra e sem porcentagem. As duas existiam para comparar com um teto de mensagens, e o teto
 * saiu quando o plano passou a ser medido em horas e moedas — uma barra enchendo contra um limite
 * que não é o que se cobra é um número que confunde mais do que informa.
 *
 * O que fica é o que a pessoa abre esta tela para ver: quanto gastou, e quando a janela vira.
 */
function UsageWindowCard({
  title,
  janela,
  resetsOn,
}: {
  title: string
  janela: ResumoDaJanela
  resetsOn: string
}) {
  return (
    <section className="flex flex-col rounded-2xl bg-koda-panel p-4 ring-1 ring-koda-fg/8">
      <p className="text-[13px] text-koda-fg/70">{title}</p>

      <div className="mt-3 flex items-baseline gap-5">
        <span className="flex items-baseline gap-1.5">
          <span className="text-[20px] font-semibold tabular-nums text-koda-fg">
            {tempoCurto(Math.round(janela.tempoMs / 1000))}
          </span>
          <span className="text-[11.5px] text-koda-fg/45">de uso</span>
        </span>
        <span className="flex items-baseline gap-1.5">
          <span className="text-[20px] font-semibold tabular-nums text-koda-fg">
            {moedasLegiveis(janela.creditos)}
          </span>
          <span className="text-[11.5px] text-koda-fg/45">
            {janela.creditos === 1 ? 'crédito' : 'créditos'}
          </span>
        </span>
      </div>

      <p className="mt-3 text-[12px] text-koda-fg/45">Reinicia em {resetsOn}</p>
    </section>
  )
}

function ActivityHeatmap({ dias }: { dias: Record<string, number> }) {
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
                  const key = dayKey(date)
                  const mensagens = dias[key] ?? 0
                  const level = levelFor(mensagens, key > todayKey)
                  const upcoming = level < 0
                  return (
                    <span
                      key={key}
                      title={upcoming ? undefined : describeDay(date, mensagens)}
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
  projects,
  projectId,
  onOpenFolders,
  onProjectChange,
  model,
  onModelChange,
  mostrarRodape,
  onToggleRodape,
  mostrarTraces,
  onToggleTraces,
  appearance,
  onAppearanceChange,
  onSignOut,
  contaKoda = null,
  planoDaConta = null,
  onAssinaturaMudou,
  initialSection,
  backend,
  cloud = null,
  remoteModels = null,
  modelosBloqueados = [],
  skills = [],
  mcps = [],
  onAddSkill,
  onAddMcp,
  agents = [],
  onSaveAgent,
  onDeleteAgent,
}: {
  onClose: () => void
  usage: UsageSummary
  backend: BackendSummary
  /** Resumo da nuvem que vem no `/api/health`; `null` quando o backend não respondeu. */
  cloud?: ApiCloud | null
  /** Pastas salvas nesta máquina; o projeto é sempre uma pasta de verdade. */
  projects: ApiProject[]
  projectId: string | null
  onProjectChange?: (id: string | null) => void
  /** Abre o escolhedor de pasta (existente ou nova). */
  onOpenFolders?: () => void
  model: string
  onModelChange: (value: string) => void
  /** Números da rodada (uso, tempo, hora) na ficha no fim de cada resposta. */
  mostrarRodape: boolean
  onToggleRodape: () => void
  /** Raciocínio do modelo e passos das ferramentas abertos na conversa. */
  mostrarTraces: boolean
  onToggleTraces: () => void
  appearance: Appearance
  onAppearanceChange: (patch: Partial<Appearance>) => void
  /** Conta do painel (quem entrou na tela de login). `null` só em tese: o app não abre sem ela. */
  contaKoda?: ContaKoda | null
  /** O plano em vigor, como o painel o conta. `null` é o Free. */
  planoDaConta?: PlanoDaConta | null
  /** Avisa que a assinatura mudou (assinou ou cancelou), para o plano ser recolhido de novo. */
  onAssinaturaMudou?: () => void
  onSignOut: () => void
  /** Seção aberta ao entrar na tela (ex.: Conta, vindo do menu do header). */
  initialSection?: SettingsSection
  /** Modelos que vieram do backend, além dos da casa. */
  remoteModels?: RemoteModel[] | null
  /**
   * Modelos que o painel tirou desta conta (desativados, ou desligados por exceção).
   * Saem do seletor — inclusive quando a lista que está valendo é a da casa.
   */
  modelosBloqueados?: readonly string[]
  /** Skills instaladas, lidas do backend (projeto + máquina + cadastradas). */
  skills?: ApiSkill[]
  /** Servidores MCP configurados (o Koda ainda não conecta nenhum de verdade). */
  mcps?: ApiMcp[]
  /** Cadastra uma skill nova no backend e devolve quando a lista já foi atualizada. */
  onAddSkill?: (skill: NovoSkill) => Promise<void>
  /** Cadastra um servidor MCP novo no backend e devolve quando a lista já foi atualizada. */
  onAddMcp?: (mcp: NovoMcp) => Promise<void>
  /** Os sub-agentes do `subs.agentes.md`. */
  agents?: ApiAgente[]
  /** Cria ou substitui um sub-agente pelo nome (o backend devolve a lista como ficou). */
  onSaveAgent?: (agente: NovoAgente) => Promise<void>
  /** Tira um sub-agente do arquivo. */
  onDeleteAgent?: (nome: string) => Promise<void>
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection ?? 'geral')
  /**
   * Qual provedor está aberto em Modelos e Provedores — guardado pela **sigla**, que é única
   * (o nome não é: Google aparece duas vezes, Gemini CLI e Antigravity). `null` = a grade.
   *
   * É estado de tela, não de dado: abrir um provedor não carrega nada (nada existe para
   * carregar). A tela dele é o cabeçalho — marca, nome e a seta de volta — e é o lugar onde
   * a configuração de cada um vai morar quando houver contrato no backend.
   */
  const [provedorAberto, setProvedorAberto] = useState<string | null>(null)
  /**
   * O provedor da tela só existe **dentro** da seção Modelos: sair para Conta (ou qualquer
   * outra) não pode deixar o topo trocado. Quem zera o estado é a troca de seção, no clique
   * da coluna — e não um efeito observando `section`, que o compilador do React sinaliza como
   * estado escrito dentro de efeito.
   */
  const provedorDaTela =
    section === 'modelos' && provedorAberto
      ? (PROVEDORES.find((item) => item.id === provedorAberto) ?? null)
      : null
  /**
   * O retrato que o backend faz dos logins desta máquina — por id de provedor.
   *
   * `null` = ainda não perguntou. `{}` = perguntou e o backend não respondeu (a tela mostra
   * «sem resposta», e não um «desconectado» que seria mentira).
   */
  const [estadoDosProvedores, setEstadoDosProvedores] =
    useState<Record<string, ApiProvedor> | null>(null)
  const [teste, setTeste] = useState<{ ocupado: boolean; texto: string | null; ok: boolean | null }>(
    { ocupado: false, texto: null, ok: null },
  )
  const [modelos, setModelos] = useState<{
    ocupado: boolean
    lista: string[]
    nomes: Record<string, string>
    motivo: string | null
    fonte: string | null
  }>({ ocupado: false, lista: [], nomes: {}, motivo: null, fonte: null })
  /**
   * O login em curso: `aguardando` enquanto o navegador não volta, e o código quando o
   * fornecedor usa device flow (GitHub) — nesse caso o código é a única coisa que a pessoa
   * precisa ver, então ele fica na tela junto do link.
   */
  const [login, setLogin] = useState<{
    estado: 'parado' | 'aguardando' | 'concluido' | 'erro'
    url?: string
    codigo?: string
    mensagem?: string
    tipo?: 'pkce' | 'device' | 'cookie'
  }>({ estado: 'parado' })
  /** O código (ou a URL de retorno) que a pessoa cola quando o navegador não volta sozinho. */
  const [codigoColado, setCodigoColado] = useState('')
  /** O teste de cada modelo, por id: o resultado é por modelo, não da tela. */
  const [testeDoModelo, setTesteDoModelo] = useState<
    Record<string, { ocupado: boolean; ok?: boolean; detalhe?: string }>
  >({})
  /** O teste de cada conta empilhada, por id — respondeu, sem cota até quando, ou o erro. */
  const [testeDaConta, setTesteDaConta] = useState<
    Record<string, { ocupado: boolean; ok?: boolean; detalhe?: string }>
  >({})

  /** O retrato do provedor aberto — `null` enquanto a consulta não volta. */
  const estadoDoAberto = provedorDaTela
    ? (estadoDosProvedores?.[provedorDaTela.id] ?? null)
    : null

  // Uma consulta por visita à seção: o login muda no CLI, não na tela. Quem quiser o retrato
  // fresco usa «Testar», que é o botão que existe para isso.
  useEffect(() => {
    if (section !== 'modelos' || estadoDosProvedores !== null) return
    let cancelado = false
    void provedoresDeLogin()
      .then((lista) => {
        if (cancelado) return
        setEstadoDosProvedores(Object.fromEntries(lista.map((item) => [item.id, item])))
      })
      .catch(() => {
        if (!cancelado) setEstadoDosProvedores({})
      })
    return () => {
      cancelado = true
    }
  }, [section, estadoDosProvedores])

  /** Troca de seção sempre fecha o provedor aberto — a coluna leva à lista, não à última tela. */
  const abrirSecao = (id: SettingsSection) => {
    setProvedorAberto(null)
    setSection(id)
  }

  /** Abrir um provedor zera o que era do anterior: teste, lista e recado não são dele. */
  const abrirProvedor = (id: string) => {
    setProvedorAberto(id)
    setTeste({ ocupado: false, texto: null, ok: null })
    // Já entra em «lendo»: o efeito abaixo busca o catálogo, e o estado de carregamento não
    // pode ser escrito lá dentro (o compilador do React acusa setState síncrono em efeito).
    setModelos({ ocupado: true, lista: [], nomes: {}, motivo: null, fonte: null })
    setLogin({ estado: 'parado' })
    setCodigoColado('')
    setTesteDoModelo({})
  }

  const testarAberto = async () => {
    if (!provedorDaTela) return
    setTeste({ ocupado: true, texto: null, ok: null })
    try {
      const resultado = await testarProvedor(provedorDaTela.id)
      setTeste({ ocupado: false, texto: resultado.detalhe, ok: resultado.ok })
      if (resultado.estado) {
        setEstadoDosProvedores((atual) => ({ ...(atual ?? {}), [provedorDaTela.id]: resultado.estado! }))
      }
    } catch (erro) {
      setTeste({ ocupado: false, texto: fraseDeFalha(erro), ok: false })
    }
  }

  const baixarModelos = async () => {
    if (!provedorDaTela) return
    setModelos({ ocupado: true, lista: [], nomes: {}, motivo: null, fonte: null })
    try {
      const resultado = await modelosDoProvedor(provedorDaTela.id)
      setModelos({
        ocupado: false,
        lista: resultado.modelos,
        nomes: resultado.nomes ?? {},
        motivo: resultado.motivo || null,
        fonte: resultado.fonte,
      })
    } catch (erro) {
      setModelos({ ocupado: false, lista: [], nomes: {}, motivo: fraseDeFalha(erro), fonte: null })
    }
  }

  const entrarAberto = async () => {
    if (!provedorDaTela) return
    setLogin({ estado: 'parado' })
    try {
      const inicio = await entrarNoProvedor(provedorDaTela.id)
      if (inicio.estado === 'erro') {
        setLogin({ estado: 'erro', mensagem: inicio.mensagem || 'Não foi possível iniciar o login.' })
        return
      }
      if (inicio.tipo === 'pkce' || inicio.tipo === 'device' || inicio.tipo === 'cookie') {
        setLogin({
          estado: 'aguardando',
          url: inicio.url,
          codigo: inicio.codigo,
          tipo: inicio.tipo,
          mensagem: inicio.mensagem,
        })
        // Abrir a página é o que a pessoa espera do botão; o popup pode ser barrado pelo
        // navegador, e é por isso que o link também fica na tela.
        if (inicio.url) window.open(inicio.url, '_blank', 'noopener,noreferrer')
      } else {
        setLogin({ estado: 'erro', mensagem: inicio.mensagem })
      }
    } catch (erro) {
      setLogin({ estado: 'erro', mensagem: fraseDeFalha(erro) })
    }
  }

  const concluirPeloCodigo = async () => {
    if (!provedorDaTela || !codigoColado.trim()) return
    try {
      const resultado = await concluirLoginComCodigo(provedorDaTela.id, codigoColado.trim())
      if (resultado.ok) {
        setLogin({ estado: 'concluido', mensagem: `conectado como ${resultado.conta ?? 'a conta'}` })
        setCodigoColado('')
        const lista = await provedoresDeLogin()
        setEstadoDosProvedores(Object.fromEntries(lista.map((item) => [item.id, item])))
      } else {
        setLogin({ estado: 'erro', mensagem: resultado.mensagem ?? 'o código não valeu' })
      }
    } catch (erro) {
      setLogin({ estado: 'erro', mensagem: fraseDeFalha(erro) })
    }
  }

  const recarregarProvedores = async () => {
    try {
      const lista = await provedoresDeLogin()
      setEstadoDosProvedores(Object.fromEntries(lista.map((item) => [item.id, item])))
    } catch {
      // Sem serviço local a tela fica com o último retrato conhecido.
    }
  }

  const testarConta = async (contaId: string) => {
    if (!provedorDaTela) return
    setTesteDaConta((atual) => ({ ...atual, [contaId]: { ocupado: true } }))
    try {
      const resultado = await testarContaDoProvedor(provedorDaTela.id, contaId)
      setTesteDaConta((atual) => ({
        ...atual,
        [contaId]: { ocupado: false, ok: resultado.ok, detalhe: resultado.detalhe },
      }))
      await recarregarProvedores()
    } catch (erro) {
      setTesteDaConta((atual) => ({
        ...atual,
        [contaId]: { ocupado: false, ok: false, detalhe: fraseDeFalha(erro) },
      }))
    }
  }

  const sairDaConta = async (contaId: string) => {
    if (!provedorDaTela) return
    try {
      await sairDoProvedor(provedorDaTela.id, contaId)
    } catch {
      // Sair de uma conta que já não existe é resultado, não erro.
    }
    setTesteDaConta((atual) => {
      const copia = { ...atual }
      delete copia[contaId]
      return copia
    })
    await recarregarProvedores()
  }

  const testarModelo = async (modelo: string) => {
    if (!provedorDaTela) return
    setTesteDoModelo((atual) => ({ ...atual, [modelo]: { ocupado: true } }))
    try {
      const resultado = await testarModeloDoProvedor(provedorDaTela.id, modelo)
      setTesteDoModelo((atual) => ({
        ...atual,
        [modelo]: { ocupado: false, ok: resultado.ok, detalhe: resultado.detalhe },
      }))
    } catch (erro) {
      setTesteDoModelo((atual) => ({
        ...atual,
        [modelo]: { ocupado: false, ok: false, detalhe: fraseDeFalha(erro) },
      }))
    }
  }

  const cancelarLogin = async () => {
    if (!provedorDaTela) return
    try {
      await cancelarLoginDoProvedor(provedorDaTela.id)
    } catch {
      // Cancelar é cortesia: se o backend não responder, o fluxo vence sozinho em 10 min.
    }
    setLogin({ estado: 'parado' })
    setCodigoColado('')
  }

  // Ao abrir um provedor, o catálogo vem sozinho: a lista é a informação principal da tela, e
  // obrigar a clicar em «Baixar modelos» para ver o que já está em disco é atrito à toa.
  useEffect(() => {
    if (!provedorDaTela) return
    const id = provedorDaTela.id
    let cancelado = false
    void modelosDoProvedor(id)
      .then((resultado) => {
        if (cancelado) return
        setModelos({
          ocupado: false,
          lista: resultado.modelos,
          nomes: resultado.nomes ?? {},
          motivo: resultado.motivo || null,
          fonte: resultado.fonte,
        })
      })
      .catch(() => {
        if (!cancelado) {
          setModelos({ ocupado: false, lista: [], nomes: {}, motivo: null, fonte: null })
        }
      })
    return () => {
      cancelado = true
    }
  }, [provedorDaTela])

  // Enquanto o navegador não volta, a tela pergunta: quem conclui é o servidor do callback,
  // e ele não tem como avisar o React.
  useEffect(() => {
    if (login.estado !== 'aguardando' || !provedorDaTela) return
    const id = provedorDaTela.id
    const timer = window.setInterval(() => {
      void estadoDoLoginDoProvedor(id)
        .then((estado) => {
          if (estado.estado === 'concluido') {
            setLogin({ estado: 'concluido', mensagem: `conectado como ${estado.conta ?? 'a conta'}` })
            return provedoresDeLogin().then((lista) =>
              setEstadoDosProvedores(Object.fromEntries(lista.map((item) => [item.id, item]))),
            )
          }
          if (estado.estado === 'erro') {
            setLogin({ estado: 'erro', mensagem: estado.detalhe || 'o login não foi concluído' })
          }
        })
        .catch(() => {
          setLogin({ estado: 'erro', mensagem: fraseDeFalha(new Error('sem resposta')) })
        })
    }, 1500)
    return () => window.clearInterval(timer)
  }, [login.estado, provedorDaTela])
  const current = SECTIONS.find((item) => item.id === section) ?? SECTIONS[0]
  // Quem está logado aparece pelo nome que está no painel, não por um rótulo fixo.
  const apelido = apelidoDaConta(contaKoda)
  const activeModel = findModel(model, remoteModels ?? [])
  const activeProject =
    projects.find((item) => item.id === projectId)?.nome ?? 'Nenhum projeto'

  /** As pastas salvas + as duas formas de abrir outra, igual ao prompt box. */
  const projectOptions = [
    { value: 'sem-projeto', label: 'Nenhum projeto', hint: 'Conversa solta, sem contexto de código' },
    ...projects.map((item) => ({
      value: item.id,
      label: item.nome,
      hint: item.existe ? item.caminho : `${item.caminho} · pasta não encontrada`,
    })),
    { value: 'abrir-pasta', label: 'Usar pasta existente', hint: 'Escolher uma pasta que já está no disco' },
    { value: 'nova-pasta', label: 'Começar do zero', hint: 'Criar uma pasta nova e trabalhar nela' },
  ]

  const handleProjectSelect = (value: string) => {
    if (value === 'abrir-pasta' || value === 'nova-pasta') {
      onOpenFolders?.()
      return
    }
    onProjectChange?.(value === 'sem-projeto' ? null : value)
  }

  // ---- cadastro de skill ----
  const [formSkill, setFormSkill] = useState(false)
  const [skillNome, setSkillNome] = useState('')
  const [skillDescricao, setSkillDescricao] = useState('')
  const [skillAcao, setSkillAcao] = useState('')
  const [erroSkill, setErroSkill] = useState<string | null>(null)
  const [salvandoSkill, setSalvandoSkill] = useState(false)
  /** Só marca os campos em vermelho depois da primeira tentativa de salvar. */
  const [tentouSkill, setTentouSkill] = useState(false)

  // ---- cadastro de servidor MCP ----
  const [formMcp, setFormMcp] = useState(false)
  const [mcpNome, setMcpNome] = useState('')
  const [mcpComando, setMcpComando] = useState('')
  const [mcpParams, setMcpParams] = useState('')
  const [erroMcp, setErroMcp] = useState<string | null>(null)
  const [salvandoMcp, setSalvandoMcp] = useState(false)
  const [tentouMcp, setTentouMcp] = useState(false)

  // ---- sub-agentes ----
  const [formAgente, setFormAgente] = useState(false)
  const [agenteNome, setAgenteNome] = useState('')
  const [agentePrompt, setAgentePrompt] = useState('')
  const [agenteSkills, setAgenteSkills] = useState<string[]>([])
  const [agenteMcps, setAgenteMcps] = useState<string[]>([])
  const [agenteModelo, setAgenteModelo] = useState('')
  /**
   * Qual agente está sendo editado. Vazio = o formulário está criando um novo.
   *
   * Editar e criar usam o mesmo formulário de propósito: é o mesmo conjunto de campos, e o
   * nome é o identificador — salvar com um nome que já existe substitui aquele agente.
   */
  const [editandoAgente, setEditandoAgente] = useState('')
  const [erroAgente, setErroAgente] = useState<string | null>(null)
  const [salvandoAgente, setSalvandoAgente] = useState(false)
  const [tentouAgente, setTentouAgente] = useState(false)

  const fecharFormSkill = () => {
    setFormSkill(false)
    setSkillNome('')
    setSkillDescricao('')
    setSkillAcao('')
    setErroSkill(null)
    setTentouSkill(false)
  }

  const fecharFormMcp = () => {
    setFormMcp(false)
    setMcpNome('')
    setMcpComando('')
    setMcpParams('')
    setErroMcp(null)
    setTentouMcp(false)
  }

  /** Salva a skill: valida os três obrigatórios antes de chamar o backend. */
  const handleSalvarSkill = async () => {
    setTentouSkill(true)
    const nome = skillNome.trim()
    const descricao = skillDescricao.trim()
    const acao = skillAcao.trim()
    if (!nome || !descricao || !acao) {
      setErroSkill('Preencha nome, descrição e ação — os três são obrigatórios.')
      return
    }
    setSalvandoSkill(true)
    setErroSkill(null)
    try {
      await onAddSkill?.({ name: nome, description: descricao, action: acao })
      fecharFormSkill()
    } catch (erro) {
      setErroSkill(fraseDeFalha(erro))
    } finally {
      setSalvandoSkill(false)
    }
  }

  /** Salva o servidor MCP: nome e comando são obrigatórios; parâmetros não. */
  const handleSalvarMcp = async () => {
    setTentouMcp(true)
    const nome = mcpNome.trim()
    const comando = mcpComando.trim()
    if (!nome || !comando) {
      setErroMcp('Preencha nome e comando/endpoint — os dois são obrigatórios.')
      return
    }
    setSalvandoMcp(true)
    setErroMcp(null)
    try {
      await onAddMcp?.({ name: nome, command: comando, params: mcpParams.trim() })
      fecharFormMcp()
    } catch (erro) {
      setErroMcp(fraseDeFalha(erro))
    } finally {
      setSalvandoMcp(false)
    }
  }

  // ---- sub-agentes ----

  const fecharFormAgente = () => {
    setFormAgente(false)
    setEditandoAgente('')
    setAgenteNome('')
    setAgentePrompt('')
    setAgenteSkills([])
    setAgenteMcps([])
    setAgenteModelo('')
    setErroAgente(null)
    setTentouAgente(false)
  }

  /** Abre o formulário com o agente dentro — editar é o mesmo formulário, preenchido. */
  const editarAgente = (agente: ApiAgente) => {
    setFormAgente(true)
    setEditandoAgente(agente.nome)
    setAgenteNome(agente.nome)
    setAgentePrompt(agente.prompt)
    setAgenteSkills([...agente.skills])
    setAgenteMcps([...agente.mcps])
    setAgenteModelo(agente.modelo)
    setErroAgente(null)
    setTentouAgente(false)
  }

  /** Liga/desliga um nome numa lista de escolhidos — é assim que skills e MCPs se marcam. */
  const alternar = (lista: string[], setLista: (valor: string[]) => void, nome: string) =>
    setLista(lista.includes(nome) ? lista.filter((item) => item !== nome) : [...lista, nome])

  const handleSalvarAgente = async () => {
    setTentouAgente(true)
    const nome = agenteNome.trim()
    if (!nome) {
      setErroAgente('Dê um nome ao agente — é por ele que o principal o chama.')
      return
    }
    setSalvandoAgente(true)
    setErroAgente(null)
    try {
      await onSaveAgent?.({
        nome,
        prompt: agentePrompt.trim(),
        skills: agenteSkills,
        mcps: agenteMcps,
        modelo: agenteModelo.trim(),
      })
      fecharFormAgente()
    } catch (erro) {
      setErroAgente(fraseDeFalha(erro))
    } finally {
      setSalvandoAgente(false)
    }
  }

  const handleApagarAgente = async (nome: string) => {
    setErroAgente(null)
    try {
      await onDeleteAgent?.(nome)
      // Apagou o que estava aberto no formulário: fecha, senão ele salvaria de volta.
      if (editandoAgente === nome) fecharFormAgente()
    } catch (erro) {
      setErroAgente(fraseDeFalha(erro))
    }
  }

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-60 shrink-0 flex-col border-r border-koda-fg/8 p-3">
        <div
          data-tauri-drag-region
          className="mb-3 flex items-center gap-2 px-2.5 py-1.5"
        >
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
                onClick={() => abrirSecao(item.id)}
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
          onClick={() => abrirSecao('conta')}
          className={[
            'mt-auto flex w-full flex-col items-start rounded-xl p-3 text-left',
            'transition-colors duration-150 focus-visible:outline-none',
            section === 'conta' ? 'bg-koda-accent/12' : 'bg-koda-fg/4 hover:bg-koda-fg/8',
          ].join(' ')}
        >
          <span className="flex w-full items-center gap-2 text-[13px] font-medium text-koda-fg/90">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-koda-accent to-koda-accent-strong text-[11px] font-semibold text-white">
              {iniciaisDaConta(apelido)}
            </span>
            <span className="min-w-0 truncate">{apelido}</span>
            <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 text-koda-fg/40" strokeWidth={1.8} />
          </span>
          <span className="mt-1.5 max-w-full truncate text-[11.5px] text-koda-fg/40">
            {contaKoda ? contaKoda.email : 'Plano Free'}
          </span>
        </button>
      </aside>
      {/*
       * `min-w-0` no lugar do padrão (`min-width: auto`): o mapa do ano é uma grade que não
       * encolhe, e sem isto a coluna inteira era empurrada para fora da janela — a seção
       * Uso aparecia cortada na direita, com metade do mapa fora da tela.
       */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Faixa da titlebar customizada: arraste + controles no canto direito. */}
        <div data-tauri-drag-region className="flex h-9 shrink-0 items-center justify-end pr-3">
          <WindowControls />
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-8 py-7">
        <div
          // `key` remonta a coluna a cada troca de seção, e o `stagger` reaproveita
          // isso para a entrada em cascata acontecer de novo.
          key={section}
          className={[
            'stagger mx-auto flex flex-col gap-6',
              // O mapa do ano pede mais largura; a conta fica numa coluna estreita. A grade
              // de provedores é de quatro por fileira e também precisa de largura para não
              // espremer os nomes.
              section === 'uso' || section === 'modelos' ? 'max-w-5xl' : section === 'conta' ? 'max-w-2xl' : 'max-w-3xl',
            ].join(' ')}
          >
          {/*
           * Com um provedor aberto, o topo **é** a tela dele: a seta de volta e o nome no
           * lugar do título da seção. Deixar «Modelos e Provedores» em cima e «Codex» embaixo
           * seriam dois cabeçalhos dizendo a mesma coisa, e a pessoa não saberia qual manda.
           */}
          {provedorDaTela ? (
            <div className="flex flex-col gap-4">
              <button
                type="button"
                onClick={() => setProvedorAberto(null)}
                className="-ml-1 flex w-fit items-center gap-1.5 rounded-lg px-1.5 py-1 text-[12.5px] font-medium text-koda-fg/55 transition-colors duration-150 hover:bg-koda-fg/6 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
              >
                <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.9} />
                Voltar
              </button>
              <div className="flex items-center gap-3.5">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-koda-fg/8">
                  {provedorDaTela.logo ? <img src={provedorDaTela.logo} alt="" aria-hidden="true" className="h-6 w-6 object-contain" />
                    : <span aria-hidden="true" className="text-sm font-bold text-koda-fg/65">{provedorDaTela.sigla}</span>}
                </span>
                <div className="min-w-0">
                  <h1 className="truncate text-[22px] font-semibold text-koda-fg">
                    {provedorDaTela.nome}
                  </h1>
                  <p className="mt-1 text-[13px] text-koda-fg/45">{provedorDaTela.cli}</p>
                </div>
              </div>
            </div>
          ) : (
            <div>
              <h1 className="text-[22px] font-semibold text-koda-fg">{current.title}</h1>
              <p className="mt-1 text-[13px] text-koda-fg/45">{current.subtitle}</p>
            </div>
          )}

          {section === 'geral' ? (
            <Card
              title="Preferências"
              description="Padrões usados no prompt box e nas respostas."
            >
              <div className="divide-y divide-koda-fg/8 border-t border-koda-fg/8">
                <Switch
                  label="Mostrar uso e tempo das respostas"
                  description="Exibe o uso de tokens, a duração e a hora no rodapé de cada resposta."
                  checked={mostrarRodape}
                  onChange={onToggleRodape}
                />

                <Switch
                  label="Mostrar raciocínio do modelo"
                  description="Abre o pensamento do modelo enquanto ele trabalha — é o que mostra que tem alguém ali dentro numa tarefa longa. Desligado, a resposta chega sem o rascunho; as ferramentas continuam aparecendo como uma linha resumida."
                  checked={mostrarTraces}
                  onChange={onToggleTraces}
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
                    options={modelMenu(remoteModels, modelosBloqueados)}
                    value={model}
                    onSelect={onModelChange}
                    align="end"
                    direction="down"
                    label="Escolher modelo padrão"
                    triggerClassName="flex items-center gap-2 rounded-xl bg-koda-fg/6 px-3 py-2 text-[13px] text-koda-fg/80 transition-colors duration-150 hover:bg-koda-fg/10 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
                  >
                    <span className="text-koda-fg/60">{activeModel.icon}</span>
                    {model ? activeModel.label : 'Nenhum modelo disponível'}
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
                    options={projectOptions}
                    value={projectId ?? 'sem-projeto'}
                    onSelect={handleProjectSelect}
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

          {section === 'nuvem' ? (
            <Atualizacoes cloud={cloud} version={backend.version} />
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
              contaKoda={contaKoda}
              planoDaConta={planoDaConta}
              onAssinaturaMudou={onAssinaturaMudou}
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
                description="Últimos 365 dias, no fuso local. Cada quadrado é o que o Koda registrou naquele dia nesta conta."
              >
                <ActivityHeatmap dias={usage.dias} />
              </Card>

              <div className="flex flex-col gap-3">
                <p className="px-1 text-[12.5px] text-koda-fg/45">Progresso de uso</p>
                {/* A explicação é **uma** para os três cartões, e não uma por cartão: o que se
                    conta é o mesmo nas três janelas, e repetir a frase três vezes faria parecer
                    que cada uma conta de um jeito. */}
                <p className="px-1 text-[11.5px] leading-4 text-koda-fg/35">
                  O tempo conta só enquanto o Koda trabalha — conversa parada na tela não gasta. Os
                  créditos são os tokens cobrados, pelo preço de cada modelo.
                </p>
                <div className="grid gap-3 md:grid-cols-3">
                  <UsageWindowCard
                    title="Uso diário"
                    janela={usage.daily}
                    resetsOn={dailyReset()}
                  />
                  <UsageWindowCard
                    title="Uso semanal"
                    janela={usage.weekly}
                    resetsOn={weeklyReset()}
                  />
                  <UsageWindowCard
                    title="Uso mensal"
                    janela={usage.monthly}
                    resetsOn={monthlyReset()}
                  />
                </div>
              </div>
            </>
          ) : null}

          {/*
           * Um **box por provedor**, soltos na área — sem cartão em volta. Foi o pedido dele
           * em 26/10/2026, duas vezes: o quadro é a unidade, não a lista dentro de um quadro.
           * Quatro por fileira («4 x 4 eu falo fileira de 4 box»), e no mouse o box se destaca
           * — o realce é o que diz «isto é um item», mesmo sem clique nenhum.
           *
           * Com um provedor aberto esta grade sai de cena: o topo já virou a tela dele, e o
           * corpo dela fica vazio de propósito — não há o que configurar enquanto não houver
           * contrato no backend, e inventar campos seria pior do que o vazio.
           */}
          {section === 'modelos' && !provedorDaTela ? (
            <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
              {PROVEDORES.map((provedor) => (
                <button
                  key={provedor.id}
                  type="button"
                  onClick={() => abrirProvedor(provedor.id)}
                  className="group flex flex-col gap-3 rounded-2xl bg-koda-panel p-4 text-left ring-1 ring-koda-fg/8 transition-colors duration-150 hover:bg-koda-fg/6 hover:ring-koda-accent/45 focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-koda-fg/8 transition-colors duration-150 group-hover:bg-koda-fg/12">
                    {provedor.logo ? <img src={provedor.logo} alt="" aria-hidden="true" className="h-5 w-5 object-contain" />
                      : <span aria-hidden="true" className="text-xs font-bold text-koda-fg/60">{provedor.sigla}</span>}
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-[13px] font-medium text-koda-fg/85 transition-colors duration-150 group-hover:text-koda-fg">
                      {provedor.nome}
                    </span>
                    <span className="truncate text-[11px] text-koda-fg/35">{provedor.cli}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          {/*
           * A tela do provedor: o login que já existe nesta máquina, e três ações que fazem
           * só o que sabem fazer. «Entrar» não inventa um OAuth dentro do Koda — manda rodar
           * o login do CLI do fornecedor, que é o fluxo oficial dele. «Testar» confere
           * arquivo, conta e validade, sem rede. «Baixar modelos» lê o catálogo que o CLI
           * deixou em disco; quando não há, diz por quê em vez de inventar uma lista.
           */}
          {section === 'modelos' && provedorDaTela ? (
            <div className="flex flex-col gap-3">
              <div className="rounded-2xl bg-koda-panel p-5 ring-1 ring-koda-fg/8">
                {/*
                 * As contas **empilhadas**, uma linha cada: é assim que o rodízio aparece
                 * na tela. «Em uso» é a que responde agora; quando ela estoura a cota, a
                 * linha passa a dizer até quando e o rodízio segue para a próxima.
                 */}
                {(estadoDoAberto?.contas ?? []).length > 0 ? (
                  <div className="flex flex-col gap-1.5">
                    {(estadoDoAberto?.contas ?? []).map((conta) => {
                      const teste = testeDaConta[conta.id]
                      return (
                        <div
                          key={conta.id}
                          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-koda-fg/4 px-3 py-2"
                        >
                          <span className="min-w-0 flex-1 truncate text-[12.5px] text-koda-fg/85">
                            {conta.conta ?? 'conta sem nome'}
                          </span>
                          {conta.atual ? <Tag>em uso</Tag> : null}
                          {conta.esgotadaAte && !conta.atual ? null : null}
                          {conta.esgotadaAte ? (
                            <Tag>sem cota até {dataCurta(conta.esgotadaAte)}</Tag>
                          ) : (
                            <Tag>ok</Tag>
                          )}
                          <button
                            type="button"
                            onClick={() => void testarConta(conta.id)}
                            disabled={teste?.ocupado}
                            className="flex items-center gap-1 rounded-lg bg-koda-fg/6 px-2 py-1 text-[11.5px] text-koda-fg/75 transition-colors duration-150 hover:bg-koda-fg/12 disabled:opacity-50"
                          >
                            {teste?.ocupado ? (
                              <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
                            ) : null}
                            Testar
                          </button>
                          <button
                            type="button"
                            onClick={() => void sairDaConta(conta.id)}
                            className="rounded-lg px-2 py-1 text-[11.5px] text-koda-fg/45 transition-colors duration-150 hover:bg-red-500/12 hover:text-red-400"
                          >
                            Sair
                          </button>
                          {teste?.detalhe ? (
                            <p
                              className={[
                                'w-full text-[11px] leading-4',
                                teste.ok ? 'text-emerald-400' : 'text-amber-400/90',
                              ].join(' ')}
                            >
                              {teste.detalhe}
                            </p>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <p className="text-[12.5px] leading-5 text-koda-fg/45">
                    {estadoDosProvedores === null
                      ? 'lendo as contas desta máquina…'
                      : 'Nenhuma conta conectada. Use «Entrar» para adicionar a primeira.'}
                  </p>
                )}

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void entrarAberto()}
                    className="flex items-center gap-1.5 rounded-xl bg-koda-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-koda-bg transition-opacity duration-150 hover:opacity-90"
                  >
                    <PlugZap className="h-3.5 w-3.5" strokeWidth={2} />
                    Entrar
                  </button>
                  <button
                    type="button"
                    onClick={() => void baixarModelos()}
                    disabled={modelos.ocupado}
                    className="flex items-center gap-1.5 rounded-xl bg-koda-fg/6 px-3.5 py-1.5 text-[12.5px] font-medium text-koda-fg/80 transition-colors duration-150 hover:bg-koda-fg/10 disabled:opacity-50"
                  >
                    {modelos.ocupado ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                    ) : (
                      <CloudDownload className="h-3.5 w-3.5" strokeWidth={1.9} />
                    )}
                    Baixar modelos
                  </button>
                  <button
                    type="button"
                    onClick={() => void testarAberto()}
                    disabled={teste.ocupado}
                    className="flex items-center gap-1.5 rounded-xl bg-koda-fg/6 px-3.5 py-1.5 text-[12.5px] font-medium text-koda-fg/80 transition-colors duration-150 hover:bg-koda-fg/10 disabled:opacity-50"
                  >
                    {teste.ocupado ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                    ) : (
                      <Activity className="h-3.5 w-3.5" strokeWidth={1.9} />
                    )}
                    Testar
                  </button>
                </div>

                {login.estado === 'aguardando' ? (
                  <div className="mt-3 rounded-xl bg-koda-fg/4 px-3.5 py-3">
                    <p className="text-[12px] leading-5 text-koda-fg/60">
                      {login.codigo
                        ? 'Digite este código na página que abriu:'
                        : login.tipo === 'cookie'
                          ? (login.mensagem || 'Entre na página e cole aqui a credencial da sessão do navegador.')
                          : 'Termine o login na página que abriu — esta tela se atualiza sozinha.'}
                    </p>
                    {login.codigo ? (
                      <p className="mt-1 font-mono text-[16px] font-semibold tracking-[0.2em] text-koda-fg">
                        {login.codigo}
                      </p>
                    ) : null}
                    <div className="mt-2 flex items-center gap-4">
                      {login.url ? (
                        <a
                          href={login.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[12px] font-medium text-koda-accent hover:underline"
                        >
                          Abrir a página
                        </a>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => void cancelarLogin()}
                        className="text-[12px] text-koda-fg/45 transition-colors duration-150 hover:text-koda-fg"
                      >
                        Cancelar
                      </button>
                    </div>
                    {/*
                     * O Claude mostra o código na página em vez de voltar sozinho, e o Codex
                     * cai nisso quando a porta 1455 está ocupada. Sem este campo, esses dois
                     * ficariam sem saída — o navegador termina e a tela continua esperando.
                     */}
                    {login.tipo === 'pkce' || login.tipo === 'cookie' ? (
                      <div className="mt-3 flex items-center gap-2">
                        <input
                          value={codigoColado}
                          onChange={(evento) => setCodigoColado(evento.target.value)}
                          type={login.tipo === 'cookie' ? 'password' : 'text'}
                          placeholder={login.tipo === 'cookie' ? 'cole aqui o cookie ou token da sessão' : 'cole aqui o código que a página mostrou'}
                          className="min-w-0 flex-1 rounded-lg bg-koda-input px-2.5 py-1.5 text-[12px] text-koda-fg ring-1 ring-koda-fg/10 outline-none placeholder:text-koda-fg/30 focus:ring-2 focus:ring-koda-accent"
                        />
                        <button
                          type="button"
                          onClick={() => void concluirPeloCodigo()}
                          disabled={!codigoColado.trim()}
                          className="shrink-0 rounded-lg bg-koda-accent px-3 py-1.5 text-[12px] font-semibold text-koda-bg transition-opacity duration-150 hover:opacity-90 disabled:opacity-50"
                        >
                          Concluir
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {login.estado === 'concluido' ? (
                  <p className="mt-3 text-[12px] leading-5 text-emerald-400">{login.mensagem}</p>
                ) : null}
                {login.estado === 'erro' && login.mensagem ? (
                  <p className="mt-3 text-[12px] leading-5 text-amber-400/90">{login.mensagem}</p>
                ) : null}
                {teste.texto ? (
                  <p
                    className={[
                      'mt-3 text-[12px] leading-5',
                      teste.ok ? 'text-emerald-400' : 'text-amber-400/90',
                    ].join(' ')}
                  >
                    {teste.texto}
                  </p>
                ) : null}
              </div>

              {/*
               * Um box por modelo, quatro por fileira — a lista corrida não deixava ver
               * nada, e o botão de testar é por modelo (a conta pode alcançar um e não
               * outro).
               */}
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-[15px] font-semibold text-koda-fg">Modelos</h2>
                <span className="text-[11.5px] text-koda-fg/35">
                  {modelos.lista.length > 0
                    ? `${modelos.lista.length} · ${modelos.fonte ?? ''}`
                    : ''}
                </span>
              </div>

              {modelos.lista.length > 0 ? (
                <div className="grid gap-2.5 sm:grid-cols-2 md:grid-cols-4">
                  {modelos.lista.map((modelo) => {
                    const teste = testeDoModelo[modelo]
                    return (
                      <div
                        key={modelo}
                        className="flex flex-col gap-1.5 rounded-xl bg-koda-panel p-3 ring-1 ring-koda-fg/8"
                      >
                        <span className="truncate text-[12.5px] font-medium text-koda-fg/90">
                          {modelos.nomes[modelo] ?? modelo}
                        </span>
                        <span className="truncate font-mono text-[10.5px] text-koda-fg/30">
                          {modelo}
                        </span>
                        <button
                          type="button"
                          onClick={() => void testarModelo(modelo)}
                          disabled={teste?.ocupado}
                          className="mt-1 flex items-center justify-center gap-1.5 rounded-lg bg-koda-fg/6 px-2 py-1 text-[11.5px] font-medium text-koda-fg/75 transition-colors duration-150 hover:bg-koda-fg/12 disabled:opacity-50"
                        >
                          {teste?.ocupado ? (
                            <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
                          ) : null}
                          Testar
                        </button>
                        {teste?.detalhe ? (
                          <p
                            className={[
                              'text-[10.5px] leading-4',
                              teste.ok ? 'text-emerald-400' : 'text-amber-400/90',
                            ].join(' ')}
                          >
                            {teste.detalhe}
                          </p>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              ) : (
                <p className="rounded-xl bg-koda-panel px-4 py-4 text-[12.5px] leading-5 text-koda-fg/40 ring-1 ring-koda-fg/8">
                  {modelos.ocupado
                    ? 'lendo o catálogo do provedor…'
                    : (modelos.motivo ??
                      'Nenhum modelo listado ainda. Entre no provedor para ver a lista da conta.')}
                </p>
              )}
            </div>
          ) : null}

          {section === 'sobre' ? <DiagnosticoLocal /> : null}

          {section === 'sobre' ? (
            <Card title="Sobre" description="Informações desta build.">
              <dl className="border-t border-koda-fg/8 text-[13px]">
                {[
                  ['Aplicação', 'Koda — shell de interface de chat'],
                  ['Versão', backend.version ? `v${backend.version}` : '—'],
                  ['Stack', 'React 19 · Vite · Tailwind 4 · lucide-react'],
                  ['Backend', backend.url],
                  [
                    'Status',
                    backend.provider === 'local'
                      ? 'Servidor local — sem os modelos da conta (entre de novo)'
                      : backend.provider
                        ? `Online · ${backend.provider}${backend.ready ? '' : ' (ainda acordando)'}`
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
                  [
                    'Contexto',
                    backend.contextoTokens > 0
                      ? `Resume sozinho depois de ${contextoEmTexto(backend.contextoTokens)}`
                      : 'Sem teto — o histórico vai inteiro ao modelo',
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

          {section === 'skills' ? (
            <Card
              title="Skills instaladas"
              description="Pacotes de instruções e ferramentas que entram no chat sob demanda."
              action={
                <BotaoAdicionar
                  aberto={formSkill}
                  rotulo="Adicionar Skill"
                  onClick={() => (formSkill ? fecharFormSkill() : setFormSkill(true))}
                />
              }
            >
              {formSkill ? (
                <div className="flex flex-col gap-3.5 border-t border-koda-fg/8 px-5 py-4">
                  <Campo
                    label="Nome"
                    valor={skillNome}
                    onChange={setSkillNome}
                    placeholder="ex.: Revisor de commit"
                    obrigatorio
                    invalido={tentouSkill && !skillNome.trim()}
                  />
                  <Campo
                    label="Descrição"
                    valor={skillDescricao}
                    onChange={setSkillDescricao}
                    placeholder="Quando o agente deve usar esta skill"
                    obrigatorio
                    invalido={tentouSkill && !skillDescricao.trim()}
                  />
                  <Campo
                    label="Comando / ação"
                    valor={skillAcao}
                    onChange={setSkillAcao}
                    placeholder="O que a skill manda o agente fazer, passo a passo"
                    obrigatorio
                    multiline
                    invalido={tentouSkill && !skillAcao.trim()}
                  />
                  {erroSkill ? (
                    <p className="text-[12.5px] leading-5 text-red-400">{erroSkill}</p>
                  ) : null}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleSalvarSkill}
                      disabled={salvandoSkill}
                      className="flex items-center gap-1.5 rounded-xl bg-koda-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-koda-bg transition-opacity duration-150 hover:opacity-90 disabled:opacity-50"
                    >
                      {salvandoSkill ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                      ) : (
                        <Check className="h-3.5 w-3.5" strokeWidth={2.2} />
                      )}
                      Salvar skill
                    </button>
                    <button
                      type="button"
                      onClick={fecharFormSkill}
                      className="rounded-xl px-3 py-1.5 text-[12.5px] text-koda-fg/55 transition-colors duration-150 hover:bg-koda-fg/6 hover:text-koda-fg"
                    >
                      Cancelar
                    </button>
                    <span className="ml-auto text-[11.5px] text-koda-fg/35">
                      Os campos com <span className="text-koda-accent">*</span> são obrigatórios
                    </span>
                  </div>
                </div>
              ) : null}

              {skills.length > 0 ? (
                <ul className="divide-y divide-koda-fg/8 border-t border-koda-fg/8">
                  {skills.map((skill) => (
                    <li key={`${skill.scope}-${skill.name}`} className="px-5 py-4">
                      <div className="flex items-center gap-2.5">
                        <Puzzle className="h-4 w-4 shrink-0 text-koda-fg/45" strokeWidth={1.7} />
                        <span className="min-w-0 truncate text-[13.5px] font-medium text-koda-fg/90">
                          {skill.name}
                        </span>
                        <span className="ml-auto shrink-0">
                          <StatusBadge
                            on={skill.enabled}
                            ligado="Ativa"
                            desligado="Desativada"
                          />
                        </span>
                        <span className="shrink-0 rounded-full bg-koda-fg/6 px-2 py-0.5 text-[10.5px] font-semibold tracking-wider text-koda-fg/55 uppercase">
                          {skill.scope === 'projeto'
                            ? 'Projeto'
                            : skill.scope === 'global'
                              ? 'Global'
                              : 'Cadastrada'}
                        </span>
                      </div>
                      {skill.description ? (
                        <p className="mt-1.5 text-[12.5px] leading-5 text-koda-fg/45">
                          {skill.description}
                        </p>
                      ) : null}
                      {skill.path ? (
                        <p className="mt-1.5 truncate font-mono text-[11.5px] text-koda-fg/35">
                          {skill.path}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : formSkill ? null : (
                <div className="flex flex-col items-center gap-2 border-t border-koda-fg/8 px-5 py-10 text-center">
                  <Puzzle className="h-5 w-5 text-koda-fg/35" strokeWidth={1.7} />
                  <p className="text-[13.5px] font-medium text-koda-fg/80">
                    Nenhuma skill instalada
                  </p>
                  <p className="max-w-sm text-[12.5px] leading-5 text-koda-fg/45">
                    Cadastre uma skill em “Adicionar Skill” — ela entra nesta lista e o
                    agente passa a usá-la quando a conversa pedir.
                  </p>
                </div>
              )}
            </Card>
          ) : null}

          {section === 'agents' ? (
            <Card
              title="Sub-agentes"
              description="Cada um roda com o prompt e as ferramentas dele. O agente principal os lança pelo nome, com a ferramenta sub_agente."
              action={
                <BotaoAdicionar
                  aberto={formAgente}
                  rotulo="Adicionar Agente"
                  onClick={() => (formAgente ? fecharFormAgente() : setFormAgente(true))}
                />
              }
            >
              {formAgente ? (
                <div className="flex flex-col gap-3.5 border-t border-koda-fg/8 px-5 py-4">
                  <Campo
                    label="Nome"
                    valor={agenteNome}
                    onChange={setAgenteNome}
                    placeholder="ex.: revisor"
                    obrigatorio
                    invalido={tentouAgente && !agenteNome.trim()}
                  />
                  <Campo
                    label="Prompt"
                    valor={agentePrompt}
                    onChange={setAgentePrompt}
                    placeholder="O que este agente é e o que ele faz — é o que ele recebe ao acordar"
                    multiline
                  />
                  <Escolha
                    titulo="Skills que ele pode usar"
                    ajuda="Sem nenhuma marcada, ele não carrega skill nenhuma — um agente novo não herda poder."
                    opcoes={(skills ?? []).map((item) => item.name)}
                    escolhidos={agenteSkills}
                    onAlternar={(nome) => alternar(agenteSkills, setAgenteSkills, nome)}
                    vazio="Nenhuma skill instalada."
                  />
                  <Escolha
                    titulo="MCPs que ele pode usar"
                    ajuda="Sem nenhum marcado, ele não alcança servidor nenhum."
                    opcoes={(mcps ?? []).map((item) => item.name)}
                    escolhidos={agenteMcps}
                    onAlternar={(nome) => alternar(agenteMcps, setAgenteMcps, nome)}
                    vazio="Nenhum servidor MCP configurado."
                  />
                  <Campo
                    label="Modelo"
                    valor={agenteModelo}
                    onChange={setAgenteModelo}
                    placeholder="Vazio = o modelo que o principal mandar"
                  />
                  {erroAgente ? (
                    <p className="text-[12.5px] leading-5 text-red-400">{erroAgente}</p>
                  ) : null}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleSalvarAgente()}
                      disabled={salvandoAgente}
                      className="flex items-center gap-1.5 rounded-xl bg-koda-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-koda-bg transition-opacity duration-150 hover:opacity-90 disabled:opacity-50"
                    >
                      {salvandoAgente ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                      ) : (
                        <Check className="h-3.5 w-3.5" strokeWidth={2.2} />
                      )}
                      {editandoAgente ? 'Salvar alterações' : 'Criar agente'}
                    </button>
                    <button
                      type="button"
                      onClick={fecharFormAgente}
                      className="rounded-xl px-3 py-1.5 text-[12.5px] text-koda-fg/55 transition-colors duration-150 hover:bg-koda-fg/6 hover:text-koda-fg"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              ) : null}

              {(agents ?? []).length > 0 ? (
                <ul className="divide-y divide-koda-fg/8 border-t border-koda-fg/8">
                  {(agents ?? []).map((agente) => (
                    <li key={agente.nome} className="px-5 py-4">
                      <div className="flex items-center gap-2.5">
                        <Bot className="h-4 w-4 shrink-0 text-koda-fg/45" strokeWidth={1.7} />
                        <span className="min-w-0 truncate font-mono text-[13.5px] font-medium text-koda-fg/90">
                          {agente.nome}
                        </span>
                        <span className="ml-auto shrink-0 text-[11.5px] text-koda-fg/40">
                          {agente.skills.length} skill(s) · {agente.mcps.length} MCP(s)
                          {agente.modelo ? ` · ${agente.modelo}` : ''}
                        </span>
                        <button
                          type="button"
                          onClick={() => editarAgente(agente)}
                          className="shrink-0 rounded-lg px-2 py-1 text-[12px] text-koda-fg/55 transition-colors duration-150 hover:bg-koda-fg/8 hover:text-koda-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-koda-accent"
                        >
                          Editar
                        </button>
                        <button
                          type="button"
                          aria-label={`Apagar ${agente.nome}`}
                          title="Apagar"
                          onClick={() => void handleApagarAgente(agente.nome)}
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-koda-fg/40 transition-colors duration-150 hover:bg-red-500/12 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-koda-accent"
                        >
                          <X className="h-3.5 w-3.5" strokeWidth={1.9} />
                        </button>
                      </div>
                      {agente.prompt ? (
                        <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-5 text-koda-fg/45">
                          {agente.prompt}
                        </p>
                      ) : (
                        <p className="mt-1.5 text-[12.5px] text-amber-500/80">
                          Sem prompt: ele acorda sabendo só que é um sub-agente.
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              ) : formAgente ? null : (
                <div className="flex flex-col items-center gap-2 border-t border-koda-fg/8 px-5 py-10 text-center">
                  <Bot className="h-5 w-5 text-koda-fg/35" strokeWidth={1.7} />
                  <p className="text-[13.5px] font-medium text-koda-fg/80">Nenhum sub-agente</p>
                  <p className="max-w-sm text-[12.5px] leading-5 text-koda-fg/45">
                    Crie um em “Adicionar Agente”. O principal passa a poder lançá-lo pelo
                    nome — e ele não apaga nada nem sai da pasta do projeto.
                  </p>
                </div>
              )}
            </Card>
          ) : null}

          {section === 'mcps' ? (
            <Card
              title="Servidores MCP"
              description="Ferramentas externas que o agente usa pelo Model Context Protocol."
              action={
                <BotaoAdicionar
                  aberto={formMcp}
                  rotulo="Adicionar MCP"
                  onClick={() => (formMcp ? fecharFormMcp() : setFormMcp(true))}
                />
              }
            >
              {formMcp ? (
                <div className="flex flex-col gap-3.5 border-t border-koda-fg/8 px-5 py-4">
                  <Campo
                    label="Nome"
                    valor={mcpNome}
                    onChange={setMcpNome}
                    placeholder="ex.: filesystem"
                    obrigatorio
                    invalido={tentouMcp && !mcpNome.trim()}
                  />
                  <Campo
                    label="Comando / endpoint"
                    valor={mcpComando}
                    onChange={setMcpComando}
                    placeholder="ex.: npx  ou  https://meu-servidor/mcp"
                    obrigatorio
                    invalido={tentouMcp && !mcpComando.trim()}
                  />
                  <Campo
                    label="Parâmetros"
                    valor={mcpParams}
                    onChange={setMcpParams}
                    placeholder="ex.: -y @modelcontextprotocol/server-filesystem C:/tmp (opcional)"
                  />
                  {erroMcp ? (
                    <p className="text-[12.5px] leading-5 text-red-400">{erroMcp}</p>
                  ) : null}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleSalvarMcp}
                      disabled={salvandoMcp}
                      className="flex items-center gap-1.5 rounded-xl bg-koda-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-koda-bg transition-opacity duration-150 hover:opacity-90 disabled:opacity-50"
                    >
                      {salvandoMcp ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                      ) : (
                        <Check className="h-3.5 w-3.5" strokeWidth={2.2} />
                      )}
                      Salvar servidor
                    </button>
                    <button
                      type="button"
                      onClick={fecharFormMcp}
                      className="rounded-xl px-3 py-1.5 text-[12.5px] text-koda-fg/55 transition-colors duration-150 hover:bg-koda-fg/6 hover:text-koda-fg"
                    >
                      Cancelar
                    </button>
                    <span className="ml-auto text-[11.5px] text-koda-fg/35">
                      Os campos com <span className="text-koda-accent">*</span> são obrigatórios
                    </span>
                  </div>
                </div>
              ) : null}

              {mcps.length > 0 ? (
                <ul className="divide-y divide-koda-fg/8 border-t border-koda-fg/8">
                  {mcps.map((mcp) => (
                    <li key={mcp.name} className="px-5 py-4">
                      <div className="flex items-center gap-2.5">
                        <Cable className="h-4 w-4 shrink-0 text-koda-fg/45" strokeWidth={1.7} />
                        <span className="min-w-0 truncate text-[13.5px] font-medium text-koda-fg/90">
                          {mcp.name}
                        </span>
                        <span className="ml-auto shrink-0">
                          <StatusBadge
                            on={mcp.enabled}
                            ligado="Ativo"
                            desligado="Desativado"
                          />
                        </span>
                      </div>
                      {mcp.description ? (
                        <p className="mt-1.5 text-[12.5px] leading-5 text-koda-fg/45">
                          {mcp.description}
                        </p>
                      ) : null}
                      {/*
                        * O estado de **execução**: um servidor ligado mas que não subiu é a
                        * diferença entre "tem ferramenta" e "tem a promessa de uma". Sem
                        * esta linha, um comando errado parecia um servidor funcionando.
                        */}
                      {mcp.enabled ? (
                        mcp.conectado ? (
                          <p className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-emerald-400">
                            <Plug className="h-3.5 w-3.5" strokeWidth={1.9} />
                            conectado
                            <span className="text-koda-fg/35">
                              · {mcp.ferramentas}{' '}
                              {mcp.ferramentas === 1 ? 'ferramenta' : 'ferramentas'}
                            </span>
                          </p>
                        ) : (
                          <p className="mt-1.5 flex items-start gap-1.5 text-[11.5px] leading-4 text-amber-400/90">
                            <PlugZap className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.9} />
                            <span className="min-w-0 break-words">
                              fora do ar
                              {mcp.erro ? (
                                <span className="text-koda-fg/35"> · {mcp.erro}</span>
                              ) : null}
                            </span>
                          </p>
                        )
                      ) : null}
                      {mcp.command ? (
                        <p className="mt-1.5 truncate font-mono text-[11.5px] text-koda-fg/35">
                          {mcp.command}
                          {mcp.params ? ` ${mcp.params}` : ''}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : formMcp ? null : (
                <div className="flex flex-col items-center gap-2 border-t border-koda-fg/8 px-5 py-10 text-center">
                  <Cable className="h-5 w-5 text-koda-fg/35" strokeWidth={1.7} />
                  <p className="text-[13.5px] font-medium text-koda-fg/80">
                    Nenhum servidor configurado
                  </p>
                  <p className="max-w-sm text-[12.5px] leading-5 text-koda-fg/45">
                    Cadastre um servidor em “Adicionar MCP” — o Koda conecta nele e as
                    ferramentas dele entram no chat.
                  </p>
                </div>
              )}
            </Card>
          ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

export default SettingsScreen
