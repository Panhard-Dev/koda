/**
 * Cliente do backend Python (`backend/`).
 *
 * O app funciona sem ele: quando a API não responde, `App.tsx` cai na resposta
 * simulada local. Por isso tudo aqui lança em caso de falha e quem chama decide.
 */

import { invoke } from '@tauri-apps/api/core'

const rawBase = import.meta.env.VITE_API_URL as string | undefined

/** Endereço de reserva: o do navegador, onde não existe launcher para dizer a porta. */
const BASE_FIXA = (rawBase ?? 'http://localhost:8787').replace(/\/+$/, '')

/**
 * Onde a API local está atendendo **nesta execução**.
 *
 * Não é constante porque no app instalado a porta é efêmera: o launcher sorteia uma porta
 * livre a cada execução e a repassa por `invoke` (ver `src-tauri/src/acesso.rs`). A
 * ligação é viva — quem já importou este nome enxerga a troca.
 */
export let apiUrl = BASE_FIXA

/**
 * O token desta execução.
 *
 * O backend é **deny-by-default**: sem ele, toda rota `/api` devolve 401. No app desktop
 * ele vem do launcher, que o sorteia por execução e o entrega por `invoke` — o processo do
 * agente não tem como lê-lo (não está no ambiente dele, ver `_ambiente_do_comando`). No
 * navegador (dev) vem de `VITE_API_TOKEN`, o mesmo valor que o backend imprime ao subir.
 */
let tokenDaExecucao: string | null = (import.meta.env.VITE_API_TOKEN as string | undefined) ?? null

/** O cabeçalho de acesso, ou nada quando ainda não há token (dev sem `VITE_API_TOKEN`). */
export function cabecalhoDeAcesso(): Record<string, string> {
  return tokenDaExecucao ? { authorization: `Bearer ${tokenDaExecucao}` } : {}
}

/** Estamos dentro do app desktop? Só lá existe `invoke`. */
function noApp(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

let pronto: Promise<void> | null = null

/**
 * Pega com o launcher a porta e o token desta execução. Idempotente e barato: quem chama
 * várias vezes espera a mesma promessa.
 *
 * Toda requisição passa por aqui antes de sair — é o que evita a corrida entre a tela
 * carregar e o launcher ter as credenciais prontas.
 */
export function prepararAcesso(): Promise<void> {
  pronto ??= carregarCredenciais()
  return pronto
}

async function carregarCredenciais(): Promise<void> {
  if (!noApp()) return
  try {
    const dados = await invoke<{ porta: number; token: string }>('acesso')
    apiUrl = `http://127.0.0.1:${dados.porta}`
    tokenDaExecucao = dados.token
  } catch (erro) {
    // Sem credenciais a conversa não anda, mas a tela continua de pé e diz o que houve —
    // é melhor do que uma tela branca por causa do launcher.
    console.warn('[koda] não consegui obter a porta e o token do launcher', erro)
  }
}

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
  /**
   * A chamada como o modelo a escreveu, em texto. Vem do histórico (a conversa reaberta);
   * a tela não desenha isto — está aqui para o `arguments` acima ter o original ao lado
   * quando o JSON do modelo não desserializou (resposta cortada no teto de tokens).
   */
  raw_arguments?: string
  /**
   * O **recurso acionado**, quando a ferramenta vem de um servidor MCP.
   *
   * O nome da ferramenta que o modelo vê é normalizado (`mcp__eco_server__somar`) e não
   * existe em lugar nenhum: o servidor é `eco-server` no `mcps.json`. É por aqui que a
   * conversa mostra o servidor e a ferramenta reais. `null`/ausente nas ferramentas do Koda.
   */
  mcp?: { servidor: string; ferramenta: string } | null
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

/**
 * Um anexo da conversa, como o backend o devolve depois do upload.
 *
 * O conteúdo **não** vem aqui — ele fica no store do backend e só a ferramenta
 * `read_attachment` o lê. O que a tela guarda é o `id` (que ela manda no chat), o nome
 * (que ela mostra) e o tipo/tamanho.
 */
export type ApiAnexo = {
  id: string
  nome: string
  /** Mime detectado no backend (não o que o navegador declarou). */
  tipo: string
  tamanho: number
}

export type ApiMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  attachments: ApiAnexo[]
  model: string | null
  elapsed_ms: number | null
  /**
   * O que a resposta **escreveu** (soma de `completion_tokens` dos passos); `null` quando o
   * provedor não conta. É o tamanho da resposta — não o custo: cada passo reenvia o
   * contexto inteiro, então somar o total multiplicaria o mesmo contexto pelo número de
   * passos e a ficha mostraria um número absurdo.
   */
  tokens: number | null
  /** Contexto do último passo (tokens de entrada) — o medidor ao lado do modelo. */
  contexto: number | null
  at: number
  steps: ToolStep[]
  /** Lista de tarefas da resposta, quando o agente montou uma. */
  todos: ApiTodo[]
  /**
   * A rodada parou antes de terminar o que foi pedido.
   *
   * Vem gravado com a mensagem, e não só no evento `done`: é o que faz o cartão de «tarefa
   * não concluída» — com o Retomar — voltar quando a conversa é reaberta. Sem isso, reabrir
   * mostrava o plano com um item «em andamento» e nada rodando.
   */
  incompleto: boolean
  /** O **código** do motivo (`pending_steps`, `interrupted`, `provider_error`…). */
  motivo: string | null
  /** Itens do plano que ficaram em aberto, com o nome que o agente deu. */
  pendentes: string[]
  /** Quantas ferramentas rodaram de verdade nesta rodada. */
  executou: number
  /** Dá para continuar de onde parou? */
  retomavel: boolean
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
  /** `projeto` = no workspace (o agente lê o arquivo); `global` = da máquina;
   *  `cadastrada` = criada na própria tela e guardada pelo Koda (entra no prompt inteira). */
  scope: 'projeto' | 'global' | 'cadastrada'
  /** Caminho do SKILL.md — relativo ao workspace quando for do projeto; vazio quando for
   *  cadastrada (ela não é uma pasta em disco). */
  path: string
  /** Desligada, a skill sai do prompt do agente (o arquivo continua em disco). */
  enabled: boolean
}

