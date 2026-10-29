import { useMemo, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, ClipboardEvent, DragEvent, ReactNode } from 'react'
import {
  ALargeSmall,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BrainCircuit,
  ChevronDown,
  CircleDot,
  ClipboardList,
  Clock,
  FilePlus2,
  FolderKanban,
  FolderOpen,
  FolderPlus,
  Gauge,
  Globe,
  Hand,
  Image as ImageIcon,
  ListTree,
  Loader2,
  MessageSquareText,
  Sparkles,
  Unlock,
  Mic,
  Paperclip,
  Pencil,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Square,
  X,
} from 'lucide-react'
import Menu from './Menu'
import type { MenuOption } from './Menu'
import FolhaTesouro from './FolhaTesouro'
import ApprovalCard from './ApprovalCard'
import AvisoDeArraste from './AvisoDeArraste'
import MoedaKoda from './MoedaKoda'
import { tempoEmTexto, useSegundosDoDia } from '../tempo'
import { PLANO_FREE, moedasEmTexto } from '../plano'
import ContextRing from './ContextRing'
import { EFFORT_MENU, EFFORT_PADRAO, effortDoModelo, effortLabel } from '../effort'
import type { Effort } from '../effort'
import { findModel, modelMenu, MODELO_PADRAO } from '../models'
import type { RemoteModel } from '../models'
import { MODOS_PERMISSAO, modoDe } from '../permissao'

/**
 * Ícone de cada modo — fica aqui porque ícone é JSX, e o módulo de modos é TS puro.
 *
 * Auto dispensa aprovações; Livre também libera ferramentas de arquivo fora do projeto.
 */
export const ICONE_DO_MODO: Record<ModoPermissao, ReactNode> = {
  // Plan: um rascunho, não um escudo — não é sobre confiar, é sobre ver antes.
  plan: <ClipboardList className="h-3.5 w-3.5 text-sky-400" strokeWidth={1.7} />,
  manual: <Hand className="h-3.5 w-3.5 text-emerald-400" strokeWidth={1.7} />,
  default: <ShieldCheck className="h-3.5 w-3.5 text-amber-300" strokeWidth={1.7} />,
  auto: <ShieldAlert className="h-3.5 w-3.5 text-red-400" strokeWidth={1.7} />,
  livre: <Unlock className="h-3.5 w-3.5 text-red-500" strokeWidth={1.7} />,
}

/**
 * A cor de cada modo no gatilho: verde, amarelo e tons de vermelho.
 *
 * É a única diferença entre os três — o contorno saiu. Quem olha de longe precisa ver a
 * cor, não decifrar um anel em volta do botão.
 */
const COR_DO_MODO: Record<ModoPermissao, string> = {
  // Plan não é sobre confiança, é sobre *ver antes*: azul diz "isto é um rascunho".
  plan: 'text-sky-400',
  manual: 'text-emerald-400',
  default: 'text-amber-300',
  auto: 'text-red-400',
  livre: 'text-red-500',
}
import { fraseDeFalha, melhorarPrompt, removerAnexo, subirAnexo } from '../api/client'
import type { ModoDoPrompt } from '../api/client'
import { filtrarComandos, textoDoComando, tokenDigitado } from '../comandos'
import {
  COR_DO_TIPO,
  ROTULO_DO_TIPO,
  filtrarMencoes,
  mencaoDigitada,
  mencoesDe,
  partesDaMencao,
  textoDaMencao,
} from '../mencoes'
import type { Mencao } from '../mencoes'
import type { Comando } from '../comandos'
import type {
  ApiAgente,
  ApiAnexo,
  ApiMcp,
  ApiProject,
  ApiSkill,
  DecisaoPermissao,
  ModoPermissao,
  PedidoPermissao,
} from '../api/client'

/**
 * Os modos da folha — cada um por um motivo, do jeito que o dono pediu.
 *
 * A ordem é de uso: «com base» é o de todo dia (a base tá boa, sobe pro cima). Os
 * outros cobrem os casos que ele descreveu: ideia solta → criar do zero; ideia boa
 * mas sem separação → estrutura; só a escrita ruim → fala; só falta acento → grafia.
 * O `hint` de cada um diz quando serve — é a dúvida de quem abre o menu.
 */
const MODOS_DO_PROMPT: MenuOption[] = [
  {
    value: 'base',
    label: 'Melhorar com base',
    hint: 'mantém o que você escreveu e acrescenta o que falta',
    icon: <Sparkles className="h-3.5 w-3.5" strokeWidth={1.7} />,
  },
  {
    value: 'criar',
    label: 'Criar do zero',
    hint: 'escreve o prompt inteiro a partir da ideia solta',
    icon: <FilePlus2 className="h-3.5 w-3.5" strokeWidth={1.7} />,
  },
  {
    value: 'estrutura',
    label: 'Estrutura',
    hint: 'separa as tarefas e organiza, sem reescrever tudo',
    icon: <ListTree className="h-3.5 w-3.5" strokeWidth={1.7} />,
  },
  {
    value: 'fala',
    label: 'Melhorar a fala',
    hint: 'deixa o texto mais claro e direto, sem mudar o pedido',
    icon: <MessageSquareText className="h-3.5 w-3.5" strokeWidth={1.7} />,
  },
  {
    value: 'grafia',
    label: 'Acentuar e pontuar',
    hint: 'só corrige acentos e pontuação, nada mais',
    icon: <ALargeSmall className="h-3.5 w-3.5" strokeWidth={1.7} />,
  },
]

export type SendPayload = {
  text: string
  /**
   * Os anexos **já enviados** ao backend (cada um com o seu `id`).
   *
   * Não são nomes de arquivo: o conteúdo subiu no upload e vive no store do backend. O
   * chat manda os ids, e a ferramenta `read_attachment` lê o conteúdo por eles.
   */
  attachments: ApiAnexo[]
  model: string
  reasoning: boolean
  web: boolean
  /** Esforço de raciocínio do modelo escolhido (`auto` deixa o Reasoning decidir). */
  effort: Effort
  /** Pasta de trabalho (caminho completo) escolhida no seletor de projeto. */
  project_path: string | null
}

