import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Download, Loader2, X } from 'lucide-react'
import Composer from './components/Composer'
import type { SendPayload } from './components/Composer'
import Header from './components/Header'
import type { ConversationSummary } from './components/Header'
import KodaLogo from './components/KodaLogo'
import LoginScreen from './components/LoginScreen'
import SettingsScreen from './components/SettingsScreen'
import MessageFooter from './components/MessageFooter'
import Reasoning from './components/Reasoning'
import BolhaUsuario from './components/BolhaUsuario'
import FalaDoModelo from './components/FalaDoModelo'
import { CLASSE_DA_JANELA } from './components/Janela'
import TarefaIncompleta from './components/TarefaIncompleta'
import ToDosMenu from './components/ToDos'
import ToolSteps from './components/ToolSteps'
import WorkingLine from './components/WorkingLine'
import {
  DENTRO_DO_TAURI,
  useAtalhosDaJanela,
  WindowControls,
} from './components/WindowControls'
import type { SettingsSection } from './components/SettingsScreen'
import ProjectPicker from './components/ProjectPicker'
import { findModel, MODELO_PADRAO } from './models'
import { EFFORT_PADRAO } from './effort'
import type { RemoteModel } from './models'
import { PLAN, dayKey, monthStart, weekStart } from './plan'
import { DEFAULT_APPEARANCE } from './appearance'
import type { Appearance } from './appearance'
import { contaGuardada, msAteRenovar, sair, sessaoAtual, sessaoParaOHost } from './api/cloud'
import type { Conta } from './api/cloud'
import {
  activateProject,
  answerApproval,
  apiUrl,
  baixarAtualizacao,
  cloudUpdate,
  definirSessaoDoHost,
  fetchUsage,
  fraseDeFalha,
  getConversation,
  health,
  listConversations,
  listMcps,
  listModels,
  listPermissions,
  listProjects,
  listSkills,
  newProject,
  releaseProject,
  setPermissionMode as salvarModoPermissao,
  statusDoDownload,
  streamChat,
  openProject,
  toggleMcp,
  toggleSkill,
} from './api/client'
import type {
  ApiCloudUpdate,
  ApiConversationSummary,
  ApiDownload,
  ApiMessage,
  ApiMcp,
  ApiProject,
  ApiSkill,
  ApiTodo,
  ApiUsage,
  DecisaoPermissao,
  Health,
  ModoPermissao,
  PedidoPermissao,
  ProjectsEstado,
  ToolStep,
} from './api/client'

type Message = {
  id: string
  role: 'user' | 'assistant'
  text: string
  attachments?: string[]
  /** Com qual modelo esta resposta foi feita — é a chave do medidor de contexto. */
  model?: string | null
  /** Tempo de processamento da resposta — vai para a ficha no fim dela. */
  elapsedMs?: number
  /** Tokens que a resposta custou, quando o provedor conta. */
  tokens?: number | null
  /**
   * Contexto do **último passo** da resposta, em tokens de entrada (`prompt_tokens`).
   *
   * É o número que o medidor ao lado do modelo mostra: vem do provedor, não de uma
   * estimativa do tamanho do texto.
   */
  contexto?: number | null
  /** Quando a mensagem entrou na sessão, para as cotas de uso. */
  at: number
  /** Ferramentas chamadas nesta resposta (modo agente). */
  steps?: ToolStep[]
  /**
   * O plano da resposta: a lista que o agente mantém em `update_todos`.
   *
   * Vai na mensagem (e não solta na tela) porque é o estado do trabalho: reabrir a
   * conversa depois mostra o que foi feito e o que faltou.
   */
  todos?: ApiTodo[]
  /**
   * O que o modelo pensou antes de escrever, quando ele pensa em voz alta.
   *
   * Vem em evento próprio e **não** faz parte da resposta: é o que evita a tela ficar
   * parada por minutos enquanto o modelo não escreve a primeira palavra. Aqui fica o
   * total (para saber que houve pensamento); onde ele aparece na resposta é `blocos`.
   */
  reasoning?: string
  /**
   * A resposta **na ordem em que chegou**: fala, ferramenta, fala, ferramenta.
   *
   * `text` e `steps` continuam sendo o que fica gravado e o que a cópia usa; isto aqui é
   * só a ordem para desenhar. Sem ela a tela juntava todas as ferramentas no topo e
   * empurrava a narração para baixo de todas — o contrário do que aconteceu de verdade.
   */
  blocos?: Bloco[]
  /**
   * A rodada terminou **sem** concluir o que foi pedido (`completed: false` no `done`).
   *
   * O backend só marca assim depois de esgotar as tentativas dele: ele cobra a ferramenta,
   * devolve o anúncio perdido ao histórico e retoma por conta própria antes de desistir. Se
   * a marca chegou, é porque sobrou trabalho de verdade — e é isso que faz a faixa de
   * "ainda falta terminar" aparecer no fim desta resposta, em vez de a pessoa ter que
   * descobrir sozinha e digitar "continue".
   *
   * Só vale para a rodada viva: não há coluna para isso no banco, então reabrir a conversa
   * depois não promete uma retomada que ninguém pode garantir.
   */
  incompleto?: boolean
}

/**
 * Um pedaço da resposta viva: o que o modelo pensou, o que ele falou, ou uma ferramenta
 * que ele rodou — na ordem em que aconteceu.
 */
type Bloco =
  | { tipo: 'texto'; texto: string }
  | { tipo: 'passo'; passo: ToolStep }
  | { tipo: 'raciocinio'; texto: string }

/** Anexa a fala ao último bloco de texto aberto, ou abre um novo. */
const anexarFala = (blocos: Bloco[] | undefined, texto: string): Bloco[] => {
  const lista = [...(blocos ?? [])]
  const ultimo = lista.at(-1)
  if (ultimo?.tipo === 'texto') {
    lista[lista.length - 1] = { tipo: 'texto', texto: ultimo.texto + texto }
  } else {
    lista.push({ tipo: 'texto', texto })
  }
  return lista
}

/**
 * Anexa o pensamento ao último bloco de raciocínio aberto, ou abre um novo.
 *
 * Raciocínio novo depois de uma ferramenta abre um bloco novo no lugar certo da
 * resposta: pensar, falar e rodar ferramenta continuam na ordem em que aconteceram.
 */
const anexarRaciocinio = (blocos: Bloco[] | undefined, texto: string): Bloco[] => {
  const lista = [...(blocos ?? [])]
  const ultimo = lista.at(-1)
  if (ultimo?.tipo === 'raciocinio') {
    lista[lista.length - 1] = { tipo: 'raciocinio', texto: ultimo.texto + texto }
  } else {
    lista.push({ tipo: 'raciocinio', texto })
  }
  return lista
}

/** Fecha, dentro dos blocos, o passo que o `steps` acabou de receber. */
const fecharPassoNosBlocos = (
  blocos: Bloco[] | undefined,
  patch: { id: string; output: string; duration_ms: number; ok: boolean },
): Bloco[] =>
  (blocos ?? []).map((bloco): Bloco =>
    bloco.tipo === 'passo' && bloco.passo.call_id === patch.id
      ? {
          tipo: 'passo',
          passo: {
            ...bloco.passo,
            output: patch.output,
            duration_ms: patch.duration_ms,
            ok: patch.ok,
          },
        }
      : bloco,
  )

const EASE = 'ease-[cubic-bezier(0.22,1,0.36,1)]'

/**
 * Rodando do fonte (`npm run app`, `npm run dev`)? Só aí a dica de subir a API na mão
 * faz sentido.
 *
 * O app instalado sobe o próprio serviço local — e mostrar `cd backend && uv run uvicorn`
 * para quem tem o Koda instalado foi o que transformou um `422` de validação numa tela
 * dizendo que o backend não subiu.
 */
const DO_FONTE = import.meta.env.DEV