/** O que a tela manda ao cadastrar uma skill nova. Os três campos são obrigatórios. */
export type NovoSkill = {
  name: string
  description: string
  /** O que a skill manda o agente fazer — o miolo das instruções. */
  action: string
}

/**
 * Um sub-agente, como a seção Agentes e o `@` o mostram.
 *
 * `skills` e `mcps` vazios significam **nenhum**, e não «todos»: o que o sub-agente pode usar
 * está escrito, nunca subentendido. Um agente novo não herda poder.
 */
export type ApiAgente = {
  nome: string
  prompt: string
  skills: string[]
  mcps: string[]
  /** Modelo dele, quando valer um diferente do principal. Vazio = o que o principal mandar. */
  modelo: string
}

/** O que a tela manda ao criar ou editar um sub-agente. O nome é o identificador. */
export type NovoAgente = ApiAgente

/** Os sub-agentes escritos no `subs.agentes.md`. */
export const listAgents = () => request<ApiAgente[]>('/api/agents')

/** Cria ou substitui um sub-agente pelo nome; devolve a lista como ficou. */
export const saveAgent = (agente: NovoAgente) =>
  request<ApiAgente[]>('/api/agents', { method: 'POST', body: JSON.stringify(agente) })

/** Tira o sub-agente do arquivo; devolve a lista como ficou. */
export const deleteAgent = (nome: string) =>
  request<ApiAgente[]>(`/api/agents/${encodeURIComponent(nome)}`, { method: 'DELETE' })

export type ApiMcp = {
  name: string
  description: string
  /** Comando (stdio) ou URL (endpoint) do servidor. */
  command: string
  /** Parâmetros extras do comando, como digitados. */
  params: string
  enabled: boolean
  /**
   * O servidor está no ar **agora** — o handshake MCP já respondeu.
   *
   * É estado de execução, não configuração: um servidor ligado mas que não subiu aparece
   * com `conectado: false` e o motivo em `erro`.
   */
  conectado: boolean
  /** Por que não conectou, quando não conectou (o que o servidor disse no `stderr`). */
  erro?: string | null
  /** Quantas ferramentas o servidor publicou no `tools/list`. */
  ferramentas: number
}