/**
 * Uma mensagem esperando a vez: o que a pessoa escreveu enquanto o Koda trabalhava.
 *
 * Ela **não** é enviada na hora — o backend está com a resposta da rodada em curso, e
 * duas respostas ao mesmo tempo na mesma conversa não existem. Fica nesta lista, presa
 * à conversa em que nasceu, e sai quando a rodada dela terminar. É o «manda outro
 * prompt por cima pra arrumar o que fiz»: enquanto o agente trabalha, a pessoa escreve
 * o conserto, e ele chega logo depois, sem ninguém ter de ficar esperando com a mão no
 * mouse.
 */
export type ItemDaFila = {
  /** Identidade da linha na tela. Não é id de mensagem: é id da espera. */
  id: string
  /** A conversa a que ela pertence (`null` enquanto a conversa nova não tem id). */
  conversa: string | null
  /** O pedido inteiro: texto, anexos e os ajustes escolhidos na hora de escrever. */
  payload: SendPayload
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

/**
 * As duas contas da aba — e são **coisas diferentes**, não a mesma em duas formas.
 *
 * - **Cheia (`03:00:00`)** — o tempo do dia. Cada plano dá um tanto de horas por dia, a
 *   contagem volta ao começo à meia-noite, e ela **só anda enquanto o agente trabalha** (quem
 *   conta é `../tempo`, e não este arquivo). É o que a pessoa gasta primeiro.
 * - **Curta (`0100`)** — as **moedas**, que são do **mês de calendário** (o tempo é do dia — os
 *   períodos não são iguais). Elas viram à meia-noite do dia 1º, a mesma virada para todo
 *   mundo, e entram quando o tempo do dia acaba: são o que segura a conversa depois disso. É por isso que a moeda do Koda fica ao lado do número: ele é o saldo dela.
 *
 * O controle das setas troca **qual das duas** está à vista. Tratá-las como o mesmo número
 * desenhado de dois jeitos estava errado, e é o erro que este comentário existe para não
 * deixar voltar.
 *
 * Os números vêm do plano (`../plano`), e não daqui: os mesmos aparecem na ficha do plano, e
 * duas cópias deles divergiriam.
 */

/**
 * O menu do "/" vive em `../comandos` (dado puro, testável sem React): aqui só entra o que
 * é tela — qual item está sob o cursor, o clique e as teclas.
 */

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

/**
 * O arraste traz **arquivo** (e não texto, um link ou uma aba)?
 *
 * Sem esta checagem o aviso aparece para qualquer arraste — inclusive o de um trecho de
 * texto selecionado, que não é anexo e cairia no `subirArquivos` como lista vazia. O
 * `types` é a única coisa legível durante o arraste (o `files` só existe no `drop`, por
 * segurança): `Files` é o que o sistema operacional põe quando se arrasta do Explorer ou
 * do Finder.
 */
function temArquivo(evento: DragEvent<HTMLElement>): boolean {
  return Array.from(evento.dataTransfer?.types ?? []).includes('Files')
}

/**
 * O teto de **um** anexo, em MB — a mesma régua do backend (`MAX_BYTES` em
 * `app/anexos.py`). Está escrito aqui só para o aviso poder dizê-lo antes de a pessoa
 * tentar e levar o erro; quem recusa de verdade continua sendo o backend.
 */
const LIMITE_DE_ANEXO_MB = 32

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
  fila = [],
  onEnviarAgora,
  onRemoverDaFila,
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
  remoteModels = null,
  provedoresLogados = [],
  modelosBloqueados = [],
  contextoPorModelo = {},
  contextoJanela = null,
  moedas = null,
  agentes = [],
  skills = [],
  mcps = [],
}: {
  onSend?: (payload: SendPayload) => void
  onStop?: () => void
  busy?: boolean
  variant?: 'home' | 'chat'
  /**
   * As mensagens esperando a vez — as que a pessoa escreveu enquanto o agente
   * trabalhava. Chegam **filtradas** pelo App: só as da conversa aberta, porque a fila
   * de uma conversa não é a da outra.
   */
  fila?: readonly ItemDaFila[]
  /** Manda uma mensagem da fila **agora**: interrompe a resposta em curso e a envia. */
  onEnviarAgora?: (id: string) => void
  /** Tira uma mensagem da fila — desistência, ou porque ela voltou para a caixa. */
  onRemoverDaFila?: (id: string) => void
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
  remoteModels?: RemoteModel[] | null
  /** Grupos de modelos dos provedores em que a pessoa entrou (Codex, Gemini…), no seletor. */
  provedoresLogados?: MenuOption[]
  /**
   * Modelos que o painel tirou desta conta (desativados, ou desligados por exceção).
   * Saem do seletor — inclusive quando a lista que está valendo é a da casa.
   */
  modelosBloqueados?: readonly string[]
  /**
   * Contexto já usado, por modelo, em tokens de entrada (o `prompt_tokens` do último
   * passo da última resposta daquele modelo). Vazio = nada medido ainda.
   */
  contextoPorModelo?: Record<string, number>
  /** Teto de contexto (a janela) que o backend aplica — o denominador do anel. */
  contextoJanela?: number | null
  /**
   * As moedas **do plano da conta** — o número da aba no modo curto.
   *
   * Vem da conta, e não de uma constante: enquanto o Free era o único plano, o número era o
   * dele, e quem assinava o Plus continuava vendo as 100 do Free. `null` (conta sem plano, ou
   * sonda de sessão que ainda não respondeu) cai na constante do Free, que é o degrau de baixo.
   */
  moedas?: number | null
  /** Sub-agentes, skills e MCPs: o que o menu do `@` pode marcar. */
  agentes?: ApiAgente[]
  skills?: ApiSkill[]
  mcps?: ApiMcp[]
}) {
  const [message, setMessage] = useState('')
  /** A folha está reescrevendo o prompt agora? Enquanto isso ela dá lugar a um girador. */
  const [melhorando, setMelhorando] = useState(false)
  /** Por que a reescrita falhou, quando falha. Some na próxima tentativa. */
  const [erroDaMelhoria, setErroDaMelhoria] = useState<string | null>(null)
  const [reasoning, setReasoning] = useState(true)
  const [web, setWeb] = useState(false)
  const [efforts, setEfforts] = useState<Record<string, Effort>>({})
  const [attachments, setAttachments] = useState<ApiAnexo[]>([])
  /** Subindo anexo: a caixa espera, para ninguém mandar a mensagem sem o arquivo pronto. */
  const [subindoAnexo, setSubindoAnexo] = useState(false)
  /** O motivo pelo qual um anexo foi recusado (tipo, tamanho, backend fora do ar). */
  const [erroAnexo, setErroAnexo] = useState<string | null>(null)
  /**
   * Um arquivo está sendo arrastado **por cima da caixa** — e o aviso está na tela.
   *
   * É um contador, e não um booleano, por um motivo que aparece na prática: `dragenter` e
   * `dragleave` disparam também ao passar **por dentro** da caixa, de um filho para outro
   * (o `textarea`, a lista de anexos, um botão). Com booleano, o aviso piscava — saía e
   * voltava a cada fronteira interna. Contando entradas e saídas, ele só sai quando o
   * ponteiro deixa a caixa de verdade.
   */
  const [arrastando, setArrastando] = useState(0)
  const [listening, setListening] = useState(false)
  /** Qual item do menu do "/" está sob o cursor do teclado. */
  const [comandoAtivo, setComandoAtivo] = useState(0)
  /** Esc fechou o menu: ele só volta quando o texto mudar. */
  const [menuFechado, setMenuFechado] = useState(false)
  /** A aba está mostrando as moedas (`0100`) em vez do tempo do dia (`03:00:00`). */
  const [compacto, setCompacto] = useState(false)
  /** O tempo do dia que ainda resta — quem faz ele andar é o App (ver `../tempo`). */
  const segundosDoDia = useSegundosDoDia()
  /** O mesmo par do menu do "/", para o menu do "@". */
  const [mencaoAtiva, setMencaoAtiva] = useState(0)
  const [menuDeMencoesFechado, setMenuDeMencoesFechado] = useState(false)
  const itensDeMencaoRef = useRef<(HTMLButtonElement | null)[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  /** A camada que desenha o texto pintado, atrás do textarea. */
  const capaRef = useRef<HTMLDivElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const recognitionRef = useRef<Recognition | null>(null)
  /** Cada linha do menu, para o item ativo ser trazido para dentro da área visível. */
  const itensDoMenuRef = useRef<(HTMLButtonElement | null)[]>([])

  const isChat = variant === 'chat'

  /**
   * O menu do "/" abre enquanto se digita **o nome do comando**.
   *
   * O espaço fecha o menu de propósito: depois dele o comando já está escolhido e o que
   * vem é o assunto (`/plan refatorar o módulo X`). O `menuFechado` é o Esc — ele esconde
   * o menu sem apagar o que foi digitado.
   */
  const token = tokenDigitado(message)
  const mostrarComandos = token !== null && !menuFechado
  const consulta = mostrarComandos ? token : ''
  const comandosFiltrados = mostrarComandos ? filtrarComandos(consulta) : []
  // O filtro pode encolher a lista por baixo do item ativo; o índice nunca passa do fim.
  const indiceAtivo = Math.min(comandoAtivo, Math.max(comandosFiltrados.length - 1, 0))

  /**
   * O menu do `@` abre enquanto se digita **o nome da menção**.
   *
   * Diferente do `/`, ele vale em qualquer lugar do texto: a pessoa escreve a frase e marca
   * no meio dela. O espaço fecha — depois dele a menção está escolhida e o que vem é o
   * assunto. Os dois menus nunca aparecem juntos: o `/` só vale no começo do texto, e a
   * marca o desliga.
   */
  const mencao = mencaoDigitada(message)
  const mostrarMencoes = mencao !== null && !menuDeMencoesFechado && !mostrarComandos
  const mencoesFiltradas = mostrarMencoes
    ? filtrarMencoes(mencoesDe(agentes, skills, mcps), mencao.tipo, mencao.consulta)
    : []
  const indiceDaMencao = Math.min(mencaoAtiva, Math.max(mencoesFiltradas.length - 1, 0))

  /** O texto em pedaços, para a camada de cor pintar só as marcas. */
  const partes = partesDaMencao(message)
  const temMencao = partes.some((parte) => parte.tipo !== null)
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

  // Com a lista rolando, o item do teclado tem de aparecer — senão as setas andam por
  // baixo da área visível e o menu parece travado. (O cursor voltando para o primeiro item
  // a cada tecla é no `onChange`: é ele o evento que muda o filtro.)
  useEffect(() => {
    if (!mostrarComandos) return
    itensDoMenuRef.current[indiceAtivo]?.scrollIntoView({ block: 'nearest' })
  }, [indiceAtivo, mostrarComandos])

  useEffect(() => {
    if (!mostrarMencoes) return
    itensDeMencaoRef.current[indiceDaMencao]?.scrollIntoView({ block: 'nearest' })
  }, [indiceDaMencao, mostrarMencoes])

  /**
   * Escolhe o comando: escreve o token na caixa e devolve o cursor, para você continuar.
   *
   * **Não** manda nada. O menu é um completador — quem escreve a mensagem é você, e o que
   * vai para o modelo é exatamente o que estiver na caixa. Nada de texto pré-definido.
   */
  const completarComando = (comando: Comando) => {
    setMessage(textoDoComando(comando))
    setComandoAtivo(0)
    setMenuFechado(false)
    // Depois do render: o React ainda não escreveu o texto novo na caixa quando este
    // handler termina, e o cursor iria para o lugar errado.
    requestAnimationFrame(() => {
      const caixa = textareaRef.current
      if (!caixa) return
      caixa.focus()
      caixa.setSelectionRange(caixa.value.length, caixa.value.length)
    })
  }

  /**
   * Escolhe a menção: troca o `@…` digitado pelo token e devolve o cursor.
   *
   * **Não** manda nada — o menu é um completador, igual ao do `/`. Troca só o pedaço que
   * está sendo digitado, e não a caixa inteira: a menção entra no meio da frase. A marca
   * está sempre no fim do texto (um espaço depois dela já a fecha), então o que sai é o
   * texto até o `@` mais o token.
   */
  const completarMencao = (escolhida: Mencao) => {
    if (!mencao) return
    setMessage(`${message.slice(0, mencao.inicio)}${textoDaMencao(escolhida)}`)
    setMencaoAtiva(0)
    setMenuDeMencoesFechado(false)
    requestAnimationFrame(() => {
      const caixa = textareaRef.current
      if (!caixa) return
      caixa.focus()
      caixa.setSelectionRange(caixa.value.length, caixa.value.length)
    })
  }

  /**
   * Pode enviar? Com o agente trabalhando, **pode**.
   *
   * Antes o `busy` segurava o envio, e a pessoa ficava sem poder escrever o conserto
   * enquanto o Koda fazia o que ela tinha pedido antes. Agora a mensagem vai para a
   * fila e sai quando a resposta em curso terminar. O que continua segurando o envio é
   * o anexo subindo — mandar a mensagem sem o arquivo pronto seria perder o arquivo.
   */
  const canSend = Boolean(model) && !subindoAnexo && (message.trim().length > 0 || attachments.length > 0)
  const activeModel = useMemo(() => {
    const doHost = findModel(model, remoteModels ?? [])
    if (doHost.label !== model) return doHost
    // Modelo de conta: o rótulo mora no grupo do provedor, não no catálogo do host.
    for (const grupo of provedoresLogados) {
      const achado = (grupo.options ?? []).find((opcao) => opcao.value === model)
      if (achado) return { value: achado.value, label: achado.label, icon: achado.icon }
    }
    return doHost
  }, [model, remoteModels, provedoresLogados])
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

  /**
   * A folha: reescreve o rascunho no modo que a pessoa escolheu no menu.
   *
   * Quem responde é o modelo que estiver selecionado — a pessoa não escolhe provedor
   * aqui. O texto melhorado **substitui** o rascunho na caixa: a ideia é chegar no
   * prompt final, não empilhar versões. Sem ferramentas e sem tocar na conversa: é
   * chamada de texto puro, feita no backend pelo `/api/prompt/melhorar`.
   *
   * Vão junto os recursos **ativos** da máquina (MCPs, skills e subs) — a validação
   * do prompt pode citá-los quando fizer sentido, e só esses.
   */
  const melhorar = async (modo: ModoDoPrompt) => {
    if (melhorando || !message.trim()) return
    setMelhorando(true)
    setErroDaMelhoria(null)
    try {
      const { prompt } = await melhorarPrompt(message, model, modo, {
        mcps: mcps.filter((item) => item.enabled).map((item) => item.name),
        skills: skills.filter((item) => item.enabled).map((item) => item.name),
        subs: agentes.map((item) => item.nome),
      })
      if (prompt.trim()) {
        setMessage(prompt)
        textareaRef.current?.focus()
      } else {
        setErroDaMelhoria('o modelo devolveu vazio — tenta de novo')
      }
    } catch (erro) {
      setErroDaMelhoria(
        erro instanceof Error && erro.message
          ? erro.message
          : 'não consegui falar com o backend para melhorar o prompt',
      )
    } finally {
      setMelhorando(false)
    }
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

  /**
   * Sobe os arquivos e guarda o que o backend devolveu.
   *
   * O `File` inteiro vai no corpo (multipart) — antes daqui saía só o nome, e o conteúdo
   * nunca chegava ao modelo. O upload é para o backend local, então é rápido; mesmo assim
   * a caixa fica bloqueada enquanto sobe, para ninguém mandar a mensagem sem o anexo pronto.
   *
   * É o mesmo caminho para o «+» e para o Ctrl+V: colar uma captura de tela tem de virar
   * anexo de verdade, não uma imagem presa na área de transferência.
   */
  const subirArquivos = async (arquivos: File[]) => {
    if (arquivos.length === 0) return
    setErroAnexo(null)
    setSubindoAnexo(true)
    try {
      for (const arquivo of arquivos) {
        const anexo = await subirAnexo(arquivo)
        setAttachments((current) =>
          current.some((item) => item.id === anexo.id) ? current : [...current, anexo],
        )
      }
    } catch (falha) {
      setErroAnexo(fraseDeFalha(falha))
    } finally {
      setSubindoAnexo(false)
    }
  }

  const addFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const arquivos = Array.from(event.target.files ?? [])
    event.target.value = ''
    await subirArquivos(arquivos)
  }

  /**
   * Ctrl+V de imagem (ou de arquivo) sobe o anexo igual ao «+».
   *
   * Sem isto o textarea só aceitava texto: colar uma captura de tela não fazia nada e a
   * imagem ficava na área de transferência. O `preventDefault` só acontece quando há
   * arquivo — colar texto puro continua sendo colar texto.
   */
  const colarArquivos = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const arquivos = Array.from(event.clipboardData?.files ?? [])
    if (arquivos.length === 0) return
    event.preventDefault()
    void subirArquivos(arquivos)
  }

  /** Tira o anexo da caixa e do store — o arquivo não vai ser usado, não fica ocupando disco. */
  const tirarAnexo = (anexo: ApiAnexo) => {
    setAttachments((current) => current.filter((item) => item.id !== anexo.id))
    void removerAnexo(anexo.id).catch(() => {
      // O anexo já pode ter sido limpo no backend: a caixa já o tirou, que é o que importa.
    })
  }

  /**
   * Arrastar e soltar arquivos **na caixa** — o mesmo caminho do «+» e do Ctrl+V.
   *
   * ## Os dois eventos não fazem a mesma coisa
   *
   * `dragenter` **entra** no alvo (uma vez por elemento cruzado); `dragover` dispara
   * **continuamente** enquanto o ponteiro está parado por cima — dezenas de vezes por
   * segundo. Somar os dois no mesmo contador foi um defeito real: 1 `dragenter` + 40
   * `dragover` contra 1 `dragleave` davam saldo +40, e o aviso **ficava preso na tela**
   * depois de a pessoa desistir do arraste. Por isso só o `dragenter` conta, e o
   * `dragover` tem um papel só: liberar o `drop`.
   *
   * O `preventDefault` no `dragover` não é opcional: sem ele o navegador recusa o `drop`
   * (o padrão dele é abrir o arquivo numa aba nova) e o arquivo nunca cai aqui.
   *
   * O contador nunca desce abaixo de zero e o `drop` o zera: os dois cobrem os caminhos em
   * que a contagem fica desalinhada — sair pela borda sem `dragleave`, ou soltar sem
   * passar pelo enter.
   */
  const entrouArraste = (evento: DragEvent<HTMLDivElement>) => {
    if (!temArquivo(evento)) return
    evento.preventDefault()
    setArrastando((atual) => atual + 1)
  }

  const sobreArraste = (evento: DragEvent<HTMLDivElement>) => {
    if (!temArquivo(evento)) return
    // Só libera a entrega — **não** mexe no contador (ver o comentário acima).
    evento.preventDefault()
    evento.dataTransfer.dropEffect = 'copy'
  }

  const saiuArraste = (evento: DragEvent<HTMLDivElement>) => {
    if (!temArquivo(evento)) return
    evento.preventDefault()
    setArrastando((atual) => Math.max(0, atual - 1))
  }

  const soltouArquivos = (evento: DragEvent<HTMLDivElement>) => {
    if (!temArquivo(evento)) return
    evento.preventDefault()
    setArrastando(0)
    void subirArquivos(Array.from(evento.dataTransfer.files))
  }

  const projectTriggerClass = [
    'flex w-full items-center gap-2 rounded-lg py-1 text-[13px]',
    projectId === null ? 'text-koda-fg/45 hover:text-koda-fg/75' : 'text-koda-accent',
    'transition-colors duration-150 focus-visible:outline-none',
  ].join(' ')

  // A silhueta da caixa — aba, rampa e corpo — é **um path só**. Era o que faltava: com dois
  // elementos (uma aba e um corpo) sobrava sempre uma emenda entre eles, por mais que um
  // cobrisse o outro. Precisa ser recalculada quando o tamanho muda (o texto cresce, a janela
  // muda), e o `ResizeObserver` no container cobre os dois casos.
  const formaRef = useRef<HTMLDivElement>(null)
  const abaRef = useRef<HTMLDivElement>(null)
  const pathRef = useRef<SVGPathElement>(null)

  useEffect(() => {
    const forma = formaRef.current
    if (!forma) return
    const desenhar = () => {
      const path = pathRef.current
      const aba = abaRef.current
      if (!path || !aba) return
      const W = forma.clientWidth
      const H = forma.clientHeight
      const alturaDaAba = 34
      const raio = 22
      const raioDaAba = 14
      const rampa = 16
      // A aba acompanha o próprio texto, então a rampa sai de onde ela termina.
      const larguraDaAba = aba.scrollWidth + 2
      const n = (v: number) => +v.toFixed(1)
      path.setAttribute(
        'd',
        [
          `M0.5 ${n(H - raio)}`,
          `L0.5 ${raioDaAba}`,
          `Q0.5 0.5 ${raioDaAba} 0.5`,
          `L${n(larguraDaAba)} 0.5`,
          `L${n(larguraDaAba + rampa)} ${alturaDaAba}`,
          `L${n(W - raio)} ${alturaDaAba}`,
          `Q${W - 0.5} ${alturaDaAba} ${W - 0.5} ${alturaDaAba + raio}`,
          `L${W - 0.5} ${n(H - raio)}`,
          `Q${W - 0.5} ${H - 0.5} ${n(W - raio)} ${H - 0.5}`,
          `L${raio} ${H - 0.5}`,
          `Q0.5 ${H - 0.5} 0.5 ${n(H - raio)}`,
          'Z',
        ].join(' ')
      )
    }
    desenhar()
    const observador = new ResizeObserver(desenhar)
    observador.observe(forma)
    return () => observador.disconnect()
  }, [])

  /**
   * Rede de segurança do aviso de arraste: soltar **fora** da janela (ou apertar Esc)
   * não dispara `dragleave` na caixa, e sem isto o aviso ficaria preso na tela.
   *
   * O `drop` no `document` cobre o arquivo solto em qualquer canto da página — inclusive
   * fora da caixa, onde o navegador abriria o arquivo numa aba nova; aqui ele é ignorado
   * em silêncio e o aviso sai. O `dragend` cobre o arraste cancelado (Esc, ou solto de
   * volta no Explorer).
   */
  useEffect(() => {
    if (arrastando === 0) return
    const limpar = () => setArrastando(0)
    const solto = (evento: Event) => {
      // Só age quando o arraste traz arquivo: um arraste de texto não é anexo.
      const tipos = (evento as unknown as DragEvent).dataTransfer?.types
      if (tipos && !Array.from(tipos).includes('Files')) return
      limpar()
    }
    document.addEventListener('drop', solto)
    document.addEventListener('dragend', limpar)
    window.addEventListener('blur', limpar)
    return () => {
      document.removeEventListener('drop', solto)
      document.removeEventListener('dragend', limpar)
      window.removeEventListener('blur', limpar)
    }
  }, [arrastando])

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

      {/* A caixa: aba, rampa e corpo desenhados num **path só** (ver o `useEffect` acima). O
          «Koda» é um texto posicionado por cima da parte de cima da silhueta.

          A caixa inteira é a área de soltar arquivo: o arraste entra por aqui e o anexo
          segue pelo mesmo `subirArquivos` do «+» e do Ctrl+V. O `onDragOver` é o que
          autoriza o navegador a entregar o `drop` — sem ele o arquivo abre numa aba nova. */}
      <div
        ref={formaRef}
        className="group relative isolate w-full pt-[40px]"
        onDragEnter={entrouArraste}
        onDragOver={sobreArraste}
        onDragLeave={saiuArraste}
        onDrop={soltouArquivos}
      >
        <svg
          className="pointer-events-none absolute inset-0 -z-10 h-full w-full overflow-visible"
          style={{ filter: 'drop-shadow(0 30px 60px var(--koda-shadow))' }}
          aria-hidden="true"
        >
          {/* A borda da caixa **não muda com o foco**. Havia aqui um realce no
              `focus-within` — roxo, depois neutro —, e o dono apontou: «essa borda roxa que
              não pedi pra colocar». Ele está certo: o sinal de foco da caixa é o cursor
              piscando dentro dela, e uma silhueta deste tamanho acendendo em volta vira
              contorno pesado em vez de aviso. Fica a borda de sempre. */}
          <path
            ref={pathRef}
            className="fill-koda-input stroke-koda-fg/10"
            strokeWidth={1}
          />
        </svg>

        {/* O aviso de arraste — por cima da caixa inteira, e não da tela: é aqui que o
            arquivo cai. Ele nasce **depois** do `svg` justamente para ficar na frente da
            silhueta, e o `rounded-[22px]` acompanha o raio do corpo da caixa. */}
        {arrastando > 0 ? <AvisoDeArraste limiteMb={LIMITE_DE_ANEXO_MB} /> : null}

        {/* A aba: a moeda do Koda e, ao lado, o tempo da conversa. O `data-aba` é o que
            deixa o aviso de arraste medir a largura dela e desenhar a mesma silhueta. */}
        <div
          ref={abaRef}
          data-aba
          // O `pr-3` não é enfeite: a aba termina numa **rampa** (o path desce 16px na
          // diagonal), e o cronômetro encostava nela — o último dígito ficava por baixo do
          // traço. A largura da aba sai do próprio conteúdo, então é o padding que a alarga.
          className="absolute top-0 left-0 flex h-[34px] items-center gap-1 pl-2 pr-3"
        >
          {/*
           * As duas setas empilhadas **atrás da moeda** — antes dela na fila.
           *
           * É **uma peça só**, e não dois botões: as duas setas são o desenho de um controle
           * único. Dois botões aqui dariam duas áreas de clique separadas para o que a pessoa
           * lê como uma coisa — e ainda partiam o realce do hover em dois.
           *
           * Ele troca a **forma do tempo**, e não o tempo: a contagem é a mesma, e o que muda
           * é caber ou não na aba. É um alternador, e por isso é `aria-pressed` e não dois
           * botões com nomes diferentes — a pessoa não escolhe "anterior" nem "próximo", ela
           * aperta uma tecla só.
           *
           * O `-mt-1` no segundo ícone é o que **cola** as setas: cada SVG do lucide reserva
           * uma folga interna, e empilhar os dois sem desconto deixava um vão de 4px entre os
           * traços. Com o desconto, um encosta no outro.
           *
           * Sem fundo próprio: na faixa de 34px qualquer retângulo pesa mais que a própria
           * moeda. A peça só acende no hover, e o `mr-0.5` a mantém separada da moeda.
           */}
          <button
            type="button"
            aria-label={compacto ? 'Mostrar o tempo do dia' : 'Mostrar as moedas'}
            aria-pressed={compacto}
            onClick={() => setCompacto((atual) => !atual)}
            className="mr-0.5 flex w-3 flex-col items-center rounded text-koda-fg/40 transition-colors duration-150 hover:text-koda-fg focus-visible:ring-1 focus-visible:ring-koda-accent focus-visible:outline-none"
          >
            <ArrowLeft className="h-2.5 w-2.5" strokeWidth={2.2} />
            <ArrowRight className="-mt-1 h-2.5 w-2.5" strokeWidth={2.2} />
          </button>

          <MoedaKoda className="h-4 w-4" />

          <span className="text-[12px] tabular-nums text-koda-fg/50">
            {compacto ? moedasEmTexto(moedas ?? PLANO_FREE.moedasPorMes) : tempoEmTexto(segundosDoDia)}
          </span>
        </div>

        {/* A área de escrever — a única que fica **clara**. A faixa de baixo (controles e
            seletor de projeto) é escura, e o contorno abraça as duas. */}
        <div className="px-4 pb-3">
        {attachments.length > 0 || subindoAnexo || erroAnexo ? (
          <ul className="mb-2 flex flex-wrap items-center gap-1.5 px-1">
            {attachments.map((anexo) => (
              <li
                key={anexo.id}
                className="flex items-center gap-1.5 rounded-lg bg-koda-fg/6 py-1 pr-1.5 pl-2.5 text-[12px] text-koda-fg/75"
              >
                <Paperclip className="h-3.5 w-3.5 text-koda-fg/45" strokeWidth={1.8} />
                <span className="max-w-44 truncate">{anexo.nome}</span>
                <button
                  type="button"
                  aria-label={`Remover ${anexo.nome}`}
                  onClick={() => tirarAnexo(anexo)}
                  className="flex h-4 w-4 items-center justify-center rounded text-koda-fg/45 transition-colors hover:bg-koda-fg/10 hover:text-koda-fg"
                >
                  <X className="h-3 w-3" strokeWidth={2.2} />
                </button>
              </li>
            ))}
            {subindoAnexo ? (
              <li className="flex items-center gap-1.5 rounded-lg bg-koda-fg/6 py-1 pr-2.5 pl-2.5 text-[12px] text-koda-fg/55">
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.8} />
                enviando…
              </li>
            ) : null}
            {erroAnexo ? (
              <li className="rounded-lg bg-red-500/10 px-2.5 py-1 text-[12px] text-red-300">
                {erroAnexo}
              </li>
            ) : null}
          </ul>
        ) : null}

        {/* A fila: o que a pessoa escreveu enquanto o Koda trabalhava. Cada linha é
            uma mensagem inteira esperando a vez. A seta manda **agora** (interrompendo a
            resposta em curso), o lápis devolve para a caixa (com os anexos) e o X
            cancela. O estilo é o dos anexos de propósito: é a mesma idéia — algo
            pendurado esperando o envio. */}
        {fila.length > 0 ? (
          <ul className="mb-2 flex flex-col gap-1.5 px-1" aria-label="Mensagens na fila">
            {fila.map((item) => (
              <li
                key={item.id}
                title="Na fila — será enviada quando o Koda terminar esta resposta"
                className="flex items-center gap-1.5 rounded-lg bg-koda-fg/6 py-1 pr-1.5 pl-2.5 text-[12px] text-koda-fg/75"
              >
                <Clock className="h-3.5 w-3.5 shrink-0 text-koda-fg/45" strokeWidth={1.8} />
                <span className="min-w-0 flex-1 truncate">
                  {item.payload.text.trim() || 'anexo'}
                </span>
                <button
                  type="button"
                  aria-label="Enviar agora"
                  title="Enviar agora — interrompe a resposta em curso e manda esta mensagem"
                  onClick={() => onEnviarAgora?.(item.id)}
                  className="flex h-4 w-4 items-center justify-center rounded text-koda-fg/45 transition-colors hover:bg-koda-fg/10 hover:text-koda-fg"
                >
                  <ArrowUp className="h-3 w-3" strokeWidth={2.2} />
                </button>
                <button
                  type="button"
                  aria-label="Editar mensagem da fila"
                  title="Editar — volta para a caixa"
                  onClick={() => {
                    // Editar é continuar escrevendo: o texto e os anexos voltam para a
                    // caixa, e a linha sai da fila. Perder o rascunho que já estava na
                    // caixa é o preço de editar — o clique é explícito.
                    setMessage(item.payload.text)
                    setAttachments(item.payload.attachments)
                    onRemoverDaFila?.(item.id)
                    textareaRef.current?.focus()
                  }}
                  className="flex h-4 w-4 items-center justify-center rounded text-koda-fg/45 transition-colors hover:bg-koda-fg/10 hover:text-koda-fg"
                >
                  <Pencil className="h-3 w-3" strokeWidth={2.2} />
                </button>
                <button
                  type="button"
                  aria-label="Remover mensagem da fila"
                  title="Remover da fila"
                  onClick={() => onRemoverDaFila?.(item.id)}
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
              Comandos
            </p>
            <div className="max-h-60 overflow-y-auto" role="listbox" aria-label="Comandos">
              {comandosFiltrados.length > 0 ? (
                comandosFiltrados.map((comando, index) => {
                  const ativo = index === indiceAtivo
                  return (
                    <button
                      key={comando.nome}
                      ref={(elemento) => {
                        itensDoMenuRef.current[index] = elemento
                      }}
                      type="button"
                      role="option"
                      aria-selected={ativo}
                      // `onMouseDown` e não `onClick`: o clique tira o foco do textarea
                      // antes, e aí o menu fecharia por baixo do dedo.
                      onMouseDown={(evento) => {
                        evento.preventDefault()
                        completarComando(comando)
                      }}
                      onMouseEnter={() => setComandoAtivo(index)}
                      className={[
                        'flex w-full items-baseline gap-2 rounded-lg px-2 py-2 text-left',
                        'text-[13.5px] transition-colors duration-100',
                        ativo ? 'bg-koda-fg/8' : 'hover:bg-koda-fg/5',
                      ].join(' ')}
                    >
                      <span className="shrink-0 font-semibold text-koda-fg">
                        {comando.nome}
                      </span>
                      <span className="min-w-0 truncate text-koda-fg/45">
                        {comando.descricao}
                      </span>
                    </button>
                  )
                })
              ) : (
                <p className="px-2 py-2 text-[13.5px] text-koda-fg/45">
                  Nenhum comando com «{consulta}»
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 border-t border-koda-fg/8 pt-2.5 pb-1 text-[12.5px] text-koda-fg/45">
              <CircleDot className="h-3.5 w-3.5 shrink-0" strokeWidth={1.7} />
              <span>
                <span className="text-koda-fg/70">↑ ↓</span> escolhe ·{' '}
                <span className="text-koda-fg/70">Enter</span> completa ·{' '}
                <span className="text-koda-fg/70">Esc</span> fecha
              </span>
            </div>
          </div>
        ) : null}

        {mostrarMencoes && mencao ? (
          <div className="mb-1">
            <p className="px-1 pb-1.5 text-[11px] font-semibold tracking-wider text-koda-fg/40 uppercase">
              {mencao.tipo ? ROTULO_DO_TIPO[mencao.tipo] : 'Sub-agentes, skills e MCPs'}
            </p>
            <div
              className="max-h-60 overflow-y-auto"
              role="listbox"
              aria-label="Sub-agentes, skills e MCPs"
            >
              {mencoesFiltradas.length > 0 ? (
                mencoesFiltradas.map((item, index) => {
                  const ativo = index === indiceDaMencao
                  return (
                    <button
                      key={item.token}
                      ref={(elemento) => {
                        itensDeMencaoRef.current[index] = elemento
                      }}
                      type="button"
                      role="option"
                      aria-selected={ativo}
                      // `onMouseDown` e não `onClick`: o clique tira o foco do textarea
                      // antes, e aí o menu fecharia por baixo do dedo.
                      onMouseDown={(evento) => {
                        evento.preventDefault()
                        completarMencao(item)
                      }}
                      onMouseEnter={() => setMencaoAtiva(index)}
                      className={[
                        'flex w-full items-baseline gap-2 rounded-lg px-2 py-2 text-left',
                        'text-[13.5px] transition-colors duration-100',
                        ativo ? 'bg-koda-fg/8' : 'hover:bg-koda-fg/5',
                      ].join(' ')}
                    >
                      {/* A cor do tipo, a mesma que a marca ganha dentro da caixa: a lista
                          ensina a cor, e o texto a repete. */}
                      <span
                        className={[
                          'shrink-0 font-mono font-semibold',
                          COR_DO_TIPO[item.tipo],
                        ].join(' ')}
                      >
                        @{item.token}
                      </span>
                      <span className="min-w-0 truncate text-koda-fg/45">{item.descricao}</span>
                    </button>
                  )
                })
              ) : (
                <p className="px-2 py-2 text-[13.5px] text-koda-fg/45">
                  Nada com «{mencao.consulta}»
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 border-t border-koda-fg/8 pt-2.5 pb-1 text-[12.5px] text-koda-fg/45">
              <CircleDot className="h-3.5 w-3.5 shrink-0" strokeWidth={1.7} />
              <span>
                <span className="text-koda-fg/70">↑ ↓</span> escolhe ·{' '}
                <span className="text-koda-fg/70">Enter</span> completa ·{' '}
                <span className="text-koda-fg/70">Esc</span> fecha
              </span>
            </div>
          </div>
        ) : null}

        <label htmlFor="koda-input" className="sr-only">
          Escreva sua mensagem para o Koda
        </label>
        {/*
         * A cor por tipo **dentro da caixa**.
         *
         * Um `<textarea>` não aceita cor por trecho, então o texto dele fica transparente e
         * esta camada, atrás, desenha o mesmo texto com as marcas pintadas. Ela não recebe
         * ponteiro (o clique e o cursor são do textarea) e repete a tipografia dele ao pé da
         * letra — é isso que faz as duas ficarem sobrepostas.
         *
         * Só entra em cena quando há marca no texto: sem nenhuma, o textarea fica com o texto
         * normal e a caixa se comporta exatamente como antes (inclusive a seleção, que fica
         * invisível com o texto transparente).
         */}
        <div className="relative">
          {temMencao ? (
            <div
              ref={capaRef}
              aria-hidden
              className="pointer-events-none absolute inset-0 overflow-hidden px-1 text-[15px] leading-6 break-words whitespace-pre-wrap"
            >
              {partes.map((parte, indice) =>
                parte.tipo ? (
                  <span key={indice} className={COR_DO_TIPO[parte.tipo]}>
                    {parte.texto}
                  </span>
                ) : (
                  <span key={indice}>{parte.texto}</span>
                ),
              )}
              {/* Um zero-largura no fim: sem ele, quando a última linha é vazia, a camada
                  não desenha a linha e o texto sobe um degrau em relação ao cursor. */}
              {'\u200b'}
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            id="koda-input"
          rows={2}
          value={message}
          onChange={(event) => {
            setMessage(event.target.value)
            // Texto novo = filtro novo: o cursor volta ao primeiro item e o menu reabre,
            // mesmo depois de um Esc.
            setComandoAtivo(0)
            setMenuFechado(false)
            setMencaoAtiva(0)
            setMenuDeMencoesFechado(false)
          }}
          onPaste={colarArquivos}
          onKeyDown={(event) => {
            if (mostrarComandos) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const total = comandosFiltrados.length
                if (total === 0) return
                const passo = event.key === 'ArrowDown' ? 1 : -1
                setComandoAtivo((atual) => (atual + passo + total) % total)
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setMenuFechado(true)
                return
              }
              if (
                (event.key === 'Enter' && !event.shiftKey) ||
                (event.key === 'Tab' && !event.shiftKey)
              ) {
                const comando = comandosFiltrados[indiceAtivo]
                // Sem item sob o cursor, o Enter segue o caminho normal (manda o texto).
                if (comando) {
                  event.preventDefault()
                  completarComando(comando)
                  return
                }
              }
            }
            if (mostrarMencoes) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const total = mencoesFiltradas.length
                if (total === 0) return
                const passo = event.key === 'ArrowDown' ? 1 : -1
                setMencaoAtiva((atual) => (atual + passo + total) % total)
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setMenuDeMencoesFechado(true)
                return
              }
              if (
                (event.key === 'Enter' && !event.shiftKey) ||
                (event.key === 'Tab' && !event.shiftKey)
              ) {
                const escolhida = mencoesFiltradas[indiceDaMencao]
                // Sem item sob o cursor, o Enter segue o caminho normal (manda o texto).
                if (escolhida) {
                  event.preventDefault()
                  completarMencao(escolhida)
                  return
                }
              }
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              send()
            }
          }}
          // Sem corretor: o `/` e os comandos não são palavras, e o WebView2 pintava a
          // linha de vermelho — parecia que a caixa estava com cor errada.
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          placeholder="Escreva sua mensagem para o Koda"
          className={[
            'min-h-[72px] w-full resize-none overflow-y-auto bg-transparent px-1',
            // Com marca no texto, quem desenha é a camada de trás: o texto daqui fica
            // transparente e só o cursor aparece. Sem marca, é o de sempre.
            temMencao
              ? 'text-transparent caret-koda-fg placeholder:text-koda-fg/40'
              : 'text-koda-fg placeholder:text-koda-fg/40',
            'text-[15px] leading-6 focus:outline-none',
          ].join(' ')}
          onScroll={(evento) => {
            // A camada não rola sozinha: passando da altura máxima, quem rola é o textarea —
            // e a cor tem de andar junto, senão o texto pintado sai de cima do cursor.
            if (capaRef.current) capaRef.current.scrollTop = evento.currentTarget.scrollTop
          }}
        />
        </div>

        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => void addFiles(event)}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => void addFiles(event)}
        />

        <div
          className={[
            'flex min-w-0 items-center justify-between gap-3',
            isChat ? 'mt-2 flex-wrap gap-2' : 'mt-1',
          ].join(' ')}
        >
          <div className="flex min-w-0 flex-wrap items-center gap-1">
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

            {/* Quanto o agente pode fazer sozinho e se as ferramentas de arquivo podem
                sair do projeto. A opção Livre descreve essa ampliação explicitamente. */}
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

          <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1">
            {/* A folha do mapa do tesouro virou menu: cada modo melhora o rascunho de
                um jeito (com base, do zero, estrutura, fala, grafia), sempre com o
                modelo que estiver selecionado. Solta, à esquerda da coroa — não é
                parte do gatilho do modelo. Caixa vazia ou já melhorando: o gatilho
                apaga e para de responder (o `Menu` não tem `disabled` próprio). */}
            <Menu
              options={MODOS_DO_PROMPT}
              onSelect={(value) => void melhorar(value as ModoDoPrompt)}
              align="end"
              direction="up"
              label="Melhorar o prompt"
              panelClassName="w-72"
              triggerClassName={[
                'mr-1.5 flex h-7 w-7 items-center justify-center rounded-lg transition-colors duration-150',
                'focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none',
                !message.trim() || melhorando
                  ? 'pointer-events-none text-amber-200/55 opacity-40'
                  : 'text-amber-200/55 hover:bg-koda-fg/8 hover:text-amber-200/80',
              ].join(' ')}
            >
              {melhorando ? (
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.8} />
              ) : (
                <FolhaTesouro className="h-4 w-4 -rotate-12" />
              )}
            </Menu>
            <Menu
              options={comMedidor([
                ...modelMenu(remoteModels, modelosBloqueados),
                ...provedoresLogados,
              ])}
              value={model}
              onSelect={(value) => onModelChange?.(value)}
              align="end"
              direction="up"
              label="Escolher modelo"
              triggerClassName="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] text-koda-fg/50 transition-colors duration-150 hover:bg-koda-fg/8 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
            >
              <span className="text-koda-fg/60">{activeModel.icon}</span>
              <span className="hidden sm:inline">{model ? activeModel.label : 'Nenhum modelo disponível'}</span>
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

            {/*
              Um botão só, e ele troca conforme o que dá para fazer:
              - **quadrado** (Parar) enquanto o Koda trabalha e a caixa está vazia — não
                há o que enviar, então o botão útil é o que pára o trabalho;
              - **seta** nos outros casos. Com o Koda trabalhando **e** texto na caixa, a
                seta manda para a fila (a mensagem sai quando a resposta terminar) — e é
                por isso que escrever faz o quadrado dar lugar a ela: com um conserto a
                caminho, poder mandar vale mais que poder parar. Apagar o texto traz o
                quadrado de volta.
            */}
            {isChat && busy && !canSend ? (
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
                aria-label={busy ? 'Enviar mensagem (entra na fila)' : 'Enviar mensagem'}
                title={busy ? 'Enviar — entra na fila e sai quando o Koda terminar' : 'Enviar mensagem'}
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

          {/* A folha não conseguiu melhorar o prompt: o motivo aparece aqui, discreto. */}
          {erroDaMelhoria ? (
            <p className="mt-1 px-1 text-[11.5px] text-red-400/80">{erroDaMelhoria}</p>
          ) : null}
        </div>
        </div>

      {/* Só o seletor de projeto é escuro: a barra de controles fica na área clara, junto
          com o texto. */}
      {isChat ? null : (
        <div className="rounded-b-[22px] bg-koda-panel px-4 py-2.5">
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