/** Onde ver o que aconteceu, em cada mundo. */
const COMO_DIAGNOSTICAR = DO_FONTE
  ? 'Suba a API com `cd backend && uv run uvicorn app.main:app --port 8787`.'
  : 'Abra Ajustes › Servidor e clique em «Ver diagnóstico».'

const newId = () => crypto.randomUUID()

type Conversation = {
  id: string
  title: string
  preview: string
  /** Vazio quando a conversa veio do servidor e ainda não foi aberta. */
  messages: Message[]
}

/** Tamanho de arquivo para a barra do download (instalador é coisa de dezenas de MB). */
const formatSize = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

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
      payload.project_path ? `pasta ${payload.project_path}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
  ]

  if (payload.attachments.length > 0) {
    blocks.push(`Anexos recebidos: ${payload.attachments.join(', ')}.`)
  }


  blocks.push(
    DO_FONTE
      ? `Suba a API para ter resposta de verdade e histórico no banco: \`cd backend && uv run uvicorn app.main:app --port 8787\` (esperado em ${apiUrl}).`
      : `O serviço local do Koda (esperado em ${apiUrl}) não respondeu. ${COMO_DIAGNOSTICAR}`,
  )

  return blocks.join('\n\n')
}

/**
 * Versão dispensada nesta máquina. O aviso é chato de nascença, então ele não
 * volta a cada abertura — só quando aparecer uma versão diferente da dispensada.
 */
const CHAVE_AVISO_DISPENSADO = 'koda.aviso-versao'

const lerVersaoDispensada = (): string | null => {
  try {
    return window.localStorage.getItem(CHAVE_AVISO_DISPENSADO)
  } catch {
    // Sem localStorage (janela privada, armazenamento bloqueado): o aviso volta sempre.
    return null
  }
}

/**
 * Aviso de versão nova, flutuando no canto de baixo à direita da janela — fora do
 * caminho do prompt box, na área vazia da tela. Ele não consulta nada: usa o resumo
 * da nuvem que já veio no `/api/health`, e quem quer o resto (notas, canal, download)
 * vai para Ajustes › Nuvem, que é quem fala com a nuvem de verdade.
 */