/** O que a tela manda ao cadastrar um servidor MCP. Nome e comando são obrigatórios. */
export type NovoMcp = {
  name: string
  command: string
  params?: string
  description?: string
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
  /** Ids dos anexos desta mensagem — o que veio de `subirAnexo`, nunca o nome do arquivo. */
  attachments: string[]
  conversation_id: string | null
  tz_offset_minutes: number
  /**
   * Retomar a tarefa da conversa, sem mensagem nova.
   *
   * É o clique no botão Retomar do cartão de "tarefa não concluída". O backend continua do
   * histórico que já existe e **não** grava turno de usuário — por isso o App não desenha
   * bolha nenhuma ao retomar. Era esse o defeito da versão antiga, que mandava
   * `text: "continue"` e fazia a tela mostrar o próprio usuário pedindo a palavra mágica.
   */
  resume?: boolean
  /**
   * Roda **livre**: nenhuma ação pede permissão antes de acontecer.
   *
   * É o que a aba Subs manda. Ela não tem cartão de permissão, e um pedido sem cartão
   * deixaria o agente parado para sempre esperando uma resposta que ninguém tem onde dar.
   * Vale só para esta rodada — o modo guardado do app não muda.
   */
  livre?: boolean
}

/**
 * Sobe um arquivo anexado na conversa e devolve os metadados (o `id` é o que vale).
 *
 * Multipart de verdade: o `File` inteiro vai no corpo — é justamente o que faltava antes,
 * quando o `Composer` mandava só o nome e o conteúdo nunca saía do navegador. O
 * `content-type` **não** é fixado aqui de propósito: o navegador o monta com o boundary do
 * multipart, e forçá-lo para `application/json` quebraria o upload.
 */
export async function subirAnexo(arquivo: File): Promise<ApiAnexo> {
  await prepararAcesso()
  const corpo = new FormData()
  corpo.append('arquivo', arquivo, arquivo.name)
  const response = await fetch(`${apiUrl}/api/attachments`, {
    method: 'POST',
    headers: { ...cabecalhoDeAcesso() },
    body: corpo,
  })
  if (!response.ok) {
    const { codigo, mensagem } = await motivoDaFalha(response)
    throw new ApiError(response.status, '/api/attachments', codigo, mensagem)
  }
  return (await response.json()) as ApiAnexo
}

/** Tira um anexo do store (o usuário removeu o chip antes de enviar a mensagem). */
export const removerAnexo = (id: string) =>
  request<void>(`/api/attachments/${encodeURIComponent(id)}`, { method: 'DELETE' })

/**
 * A sessão do navegador que a IA está dirigindo (o MCP `koda-dev-browser`).
 *
 * `vivo: false` quando não há nenhuma — e também quando a sessão parou de publicar, porque o
 * backend só considera viva a que se atualizou nos últimos segundos. Um quadro velho mostrado
 * como se estivesse ao vivo seria pior do que não mostrar nada.
 */
export type EstadoDoNavegador = {
  vivo: boolean
  porta?: number | null
  url?: string | null
  titulo?: string | null
  /**
   * Onde a página está rolada, no navegador da IA.
   *
   * Vai junto porque o painel é **outra** instância do navegador: ele carrega a página do zero
   * e, sem isto, fica no topo enquanto a IA está lendo lá embaixo. `topo` e `total` em pixels,
   * medidos na janela da IA (`janela`) — o painel converte para a proporção dele, que é outra.
   */
  rolagem?: { topo: number; total: number; janela: number; alvo?: string | null } | null
  idade_s?: number | null
  motivo?: string | null
}

export const estadoDoNavegador = () => request<EstadoDoNavegador>('/api/dev-browser')

/** Um erro já consolidado pelo MCP `koda-dev-logs` — uma linha do painel de Logs. */
export type ErroDeLog = {
  chave: string
  /** `navegador` (console/exceção), `rede` (HTTP 4xx/5xx) ou `servidor` (log do alvo). */
  fonte: string
  tipo: string
  severidade: 'grave' | 'leve'
  texto: string
  /** Arquivo e linha, quando o relato traz — vazio quando não veio, e não um chute. */
  onde?: string | null
  /** Quantas vezes a mesma assinatura apareceu. É o que evita a parede de repetição. */
  ocorrencias: number
  /** Passou do teto de repetição: sinal de laço. */
  repetindo?: boolean
  /** Nasceu depois da marca do MCP — o que a verificação pós-correção olha. */
  novo?: boolean
  primeiro?: number
  ultimo?: number
}

/**
 * O retrato dos logs que o MCP `koda-dev-logs` publicou.
 *
 * `vivo: false` quando o MCP não está rodando (nenhuma página foi aberta ainda) — e é a mesma
 * regra do `dev-browser`: lista velha mostrada como se fosse de agora seria pior do que não
 * mostrar nada.
 */