function AvisoDeAtualizacao({
  versao,
  link,
  download,
  onBaixar,
  onVerDetalhes,
  onDispensar,
}: {
  versao: string
  link: string | null
  download: ApiDownload | null
  onBaixar: () => void
  onVerDetalhes: () => void
  onDispensar: () => void
}) {
  const baixando = download?.estado === 'baixando'
  const concluido = download?.estado === 'concluido'
  const total = download?.total ?? null
  const percentual =
    total && total > 0 && download
      ? Math.min(100, Math.round((download.recebido / total) * 100))
      : 8

  return (
    <div className="msg-in fixed right-6 bottom-6 z-40">
      {/* Cartão em pé, não uma faixa deitada: cabeça com a coroa e o X, o texto
          embaixo e as ações empilhadas na largura toda.

          Vidro: o fundo é translúcido e o que estiver atrás (o prompt box, a conversa)
          aparece desfocado através dele. O degradê por cima é o brilho da chapa —
          `koda-fg` vira escuro no tema claro e claro no escuro, então serve nos dois. */}
      <div
        className={[
          'w-60 rounded-2xl p-4 backdrop-blur-2xl backdrop-saturate-150',
          'bg-koda-surface/55 bg-gradient-to-b from-koda-fg/6 to-transparent',
          'ring-1 ring-koda-fg/12',
          'shadow-[0_28px_60px_-24px_var(--koda-shadow)]',
        ].join(' ')}
      >
        <div className="flex items-start justify-between gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-koda-accent/15">
            {/* A coroa da casa, não um ícone genérico: o aviso é do Koda. */}
            <KodaLogo className="h-4 w-auto" />
          </span>

          <button
            type="button"
            aria-label="Dispensar aviso de atualização"
            title="Dispensar"
            onClick={onDispensar}
            className="-mt-1 -mr-1 flex h-7 w-7 items-center justify-center rounded-lg text-koda-fg/45 transition-colors duration-150 hover:bg-koda-fg/8 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </div>

        <p className="mt-3 text-[13.5px] leading-5 font-semibold text-koda-fg">
          Koda v{versao} está disponível
        </p>
        <p className="mt-1 text-[12.5px] leading-5 text-koda-fg/50">
          Versão mais nova publicada na nuvem. Nada é baixado sem você pedir.
        </p>

        {baixando ? (
          <div className="mt-3.5 flex flex-col gap-2">
            <div className="flex items-center gap-2 text-[12.5px] text-koda-fg/75">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-koda-accent" strokeWidth={2} />
              Baixando{total ? null : ' o instalador…'}
              <span className="ml-auto shrink-0 font-mono text-[11.5px] text-koda-fg/50">
                {total ? `${percentual}% · ${formatSize(total)}` : formatSize(download?.recebido ?? 0)}
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
              {download?.arquivo ?? 'koda-setup.exe'}
            </p>
          </div>
        ) : (
          <div className="mt-3.5 flex flex-col gap-1.5">
            {download?.estado === 'erro' ? (
              <p className="px-0.5 text-[12px] leading-4 text-red-400">{download.erro}</p>
            ) : null}
            {link ? (
              <button
                type="button"
                onClick={onBaixar}
                className="flex items-center justify-center gap-1.5 rounded-xl bg-koda-accent-strong px-3 py-2 text-[13px] font-medium text-white transition-colors duration-150 hover:bg-koda-accent-strong/85 focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
              >
                <Download className="h-3.5 w-3.5" strokeWidth={2} />
                Baixar
              </button>
            ) : null}
            <button
              type="button"
              onClick={onVerDetalhes}
              className={[
                'rounded-xl px-3 py-2 text-[13px] font-medium transition-colors duration-150',
                'focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none',
                // Sem link de download, o caminho principal passa a ser Ajustes › Nuvem.
                link
                  ? 'bg-koda-fg/8 text-koda-fg/85 ring-1 ring-koda-fg/10 hover:bg-koda-fg/12 hover:text-koda-fg'
                  : 'bg-koda-accent-strong text-white hover:bg-koda-accent-strong/85',
              ].join(' ')}
            >
              Ver novidades
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * A caixinha do canto: o aviso de que a conversa está no servidor local, em duas doses.
 *
 * `reconectando` é o caso comum e não pede nada de ninguém — a própria tela está tentando de
 * novo, e o aviso só existe para a resposta que chegar agora não parecer a de verdade.
 * `morta` é o caso em que o painel recusou a sessão: aí sim a única saída é entrar de novo,
 * e o aviso diz isso com todas as letras em vez de mandar tentar de novo à toa.
 */
function AvisoDaSessao({
  estado,
  motivo,
  onEntrar,
}: {
  estado: 'reconectando' | 'morta'
  motivo?: string | null
  onEntrar: () => void
}) {
  const morta = estado === 'morta'

  return (
    <div className="msg-in fixed right-6 bottom-6 z-40" role="status">
      <div
        className={[
          'w-60 rounded-2xl p-4 backdrop-blur-2xl backdrop-saturate-150',
          'bg-koda-surface/55 bg-gradient-to-b from-koda-fg/6 to-transparent',
          'ring-1 ring-koda-fg/12',
          'shadow-[0_28px_60px_-24px_var(--koda-shadow)]',
        ].join(' ')}
      >
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-koda-accent/15">
          <KodaLogo className="h-4 w-auto" />
        </span>

        <p className="mt-3 text-[13.5px] leading-5 font-semibold text-koda-fg">
          {morta ? 'Sem os modelos da sua conta' : 'Reconectando ao serviço de modelos'}
        </p>
        <p className="mt-1 text-[12.5px] leading-5 text-koda-fg/50">
          {morta
            ? // O que o painel disse manda: conta bloqueada e sessão vencida pedem coisas
              // diferentes de quem está lendo.
              motivo ||
              'Esta sessão não vale mais para o serviço de modelos. Entre de novo para voltar aos modelos do Koda — com ferramentas.'
            : 'Enquanto isso a resposta sai do servidor local: sem modelo de verdade e sem ferramentas. Tentando de novo sozinho.'}
        </p>

        {morta ? (
          <div className="mt-3.5 flex flex-col gap-2">
            <button
              type="button"
              onClick={onEntrar}
              className="rounded-xl bg-koda-accent-strong px-3 py-2 text-[13px] font-medium text-white transition-colors duration-150 hover:bg-koda-accent-strong/85 focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
            >
              Entrar de novo
            </button>
          </div>
        ) : (
          <p className="mt-3 flex items-center gap-2 text-[12px] text-koda-fg/40">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-koda-accent" strokeWidth={1.8} />
            tentando agora
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * O que a janela mostra no instante entre abrir e saber se há sessão.
 *
 * É curto de propósito: com a sessão guardada esta tela passa voando, e com o login
 * pendente quem chega em seguida é a tela de entrar. Vale mais do que um quadro branco.
 */
function Abertura() {
  return (
    <div className={CLASSE_DA_JANELA}>
      <div data-tauri-drag-region className="flex shrink-0 items-center p-5">
        <div className="-mr-2 ml-auto">
          <WindowControls />
        </div>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 pb-20">
        <KodaLogo className="h-10 w-auto" />
        <p className="text-[13px] text-koda-fg/40">abrindo o Koda…</p>
      </div>
    </div>
  )
}

const fromApiMessage = (message: ApiMessage): Message => ({
  id: message.id,
  role: message.role,
  text: message.text,
  attachments: message.attachments,
  model: message.model,
  elapsedMs: message.elapsed_ms ?? undefined,
  tokens: message.tokens,
  contexto: message.contexto,
  at: message.at,
  steps: message.steps,
  todos: message.todos ?? [],
})

const fromApiSummary = (conversation: ApiConversationSummary): Conversation => ({
  id: conversation.id,
  title: conversation.title,
  preview: conversation.preview,
  messages: [],
})

/**
 * Quanto a tela insiste em falar com o backend local antes de desistir.
 *
 * O app abre a janela **sem esperar** os serviços (ver `src-tauri/src/main.rs`), e o
 * Python empacotado leva segundos para atender a 8787. Primeiro de segundo em segundo,
 * pelo mesmo prazo que o lado Rust dá antes de chamar o backend de offline; depois mais
 * devagar, de cinco em cinco segundos, até completar perto de seis minutos — partida a
 * frio em máquina lenta não pode virar "modo offline" para sempre.
 */
const ESPERA_BACKEND_MS = 1000
const TENTATIVAS_BACKEND = 40
const ESPERA_BACKEND_LENTA_MS = 5000
const TENTATIVAS_BACKEND_LENTAS = 60

/** Uma rodada de leitura no servidor: estado, cotas, histórico, conta, skills e MCPs. */
async function loadSession() {
  const [info, usage, conversations, models, skills, mcps] = await Promise.all([
    health(),
    fetchUsage(),
    listConversations(),
    listModels(),
    listSkills(),
    listMcps(),
  ])
  return { info, usage, conversations, models, skills, mcps }
}

function App() {
  const [messages, setMessages] = useState<Message[]>([])
  const [busy, setBusy] = useState(false)
  /**
   * Como está a credencial da conta no serviço de modelos.
   *
   * Existe porque "respondendo pelo servidor local" tinha um único aviso para situações
   * bem diferentes: rede caindo (que se resolve sozinho em segundos) e sessão recusada pelo
   * painel (que só um login novo resolve). Com um aviso só, a tela mandava a pessoa tentar
   * de novo até quando não havia o que tentar.
   */
  const [credencial, setCredencial] = useState<
    'enviando' | 'pronto' | 'voltando' | 'morta' | 'sem-sessao'
  >('enviando')
  /** Por que a sessão morreu, na voz do painel — é o texto que o aviso mostra. */
  const [motivoDaSessao, setMotivoDaSessao] = useState<string | null>(null)
  /**
   * Relógio de 400 ms enquanto a resposta está em curso.
   *
   * É ele que faz a linha de trabalho contar os segundos (a prova de que ninguém travou) e
   * que decide, olhando o último sinal, se o modelo está calado — ou seja, se a linha
   * precisa aparecer.
   */
  const [agora, setAgora] = useState(() => Date.now())
  const [interrupted, setInterrupted] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  /** Pastas de verdade: o projeto é sempre uma pasta do disco, com o caminho salvo. */
  const [projects, setProjects] = useState<ApiProject[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [pastaPadrao, setPastaPadrao] = useState('')
  const [pastasAberto, setPastasAberto] = useState(false)
  const [ocupadoPastas, setOcupadoPastas] = useState(false)
  const [erroPastas, setErroPastas] = useState<string | null>(null)
  /** Quanto o agente pode fazer sozinho (`manual` pergunta tudo que mexe na máquina). */
  const [permissionMode, setPermissionMode] = useState<ModoPermissao>('default')
  // F11 liga/desliga a tela cheia: a janela não tem barra de título, então a tecla não
  // tem quem a trate por conta própria.
  useAtalhosDaJanela()
  const [permissaoPendente, setPermissaoPendente] = useState<PedidoPermissao | null>(null)
  const [respondendoPermissao, setRespondendoPermissao] = useState(false)
  const [erroPermissao, setErroPermissao] = useState<string | null>(null)
  /** Números da rodada (uso, tempo, hora) na ficha no fim de cada resposta. */
  const [mostrarRodape, setMostrarRodape] = useState(true)
  const [history, setHistory] = useState<Conversation[]>([])
  const [view, setView] = useState<'chat' | 'settings'>('chat')
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('geral')
  const [model, setModel] = useState(MODELO_PADRAO)
  const [appearance, setAppearance] = useState<Appearance>(DEFAULT_APPEARANCE)
  /** Porta de entrada: enquanto não se sabe se há sessão, o app não aparece. */
  const [sessao, setSessao] = useState<'checando' | 'dentro' | 'fora'>('checando')
  /** Conta logada (do painel). `null` = ninguém entrou ainda. */
  const [conta, setConta] = useState<Conta | null>(contaGuardada)
  /** `null` = backend fora do ar: as respostas voltam a ser simuladas no navegador. */
  const [backend, setBackend] = useState<Health | null>(null)
  /** Cada clique em "tentar de novo" no aviso de sessão roda o envio na hora. */
  const [tentativaDeSessao, setTentativaDeSessao] = useState(0)
  const [remoteUsage, setRemoteUsage] = useState<ApiUsage | null>(null)
  /** Catálogo do provedor (o serviço lista os modelos dele em /v1/models). */
  const [remoteModels, setRemoteModels] = useState<RemoteModel[]>([])
  /** Skills instaladas (o backend lê `.agents/skills` do projeto e da máquina). */
  const [skills, setSkills] = useState<ApiSkill[]>([])
  /** Servidores MCP configurados (o Koda ainda não conecta nenhum de verdade). */
  const [mcps, setMcps] = useState<ApiMcp[]>([])
  /** Versão que a pessoa já dispensou no aviso do canto. */
  const [versaoDispensada, setVersaoDispensada] = useState<string | null>(
    lerVersaoDispensada,
  )
  /** Download do instalador em curso (vem do backend local, não de outra requisição). */
  const [download, setDownload] = useState<ApiDownload | null>(null)
  /** Resultado da consulta que a tela faz à nuvem ao abrir (além do resumo do health). */
  const [nuvemDetalhe, setNuvemDetalhe] = useState<ApiCloudUpdate | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  /** Último sinal de vida vindo do backend (pensamento, palavra, ferramenta). */
  const ultimoSinalRef = useRef(0)
  /** Quando a resposta em curso começou (a linha de trabalho conta a partir daqui). */
  const inicioDaRespostaRef = useRef(0)
  const timersRef = useRef<number[]>([])
  const runIdRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const conversationIdRef = useRef<string | null>(null)
  /**
   * O último pedido que saiu daqui, inteiro (modelo, reasoning, web, esforço, pasta).
   *
   * É com ele que "rodar de novo" remonta um pedido sem adivinhar ajuste nenhum: o que
   * volta é exatamente o que a pessoa tinha escolhido na última vez.
   */
  const ultimoPayloadRef = useRef<SendPayload | null>(null)

  const hasMessages = messages.length > 0
  const normalizedQuery = query.trim().toLowerCase()
  const searching = searchOpen && normalizedQuery.length > 0
  const lastMessage = messages.at(-1)
  /**
   * O plano em vigor, para o menu acima do prompt box.
   *
   * Manda a última resposta: enquanto ela está viva, a lista chega por `onTodos` e vai
   * mudando na hora; terminada a tarefa, ela fica ali para dizer o que foi feito. Não é
   * mais pintada dentro da conversa — ela é o estado do trabalho, não uma fala.
   */
  /**
   * Contexto medido por modelo: o do **último** passo da última resposta de cada um.
   *
   * Percorrendo na ordem, a mensagem mais nova sobrescreve a anterior — é o retrato do
   * agora, e não a soma de tudo o que já passou. O modelo que ainda não respondeu nesta
   * conversa fica sem medida (anel vazio), em vez de herdar o número de outro.
   */
  const contextoPorModelo = useMemo(() => {
    const mapa: Record<string, number> = {}
    for (const mensagem of messages) {
      if (mensagem.role !== 'assistant' || !mensagem.model || !mensagem.contexto) continue
      mapa[mensagem.model] = mensagem.contexto
    }
    return mapa
  }, [messages])

  /** O teto que o backend aplica à conversa — o denominador do anel. */
  const janelaDoContexto = useMemo(() => {
    const doBackend = backend?.contexto_tokens ?? 0
    if (doBackend > 0) return doBackend
    const doCatalogo = remoteModels.find((item) => item.janela)?.janela ?? null
    return doCatalogo ?? null
  }, [backend, remoteModels])

  const todosAtivos = useMemo(() => {
    const ultima = [...messages].reverse().find((message) => message.role === 'assistant')
    return ultima?.todos ?? []
  }, [messages])
  /**
   * A resposta que está sendo escrita agora: a última mensagem, ainda sem tempo de
   * processamento. É nela que a linha de trabalho mora.
   */
  const viva =
    busy && lastMessage?.role === 'assistant' && !lastMessage.elapsedMs ? lastMessage : null
  /**
   * Ainda não há resposta nenhuma para acompanhar (a do assistente nem foi criada): a
   * mesma linha de trabalho aparece solta na conversa.
   */
  const waiting = busy && viva === null
  /**
   * Faz mais de 800 ms que nenhum sinal chega do backend. Pensar, falar e rodar ferramenta
   * deixam rastro; o silêncio é justamente o buraco em que a tela parecia parada — o modelo
   * lendo o resultado da ferramenta, montando o próximo passo, ou pensando antes da
   * primeira palavra.
   */
  const quieto = busy && agora - ultimoSinalRef.current > 800
  /** Ferramenta anunciada e ainda sem resultado: a coisa mais concreta a dizer na linha. */
  const passoEmCurso =
    viva === null
      ? null
      : ([...(viva.steps ?? [])]
          .reverse()
          .find((step) => step.output === '' && step.duration_ms === 0) ?? null)
  const segundosDaResposta = Math.max(
    0,
    Math.round((agora - (viva?.at ?? inicioDaRespostaRef.current)) / 1000),
  )
  /**
   * Versão publicada na nuvem que ainda não foi dispensada (senão, `null`).
   *
   * O resumo do health é memória do backend: numa sessão nova ele ainda não consultou a
   * nuvem e o aviso não teria como aparecer. Por isso a consulta de verdade (a que a tela
   * dispara ao abrir) tem prioridade sobre o resumo.
   */
  const nuvem = backend?.cloud ?? null
  const atualizacaoNuvem = nuvemDetalhe?.atualizacao ?? null
  const versaoPublicada = atualizacaoNuvem?.latest_version ?? nuvem?.latest_version ?? null
  const temVersaoNova = atualizacaoNuvem?.update_available ?? nuvem?.update_available ?? false
  const linkDownload = atualizacaoNuvem?.download_url ?? nuvem?.download_url ?? null
  /**
   * O aviso é coisa do app instalado: só lá ele faz sentido (baixar instalador e trocar
   * de versão). No navegador — Vite puro, preview — ele polui uma tela que não vai se
   * atualizar, então nem aparece.
   */
  const versaoNova =
    DENTRO_DO_TAURI && temVersaoNova && versaoPublicada && versaoPublicada !== versaoDispensada
      ? versaoPublicada
      : null

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

  // Enquanto a resposta está em curso, um relógio de 400 ms move a linha de trabalho: os
  // segundos correndo são o que distingue "está trabalhando" de "travou".
  useEffect(() => {
    if (!busy) return
    const timer = window.setInterval(() => setAgora(Date.now()), 400)
    return () => window.clearInterval(timer)
  }, [busy])

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

  // A primeira pergunta da vida do app é quem está aqui. Sem conta, o resto não abre — é
  // isso que faz o login ser obrigatório de verdade, e não uma tela decorativa.
  useEffect(() => {
    let cancelado = false
    void sessaoAtual()
      .then((logada) => {
        if (cancelado) return
        setConta(logada)
        setSessao(logada ? 'dentro' : 'fora')
      })
      .catch(() => {
        if (!cancelado) setSessao('fora')
      })
    return () => {
      cancelado = true
    }
  }, [])

  // A conta logada **é** a credencial dos modelos: o app não guarda chave de API nenhuma.
  // O front manda a sessão ao backend, o backend a apresenta ao host, e o host pergunta ao
  // painel se ela vale — daí o modelo só responder para quem está logado. Sair limpa a
  // credencial e o host volta a recusar. O nome e o e-mail vão junto para o assistente
  // saber com quem está falando.
  //
  // Reenvia quando a credencial estiver perto de vencer (`msAteRenovar` conta pelo prazo do
  // próprio token) e quando o backend aparece, porque um backend que subiu antes do login
  // precisa ser avisado. Sem isso a conversa morreria no meio do dia pedindo para entrar de
  // novo — ou pior: continuaria respondendo pelo servidor local sem avisar.
  const backendPronto = backend !== null

  /**
   * Espera até reenviar a sessão, a partir do que a credencial ainda tem de prazo.
   *
   * O teto de dez minutos é o tempo que o host confia numa credencial antes de perguntar ao
   * painel de novo: acima disso, o backend guardaria uma credencial que o host já esqueceu.
   * O piso evita laço de requisição quando o relógio diz que já passou da hora.
   */
  const esperaAteRenovar = (falta: number | null): number =>
    falta === null ? 10 * 60 * 1000 : Math.min(10 * 60 * 1000, Math.max(30 * 1000, falta))

  /**
   * Espera entre as tentativas quando a credencial não chegou ao backend.
   *
   * Os primeiros segundos são de rede e de host acordando, não de sessão: tentar rápido no
   * começo e espaçar depois resolve sozinho o caso comum (a janela abriu antes do host
   * responder) sem martelar o painel no caso ruim.
   */
  const esperaDaTentativa = (tentativa: number): number =>
    [2_000, 5_000, 10_000, 20_000, 30_000][Math.min(tentativa, 4)]

  /**
   * Logada e mesmo assim respondendo pelo servidor local.
   *
   * É o sintoma mais enganoso que este app tem: conta no lugar, nuvem conectada, resposta
   * chegando — e o modelo de verdade nunca foi chamado, porque a sessão que autoriza o
   * serviço de modelos não vale mais (expirou, foi revogada) ou foi recusada. Sem dizer
   * isso na tela, quem usa não tem como saber que está falando sozinho.
   */
  const semModeloDaConta =
    sessao === 'dentro' && backend !== null && backend.provider === 'local'

  // Reentregar a mesma credencial que o backend já aceitou não muda nada lá e ainda
  // gasta uma sonda no host: o laço pula. Quando o backend cai e volta, ele esquece o que
  // tinha (a credencial mora na memória dele) — é o efeito de baixo que zera isto e manda
  // a credencial de novo, sem esperar o ciclo.
  const tokenEntregueRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelado = false
    let timer: number | undefined
    let tentativa = 0

    const agendar = (ms: number) => {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(() => void rodar(), ms)
    }

    /** Chega mais perto a próxima tentativa e agenda: quem falhou tenta de novo sozinho. */
    const insistir = () => {
      tentativa += 1
      agendar(esperaDaTentativa(tentativa))
    }

    const rodar = async () => {
      // Enquanto não se sabe quem está aqui, não manda nada: "vazio" é o backend entendendo
      // "ninguém logado", e largar a conta por um instante no meio da abertura é justamente
      // o que derruba a conversa para o servidor local.
      if (sessao === 'checando') return

      // Sem conta não há credencial para apresentar: a chamada limpa o que estiver no
      // backend — é isso que acontece ao sair da conta.
      if (sessao === 'fora') {
        await definirSessaoDoHost(null, null).catch(() => {})
        if (!cancelado) setCredencial('sem-sessao')
        return
      }

      const credencial = await sessaoParaOHost()
      if (cancelado) return

      // A conta não existe mais nesta máquina: a tela volta para o login.
      if (credencial.estado === 'sem-sessao') {
        setConta(null)
        setSessao('fora')
        return
      }

      // **Nada de mandar vazio.** Vazio quer dizer "ninguém está logado", e o backend
      // obedecia: largava a conta e passava a responder pelo servidor local — sem modelo de
      // verdade e sem ferramentas — enquanto a tela continuava parecendo normal, com a conta
      // no lugar e a nuvem conectada. Por isso cada caso abaixo tem a sua saída, e nenhuma
      // delas é entregar o backend sem credencial.
      //
      // O painel recusou a renovação: a sessão morreu (expirou, foi revogada, a conta foi
      // barrada). Não há o que tentar sozinho — quem resolve é entrar de novo, e é isso que
      // o aviso da tela passa a dizer.
      if (credencial.estado === 'morta') {
        setCredencial('morta')
        setMotivoDaSessao(credencial.motivo)
        agendar(esperaDaTentativa(20))
        return
      }

      // O painel não foi alcançado: é rede. Tentar de novo é exatamente o certo.
      if (credencial.estado === 'sem-rede') {
        setCredencial('voltando')
        insistir()
        return
      }

      if (tokenEntregueRef.current === credencial.token) {
        setCredencial('pronto')
        tentativa = 0
        agendar(esperaAteRenovar(msAteRenovar()))
        return
      }

      try {
        const estado = await definirSessaoDoHost(credencial.token, conta)
        if (cancelado) return
        // O backend reescolheu o provider agora: a tela fica sabendo na hora. É o que faz
        // o aviso de "sem os modelos da conta" aparecer e desaparecer no mesmo segundo.
        setBackend((atual) =>
          atual === null
            ? atual
            : {
                ...atual,
                provider: estado.provider,
                provider_ready: estado.provider_ready,
                tools_ready: estado.tools_ready,
              },
        )

        // A credencial chegou, mas o host ainda não respondeu por ela (o host confere no
        // painel na primeira vez, e isso leva um instante): insistir aqui é o que faz a
        // conversa voltar sozinha em segundos, sem ninguém clicar em nada.
        if (estado.provider === 'local') {
          setCredencial('voltando')
          insistir()
          return
        }

        tokenEntregueRef.current = credencial.token
        setCredencial('pronto')
        tentativa = 0
        // Pronto: a próxima volta é quando a credencial estiver perto de vencer. O teto é o
        // tempo que o host confia numa credencial antes de perguntar ao painel de novo.
        agendar(esperaAteRenovar(msAteRenovar()))
      } catch {
        // Backend fora do ar, ou ainda subindo: a próxima volta resolve, sem barulho.
        setCredencial('voltando')
        insistir()
      }
    }

    // A máquina dorme, a janela fica escondida por horas, a rede cai e volta: em todos
    // esses casos a credencial do backend pode ter vencido. Voltar é motivo para renovar e
    // reenviar na hora, sem esperar o ciclo.
    const aoVoltar = () => {
      if (document.visibilityState === 'visible') void rodar()
    }
    const aoVoltarARede = () => void rodar()

    void rodar()
    document.addEventListener('visibilitychange', aoVoltar)
    window.addEventListener('online', aoVoltarARede)
    window.addEventListener('focus', aoVoltarARede)
    return () => {
      cancelado = true
      document.removeEventListener('visibilitychange', aoVoltar)
      window.removeEventListener('online', aoVoltarARede)
      window.removeEventListener('focus', aoVoltarARede)
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [sessao, backendPronto, conta, tentativaDeSessao])

  // Já tínhamos a credencial entregue e o backend voltou a responder pelo servidor local —
  // o processo dele subiu de novo, por exemplo, e a credencial que morava na memória dele
  // foi embora junto. Reentrega agora, sem esperar o ciclo de dez minutos: é a diferença
  // entre a conversa voltar sozinha e a conversa ficar sem ferramentas sem ninguém saber.
  useEffect(() => {
    if (!semModeloDaConta || credencial !== 'pronto') return
    tokenEntregueRef.current = null
    const timer = window.setTimeout(() => setTentativaDeSessao((atual) => atual + 1), 1_500)
    return () => window.clearTimeout(timer)
  }, [semModeloDaConta, credencial])

  // Com a conta em pé, pergunta ao backend se ele está de pé. Se estiver, a sessão passa a
  // ser dele: histórico, cotas e conta vêm do SQLite.
  //
  // A pergunta se repete enquanto ele não responder. Antes era uma tentativa só, disparada
  // assim que a conta voltava: como o backend sobe em paralelo com a janela, a primeira
  // chamada chegava antes de a porta 8787 abrir e a sessão inteira ficava em modo offline
  // — era o que fazia a tela de Nuvem dizer "sem resposta" e "sua versão: —" mesmo com
  // tudo funcionando. Desistir agora leva 40 s, e uma queda depois (backend que morre no
  // meio do uso) volta a cair neste mesmo laço.
  useEffect(() => {
    if (sessao !== 'dentro' || backend !== null) return
    let cancelled = false
    let timer: number | undefined

    const connect = async (tentativa: number) => {
      try {
        const { info, usage, conversations, models, skills, mcps } = await loadSession()
        if (cancelled) return
        setBackend(info)
        setRemoteUsage(usage)
        setHistory(conversations.map(fromApiSummary))
        setRemoteModels(models)
        setSkills(skills)
        setMcps(mcps)
        // As pastas e a permissão vivem no banco do backend: é o que ele tem, não o que a
        // tela lembra.
        void carregarPastas()
      } catch {
        if (cancelled) return
        setBackend(null)
        const proxima = tentativa + 1
        if (proxima <= TENTATIVAS_BACKEND) {
          timer = window.setTimeout(() => void connect(proxima), ESPERA_BACKEND_MS)
        } else if (proxima <= TENTATIVAS_BACKEND + TENTATIVAS_BACKEND_LENTAS) {
          timer = window.setTimeout(() => void connect(proxima), ESPERA_BACKEND_LENTA_MS)
        }
      }
    }

    void connect(0)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [sessao, backend])

  // Contagem local, usada quando não há backend (e como base do modo offline).
  const usageCounts = useMemo(() => {
    const all = [...history.flatMap((conversation) => conversation.messages), ...messages]
    const today = dayKey(new Date())
    const weekFrom = weekStart().getTime()
    const monthFrom = monthStart().getTime()
    // O mapa do ano sem backend: o mesmo cálculo por dia, com o que está na tela.
    const dias: Record<string, number> = {}
    for (const message of all) {
      const key = dayKey(new Date(message.at))
      dias[key] = (dias[key] ?? 0) + 1
    }
    return {
      messages: all.length,
      todayMessages: all.filter((message) => dayKey(new Date(message.at)) === today).length,
      weekMessages: all.filter((message) => message.at >= weekFrom).length,
      monthMessages: all.filter((message) => message.at >= monthFrom).length,
      conversations: history.length + (messages.length > 0 ? 1 : 0),
      dias,
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

  // O aviso de versão nova depende de alguém ter consultado a nuvem. Numa sessão nova,
  // ninguém consultou: a tela pergunta ao abrir (e o backend guarda o resultado por 15
  // minutos, então isso não vira consulta a cada render).
  useEffect(() => {
    if (!DENTRO_DO_TAURI) return
    cloudUpdate()
      .then(setNuvemDetalhe)
      .catch(() => {
        // Sem backend local, ou nuvem fora do ar: o health responde o que já sabe.
      })
  }, [])

  // Enquanto o backend baixa o instalador, a tela pergunta de tempos em tempos: é o que
  // faz a barra andar e o "salvo" aparecer sem o usuário ter de mexer em nada.
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

  const openSettings = (section: SettingsSection = 'geral') => {
    setSettingsSection(section)
    setView('settings')
  }

  const dispensarAviso = () => {
    if (!versaoNova) return
    setVersaoDispensada(versaoNova)
    try {
      window.localStorage.setItem(CHAVE_AVISO_DISPENSADO, versaoNova)
    } catch {
      // Sem localStorage: a dispensa vale só para esta sessão.
    }
  }

  /**
   * Baixar o instalador é do backend local: ele pega o link que a nuvem publicou e grava
   * o arquivo na pasta de downloads. A tela só acompanha — nada de mandar o usuário para
   * fora do app (foi assim que o arquivo acabou caindo num "salvar como" do navegador).
   */
  const handleBaixar = () => {
    const alvo = linkDownload
    baixarAtualizacao()
      .then(setDownload)
      .catch(() => {
        // Backend local antigo (sem a rota) ou fora do ar: sobra o caminho de antes.
        if (alvo) window.open(alvo, '_blank', 'noopener')
        else
          setDownload({
            estado: 'erro',
            recebido: 0,
            total: null,
            arquivo: null,
            pasta: null,
            caminho: null,
            versao: null,
            erro: 'não consegui falar com o backend local',
          })
      })
  }

  /**
   * Liga/desliga uma skill no submenu do menu: vira na hora na tela e confirma com
   * o backend; se ele falhar, volta para como estava.
   */
  const handleToggleSkill = (name: string) => {
    const anteriores = skills
    setSkills(
      skills.map((item) => (item.name === name ? { ...item, enabled: !item.enabled } : item)),
    )
    toggleSkill(name)
      .then((atualizada) =>
        setSkills((current) =>
          current.map((item) => (item.name === name ? atualizada : item)),
        ),
      )
      .catch(() => setSkills(anteriores))
  }

  /** Mesma régua do toggle de skills, para servidores MCP. */
  const handleToggleMcp = (name: string) => {
    const anteriores = mcps
    setMcps(mcps.map((item) => (item.name === name ? { ...item, enabled: !item.enabled } : item)))
    toggleMcp(name)
      .then((atualizado) =>
        setMcps((current) => current.map((item) => (item.name === name ? atualizado : item))),
      )
      .catch(() => setMcps(anteriores))
  }

  /**
   * O que a interface precisa saber das pastas e da permissão, vindo sempre do backend.
   *
   * Nada de pasta inventada na tela: a lista e a pasta aberta são as que estão salvas no
   * SQLite — é isso que faz o caminho completo sobreviver a fechar o app, e valer em
   * qualquer PC.
   */
  const aplicarPastas = (estado: ProjectsEstado) => {
    setProjects(estado.projetos)
    setProjectId(estado.ativo_id)
    setPastaPadrao(estado.padrao)
    setPermissionMode(estado.permissao)
  }

  // Declaração de função (e não `const`): o efeito de conexão chama isto antes da linha
  // onde ele é escrito, e uma função declarada existe desde o começo do componente.
  async function carregarPastas() {
    try {
      const [estado, permissoes] = await Promise.all([listProjects(), listPermissions()])
      aplicarPastas(estado)
      setPermissionMode(permissoes.modo)
    } catch {
      // Backend fora do ar: sem pasta salva, e a permissão segue no padrão da tela.
    }
  }

  const escolherPasta = async (caminho: string) => {
    setOcupadoPastas(true)
    setErroPastas(null)
    try {
      aplicarPastas(await openProject(caminho))
      setPastasAberto(false)
    } catch (falha) {
      setErroPastas(
        falha instanceof Error ? falha.message : 'Não consegui abrir essa pasta.',
      )
    } finally {
      setOcupadoPastas(false)
    }
  }

  const criarPasta = async (pastaPai: string, nome: string) => {
    setOcupadoPastas(true)
    setErroPastas(null)
    try {
      aplicarPastas(await newProject(pastaPai, nome))
      setPastasAberto(false)
    } catch (falha) {
      setErroPastas(
        falha instanceof Error ? falha.message : 'Não consegui criar essa pasta.',
      )
    } finally {
      setOcupadoPastas(false)
    }
  }

  const trocarProjeto = (id: string | null) => {
    setProjectId(id)
    const chamada = id === null ? releaseProject() : activateProject(id)
    void chamada.then(aplicarPastas).catch(() => {
      // A pasta saiu do disco entre a lista e o clique: recarrega o que existe de verdade.
      void carregarPastas()
    })
  }

  const trocarModoPermissao = (modo: ModoPermissao) => {
    const anterior = permissionMode
    setPermissionMode(modo)
    void salvarModoPermissao(modo).catch(() => setPermissionMode(anterior))
  }

  /**
   * Responde o cartão de permissão. É esta chamada que destrava o agente: o passo dele
   * está parado esperando exatamente este id.
   */
  const responderPermissao = async (decisao: DecisaoPermissao) => {
    const pedido = permissaoPendente
    if (!pedido) return
    setRespondendoPermissao(true)
    setErroPermissao(null)
    try {
      await answerApproval(pedido.id, decisao)
      setPermissaoPendente(null)
    } catch {
      setErroPermissao('Não consegui enviar a resposta. Tente de novo.')
    } finally {
      setRespondendoPermissao(false)
    }
  }

  /**
   * Sair da conta limpa o que era daquela conta — conversa e histórico — e fecha a porta: a
   * tela de login volta na hora, sem esperar a nuvem.
   *
   * A sessão do painel é encerrada em paralelo (o token de renovação é revogado lá).
   */
  const handleSignOut = () => {
    resetRun()
    conversationIdRef.current = null
    setMessages([])
    setHistory([])
    setBusy(false)
    setInterrupted(false)
    setQuery('')
    setSearchOpen(false)
    setRemoteUsage(null)
    setView('chat')
    setConta(null)
    setSessao('fora')
    void sair()
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
    ultimoPayloadRef.current = payload
    const startedAt = performance.now()
    // O relógio da linha de trabalho começa aqui: daqui a pouco, se o backend ficar 800 ms
    // calado, ela aparece dizendo que ainda tem alguém trabalhando.
    inicioDaRespostaRef.current = Date.now()
    ultimoSinalRef.current = Date.now()

    // Sem backend: antes de simular, tenta de novo — assim subir a API depois de
    // abrir a tela passa a valer já na próxima mensagem, sem recarregar a página.
    let online = backend !== null
    if (!online) {
      try {
        const { info, usage, conversations, models, skills, mcps } = await loadSession()
        setBackend(info)
        setRemoteUsage(usage)
        setHistory(conversations.map(fromApiSummary))
        setRemoteModels(models)
        setSkills(skills)
        setMcps(mcps)
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
      {
        id: assistantId,
        role: 'assistant',
        text: '',
        model: payload.model,
        at: Date.now(),
        steps: [],
        todos: [],
      },
    ])
    const patchAssistant = (patch: (message: Message) => Message) =>
      setMessages((current) =>
        current.map((message) => (message.id === assistantId ? patch(message) : message)),
      )
    /** Ferramenta anunciada: entra na lista como "rodando" até o resultado voltar. */
    const abrirPasso = (id: string, name: string, argumentos: Record<string, unknown>) =>
      patchAssistant((message) => {
        const passo: ToolStep = {
          name,
          arguments: argumentos,
          output: '',
          duration_ms: 0,
          call_id: id,
          ok: true,
        }
        const bloco: Bloco = { tipo: 'passo', passo }
        return {
          ...message,
          steps: [...(message.steps ?? []), passo],
          blocos: [...(message.blocos ?? []), bloco],
        }
      })
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
        blocos: fecharPassoNosBlocos(message.blocos, patch),
      }))

    const controller = new AbortController()
    abortRef.current = controller
    /** Cada evento que chega do backend reinicia o silêncio que faz a linha de trabalho aparecer. */
    const sinal = () => {
      ultimoSinalRef.current = Date.now()
    }

    try {
      await streamChat(
        {
          text: payload.text,
          model: payload.model,
          reasoning: payload.reasoning,
          effort: payload.effort,
          web: payload.web,
          project_path: payload.project_path,
          attachments: payload.attachments,
          conversation_id: conversationIdRef.current,
          tz_offset_minutes: new Date().getTimezoneOffset(),
        },
        {
          signal: controller.signal,
          onStart: (data) => {
            conversationIdRef.current = data.conversation_id
          },
          onDelta: (text) => {
            sinal()
            patchAssistant((message) => ({
              ...message,
              text: message.text + text,
              blocos: anexarFala(message.blocos, text),
            }))
          },
          onReasoning: (text) => {
            sinal()
            patchAssistant((message) => ({
              ...message,
              reasoning: (message.reasoning ?? '') + text,
              blocos: anexarRaciocinio(message.blocos, text),
            }))
          },
          onToolCall: (data) => {
            sinal()
            abrirPasso(data.id, data.name, data.arguments)
          },
          onToolResult: (data) => {
            sinal()
            fecharPasso(data)
          },
          onTodos: (data) => {
            sinal()
            patchAssistant((message) => ({ ...message, todos: data.todos }))
          },
          onApprovalRequest: (data) => {
            sinal()
            setErroPermissao(null)
            setPermissaoPendente(data)
          },
          onDone: (data) => {
            patchAssistant((message) => ({
              ...message,
              elapsedMs: data.elapsed_ms,
              tokens: data.tokens ?? null,
              contexto: data.contexto ?? message.contexto ?? null,
              // O backend é quem sabe: ele só diz `false` depois de insistir sozinho.
              incompleto: data.completed === false,
              at: Date.now(),
            }))
            setBusy(false)
            // O pedido de permissão morre junto com a resposta que o fez.
            setPermissaoPendente(null)
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
        const detail = fraseDeFalha(error)
        patchAssistant((current) => ({
          ...current,
          text: current.text
            ? `${current.text}\n\n[A conexão com o serviço local caiu: ${detail}]`
            : `Não consegui falar com o serviço local do Koda. ${detail} ${COMO_DIAGNOSTICAR}`,
        }))
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setPermissaoPendente(null)
      setBusy(false)
    }
  }

  /**
   * Refaz uma rodada: manda a pergunta daquela resposta de novo.
   *
   * Na última resposta isso é refazer de verdade — a rodada antiga sai da tela e a mesma
   * pergunta volta, sem sobrar duas respostas para a mesma coisa. Nas respostas do meio
   * não dá para voltar no tempo sem ramificar a conversa (o backend guarda o histórico
   * dele), então a pergunta vai de novo como uma rodada nova no fim. Os ajustes são os da
   * última vez: modelo, reasoning, web, esforço e pasta.
   */
  const refazer = (assistantId: string) => {
    if (busy) return
    const indice = messages.findIndex((message) => message.id === assistantId)
    const pergunta = indice > 0 ? messages[indice - 1] : null
    if (!pergunta || pergunta.role !== 'user') return

    const anterior = ultimoPayloadRef.current
    if (indice === messages.length - 1) {
      // A rodada inteira sai (pergunta e resposta): quem devolve a pergunta é o envio.
      setMessages((current) => current.slice(0, indice - 1))
    }
    void handleSend({
      text: pergunta.text,
      attachments: pergunta.attachments ?? [],
      model: anterior?.model ?? model,
      reasoning: anterior?.reasoning ?? true,
      web: anterior?.web ?? false,
      effort: anterior?.effort ?? EFFORT_PADRAO,
      project_path:
        anterior?.project_path ?? projects.find((item) => item.id === projectId)?.caminho ?? null,
    })
  }

  /**
   * Continua a tarefa que fechou no meio, sem a pessoa ter que escrever nada.
   *
   * O pedido vai como um turno normal e vira uma bolha na conversa ("continue"), de
   * propósito: o backend guarda o turno, então escondê-lo aqui só faria o histórico ficar
   * diferente do que a tela mostrou. Os ajustes são os da última rodada, iguais aos de
   * "rodar de novo" — quem pediu para seguir não quer reconferir modelo e esforço.
   */
  const continuarTarefa = () => {
    if (busy) return
    const anterior = ultimoPayloadRef.current
    void handleSend({
      text: 'continue',
      attachments: [],
      model: anterior?.model ?? model,
      reasoning: anterior?.reasoning ?? true,
      web: anterior?.web ?? false,
      effort: anterior?.effort ?? EFFORT_PADRAO,
      project_path:
        anterior?.project_path ?? projects.find((item) => item.id === projectId)?.caminho ?? null,
    })
  }

  // O portão. Enquanto a sessão está sendo conferida, uma abertura discreta; sem conta,
  // a tela de entrar — e nada do app atrás dela.
  if (sessao === 'checando') return <Abertura />
  if (sessao === 'fora' || conta === null) {
    return (
      <LoginScreen
        onEntrou={(nova) => {
          setConta(nova)
          setSessao('dentro')
        }}
      />
    )
  }

  return (
    // `--koda-zoom` escala a interface inteira; dividir as medidas da viewport
    // por ele mantém o app exatamente do tamanho da janela em qualquer escala.
    <div className={CLASSE_DA_JANELA}>
      {/* A tela de configuração ocupa a janela inteira: sem header do chat. */}
      {view === 'chat' ? (
        <Header
          searchOpen={searchOpen}
          searchQuery={query}
          resultLabel={searching ? `${matchingIds.size} de ${messages.length}` : null}
          projects={projects}
          projectId={projectId}
          conta={conta}
          conversations={conversationSummaries}
          skills={skills}
          mcps={mcps}
          onToggleSkill={handleToggleSkill}
          onToggleMcp={handleToggleMcp}
          onToggleSearch={handleToggleSearch}
          onSearchQueryChange={setQuery}
          onNewChat={handleNewChat}
          onProjectChange={trocarProjeto}
          onOpenFolders={() => setPastasAberto(true)}
          onOpenConversation={handleOpenConversation}
          onOpenSettings={openSettings}
        />
      ) : null}

      {/*
       * O plano da tarefa no canto de cima à direita, logo abaixo dos controles da janela:
       * um botão com a contagem do que falta que abre o painel. Fica fora da conversa — é
       * estado do trabalho, não uma fala —, e segura o plano de pé enquanto o agente roda.
       */}
      {view === 'chat' ? (
        <div className="pointer-events-none relative z-20 -mt-2 flex shrink-0 justify-end px-5">
          <div className="pointer-events-auto">
            <ToDosMenu todos={todosAtivos} />
          </div>
        </div>
      ) : null}

      {pastasAberto ? (
        <ProjectPicker
          onFechar={() => setPastasAberto(false)}
          onUsar={(caminho) => void escolherPasta(caminho)}
          onCriar={(pai, nome) => void criarPasta(pai, nome)}
          ocupado={ocupadoPastas}
          erro={erroPastas}
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
            dias: remoteUsage?.dias ?? usageCounts.dias,
            limits: {
              daily: remoteUsage?.daily.limit ?? PLAN.dailyMessages,
              weekly: remoteUsage?.weekly.limit ?? PLAN.weeklyMessages,
              monthly: remoteUsage?.monthly.limit ?? PLAN.monthlyMessages,
            },
            // Os rótulos do catálogo da casa são strings; o tipo do menu aceita JSX
            // por causa dos contadores do submenu de skills.
            model: findModel(model, remoteModels).label as string,
            project:
              projects.find((item) => item.id === projectId)?.nome ?? 'Nenhum projeto',
          }}
          backend={{
            url: apiUrl,
            provider: backend?.provider ?? null,
            ready: backend?.provider_ready ?? false,
            model: backend?.model ?? null,
            version: backend?.version ?? null,
            workspace: backend?.workspace ?? null,
            toolCount: backend?.tools.length ?? 0,
            contextoTokens: backend?.contexto_tokens ?? 0,
          }}
          cloud={backend?.cloud ?? null}
          projects={projects}
          projectId={projectId}
          onProjectChange={trocarProjeto}
          model={model}
          onModelChange={setModel}
          remoteModels={remoteModels}
          skills={skills}
          mcps={mcps}
          mostrarRodape={mostrarRodape}
          onToggleRodape={() => setMostrarRodape((value) => !value)}
          appearance={appearance}
          onAppearanceChange={(patch) =>
            setAppearance((current) => ({ ...current, ...patch }))
          }
          contaKoda={conta}
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
              const blocos = message.blocos ?? []
              /** A resposta sendo escrita agora: é nela que a linha de trabalho aparece. */
              const ehViva = message.id === viva?.id
              /**
               * O raciocínio aberto no fim da resposta **é** o indicador: um card com arco
               * girando e "pensando" ao lado. A linha de trabalho entra só quando ele não
               * está ali — senão a tela teria dois sinais dizendo a mesma coisa.
               */
              const pensando = blocos.at(-1)?.tipo === 'raciocinio' && ehViva
              // O plano já não conta como conteúdo da bolha: ele mora no menu acima da
              // caixa agora. Mensagem que só tinha to-dos não vira bolha vazia na conversa.
              const semConteudo =
                !message.text &&
                !message.reasoning &&
                !(message.steps && message.steps.length > 0)
              // No modo agente a resposta nasce vazia (só as ferramentas aparecem
              // primeiro): sem conteúdo ainda, quem representa a espera é a linha de
              // trabalho — não uma coroa solta no vazio.
              const semNada =
                message.role === 'assistant' &&
                semConteudo &&
                !message.elapsedMs &&
                !ehViva
              if (semNada) return null
              return message.role === 'user' ? (
                <div
                  key={message.id}
                  className={[
                    'flex justify-end transition-opacity duration-300 msg-in',
                    dimmed ? 'opacity-20' : 'opacity-100',
                  ].join(' ')}
                >
                  <BolhaUsuario texto={message.text} anexos={message.attachments} />
                </div>
              ) : (
                <div
                  key={message.id}
                  className={[
                    'flex flex-col gap-1.5 transition-opacity duration-300 msg-in',
                    dimmed ? 'opacity-20' : 'opacity-100',
                  ].join(' ')}
                >
                  {message.steps && message.steps.length > 0 && blocos.length === 0 ? (
                    <ToolSteps steps={message.steps} />
                  ) : null}
                  {message.reasoning && blocos.length === 0 ? (
                    // Caminho de exceção: pensamento sem nenhum bloco (mensagem antiga).
                    <Reasoning texto={message.reasoning} ativo={false} />
                  ) : null}
                  {blocos.length > 0 ? (
                    // A resposta chegou em partes: pensamento, fala e ferramenta saem na
                    // ordem em que aconteceram, um embaixo do outro.
                    blocos.map((bloco, indice) => {
                      const ultimo = indice === blocos.length - 1
                      if (bloco.tipo === 'passo') {
                        return (
                          <ToolSteps
                            key={`passo-${bloco.passo.call_id || indice}`}
                            steps={[bloco.passo]}
                          />
                        )
                      }
                      if (bloco.tipo === 'raciocinio') {
                        // Só pensa o raciocínio que ainda está no fim da resposta viva:
                        // assim que vem fala, ferramenta ou o fim da mensagem, ele fecha.
                        return (
                          <Reasoning
                            key={`pensa-${indice}`}
                            texto={bloco.texto}
                            ativo={ultimo && ehViva}
                          />
                        )
                      }
                      return (
                        <FalaDoModelo key={`texto-${indice}`} texto={bloco.texto} />
                      )
                    })
                  ) : message.text ? (
                    <FalaDoModelo texto={message.text} />
                  ) : null}
                  {/*
                   * O fim da resposta viva: enquanto o modelo trabalha, a última coisa
                   * depois do que já apareceu é o sinal de que ele continua ali — e do que
                   * está fazendo. Sem conteúdo ainda ele aparece na hora; com conteúdo, só
                   * depois do silêncio (enquanto as palavras chegam, elas são o sinal).
                   */}
                  {ehViva && !pensando && (semConteudo || quieto) ? (
                    <WorkingLine passo={passoEmCurso} segundos={segundosDaResposta} />
                  ) : null}
                  {/* A ficha fecha a resposta: só quando ela terminou de verdade. */}
                  {message.elapsedMs ? (
                    <MessageFooter
                      texto={message.text}
                      tokens={message.tokens ?? null}
                      elapsedMs={message.elapsedMs}
                      at={message.at}
                      numeros={mostrarRodape}
                      ocupado={busy}
                      onRefazer={() => refazer(message.id)}
                    />
                  ) : null}
                  {/*
                   * Só na última resposta: numa rodada antiga, "continuar" retomaria um
                   * assunto que a conversa já deixou para trás.
                   */}
                  {message.incompleto && message.id === messages.at(-1)?.id ? (
                    <TarefaIncompleta ocupado={busy} onContinuar={continuarTarefa} />
                  ) : null}
                </div>
              )
            })}

            {interrupted && !busy ? (
              <p className="text-[13px] text-koda-fg/35 msg-in">Geração interrompida</p>
            ) : null}

            {waiting ? <WorkingLine segundos={segundosDaResposta} /> : null}

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

          <div className="flex w-full max-w-3xl flex-col gap-2.5">
            <Composer
              onSend={handleSend}
              onStop={handleStop}
              busy={busy}
              variant={hasMessages ? 'chat' : 'home'}
              projects={projects}
              projectId={projectId}
              pastaPadrao={pastaPadrao}
              onProjectChange={trocarProjeto}
              onOpenFolders={() => {
                setErroPastas(null)
                setPastasAberto(true)
              }}
              permissionMode={permissionMode}
              onPermissionModeChange={trocarModoPermissao}
              pedido={permissaoPendente}
              respondendoPermissao={respondendoPermissao}
              erroPermissao={erroPermissao}
              onDecidirPermissao={responderPermissao}
              model={model}
              onModelChange={setModel}
              remoteModels={remoteModels}
              contextoPorModelo={contextoPorModelo}
              contextoJanela={janelaDoContexto}
            />
            {/* A sessão que não vale mais vem antes de qualquer novidade: uma conversa
                respondida pelo servidor local é mais urgente que uma versão nova. */}
            {semModeloDaConta ? (
              <AvisoDaSessao
                estado={credencial === 'morta' ? 'morta' : 'reconectando'}
                motivo={motivoDaSessao}
                onEntrar={handleSignOut}
              />
            ) : versaoNova ? (
              <AvisoDeAtualizacao
                versao={versaoNova}
                link={linkDownload}
                download={download}
                onBaixar={handleBaixar}
                onVerDetalhes={() => openSettings('nuvem')}
                onDispensar={dispensarAviso}
              />
            ) : null}
          </div>
        </div>
        </main>
      )}
    </div>
  )
}

export default App