export type EstadoDosLogs = {
  vivo: boolean
  idade_s?: number | null
  fontes?: Record<string, unknown>
  resumo?: { grave?: number; leve?: number; total?: number; novos?: number; repetindo?: number }
  erros?: ErroDeLog[]
  motivo?: string | null
}

export const estadoDosLogs = () => request<EstadoDosLogs>('/api/dev-logs')

/**
 * O último quadro da sessão, como blob local.
 *
 * Vem por `fetch` e não direto no `src` da imagem porque a rota exige o token, e um `<img>`
 * não manda cabeçalho. O `src` recebe um `URL.createObjectURL` — que quem chama **precisa**
 * revogar, senão cada quadro vira um vazamento de memória.
 */
export async function quadroDoNavegador(): Promise<Blob | null> {
  const resposta = await fetch(`${apiUrl}/api/dev-browser/tela`, {
    headers: { ...cabecalhoDeAcesso() },
    cache: 'no-store',
  })
  if (!resposta.ok) return null
  return resposta.blob()
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
    if (erro.status === 401) {
      // Não é senha errada de ninguém: é o token da execução. Ele vale só para a execução
      // que o gerou — backend de uma execução anterior recusa o da atual, e vice-versa.
      return 'O serviço local recusou a credencial desta execução (401). Feche e abra o Koda de novo.'
    }
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
  await prepararAcesso()
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...cabecalhoDeAcesso(),
      ...(init.headers ?? {}),
    },
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
  // O detalhado, e não o `/api/health`: o mínimo é o que responde **sem** token (só `ok` e
  // versão, ver `app/seguranca.py`). Este é o retrato que a tela precisa — e ele exige o
  // token desta execução, que a requisição manda no cabeçalho.
  request<Health>('/api/health/detalhado', { signal: AbortSignal.timeout(1500) })

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

/** Cadastra uma skill nova; devolve a skill criada já no formato da lista. */
export const createSkill = (skill: NovoSkill) =>
  request<ApiSkill>('/api/skills', { method: 'POST', body: JSON.stringify(skill) })

/** Servidores MCP configurados (o Koda ainda não conecta nenhum de verdade). */
export const listMcps = () => request<ApiMcp[]>('/api/mcps')

/** Liga/desliga um servidor MCP; devolve o servidor atualizado. */
export const toggleMcp = (name: string) =>
  request<ApiMcp>(`/api/mcps/${encodeURIComponent(name)}/toggle`, { method: 'POST' })

/** Cadastra um servidor MCP; devolve o servidor criado já no formato da lista. */
export const createMcp = (mcp: NovoMcp) =>
  request<ApiMcp>('/api/mcps', { method: 'POST', body: JSON.stringify(mcp) })

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

export type ModoPermissao = 'manual' | 'default' | 'auto' | 'livre'

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

// ------------------------------------------------------- o painel de código

/**
 * Um item da árvore: uma pasta ou um arquivo de código.
 *
 * Só nome e caminho. Tamanho não vem aqui de propósito: a lista mostra nome, e o tamanho
 * aparece quando o arquivo é aberto — medido no `ler_arquivo`, que lê o arquivo de verdade.
 */
export type ItemDeArvore = {
  nome: string
  caminho: string
  pasta: boolean
}

/** Os filhos de uma pasta, como a aba Código os desenha. */
export type ArvoreDePasta = {
  caminho: string
  nome: string
  itens: ItemDeArvore[]
}

/**
 * O que a IA mudou num arquivo **nesta execução** do Koda — o resumo que marca a árvore.
 *
 * `mais`/`menos` são `null` quando o arquivo passou do teto do diff: a tela diz «mudou» sem
 * inventar uma contagem que não foi medida.
 */
export type MudancaDeArquivo = {
  caminho: string
  /** Qual ferramenta escreveu: `write_file`, `edit_file` ou `apply_patch`. */
  ferramenta: string
  quando: number
  /** Quantas vezes uma ferramenta escreveu neste arquivo. */
  vezes: number
  mais: number | null
  menos: number | null
  /** O arquivo não existia antes — foi criado pela IA. */
  criado: boolean
}

/** Uma linha do diff, já com a marca. `antigo`/`novo` são `null` do lado que não existe. */
export type LinhaDeDiff = {
  tipo: 'igual' | 'entrou' | 'saiu'
  antigo: number | null
  novo: number | null
  texto: string
}

/** O retrato de um arquivo alterado: o resumo mais as linhas marcadas. */
export type RetratoDaMudanca = MudancaDeArquivo & {
  /** `null` quando o arquivo passou do teto do diff. */
  linhas: LinhaDeDiff[] | null
}

/**
 * O texto de um arquivo, para o visualizador.
 *
 * `truncado` é o que permite a tela dizer «cortado» em vez de mostrar um pedaço como se
 * fosse o arquivo inteiro. `mudanca` é `null` quando a IA não mexeu neste arquivo nesta
 * execução — e aí a tela mostra o código como ele está, sem pintar nada.
 */
export type ArquivoLido = {
  caminho: string
  nome: string
  texto: string
  linhas: number
  tamanho: number
  truncado: boolean
  mudanca: RetratoDaMudanca | null
}

/** Os filhos de uma pasta — **um nível só**: quem abre a pasta pede os dela. */
export const listarArquivos = (caminho: string) =>
  request<ArvoreDePasta>(`/api/fs/arvore?caminho=${encodeURIComponent(caminho)}`)

/** O conteúdo real de um arquivo. Lê o disco a cada chamada — não há cache. */
export const lerArquivo = (caminho: string) =>
  request<ArquivoLido>(`/api/fs/arquivo?caminho=${encodeURIComponent(caminho)}`)

/**
 * Os arquivos que a IA mexeu nesta execução — o que marca a árvore.
 *
 * É uma leitura barata (só memória do backend, sem disco), feita em sondagem pela aba
 * Código: é assim que a tela acompanha a IA trabalhando com o painel aberto.
 */
export const listarMudancas = () =>
  request<{ itens: MudancaDeArquivo[] }>('/api/fs/mudancas')

/** Esquece as marcas. O arquivo no disco não é tocado. */
export const limparMudancas = () =>
  request<{ removidas: number }>('/api/fs/mudancas', { method: 'DELETE' })

/**
 * O que **uma** chamada de ferramenta mudou — é o que o cartão dela mostra na conversa.
 *
 * `criado` diz que o arquivo não existia antes; sem ele, um arquivo escrito do zero e um
 * arquivo reescrito apareceriam iguais, e são coisas diferentes.
 */
export type MudancaDaChamada = {
  caminho: string
  ferramenta: string
  criado: boolean
  /** `null` quando o arquivo passou do teto do diff. */
  linhas: LinhaDeDiff[] | null
}

/**
 * O diff de uma chamada de ferramenta, pelo id dela.
 *
 * Por chamada, e não por arquivo: num arquivo escrito três vezes na mesma conversa, o
 * acumulado apareceria igual nos três cartões. Lista vazia é resposta legítima — chamada que
 * não escreveu nada, ou conversa de uma execução anterior do Koda, porque o registro vive no
 * processo do backend e morre com ele.
 */
export const mudancasDaChamada = (id: string) =>
  request<{ itens: MudancaDaChamada[] }>(
    `/api/fs/mudancas/chamada?id=${encodeURIComponent(id)}`,
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
  tool_call: {
    id: string
    name: string
    arguments: Record<string, unknown>
    step: number
    /** Servidor e ferramenta reais, quando a chamada é de um servidor MCP. */
    mcp?: { servidor: string; ferramenta: string }
  }
  tool_result: {
    id: string
    name: string
    output: string
    duration_ms: number
    ok: boolean
    step: number
    /** A pessoa negou a ação: o passo nem chegou a rodar. */
    negado?: boolean
    /** Servidor e ferramenta reais, quando a chamada é de um servidor MCP. */
    mcp?: { servidor: string; ferramenta: string }
  }
  /**
   * O agente registrou/atualizou a lista de tarefas (o plano da tarefa grande).
   *
   * Vem como evento próprio, e não como resultado de ferramenta: é o que a conversa
   * desenha como painel, em vez de esconder atrás de "Rodar ferramenta".
   */
  todos: { todos: ApiTodo[]; step: number }
  /**
   * O que um **sub-agente** está fazendo, em nome dele.
   *
   * Vem como evento próprio, e não misturado aos passos de cima: o sub-agente narra o
   * trabalho dele numa aba da área Subs, e a conversa de cima mostra uma coisa só — a
   * chamada do `sub_agente` e o que ele devolveu. `dados` é o evento de dentro, do mesmo
   * formato dos de cima (`delta`, `tool_call`, `tool_result`, `todos`…).
   */
  sub: {
    /** O id da chamada `sub_agente` que o lançou. É a identidade da aba dele. */
    chamada: string
    agente: string
    evento: string
    dados: Record<string, unknown>
  }
  /** O agente parou pedindo permissão para mexer na máquina. */
  approval_request: PedidoPermissao
  done: {
    conversation_id: string
    message_id: string
    elapsed_ms: number
    steps: number
    completed?: boolean
    /**
     * **Por que** a rodada não fechou, como código (`pending_steps`, `time_limit`,
     * `provider_error`…). É o contrato de `loop.PARADA_*`; a tradução para leitura é do
     * `components/TarefaIncompleta.tsx`. `null`/ausente quando a rodada concluiu.
     */
    reason?: string | null
    /** Os itens do plano que ficaram em aberto — o que faltou, com o nome que o modelo deu. */
    pending_items?: string[]
    /** Quantas ferramentas rodaram de verdade: separa "nada foi executado" de "parte está no disco". */
    executed?: number
    /** Dá para retomar? Falso no único motivo que não vale a pena (`context_overflow`). */
    resumable?: boolean
    /** O que a resposta escreveu (soma de `completion_tokens`); `null` se o provedor não conta. */
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
  /** Um sub-agente lançado narrou um passo do trabalho dele. */
  onSub?: (data: StreamData['sub']) => void
  onDone?: (data: StreamData['done']) => void
  /**
   * O fluxo fechou sem evento terminal — o `done` nunca chegou.
   *
   * É o contrato de vivacidade do lado do cliente: **fluxo fechado é rodada encerrada**.
   * Sem isto, o `done` só existia no caminho de sucesso (o backend não o emite quando o
   * provedor falha), e a tela ficava presa em "Pensando"/"Trabalhando…" para sempre — o
   * `setBusy(false)` morava dentro do `onDone`, que nunca era chamado. Achado 9 do QA.
   */
  onClosed?: () => void
  onError?: (message: string) => void
  signal?: AbortSignal
}

/**
 * Envia a mensagem e consome o `text/event-stream` do servidor.
 * Lança em falha de rede; o evento `error` do protocolo é entregue via `onError`.
 */
export async function streamChat(payload: ChatPayload, handlers: StreamHandlers) {
  await prepararAcesso()
  const response = await fetch(`${apiUrl}/api/chat`, {
    method: 'POST',
    // O token vai também aqui: o stream é a rota mais importante, e ela é protegida como
    // todas as outras.
    headers: { 'content-type': 'application/json', ...cabecalhoDeAcesso() },
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
      else if (event === 'sub') handlers.onSub?.(parsed as unknown as StreamData['sub'])
      else if (event === 'approval_request')
        handlers.onApprovalRequest?.(parsed as unknown as StreamData['approval_request'])
      else if (event === 'done') {
        viuTerminal = true
        handlers.onDone?.(parsed as unknown as StreamData['done'])
      }
      else if (event === 'error') {
        // Erro também é terminal: a rodada acabou, e a tela tem de voltar ao normal.
        viuTerminal = true
        handlers.onError?.(String(parsed.message ?? 'erro no backend'))
      }
    } catch {
      // Bloco ilegível: segue lendo o stream em vez de derrubar a resposta.
    }
  }

  // O terminal desta rodada. `done` e `error` encerram; qualquer outra saída do fluxo
  // (queda de rede, backend que morreu, provedor que estourou) também encerra — e a tela
  // precisa saber, senão fica presa no estado de "trabalhando".
  let viuTerminal = false

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    blocks.forEach(dispatch)
  }
  if (buffer.trim()) dispatch(buffer)
  if (!viuTerminal) handlers.onClosed?.()
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
  await prepararAcesso()
  const response = await fetch(`${apiUrl}/api/host/sessao`, {
    method: token ? 'POST' : 'DELETE',
    headers: { 'content-type': 'application/json', ...cabecalhoDeAcesso() },
    ...(token
      ? { body: JSON.stringify({ token, nome: conta?.nome ?? null, email: conta?.email ?? null }) }
      : {}),
  })
  if (!response.ok) throw new ApiError(response.status, '/api/host/sessao')
  return (await response.json()) as EstadoDoHost
}
