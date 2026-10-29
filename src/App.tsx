import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Download, Loader2, X } from 'lucide-react'
import Composer from './components/Composer'
import type { ItemDaFila, SendPayload } from './components/Composer'
import Header from './components/Header'
import type { ConversationSummary } from './components/Header'
import KodaLogo from './components/KodaLogo'
import LoginScreen from './components/LoginScreen'
import Presente, { type Aba } from './components/Presente'
import Store from './components/Store'
import type { PlanoDaConta } from './api/cloud'
import CheckoutScreen, { type CompraDoCheckout } from './components/CheckoutScreen'

import { definirConta, definirHorasDoDia, ligar, sincronizar } from './tempo'
import SettingsScreen from './components/SettingsScreen'
import MessageFooter from './components/MessageFooter'
import Reasoning from './components/Reasoning'
import BolhaUsuario from './components/BolhaUsuario'
import FalaDoModelo from './components/FalaDoModelo'
import { CLASSE_DA_JANELA } from './components/Janela'
import TarefaIncompleta from './components/TarefaIncompleta'
import ToDosMenu from './components/ToDos'
import ToolSteps from './components/ToolSteps'
import CartaoDeCompactacao from './components/Compactacao'
import { separarCompactacoes } from './compactacao'
import type { Compactacao as AvisoDeCompactacao } from './compactacao'
import WorkingLine from './components/WorkingLine'
import ReconnectingLine from './components/ReconnectingLine'
import { LOGO_DO_PROVEDOR } from './logos-provedores'
import { SUBS_POR_RODADA } from './components/Subs'
import type { SessaoDeSub } from './components/Subs'
import {
  DENTRO_DO_TAURI,
  useAtalhosDaJanela,
  WindowControls,
} from './components/WindowControls'
import type { SettingsSection } from './components/SettingsScreen'
import ProjectPicker from './components/ProjectPicker'
import PainelLateral from './components/PainelLateral'
import BarraLateralCamera from './components/BarraLateralCamera'
import { findModel, modelMenu } from './models'
import { lerModeloSalvo, salvarModelo } from './modelo-salvo'
import { atualizarModelosCom400, lerModelosCom400 } from './modelos-com-400'
import { guardarModelosBloqueados, lerModelosBloqueados } from './modelos-bloqueados'
import { EFFORT_PADRAO } from './effort'
import type { RemoteModel } from './models'
import { dayStart, dayKey, monthStart, weekStart } from './plan'
import { PLANO_FREE, planoParaBeneficios } from './plano'
import { moedasDeTokensPorModelo } from './custo'
import { DEFAULT_APPEARANCE } from './appearance'
import type { Appearance } from './appearance'
import {
  contaGuardada,
  msAteRenovar,
  reportarUso,
  sair,
  sessaoAtual,
  sessaoParaOHost,
  usoDaConta,
  verificarSessao,
} from './api/cloud'
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
  createMcp,
  createSkill,
  deleteAgent,
  getConversation,
  health,
  listAgents,
  listConversations,
  listMcps,
  listModels,
  modelosDoProvedor,
  provedoresDeLogin,
  listPermissions,
  listProjects,
  listSkills,
  newProject,
  releaseProject,
  saveAgent,
  setPermissionMode as salvarModoPermissao,
  statusDoDownload,
  streamChat,
  decidirPlano,
  openProject,
  toggleMcp,
  toggleSkill,
} from './api/client'
import type {
  ApiAgente,
  ApiCloudUpdate,
  ApiConversationSummary,
  ApiAnexo,
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
  NovoAgente,
  NovoMcp,
  NovoSkill,
  PedidoPermissao,
  ProjectsEstado,
  ToolStep,
  UsageWindow,
} from './api/client'
import {
  dormir,
  ehFalhaDeConexao,
  ErroDoServico,
  esperaDaTentativa as esperaDeReconexao,
  QuedaDeConexao,
  TENTATIVAS_DE_RECONEXAO,
} from './reconectar'

/** Uma janela de uso já com as moedas contadas — o que a tela de Uso desenha. */
type ResumoDaJanela = { tempoMs: number; creditos: number }

/**
 * A janela que o servidor mandou, com os tokens virados em moedas.
 *
 * A conversão é aqui, e não no servidor, porque a tabela de preços mora num lugar só
 * (`src/custo.ts`) — o servidor ter uma segunda cópia dela seria a garantia de que um dia os
 * dois números divergem.
 */
function janelaDoServidor(janela: UsageWindow): ResumoDaJanela {
  return {
    tempoMs: janela.tempo_ms,
    creditos: moedasDeTokensPorModelo(janela.tokens_por_modelo),
  }
}

type Message = {
  id: string
  role: 'user' | 'assistant'
  text: string
  attachments?: ApiAnexo[]
  /** Com qual modelo esta resposta foi feita — é a chave do medidor de contexto. */
  model?: string | null
  /** Tempo de processamento da resposta — vai para a ficha no fim dela. */
  elapsedMs?: number
  /**
   * O que a resposta **escreveu** (soma de `completion_tokens` dos passos), quando o
   * provedor conta. É o tamanho da resposta, não o custo — o custo multiplicaria o
   * contexto reenviado em cada passo.
   */
  tokens?: number | null
  /**
   * O **custo** da resposta, em tokens (soma de `total_tokens` dos passos).
   *
   * É o irmão de `tokens` e não o mesmo número: `tokens` é o tamanho do que a resposta
   * escreveu, e este é o que o provedor cobrou — várias vezes maior, porque cada passo reenvia
   * o contexto inteiro. É dele que sai a conta das moedas na ficha.
   */
  tokensTotal?: number | null
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
   * Vai **gravado com a mensagem** (coluna `incompleto`): reabrir a conversa depois mostra
   * o mesmo cartão, com o Retomar. Sem isso, o plano voltava com um item «em andamento» e
   * nada rodando — sem sinal de que a tarefa tinha parado.
   */
  incompleto?: boolean
  /**
   * O **contrato** da rodada incompleta, direto do `done`: código do motivo, os itens que
   * ficaram pendentes, quantas ferramentas rodaram e se dá para retomar.
   *
   * Vem separado do texto de propósito: o loop não escreve mais instrução de uso na resposta
   * ("me diga continue"), então quem explica o que falta é o cartão — e ele precisa do dados,
   * não de uma frase para interpretar.
   */
  motivo?: string | null
  pendentes?: string[]
  executou?: number
  retomavel?: boolean
}

/**
 * Uma rodada viva: a resposta que está sendo escrita **agora**, e a conversa dela.
 *
 * Ela não mora em `messages` de propósito. `messages` é a conversa que está na tela, e a
 * rodada não é dela — é do pedido que a criou. Morando junto, trocar de conversa levava a
 * resposta embora junto, e era isso que fazia o trabalho morrer quando a pessoa ia olhar
 * outra conversa (ou os Ajustes) enquanto o agente trabalhava.
 *
 * Quando a rodada termina, a resposta passa para `messages` — se a conversa dela for a que
 * está na tela. Se não for, quem a tem é o banco: ela volta ao abrir a conversa.
 */
type RodadaViva = {
  /** Id da rodada. Único na tela, e não é o id da mensagem: são coisas diferentes. */
  id: string
  /** A conversa dela. `null` entre o envio e o `start` — o id quem dá é o backend. */
  conversa: string | null
  /** A resposta sendo escrita. */
  mensagem: Message
  controller: AbortController
}

/** Um passo de dentro de um sub-agente, como ele chega no evento `sub`. */
type EventoDeSub = {
  /** O id da chamada `sub_agente` que o lançou — é a identidade da aba dele. */
  chamada: string
  agente: string
  /** O evento de dentro: `delta`, `tool_call`, `tool_result`, `todos`… */
  evento: string
  dados: Record<string, unknown>
}

/** Um evento de dentro do sub-agente, aplicado no que a aba dele mostra. */
function aplicarEventoDoSub(sessao: SessaoDeSub, evento: EventoDeSub): SessaoDeSub {
  if (evento.evento === 'delta') {
    return { ...sessao, texto: sessao.texto + String(evento.dados.text ?? '') }
  }
  if (evento.evento === 'tool_call') {
    const passo: ToolStep = {
      name: String(evento.dados.name ?? ''),
      arguments: (evento.dados.arguments ?? {}) as Record<string, unknown>,
      output: '',
      duration_ms: 0,
      call_id: String(evento.dados.id ?? ''),
      ok: true,
      mcp: (evento.dados.mcp ?? null) as ToolStep['mcp'],
    }
    return { ...sessao, passos: [...sessao.passos, passo] }
  }
  if (evento.evento === 'tool_result') {
    const alvo = String(evento.dados.id ?? '')
    return {
      ...sessao,
      passos: sessao.passos.map((passo) =>
        passo.call_id === alvo
          ? {
              ...passo,
              output: String(evento.dados.output ?? ''),
              duration_ms: Number(evento.dados.duration_ms ?? 0),
              ok: Boolean(evento.dados.ok ?? true),
            }
          : passo,
      ),
    }
  }
  return sessao
}

/**
 * O que o App envia ao backend: o payload do Composer mais o **Retomar**.
 *
 * `resume` não é uma mensagem — é a ação do botão do cartão de tarefa não concluída. Por
 * isso ele não vira bolha na conversa (ver `handleSend`).
 */
type PayloadDeEnvio = SendPayload & { resume?: boolean; approved_plan_id?: string }

/**
 * Um pedaço da resposta viva: o que o modelo pensou, o que ele falou, ou uma ferramenta
 * que ele rodou — na ordem em que aconteceu.
 */
type Bloco =
  | { tipo: 'texto'; texto: string }
  | { tipo: 'passo'; passo: ToolStep }
  | { tipo: 'raciocinio'; texto: string }
  | { tipo: 'compactacao'; compactacao: AvisoDeCompactacao }

/**
 * Anexa a fala ao último bloco de texto aberto, ou abre um novo.
 *
 * O que chega pode trazer junto um aviso de compactação — ele viaja **dentro do texto**
 * porque precisa ficar gravado com a mensagem. Na tela ele sai do texto e vira bloco
 * próprio, no ponto exato da resposta onde a compactação aconteceu: ver
 * `components/Compactacao.tsx`.
 */
const anexarFala = (blocos: Bloco[] | undefined, texto: string): Bloco[] => {
  const lista = [...(blocos ?? [])]
  const ultimo = lista.at(-1)
  const acumulado = ultimo?.tipo === 'texto' ? ultimo.texto + texto : texto
  if (ultimo?.tipo === 'texto') lista.pop()

  if (!acumulado) {
    lista.push({ tipo: 'texto', texto: '' })
    return lista
  }

  const partes = separarCompactacoes(acumulado)
  for (const parte of partes) {
    if (parte.tipo === 'texto') lista.push({ tipo: 'texto', texto: parte.texto })
    else lista.push({ tipo: 'compactacao', compactacao: parte.compactacao })
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
  patch: { id: string; output: string; duration_ms: number; ok: boolean; mcp?: ToolStep['mcp'] },
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
            mcp: patch.mcp ?? bloco.passo.mcp ?? null,
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
  : 'Abra Ajustes › Sobre e clique em «Ver diagnóstico».'

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
    blocks.push(
      `Anexos recebidos: ${payload.attachments.map((anexo) => anexo.nome).join(', ')}.`,
    )
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
 * O que a janela mostra enquanto a sessão é conferida ou o backend inicia.
 *
 * Com sessão e backend prontos esta tela passa voando. Se a API Python demorar, ela
 * continua visível em vez de revelar um chat que ainda não funciona.
 */
function Abertura({
  aguardandoBackend = false,
  backendDemorando = false,
  onTentarNovamente,
}: {
  aguardandoBackend?: boolean
  backendDemorando?: boolean
  onTentarNovamente?: () => void
}) {
  return (
    <div className={CLASSE_DA_JANELA}>
      <div data-tauri-drag-region className="flex shrink-0 items-center p-5">
        <div className="-mr-2 ml-auto">
          <WindowControls />
        </div>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 pb-20">
        <KodaLogo className="h-10 w-auto" />
        <Loader2 className="h-4 w-4 animate-spin text-koda-accent" strokeWidth={1.8} />
        <p className="text-[13px] text-koda-fg/55">
          {aguardandoBackend ? 'iniciando o backend do Koda…' : 'abrindo o Koda…'}
        </p>
        {aguardandoBackend && backendDemorando && (
          <div className="flex flex-col items-center gap-3">
            <p className="max-w-sm text-center text-[12px] text-koda-fg/40">
              O Python está demorando para iniciar. O Koda continuará tentando automaticamente.
            </p>
            <button
              type="button"
              onClick={onTentarNovamente}
              className="rounded-lg px-3 py-1.5 text-[12px] text-koda-fg/65 transition-colors hover:bg-koda-fg/8 hover:text-koda-fg"
            >
              Tentar agora
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Reabre uma mensagem gravada.
 *
 * O texto guardado pode trazer a nota de compactação **dentro** dele — foi assim que ela
 * ficou no banco, junto da resposta, para quem reler saber que parte do histórico virou
 * resumo. Aqui ela vira o mesmo cartão que apareceu durante a conversa; as ferramentas, que
 * vêm separadas e sem a ordem de quando aconteceram, entram primeiro, como sempre entraram.
 * Sem nota nenhuma, a mensagem continua sendo só texto: nada muda para quem já tinha a
 * conversa salva.
 */
const fromApiMessage = (message: ApiMessage): Message => {
  const comum = {
    id: message.id,
    role: message.role,
    text: message.text,
    attachments: message.attachments,
    model: message.model,
    elapsedMs: message.elapsed_ms ?? undefined,
    tokens: message.tokens,
    tokensTotal: message.tokens_total,
    contexto: message.contexto,
    at: message.at,
    steps: message.steps,
    todos: message.todos ?? [],
    // O desfecho da rodada vem do banco: é ele que faz o cartão de «tarefa não concluída»
    // voltar ao reabrir a conversa. Antes ficava só na tela, e a conversa reaberta mostrava
    // o plano com um item «em andamento» e nada rodando.
    incompleto: message.incompleto,
    motivo: message.motivo,
    pendentes: message.pendentes ?? [],
    executou: message.executou,
    retomavel: message.retomavel,
  }

  const partes = message.role === 'assistant' ? separarCompactacoes(message.text) : []
  if (!partes.some((parte) => parte.tipo === 'compactacao')) return comum

  const blocos: Bloco[] = [
    ...(message.steps ?? []).map((passo): Bloco => ({ tipo: 'passo', passo })),
    ...partes.map((parte): Bloco =>
      parte.tipo === 'texto'
        ? { tipo: 'texto', texto: parte.texto }
        : { tipo: 'compactacao', compactacao: parte.compactacao },
    ),
  ]
  return { ...comum, blocos }
}

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
 * devagar, de cinco em cinco segundos, sem desistir. Partida a frio em máquina lenta não
 * deve revelar um chat sem API nem virar "modo offline" para sempre.
 */
const ESPERA_BACKEND_MS = 1000
const TENTATIVAS_BACKEND = 40
const ESPERA_BACKEND_LENTA_MS = 5000

/**
 * De quanto em quanto tempo o app pergunta ao painel se a sessão ainda vale.
 *
 * Não é o intervalo da renovação: esta pergunta **não** gira a sessão, é só uma leitura.
 * Por isso pode ser curta. Banir alguém no painel passa a ter efeito em menos de um minuto,
 * em vez de esperar o token curto vencer (20 min) ou o host perguntar de novo (10 min).
 */
const SONDA_DE_SESSAO_MS = 45_000

/**
 * Uma rodada de leitura no servidor: estado, cotas, histórico, conta, skills, MCPs e agentes.
 *
 * Os agentes vêm junto porque os dois lugares que os usam — a seção Agentes e o menu do `@` —
 * aparecem na mesma tela em que esta leitura roda.
 */
async function loadSession() {
  const [info, usage, conversations, models, skills, mcps, agents] = await Promise.all([
    health(),
    fetchUsage(),
    listConversations(),
    listModels(),
    listSkills(),
    listMcps(),
    listAgents(),
  ])
  return { info, usage, conversations, models, skills, mcps, agents }
}

function App() {
  const [messages, setMessages] = useState<Message[]>([])
  /**
   * As rodadas vivas — a resposta sendo escrita agora, e de qual conversa ela é.
   *
   * É uma lista, e não um `busy` de liga/desliga, porque cada rodada pertence a uma
   * conversa. Com um interruptor só, trocar de conversa só tinha dois caminhos: parar o
   * trabalho (era o que acontecia) ou dizer «trabalhando» na conversa errada.
   */
  const [rodadas, setRodadas] = useState<RodadaViva[]>([])
  /**
   * Como está a credencial da conta no serviço de modelos.
   *
   * Existe porque "respondendo pelo servidor local" tinha um único aviso para situações
   * bem diferentes: rede caindo (que se resolve sozinho em segundos) e sessão recusada pelo
   * painel (que só um login novo resolve). Com um aviso só, a tela mandava a pessoa tentar
   * de novo até quando não havia o que tentar.
   *
   * Sessão recusada pelo painel **não** mora mais aqui: ela virou logout. Manter um estado
   * para ela seria guardar um caso que a tela não mostra mais.
   */
  const [credencial, setCredencial] = useState<
    'enviando' | 'pronto' | 'voltando' | 'sem-sessao'
  >('enviando')
  /**
   * Por que a sessão acabou, na voz do painel.
   *
   * Quem mostra é a **tela de login**: quando o painel barra a conta, o app fecha a porta e
   * leva esta frase junto. Sem ela, quem foi banido veria a tela de entrar aparecer do nada
   * e leria isso como "o app me expulsou", não como "a conta está bloqueada".
   */
  const [motivoDaSessao, setMotivoDaSessao] = useState<string | null>(null)
  /**
   * Relógio de 400 ms enquanto a resposta está em curso.
   *
   * É ele que faz a linha de trabalho contar os segundos (a prova de que ninguém travou) e
   * que decide, olhando o último sinal, se o modelo está calado — ou seja, se a linha
   * precisa aparecer.
   */
  const [agora, setAgora] = useState(() => Date.now())
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  /** Pastas de verdade: o projeto é sempre uma pasta do disco, com o caminho salvo. */
  const [projects, setProjects] = useState<ApiProject[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [pastaPadrao, setPastaPadrao] = useState('')
  const [pastasAberto, setPastasAberto] = useState(false)
  /** Barra lateral do histórico. Sobreposição: cobre a conversa e fica acima de tudo. */
  const [painelAberto, setPainelAberto] = useState(false)
  /** A segunda barra lateral — a que o botão da câmera abre. */
  const [barraCameraAberta, setBarraCameraAberta] = useState(false)
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
  /**
   * Raciocínio e passos das ferramentas abertos na conversa. **Ligado por padrão.**
   *
   * O pensamento do modelo é parte do que está acontecendo: ele mostra o que está sendo
   * considerado antes da conclusão, e numa tarefa longa é ele que prova que tem alguém
   * trabalhando ali dentro. Esconder isso foi um engano — o interruptor existe para quem
   * preferir a conversa mais limpa, mas **não** como padrão.
   *
   * Desligado, as ferramentas ainda aparecem como **uma linha** (quantas rodaram e quanto
   * levou), com o detalhe atrás de um clique.
   */
  const [mostrarTraces, setMostrarTraces] = useState(true)
  const [history, setHistory] = useState<Conversation[]>([])
  const [view, setView] = useState<'chat' | 'settings' | 'presente' | 'checkout' | 'store'>(
    'chat',
  )
  // A área do presente é a única tela que guarda em que vista abre, e são dois caminhos que
  // discordam: o botão do cabeçalho abre no «Free» — o que a pessoa já tem, porque abrir no que
  // ela não tem é vender antes de deixar olhar — e o checkout devolve para «Planos», que é a
  // comparação de onde ela saiu. Guardado no `App` porque a área desmonta ao trocar de vista.
  const [abaDoPresente, setAbaDoPresente] = useState<Aba>('free')
  // O que o checkout está cobrando — um plano ou um pacote de créditos. `null` só existe antes
  // da primeira escolha: o checkout não é alcançável sem um produto escolhido, e as linhas que
  // o abrem são juntas.
  const [compraDoCheckout, setCompraDoCheckout] = useState<CompraDoCheckout | null>(null)
  // O plano em vigor na conta, como o painel o conta. `null` é o Free. Chega pela **sonda de
  // sessão** — a mesma resposta que já diz se a sessão está viva —, e é o que o perfil mostra
  // na etiqueta. Sem guardar isto, a tela teria de adivinhar o plano, e adivinhar plano é
  // mostrar «Free» para quem paga.
  const [planoDaConta, setPlanoDaConta] = useState<PlanoDaConta | null>(null)
  // O painel pode manter os números de um plano cancelado para o histórico. Eles não podem
  // continuar valendo como horas/moedas depois do cancelamento ou reembolso.
  const planoDeBeneficios = planoParaBeneficios(planoDaConta)
  /**
   * Os créditos **avulsos** da conta — comprados ou dados pelo painel.
   *
   * Entram no saldo da aba junto com as moedas do plano: é o que a pessoa tem além dele, e
   * deixá-los de fora fazia o número **não mudar** quando o suporte dava moedas (o plano
   * mudava, as moedas não). Vem na mesma sonda de sessão, sem ida extra à rede.
   */
  const [creditosAvulsos, setCreditosAvulsos] = useState(0)

  /**
   * Recolhe o plano da conta no painel.
   *
   * A sonda de sessão já traz isso de tempo em tempo, mas ela é lenta de propósito (minutos).
   * Depois de assinar ou cancelar, esperar por ela deixaria o perfil dizendo «Free» para quem
   * acabou de pagar — ou o contrário, para quem acabou de cancelar.
   */
  const atualizarPlano = () => {
    void verificarSessao().then((resultado) => {
      if (resultado.estado === 'viva') {
        setPlanoDaConta(resultado.plano)
        setCreditosAvulsos(resultado.creditosAvulsos)
      }
    })
  }
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('geral')
  const [model, setModel] = useState(lerModeloSalvo)
  /**
   * Troca de modelo com memória.
   *
   * A escolha vai para o `localStorage` **no clique**, e não num efeito que observa o
   * estado: assim ela já está guardada mesmo se a janela fechar no instante seguinte — e
   * fechar no instante seguinte é exatamente o que acontece quando a pessoa escolhe o
   * modelo e sai. Na abertura, quem lê é `lerModeloSalvo` (ver `src/modelo-salvo.ts`).
   */
  const escolherModelo = (valor: string) => {
    setModel(valor)
    salvarModelo(valor)
  }
  const [appearance, setAppearance] = useState<Appearance>(DEFAULT_APPEARANCE)
  /** Porta de entrada: enquanto não se sabe se há sessão, o app não aparece. */
  const [sessao, setSessao] = useState<'checando' | 'dentro' | 'fora'>('checando')
  /** Conta logada (do painel). `null` = ninguém entrou ainda. */
  const [conta, setConta] = useState<Conta | null>(contaGuardada)
  /** `null` = backend fora do ar: as respostas voltam a ser simuladas no navegador. */
  const [backend, setBackend] = useState<Health | null>(null)
  /** A primeira tela só libera o chat depois que o backend respondeu à carga inicial. */
  const [backendInicializado, setBackendInicializado] = useState(false)
  const [backendDemorando, setBackendDemorando] = useState(false)
  const [tentativaManualBackend, setTentativaManualBackend] = useState(0)
  /** Cada clique em "tentar de novo" no aviso de sessão roda o envio na hora. */
  const [tentativaDeSessao, setTentativaDeSessao] = useState(0)
  const [remoteUsage, setRemoteUsage] = useState<ApiUsage | null>(null)
  /** Catálogo do provedor (o serviço lista os modelos dele em /v1/models). */
  /** null = ainda sem resposta; [] = o host respondeu sem catálogo, então não oferecer o espelho. */
  const [remoteModels, setRemoteModels] = useState<RemoteModel[] | null>(null)
  const [modelosCom400, setModelosCom400] = useState<string[]>(lerModelosCom400)
  /**
   * Slugs que o **painel** tirou desta conta.
   *
   * Vazio = o painel não tirou nada (ou nunca foi consultado). Só entra aqui o que o painel
   * cadastrou e desligou — um modelo que ele nem conhece continua valendo, porque o dono do
   * catálogo é o host e o painel só tem o direito de riscar o que ele mesmo escreveu.
   */
  const [modelosBloqueados, setModelosBloqueados] = useState<string[]>(() =>
    lerModelosBloqueados(conta?.id),
  )
  /** Skills instaladas (o backend lê `.agents/skills` do projeto e da máquina). */
  const [skills, setSkills] = useState<ApiSkill[]>([])
  /** Servidores MCP configurados (o Koda ainda não conecta nenhum de verdade). */
  const [mcps, setMcps] = useState<ApiMcp[]>([])
  /** Os sub-agentes do `subs.agentes.md` — a seção Agentes e o menu do `@` leem daqui. */
  const [agents, setAgents] = useState<ApiAgente[]>([])
  /** As sessões de sub-agente lançadas — a área Subs abre uma aba por uma destas. */
  const [subs, setSubs] = useState<SessaoDeSub[]>([])
  /** Versão que a pessoa já dispensou no aviso do canto. */
  const [versaoDispensada, setVersaoDispensada] = useState<string | null>(
    lerVersaoDispensada,
  )
  /** Download do instalador em curso (vem do backend local, não de outra requisição). */
  const [download, setDownload] = useState<ApiDownload | null>(null)
  /** Resultado da consulta que a tela faz à nuvem ao abrir (além do resumo do health). */
  const [nuvemDetalhe, setNuvemDetalhe] = useState<ApiCloudUpdate | null>(null)
  /** A caixa que rola a conversa — é dela que sai a posição real do usuário. */
  const listaRef = useRef<HTMLDivElement>(null)
  /**
   * A coluna de conteúdo **dentro** da caixa.
   *
   * É ela que cresce a cada palavra, a cada ferramenta e a cada ficha, e é por isso que é
   * ela que o observador vigia. Vigiando só a caixa, um passo de ferramenta — que não mexe
   * no texto da resposta — crescia a conversa sem ninguém descer.
   */
  const conteudoRef = useRef<HTMLDivElement>(null)
  /**
   * A rolagem automática só entra quando a pessoa **já está** no fim da conversa.
   *
   * Antes, cada pedaço de texto que chegava chamava `scrollIntoView`: quem subia para reler
   * uma resposta antiga era puxado de volta para baixo a cada token e não conseguia ler
   * nada enquanto o modelo escrevia. Agora, subir desliga o acompanhamento; voltar ao fim
   * liga de novo.
   */
  const seguirOFimRef = useRef(true)
  /** O mesmo que `seguirOFimRef`, mas em estado — é ele que mostra e esconde o botão. */
  const [noFim, setNoFim] = useState(true)
  /**
   * A folga de quem conta como "no fim", em pixels.
   *
   * Pequena de propósito. Com os 80 px de antes, quem subia um pouco continuava contando
   * como "no fim" e era puxado de volta na palavra seguinte; e como o acompanhamento
   * descia **antes** de a rolagem acumular 80 px, a pessoa nunca chegava a desligá-lo
   * rolando de leve. Era esse o "fica bugado" de quem tentava subir durante a resposta.
   */
  const FOLGA_DO_FIM = 24

  /** Liga/desliga o acompanhamento e, junto dele, o botão do fim. */
  const marcarFim = (estaNoFim: boolean) => {
    seguirOFimRef.current = estaNoFim
    setNoFim((atual) => (atual === estaNoFim ? atual : estaNoFim))
  }

  /** O usuário está colado no fim? */
  const aoRolar = () => {
    const caixa = listaRef.current
    if (!caixa) return
    marcarFim(caixa.scrollHeight - caixa.scrollTop - caixa.clientHeight <= FOLGA_DO_FIM)
  }

  /**
   * A roda desliga o acompanhamento **na hora**, antes da próxima palavra.
   *
   * É o conserto do defeito: esperar pelo evento de rolagem só valia depois de o dedo
   * acumular distância suficiente, e o acompanhamento descia antes disso — a tela voltava
   * sozinha e parecia travada. Olhando a **intenção** (roda para cima), o primeiro
   * movimento já basta.
   */
  const aoRolarComRoda = (deltaY: number) => {
    if (deltaY < 0) marcarFim(false)
  }

  /** O botão do fim: desce de uma vez e volta a acompanhar. */
  const irParaOFim = () => {
    marcarFim(true)
    const caixa = listaRef.current
    if (!caixa) return
    caixa.scrollTo({ top: caixa.scrollHeight, behavior: 'smooth' })
  }
  /** Último sinal de vida vindo do backend (pensamento, palavra, ferramenta). */
  const ultimoSinalRef = useRef(0)
  /**
   * A rodada está **insistindo sozinha** — a conexão caiu (o laço da reconexão tentando de
   * novo) ou o provedor falhou/respondeu vazio (o loop do agente, pelo evento `aviso`) — e
   * a linha «Reconectando… NN/NN» diz qual tentativa é esta, sobre quantas.
   *
   * Regra do dono: a linha vale para **qualquer** erro, não só queda de rede. Apagada no
   * primeiro evento de verdade que chega (`sinal`): se o backend respondeu, a insistência
   * acabou e a linha sai de cena. `null` = ninguém insistindo.
   */
  const [reconexao, setReconexao] = useState<{ tentativa: number; total?: number } | null>(null)
  /** Quando a resposta em curso começou (a linha de trabalho conta a partir daqui). */
  const inicioDaRespostaRef = useRef(0)
  const timersRef = useRef<number[]>([])
  const conversationIdRef = useRef<string | null>(null)
  /**
   * A conversa na tela, também no estado.
   *
   * A ref serve aos retornos assíncronos — ler o valor de agora sem depender do render. O
   * estado serve à tela, que precisa **desenhar** a partir dele: é ele que decide qual
   * rodada viva pertence a esta conversa. Um só dos dois não dá conta dos dois papéis.
   */
  const [conversa, setConversa] = useState<string | null>(null)
  /**
   * Muda a cada troca de conversa.
   *
   * Serve para o `start` do stream saber se ele ainda fala da conversa que está na tela. Ele
   * chega de forma assíncrona, e sem isto uma conversa nova aberta nesse meio-tempo levava o
   * id de uma rodada antiga — a tela pulava para uma conversa que ninguém pediu.
   */
  const visitaRef = useRef(0)

  /** Troca a conversa da tela: a ref (para os retornos assíncronos), o estado (para
   *  desenhar) e a visita (para o `start` saber se ainda é ele quem manda). */
  const definirConversa = (id: string | null) => {
    conversationIdRef.current = id
    visitaRef.current += 1
    setConversa(id)
  }

  /**
   * As rodadas vivas, para leitura de dentro dos retornos assíncronos.
   *
   * `escreverRodadas` é o **único** caminho de escrita, e ele atualiza a ref e o estado
   * juntos. Quem está dentro do stream (o `done`, o `catch`) capturou o estado **antes** de
   * a rodada existir; sem a ref leria uma lista velha, não acharia a própria rodada, e a
   * resposta ficaria presa no limbo para sempre.
   */
  const rodadasRef = useRef<RodadaViva[]>([])
  const escreverRodadas = (mudar: (atual: RodadaViva[]) => RodadaViva[]) => {
    rodadasRef.current = mudar(rodadasRef.current)
    setRodadas(rodadasRef.current)
  }

  /**
   * A fila: as mensagens escritas enquanto o agente trabalhava.
   *
   * Espelho do estado na ref, pelo mesmo motivo das rodadas — quem lê a fila de dentro
   * de um efeito precisa da lista de agora, não da do render em que ele foi montado.
   * Cada item carrega a conversa em que nasceu: a fila de uma conversa não vaza na
   * outra, e uma mensagem nunca é mandada para a conversa errada.
   */
  const filaRef = useRef<ItemDaFila[]>([])
  const [fila, setFila] = useState<ItemDaFila[]>([])
  const escreverFila = (mudar: (atual: ItemDaFila[]) => ItemDaFila[]) => {
    filaRef.current = mudar(filaRef.current)
    setFila(filaRef.current)
  }

  /** Muda a resposta de uma rodada sem tirá-la de curso. */
  const patchRodada = (id: string, patch: (mensagem: Message) => Message) =>
    escreverRodadas((atual) =>
      atual.map((item) =>
        item.id === id ? { ...item, mensagem: patch(item.mensagem) } : item,
      ),
    )

  /** A resposta cortada no meio: o que saiu fica, e ela passa a dizer que parou. */
  const marcarInterrompida = (mensagem: Message): Message => ({
    ...mensagem,
    incompleto: true,
    motivo: 'interrupted',
    // O que faltou sai do próprio plano: o que não foi marcado como feito.
    pendentes: (mensagem.todos ?? []).filter((item) => !item.feito).map((item) => item.texto),
    retomavel: true,
  })

  /**
   * Fecha a rodada: a resposta entra na conversa e a rodada sai.
   *
   * Só entra em `messages` quando a conversa dela é a que está na tela. Nas outras, quem a
   * tem é o banco — ela volta ao abrir a conversa, e empilhá-la aqui a mostraria na conversa
   * errada.
   */
  const concluirRodada = (id: string, patch: (mensagem: Message) => Message) => {
    const alvo = rodadasRef.current.find((item) => item.id === id)
    if (!alvo) return
    const pronta = patch(alvo.mensagem)
    if (alvo.conversa === conversationIdRef.current) {
      setMessages((atual) => [...atual, pronta])
    }
    escreverRodadas((atual) => atual.filter((item) => item.id !== id))
  }

  /**
   * Para uma rodada — o botão Parar.
   *
   * A rodada simulada (backend fora do ar) não tem `catch` para fechá-la, então quem fecha é
   * quem parou. Na de verdade, o `catch` do envio chega logo depois e não acha mais nada
   * para fazer, que é o certo.
   */
  const pararRodada = (id: string) => {
    const alvo = rodadasRef.current.find((item) => item.id === id)
    if (!alvo) return
    alvo.controller.abort()
    concluirRodada(id, marcarInterrompida)
  }

  /** Derruba tudo: sessão que morreu, saída da conta. */
  const pararTudo = () => {
    rodadasRef.current.forEach((item) => item.controller.abort())
    escreverRodadas(() => [])
    // A fila morre junto: sem sessão, o que ela tem não tem para onde ir.
    escreverFila(() => [])
    timersRef.current.forEach((timer) => window.clearTimeout(timer))
    timersRef.current = []
  }
  /**
   * O último pedido que saiu daqui, inteiro (modelo, reasoning, web, esforço, pasta).
   *
   * É com ele que "rodar de novo" remonta um pedido sem adivinhar ajuste nenhum: o que
   * volta é exatamente o que a pessoa tinha escolhido na última vez.
   */
  const ultimoPayloadRef = useRef<PayloadDeEnvio | null>(null)

  /** A rodada desta conversa — a resposta sendo escrita agora, se houver. */
  const rodada = rodadas.find((item) => item.conversa === conversa) ?? null
  /**
   * O que a conversa mostra: o que está gravado **mais** a resposta em curso.
   *
   * É daqui que sai tudo o que a tela desenha. Trocar `messages` por esta lista nos pontos
   * de leitura é o que faz a resposta continuar aparecendo depois de ir e voltar de outra
   * conversa — e o que faz o agente continuar trabalhando quando ela não é a da tela.
   */
  const visiveis = rodada ? [...messages, rodada.mensagem] : messages
  /**
   * Há trabalho em curso **nesta** conversa.
   *
   * Era um `useState` global, e por isso uma rodada numa conversa punha o botão Parar em
   * todas. Agora sai da rodada da conversa: o prompt box desta mostra «trabalhando», o das
   * outras deixa mandar mensagem.
   */
  const busy = rodada !== null

  /*
   * O relógio do dia anda **enquanto o agente trabalha**, e só. Quem liga e desliga é daqui, e
   * não do `Composer`, por um motivo: a caixa é desmontada quando a pessoa sai do chat, e o
   * agente continua trabalhando enquanto isso. Se o `ligar` morasse lá, sair para os Ajustes
   * pararia a contagem no meio de uma resposta — e a hora gasta deixaria de ser contada.
   */
  useEffect(() => {
    ligar(busy)
  }, [busy])

  /*
   * O mostrador do dia é **do servidor**, não do rascunho.
   *
   * Cada resposta grava o tempo dela no banco do backend, e `/api/usage` soma a janela do dia
   * — é esse número que a aba tem de mostrar. Sem esta reapontagem a aba era só o rascunho
   * local: apagar os dados do app (ou reinstalar) devolvia as horas já gastas, e o mostrador
   * podia discordar da tela de Uso, que sempre leu o banco. O rascunho fica para o caso de o
   * backend não responder.
   */
  useEffect(() => {
    if (remoteUsage) sincronizar(remoteUsage.daily.tempo_ms / 1000)
  }, [remoteUsage])

  /*
   * O orçamento do dia é o do **plano da conta**, não o do Free.
   *
   * O plano chega pela sonda de sessão (`/api/account/me` → `plano.horas_por_dia`). Sem isto a
   * aba mostrava sempre a hora do Free: quem assinava o Plus continuava vendo `01:00:00`, e a
   * troca de plano não aparecia em lugar nenhum do chat.
   */
  useEffect(() => {
    definirHorasDoDia(planoDeBeneficios?.horas_por_dia ?? PLANO_FREE.horasPorDia)
  }, [planoDeBeneficios])

  /*
   * O rascunho do dia é **por conta**.
   *
   * O limite pertence a quem gasta: trocar de conta no mesmo PC não pode carregar o tempo que
   * a anterior deixou. O backend separa o gasto pelo mesmo e-mail (`host_auth.email_da_conta`),
   * e a chave do rascunho local acompanha — senão o paliativo do `localStorage` desmentiria o
   * número do servidor justamente na hora em que ele não responde.
   */
  useEffect(() => {
    definirConta(conta?.email ?? null)
  }, [conta])

  const hasMessages = visiveis.length > 0
  const normalizedQuery = query.trim().toLowerCase()
  const searching = searchOpen && normalizedQuery.length > 0
  const lastMessage = visiveis.at(-1)
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
    // `visiveis` e não `messages`: a rodada em curso é justamente quem tem a medida mais
    // nova, e é ela que o anel ao lado do modelo deve mostrar enquanto o agente trabalha.
    for (const mensagem of visiveis) {
      if (mensagem.role !== 'assistant' || !mensagem.model || !mensagem.contexto) continue
      mapa[mensagem.model] = mensagem.contexto
    }
    return mapa
  }, [visiveis])

  /**
   * O catálogo que o seletor pode mostrar: o do host, menos o que saiu de circulação.
   *
   * Este é o único ponto onde o painel entra na lista — daí em diante todo mundo (o menu do
   * prompt, o de Ajustes, o rótulo do modelo em uso) enxerga o mesmo recorte. Sem isso o
   * seletor continuaria oferecendo um modelo desativado, porque quem lista os modelos é o
   * host, e o host não sabe de painel: ele publica o catálogo dele e pronto.
   *
   * São **duas** portas de saída, pela mesma razão: o painel desativa um modelo, e o host
   * recusa com 400 o que ele já não tem. As duas tiram o modelo do seletor na hora.
   *
   * O teste do backend entra aqui, e não só no menu: `modeloAtivo` escolhe o primeiro da
   * lista, e um modelo que dá 400 como primeiro mandaria toda resposta nova para o erro.
   * O filtro fica **neste** ponto para o resto do app ver o mesmo recorte do menu.
   *
   * Um 400 confirmado continua excluído quando o catálogo falha ou volta sem status; uma
   * resposta 200 do mesmo modelo o libera de novo. 429, 401 e 500 não mudam essa decisão.
   */
  const modelosVisiveis = useMemo(
    () =>
      (remoteModels ?? []).filter(
        (item) =>
          !modelosBloqueados.includes(item.value) &&
          !modelosCom400.includes(item.value) &&
          item.status !== 400,
      ),
    [remoteModels, modelosBloqueados, modelosCom400],
  )
  const modelosForaDoMenu = useMemo(
    () => [...new Set([...modelosBloqueados, ...modelosCom400])],
    [modelosBloqueados, modelosCom400],
  )

  /**
   * O catálogo que o seletor usa.
   *
   * `[]` é resposta do host dizendo «não tenho nada» (é o que acontece sem a sessão da
   * conta no host), e o menu tratava isso como lista vazia — daí o «Nenhum modelo
   * disponível» com o serviço no ar. Aqui lista vazia volta a ser `null`, que é o sinal de
   * «use o espelho da casa», e o seletor nunca fica sem nada.
   */
  const catalogoDoMenu = remoteModels && remoteModels.length > 0 ? remoteModels : null

  /**
   * Os modelos dos provedores em que a pessoa entrou, agrupados por provedor.
   *
   * Ficam **separados** do catálogo do host de propósito: são de outra conta e de outro
   * caminho (o token do Koda), não do serviço que serve o chat. No seletor eles aparecem
   * como grupos próprios — «Codex», «Gemini» —, que é como ele pediu.
   *
   * A lista é pedida uma vez por sessão: entrar num provedor é evento raro, e o menu não
   * pode ficar batendo no backend a cada abertura.
   */
  const [gruposLogados, setGruposLogados] = useState<ReturnType<typeof modelMenu>>([])
  useEffect(() => {
    // `backend` entra na dependência de propósito: no arranque a sessão fica «dentro» antes
    // de o serviço local responder, e uma consulta que falha ali deixava o menu sem os
    // provedores para sempre. Com o backend na lista, a busca roda de novo quando ele sobe —
    // e o intervalo cobre o caso de a pessoa entrar num provedor com o app já aberto.
    if (sessao !== 'dentro' || backend === null) return
    let cancelado = false
    let consultando = false
    const buscar = () => {
      if (consultando) return
      consultando = true
      void (async () => {
        try {
          const lista = await provedoresDeLogin()
          const conectados = lista.filter((item) => item.conectado)
          const grupos = await Promise.all(
            conectados.map(async (provedor) => {
              const resultado = await modelosDoProvedor(provedor.id)
              if (resultado.modelos.length === 0) return null
              return {
                value: `provedor-${provedor.id}`,
                label: provedor.nome,
                icon: (
                  <img
                    src={LOGO_DO_PROVEDOR[provedor.id]}
                    alt=""
                    aria-hidden="true"
                    className="h-3.5 w-3.5 object-contain"
                  />
                ),
                // O valor carrega o provedor (`provedor:<id>:<modelo>`): é o que permite ao
                // backend saber de quem é o modelo **sem** depender de cache — e é o que
                // impede esse id de vazar para o host, que só conhece o catálogo dele.
                options: resultado.modelos.map((modelo) => ({
                  value: `provedor:${provedor.id}:${modelo}`,
                  label: resultado.nomes?.[modelo] ?? modelo,
                })),
              } as ReturnType<typeof modelMenu>[number]
            }),
          )
          if (!cancelado) {
            setGruposLogados(
              grupos.filter((item): item is NonNullable<typeof item> => item !== null),
            )
          }
        } catch {
          // Serviço local fora do ar ou provedor sem lista: o menu fica com o catálogo.
        } finally {
          consultando = false
        }
      })()
    }
    buscar()
    const timer = window.setInterval(buscar, 8_000)
    return () => {
      cancelado = true
      window.clearInterval(timer)
    }
  }, [sessao, backend])

  /** O teto que o backend aplica à conversa — o denominador do anel. */
  const janelaDoContexto = useMemo(() => {
    const doBackend = backend?.contexto_tokens ?? 0
    if (doBackend > 0) return doBackend
    const doCatalogo = modelosVisiveis.find((item) => item.janela)?.janela ?? null
    return doCatalogo ?? null
  }, [backend, modelosVisiveis])

  const todosAtivos = useMemo(() => {
    const ultima = [...visiveis].reverse().find((message) => message.role === 'assistant')
    return ultima?.todos ?? []
  }, [visiveis])
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
      visiveis
        .filter((message) =>
          [message.text, ...(message.attachments ?? []).map((anexo) => anexo.nome)]
            .join(' ')
            .toLowerCase()
            .includes(normalizedQuery),
        )
        .map((message) => message.id),
    )
  }, [visiveis, normalizedQuery, searching])

  const lastText = visiveis.at(-1)?.text

  /**
   * Desce a rolagem **direto na caixa**.
   *
   * Nunca por `scrollIntoView`: ele sobe a árvore e empurra **todo** ancestral rolável —
   * inclusive os `overflow: hidden`, que também guardam `scrollTop`. A casca do app tem de
   * ficar parada; quem rola é a conversa, e só ela.
   */
  const descerAoFim = () => {
    const caixa = listaRef.current
    if (!caixa) return
    caixa.scrollTop = caixa.scrollHeight
  }

  useEffect(() => {
    if (!seguirOFimRef.current) return
    // Sem `behavior: 'smooth'` de propósito: a rolagem suave fica **atrás** do texto que
    // chega, e a distância medida durante a animação parecia "saiu do fim" — o
    // acompanhamento se desligava sozinho no meio da resposta.
    descerAoFim()
  }, [visiveis.length, busy, lastText])

  /**
   * E o mesmo para **qualquer** crescimento da conversa — inclusive o que não mexe no texto
   * da última resposta: um passo de ferramenta a mais, a ficha que fecha, o raciocínio que
   * abre. É o que faz o pedido valer inteiro: a IA falou **ou** usou ferramenta, a tela
   * desce.
   */
  useEffect(() => {
    const conteudo = conteudoRef.current
    if (!conteudo) return
    const observador = new ResizeObserver(() => {
      if (!seguirOFimRef.current) return
      const caixa = listaRef.current
      if (!caixa) return
      caixa.scrollTop = caixa.scrollHeight
    })
    observador.observe(conteudo)
    return () => observador.disconnect()
  }, [])

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

  useEffect(() => {
    setModelosBloqueados(lerModelosBloqueados(conta?.id))
  }, [conta?.id])

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
      // barrada). Não há o que tentar sozinho — quem resolve é entrar de novo.
      //
      // E é **entrar de novo** mesmo: a porta fecha agora. Antes daqui saía só um aviso no
      // canto e a pessoa continuava dentro do app, com a tela parecendo normal enquanto
      // nada do que ela pedisse funcionava — o pior dos mundos, porque o aviso parecia um
      // detalhe. A cópia local da sessão já foi apagada pela própria renovação; o que falta
      // é a tela obedecer. O motivo vai junto para o login dizer por que a sessão acabou.
      if (credencial.estado === 'morta') {
        setMotivoDaSessao(credencial.motivo)
        setConta(null)
        setSessao('fora')
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
        const conversasDaConta = await listConversations()
        if (cancelado) return
        setHistory(conversasDaConta.map(fromApiSummary))
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

  /**
   * A sonda: a sessão ainda vale, e o painel tirou algum modelo desta conta?
   *
   * As duas perguntas viajam juntas porque são a mesma consulta — o perfil da conta. Uma
   * responde "a conta foi barrada?", a outra "o catálogo mudou?".
   *
   * Sem a sonda, o banimento só teria efeito quando alguma das contagens do app terminasse:
   * a renovação é devida perto dos 12 minutos do token curto, e o efeito de sessão chega a
   * esperar 10 minutos entre uma volta e outra. Nesse meio-tempo a pessoa ficaria dentro do
   * app, com a tela normal, mesmo depois de o painel já ter recusado tudo dela.
   *
   * Ela é barata de propósito: uma leitura, sem girar a sessão (a rotação é de uso único) e
   * sem escrever nada. E nunca derruba por dúvida: "sem rede" não é "sem sessão", então uma
   * consulta que tropeçou não devolve ninguém para a tela de login.
   */
  useEffect(() => {
    if (sessao !== 'dentro') return
    let cancelado = false
    let timer: number | undefined

    const rodar = async () => {
      // Uma volta de cada vez: o foco, a rede voltando e o relógio podem coincidir, e sem
      // isto cada um agendaria a sua própria próxima volta.
      if (timer !== undefined) {
        window.clearTimeout(timer)
        timer = undefined
      }

      const resultado = await verificarSessao()
      if (cancelado) return

      if (resultado.estado === 'morta') {
        // O painel barrou a conta. Não há o que insistir: a cópia local já foi apagada pela
        // própria sonda. Aqui a tela obedece na hora — e leva o motivo junto, para o login
        // não parecer que a pessoa foi expulsa sem explicação.
        // A sessão morreu: aí sim derruba tudo. Não há credencial para o trabalho continuar.
        pararTudo()
        definirConversa(null)
        tokenEntregueRef.current = null
        setMessages([])
        setHistory([])
        setQuery('')
        setSearchOpen(false)
        setRemoteUsage(null)
        setView('chat')
        setMotivoDaSessao(resultado.motivo)
        setConta(null)
        setSessao('fora')
        return
      }

      // Só a resposta afirmativa mexe no catálogo: "sem rede" não é motivo para reabrir um
      // modelo que o painel tirou. O plano entra pela mesma porta, e pela mesma razão.
      if (resultado.estado === 'viva') {
        setModelosBloqueados(resultado.bloqueados)
        guardarModelosBloqueados(conta?.id, resultado.bloqueados)
        setPlanoDaConta(resultado.plano)
        setCreditosAvulsos(resultado.creditosAvulsos)
      }

      timer = window.setTimeout(() => void rodar(), SONDA_DE_SESSAO_MS)
    }

    // A máquina dorme, a janela fica escondida por horas, a rede cai e volta: em todos esses
    // casos a resposta velha pode já estar errada. Voltar é motivo para perguntar na hora.
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
  }, [sessao])

  /**
   * Um modelo que o painel desativou sai do seletor na hora — e se era o escolhido, quem
   * manda passa a ser o primeiro que sobrou.
   *
   * `model` é a escolha guardada, e ela pode apontar para um modelo que o painel tirou
   * enquanto o app estava aberto. A conferência é feita **no render**, e não por um efeito
   * corrigindo o estado depois: sem isso existiria um quadro com a tela apontando para um
   * modelo que não está mais na lista — e é justamente nesse quadro que a mensagem seguinte
   * sairia nele.
   *
   * Sem catálogo, usa o espelho local já descontando os 400 confirmados. Se o host listou
   * modelos mas todos foram recusados, não há modelo ativo nem envio até algum responder.
   */
  const modeloAtivo = useMemo(() => {
    const doHost = catalogoDoMenu !== null
      ? modelosVisiveis.map((item) => item.value)
      : modelMenu(null, modelosForaDoMenu).flatMap((grupo) =>
          (grupo.options ?? []).map((item) => item.value),
        )
    // Os modelos das contas logadas também são escolha válida: eles aparecem no menu, então
    // precisam contar como «disponível» — senão o seletor abria neles e o rótulo continuava
    // dizendo «nenhum modelo».
    const dosProvedores = gruposLogados.flatMap((grupo) =>
      (grupo.options ?? []).map((item) => item.value),
    )
    const disponiveis = [...new Set([...doHost, ...dosProvedores])]
    return disponiveis.includes(model) ? model : (disponiveis[0] ?? '')
  }, [catalogoDoMenu, modelosVisiveis, modelosForaDoMenu, gruposLogados, model])

  /**
   * Um modelo bloqueado não volta pela porta de trás.
   *
   * "Rodar de novo" e "continuar" reaproveitam o pedido anterior inteiro — inclusive o
   * modelo que foi usado naquela vez. Se o painel desativou esse modelo no meio, repetir o
   * pedido seria um jeito de continuar usando exatamente o que ele tirou, sem passar pelo
   * seletor. Aqui o modelo guardado só vale se ainda estiver de pé; se não, cai no ativo.
   *
   * Vale igual para o modelo que saiu do catálogo do host: repetir "Continuar" no `liz-4`
   * depois do 400 seria reintroduzir à mão o modelo que acabou de sair da lista.
   */
  const modeloSeguro = (escolhido: string | null | undefined): string =>
    escolhido &&
    !modelosBloqueados.includes(escolhido) &&
    modelosVisiveis.some((item) => item.value === escolhido)
      ? escolhido
      : modeloAtivo

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
        const { info, usage, conversations, models, skills, mcps, agents } =
          await loadSession()
        if (cancelled) return
        setBackend(info)
        setBackendInicializado(true)
        setBackendDemorando(false)
        setRemoteUsage(usage)
        setHistory(conversations.map(fromApiSummary))
        setRemoteModels(models)
        setModelosCom400(atualizarModelosCom400(models))
        setSkills(skills)
        setMcps(mcps)
        setAgents(agents)
        // As pastas e a permissão vivem no banco do backend: é o que ele tem, não o que a
        // tela lembra.
        void carregarPastas()
      } catch {
        if (cancelled) return
        setBackend(null)
        const proxima = tentativa + 1
        if (proxima > TENTATIVAS_BACKEND) setBackendDemorando(true)
        if (proxima <= TENTATIVAS_BACKEND) {
          timer = window.setTimeout(() => void connect(proxima), ESPERA_BACKEND_MS)
        } else {
          timer = window.setTimeout(() => void connect(proxima), ESPERA_BACKEND_LENTA_MS)
        }
      }
    }

    void connect(0)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [sessao, backend, tentativaManualBackend])

  // O backend pode responder antes do host de modelos. Um catálogo vazio nessa primeira
  // leitura não autoriza mostrar a lista fixa para sempre: insiste até o host publicar algo.
  useEffect(() => {
    if (sessao !== 'dentro' || backend === null || remoteModels?.length !== 0) return
    let cancelado = false
    let consultando = false
    const timer = window.setInterval(() => {
      if (consultando) return
      consultando = true
      void listModels()
        .then((models) => {
          if (cancelado || models.length === 0) return
          setRemoteModels(models)
          setModelosCom400(atualizarModelosCom400(models))
        })
        .catch(() => {})
        .finally(() => { consultando = false })
    }, 5_000)
    return () => {
      cancelado = true
      window.clearTimeout(timer)
    }
  }, [sessao, backend, remoteModels])

  // Contagem local, usada quando não há backend (e como base do modo offline).
  const usageCounts = useMemo(() => {
    const all = [...history.flatMap((conversation) => conversation.messages), ...visiveis]
    // O mapa do ano sem backend: o mesmo cálculo por dia, com o que está na tela.
    const dias: Record<string, number> = {}
    for (const message of all) {
      const key = dayKey(new Date(message.at))
      dias[key] = (dias[key] ?? 0) + 1
    }

    /**
     * O que uma janela gastou, com o que está na tela.
     *
     * A conta é a **mesma do servidor**: o tempo é a soma de `elapsedMs` (a hora gasta
     * respondendo — conversa parada não consome) e os tokens vão **por modelo**, para o preço
     * sair certo. Mensagem de pessoa não entra em nenhum dos dois: ela não tem nem tempo nem
     * modelo.
     */
    const janela = (desde: number) => {
      const dentro = all.filter((message) => message.at >= desde)
      const porModelo: Record<string, number> = {}
      for (const message of dentro) {
        if (!message.model || !message.tokensTotal) continue
        porModelo[message.model] = (porModelo[message.model] ?? 0) + message.tokensTotal
      }
      return {
        tempoMs: dentro.reduce((soma, message) => soma + (message.elapsedMs ?? 0), 0),
        creditos: moedasDeTokensPorModelo(porModelo),
      }
    }

    return {
      messages: all.length,
      conversations: history.length + (visiveis.length > 0 ? 1 : 0),
      dias,
      daily: janela(dayStart().getTime()),
      weekly: janela(weekStart().getTime()),
      monthly: janela(monthStart().getTime()),
    }
  }, [history, visiveis])

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
    visiveis.length > 0
      ? [
          {
            id: conversationIdRef.current ?? newId(),
            title: titleFor(visiveis),
            preview: previewFor(visiveis),
            messages: visiveis,
          },
          ...rest,
        ]
      : rest

  /**
   * O uso vem do **painel**; o backend local é a reserva.
   *
   * É o painel que guarda o gasto **da conta** — o local é do PC, e some ao reinstalar ou ao
   * trocar de máquina. A reserva existe para a tela não ficar vazia quando a nuvem não
   * responde: ela é medida nesta máquina, então é o melhor número que existe sem rede.
   */
  const refreshUsage = async () => {
    try {
      setRemoteUsage(await usoDaConta())
      return
    } catch {
      // Sem sessão ou sem rede: quem responde é a medição local.
    }
    try {
      setRemoteUsage(await fetchUsage())
    } catch {
      setBackend(null)
    }
  }

  /**
   * As moedas que a conta ainda tem no mês: o que o plano dá, **mais os créditos avulsos**,
   * menos o que já foi gasto.
   *
   * O avulso entra porque é dinheiro da pessoa: o suporte dá moedas e o número da aba tem de
   * mudar — antes ele só olhava o plano, e dar crédito não mexia em nada na tela.
   *
   * O gasto sai do uso (que vem do painel) convertido pela tabela de preços. `floor` de
   * propósito: prometer a moeda que o saldo não fecha é o erro que a régua das conversas já
   * evita do mesmo jeito. `null` quando não há nem plano nem uso (a aba cai na constante do
   * Free, que é o degrau de baixo).
   */
  const saldoDeMoedas =
    planoDaConta || remoteUsage || creditosAvulsos > 0
      ? Math.max(
          0,
          Math.floor(
            (planoDeBeneficios?.moedas_por_mes ?? PLANO_FREE.moedasPorMes) +
              creditosAvulsos -
              (remoteUsage ? moedasDeTokensPorModelo(remoteUsage.monthly.tokens_por_modelo) : 0),
          ),
        )
      : null

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

  /**
   * Conversa nova.
   *
   * A rodada em curso **não** é abortada: ela é de outra conversa, e o pedido é que continue
   * trabalhando enquanto a pessoa olha outra coisa. Antes, este clique matava o trabalho.
   */
  const handleNewChat = () => {
    definirConversa(null)
    if (backend) void refreshHistory()
    else setHistory((current) => archivedCurrent(current))
    setMessages([])
    setQuery('')
    setSearchOpen(false)
  }

  /**
   * Abre uma conversa do histórico.
   *
   * Também **não** aborta nada. Se a conversa aberta for a de uma rodada viva, a resposta que
   * está sendo escrita reaparece no fim dela — quem junta as duas coisas é o `visiveis`.
   */
  const handleOpenConversation = (id: string) => {
    setQuery('')
    setSearchOpen(false)

    if (backend) {
      void (async () => {
        try {
          const conversation = await getConversation(id)
          setMessages(conversation.messages.map(fromApiMessage))
          definirConversa(conversation.id)
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
    definirConversa(target.id)
  }

  /**
   * O botão Parar — para a rodada **desta** conversa.
   *
   * A marca de «parou» não é posta aqui à mão: quem a põe é o `pararRodada`, que fecha a
   * rodada com o mesmo cartão que o «interrompido» de qualquer outro caminho.
   */
  const handleStop = () => {
    if (rodada) pararRodada(rodada.id)
  }

  // O aviso de versão nova depende de alguém ter consultado a nuvem — e quem consulta é o
  // backend local. A janela abre **sem esperar** o Python subir, então perguntar na
  // montagem chegava antes de a porta atender: a chamada falhava, o `catch` engolia e o
  // aviso nunca aparecia (o cartão de Ajustes só funcionava porque reconsulta ao abrir).
  // Agora a pergunta sai quando o backend responde pela primeira vez — e de novo se ele
  // cair e voltar. O backend guarda o resultado por 15 minutos, então não vira enxurrada.
  useEffect(() => {
    if (!DENTRO_DO_TAURI || !backend) return
    cloudUpdate()
      .then(setNuvemDetalhe)
      .catch(() => {
        // Nuvem fora do ar: o health responde o que já sabe.
      })
  }, [backend])

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
   * Cadastra uma skill e a põe na lista na hora. Devolve a promessa para o formulário
   * saber se deu certo (e mostrar o motivo quando não deu — nome repetido, backend fora).
   */
  const handleAddSkill = async (skill: NovoSkill) => {
    const criada = await createSkill(skill)
    setSkills((current) => [criada, ...current])
  }

  /** Mesma régua do cadastro de skill, para servidores MCP. */
  const handleAddMcp = async (mcp: NovoMcp) => {
    const criado = await createMcp(mcp)
    setMcps((current) => [...current, criado])
  }

  /**
   * Um conector da Store mudou de estado: relê a lista de MCPs.
   *
   * É o que faz o conector ativado na Store **aparecer na área MCP** (Ajustes → MCPs e o
   * submenu do cabeçalho) sem a pessoa sair e voltar. Sem isto, a Store dizia «Ativo» e o
   * resto do app continuava mostrando a lista de antes — duas verdades na mesma tela.
   */
  const handleConectoresMudaram = () => {
    listMcps()
      .then(setMcps)
      .catch(() => {})
  }

  /**
   * Salva um sub-agente e fica com a lista que o backend devolveu.
   *
   * A lista vem do backend, e não de um `[...current, agente]` montado aqui: salvar com um
   * nome que já existe **substitui** aquele agente, e uma lista montada na tela mostraria
   * dois. Quem sabe o que ficou escrito é o arquivo.
   */
  const handleSaveAgent = async (agente: NovoAgente) => {
    setAgents(await saveAgent(agente))
  }

  const handleDeleteAgent = async (nome: string) => {
    setAgents(await deleteAgent(nome))
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
    // Sair da conta derruba as rodadas: sem sessão, o trabalho não teria como continuar.
    pararTudo()
    definirConversa(null)
    setMessages([])
    setHistory([])
    setQuery('')
    setSearchOpen(false)
    setRemoteUsage(null)
    setView('chat')
    // Sair por vontade própria não tem motivo a explicar: a frase é do painel, e ela só
    // deve aparecer quando foi o painel que barrou a conta.
    setMotivoDaSessao(null)
    setConta(null)
    setSessao('fora')
    void sair()
  }

  /**
   * O cartão do plano (`bloco plano`) decide o destino da tarefa: **Fazer** aceita e
   * **Desistir** recusa. O clique nasce lá dentro (sem saber quem envia) e chega aqui
   * como evento de janela — este é o único ouvido, e ele transforma a decisão na
   * mensagem que o agente entende. As configurações (modelo, esforço, web, pasta) são
   * as do último envio, porque aceitar um plano é continuar a mesma conversa; sem
   * último envio, sai do modelo ativo com o resto no padrão.
   */
  useEffect(() => {
    const aoDecidir = (evento: Event) => {
      const detail = (evento as CustomEvent<{ aceito?: boolean; planId?: string; onResult?: (ok: boolean) => void }>).detail
      if (!detail?.planId) return
      void decidirPlano(detail.planId, detail.aceito === false ? 'reject' : 'approve')
        .then(({ execution }) => {
          if (execution && execution.conversation_id === conversationIdRef.current) {
            detail.onResult?.(true)
            return handleSend({ ...execution,
              text: '', attachments: [], resume: true })
          }
          detail.onResult?.(!execution)
        }).catch((error: unknown) => {
          detail.onResult?.(false)
          console.warn('[koda] decisão do plano recusada', error)
        })
    }
    window.addEventListener('koda-plano', aoDecidir)
    return () => window.removeEventListener('koda-plano', aoDecidir)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model])

  const handleSend = async (payload: PayloadDeEnvio) => {
    /**
     * A resposta desta conversa está em curso? Então a mensagem **não** é enviada agora:
     * ela vai para a fila e sai quando a rodada terminar.
     *
     * Quem decide é daqui, e não a caixa. A caixa olharia o `busy` do render dela, e
     * entre a rodada acabar e o render chegar existe um vão em que a prop está velha —
     * por esse vão uma mensagem entraria na fila já sem ninguém trabalhando, e ninguém
     * mais a mandaria. A `rodadasRef` é a lista de agora, sem vão nenhum.
     */
    if (rodadasRef.current.some((item) => item.conversa === conversationIdRef.current)) {
      handleEnfileirar(payload)
      return
    }
    // De qual visita à conversa é este envio. O `start` do stream chega depois, e é esta
    // marca que diz se ele ainda fala da conversa que está na tela.
    const visitaNoEnvio = visitaRef.current
    // Mandar (ou retomar) é dizer "me mostre isto": o acompanhamento volta a valer mesmo
    // que a pessoa estivesse lendo algo mais acima na conversa.
    marcarFim(true)
    // Retomar **não** é uma mensagem da pessoa: o backend continua o histórico e não grava
    // turno de usuário, então desenhar uma bolha aqui criaria na tela uma fala que não
    // existe no banco. Era o defeito antigo: o botão virava uma bolha com "continue".
    if (!payload.resume) {
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
    }
    // A rodada nasce **aqui**, antes de saber se o backend está no ar: ela é a resposta sendo
    // escrita, e as duas formas de escrevê-la (o stream e a resposta simulada) terminam do
    // mesmo jeito — fechando a rodada. É ela que diz à tela que há trabalho em curso, e é
    // por ela que a resposta sobrevive à troca de conversa.
    const rodadaId = newId()
    const controller = new AbortController()
    escreverRodadas((atual) => [
      ...atual,
      {
        id: rodadaId,
        // A conversa é a de agora. Numa conversa nova ela ainda não tem id; quem o traz é o
        // `start` do stream, e é ele que reaponta a rodada para lá.
        conversa: conversationIdRef.current,
        mensagem: {
          id: newId(),
          role: 'assistant',
          text: '',
          model: payload.model,
          at: Date.now(),
          steps: [],
          todos: [],
        },
        controller,
      },
    ])
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
        const { info, usage, conversations, models, skills, mcps, agents } =
          await loadSession()
        setBackend(info)
        setRemoteUsage(usage)
        setHistory(conversations.map(fromApiSummary))
        setRemoteModels(models)
        setModelosCom400(atualizarModelosCom400(models))
        setSkills(skills)
        setMcps(mcps)
        setAgents(agents)
        online = true
      } catch {
        online = false
      }
    }

    // Sem backend: mantém o comportamento antigo, com resposta simulada.
    if (!online) {
      const timer = window.setTimeout(() => {
        // Pararam a rodada no meio dos 800 ms: quem a fechou foi o `pararRodada`, e escrever
        // por cima aqui desfaria a marca de interrompida.
        if (controller.signal.aborted) return
        concluirRodada(rodadaId, (mensagem) => ({
          ...mensagem,
          text: buildReply(payload),
          elapsedMs: performance.now() - startedAt,
        }))
      }, 800)
      timersRef.current.push(timer)
      return
    }

    /** Tudo o que o stream faz daqui para baixo mexe na resposta **daquela** rodada. */
    const patchAssistant = (patch: (message: Message) => Message) => patchRodada(rodadaId, patch)
    /** Ferramenta anunciada: entra na lista como "rodando" até o resultado voltar. */
    const abrirPasso = (
      id: string,
      name: string,
      argumentos: Record<string, unknown>,
      mcp?: ToolStep['mcp'],
    ) =>
      patchAssistant((message) => {
        const passo: ToolStep = {
          name,
          arguments: argumentos,
          output: '',
          duration_ms: 0,
          call_id: id,
          ok: true,
          mcp: mcp ?? null,
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
      mcp?: ToolStep['mcp']
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
                // O `tool_result` traz o endereço de origem do MCP; sem ele, um passo aberto
                // pelo `tool_call` (que também traz) ficaria sem — e a linha mostraria o
                // nome normalizado.
                mcp: patch.mcp ?? step.mcp ?? null,
              }
            : step,
        ),
        blocos: fecharPassoNosBlocos(message.blocos, patch),
      }))

    /**
     * Cada evento que chega do backend reinicia o silêncio que faz a linha de trabalho
     * aparecer — e apaga a linha «Reconectando…»: se algo chegou de verdade, a insistência
     * acabou (ou nunca houve) e a linha sai de cena.
     */
    const sinal = () => {
      ultimoSinalRef.current = Date.now()
      setReconexao(null)
    }

    /**
     * O corpo do pedido, do jeito que a tentativa precisa.
     *
     * `retomando` é a reconexão no meio da resposta: o backend já tem a mensagem do
     * usuário gravada e continua **do histórico** (`resume`), em vez de receber a
     * mesma pergunta de novo e respondê-la duas vezes. Sem `start` a tentativa ainda
     * não tinha chegado ao backend, e aí o pedido original é o certo.
     */
    const pedido = (retomando: boolean) => ({
      text: payload.text,
      model: payload.model,
      reasoning: payload.reasoning,
      effort: payload.effort,
      web: payload.web,
      project_path: payload.project_path,
      // O chat manda os **ids** dos anexos (o conteúdo já subiu no upload); o backend
      // resolve cada id no store e a `read_attachment` é quem lê o arquivo.
      attachments: payload.attachments.map((anexo) => anexo.id),
      conversation_id: conversationIdRef.current,
      tz_offset_minutes: new Date().getTimezoneOffset(),
      resume: retomando ? true : payload.resume,
      approved_plan_id: retomando ? undefined : payload.approved_plan_id,
    })

    /**
     * O laço da reconexão: até 10 tentativas, uma depois da outra, para **qualquer**
     * erro — queda de rede (o `fetch` sem resposta), 5xx do serviço, fluxo fechado no
     * meio, silêncio estourado (o sinal de vivo do cliente) e até os erros de pedido
     * (401/422/404: repetir pode não adiantar, mas dez tentativas com aviso na tela
     * custam menos que a rodada morrer sem explicar). Só o **Parar** encerra na hora.
     * Acertando, a rodada segue normalmente — o contexto é o do backend, que nunca
     * saiu de lá. Esgotando, a rodada morre dizendo o erro.
     */
    // Fora do laço de propósito: a tentativa 2 precisa de saber se a 1 chegou a
    // começar (aí o pedido vai como `resume`, e não como pergunta nova).
    let comecouEmAlgumaTentativa = false
    // A conversa já existia **antes** deste envio: a pessoa está numa conversa aberta,
    // ou mandou pelo Continuar. Vale pelo mesmo motivo do `comecou...`: o
    // `append_message` do backend corre **antes** do primeiro evento (`start`), então
    // uma falha entre os dois já gravou a mensagem — e a tentativa seguinte precisa de
    // `resume` para não gravá-la uma segunda vez. Conversa nova sem `start`: nada foi
    // gravado ainda, e repetir como pedido novo é o certo.
    const conversaExistiaAntes =
      Boolean(conversationIdRef.current) || payload.resume === true
    for (let tentativa = 1; tentativa <= TENTATIVAS_DE_RECONEXAO; tentativa++) {
      // O fluxo fechou sem `done`/`error` nesta tentativa — queda no meio da resposta.
      let fechouSemTerminal = false
      const retomando =
        tentativa > 1 && (comecouEmAlgumaTentativa || conversaExistiaAntes)
      try {
        await streamChat(pedido(retomando), {
          signal: controller.signal,
          onStart: (data) => {
            comecouEmAlgumaTentativa = true
            // O backend é quem dá o id da conversa. A rodada passa a ser dela — é isto que
            // faz a resposta continuar sendo desenhada na conversa certa, e não na que
            // estiver na tela quando o primeiro pedaço de texto chegar.
            escreverRodadas((atual) =>
              atual.map((item) =>
                item.id === rodadaId ? { ...item, conversa: data.conversation_id } : item,
              ),
            )
            // A tela só passa a ser esta conversa se ela ainda for a mesma de quando a
            // mensagem saiu: se a pessoa já abriu outra, quem manda é ela, não o backend.
            if (visitaRef.current === visitaNoEnvio) {
              definirConversa(data.conversation_id)
              // O que estiver na fila desta conversa nova ainda não tinha id — a conversa
              // era `null` quando a mensagem foi enfileirada. Sem este re-apontamento a
              // fila nunca saberia que é desta conversa, e a mensagem ficaria esperando
              // para sempre. Só vale enquanto a tela continua nesta conversa: se a pessoa
              // foi para outra, o `null` continua sendo da conversa de origem dela.
              escreverFila((atual) =>
                atual.map((item) =>
                  item.conversa === null ? { ...item, conversa: data.conversation_id } : item,
                ),
              )
            }
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
          // O provedor falhou (ou respondeu vazio) e o **backend** está insistindo: em vez
          // de um texto de aviso, a linha «Reconectando… NN/NN» acende com o contador dele.
          // É o que faz a linha aparecer para qualquer erro, e não só quando a conexão cai —
          // regra do dono. O `text` do evento não é mostrado em lugar nenhum.
          onAviso: (data) => {
            sinal()
            if (data.tentativa != null) {
              setReconexao({ tentativa: data.tentativa, total: data.total })
            }
          },
          onToolCall: (data) => {
            sinal()
            abrirPasso(data.id, data.name, data.arguments, data.mcp)
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
          // O sub-agente narra numa aba da área Subs, e não na conversa de cima: aqui só se
          // guarda o que ele contou, endereçado à chamada que o lançou.
          onSub: (evento) => {
            sinal()
            setSubs((atual) => {
              const indice = atual.findIndex((item) => item.chamada === evento.chamada)
              const base: SessaoDeSub =
                indice >= 0
                  ? atual[indice]
                  : {
                      chamada: evento.chamada,
                      agente: evento.agente,
                      texto: '',
                      passos: [],
                      vivo: true,
                    }
              const atualizada = aplicarEventoDoSub(base, evento)
              const lista =
                indice >= 0
                  ? atual.map((item, posicao) => (posicao === indice ? atualizada : item))
                  : [...atual, atualizada]
              // O teto de abas é do Subs: ficam as últimas, e as de rodadas antigas saem.
              return lista.slice(-SUBS_POR_RODADA)
            })
          },
          onDone: (data) => {
            concluirRodada(rodadaId, (mensagem) => ({
              ...mensagem,
              elapsedMs: data.elapsed_ms,
              tokens: data.tokens ?? null,
              tokensTotal: data.tokens_total ?? null,
              contexto: data.contexto ?? mensagem.contexto ?? null,
              // O backend é quem sabe: ele só diz `false` depois de insistir sozinho.
              incompleto: data.completed === false,
              // O contrato estruturado da rodada incompleta — é dele que o cartão vive.
              motivo: data.reason ?? null,
              pendentes: data.pending_items ?? [],
              executou: data.executed ?? 0,
              retomavel: data.resumable ?? false,
              at: Date.now(),
            }))
            // O pedido de permissão morre junto com a resposta que o fez — e a espera acabou.
            setPermissaoPendente(null)
            /*
             * O gasto desta resposta **sobe para o painel** — é ele que guarda o limite da
             * conta. O backend local mediu (é ele que viu a resposta acontecer), mas quem
             * conta é o painel: o número que fica no PC some ao reinstalar e não acompanha a
             * pessoa noutra máquina.
             *
             * Repetir é seguro (a chave da contagem é o id da mensagem), então não há fila
             * nem retry: se o relato falhar, a próxima resposta relata a dela e o limite
             * segue valendo pelo que já entrou.
             */
            void reportarUso({
              message_id: data.message_id,
              conversation_id: data.conversation_id,
              model: ultimoPayloadRef.current?.model ?? null,
              tempo_ms: data.elapsed_ms ?? 0,
              tokens: data.tokens_total ?? 0,
            }).catch(() => undefined)
            void refreshUsage()
            void refreshHistory()
          },
          onError: (message) => {
            // O backend respondeu que a rodada falhou (provedor estourou, cota,
            // modelo recusou). Antes encerrava a rodada na hora; agora o erro passa
            // pelo mesmo laço de 10 tentativas — regra do dono: **todo** erro tenta.
            // Se for passageiro (o host reiniciando, um soluço do provedor), a
            // tentativa seguinte acerta e o contexto continua; se não for, morre em
            // 10 tentativas dizendo o motivo. Lançar aqui atravessa o `dispatch` do
            // cliente e sai do `streamChat` como qualquer outra falha.
            // (A tela continua saindo de "Trabalhando…": o laço, em qualquer saída,
            // ou insiste em silêncio ou encerra a rodada.)
            setPermissaoPendente(null)
            throw new ErroDoServico(message)
          },
          // Contrato de vivacidade: fluxo fechado sem terminal. Não encerra a rodada
          // aqui dentro — quem decide é o laço da reconexão lá fora: se ainda há
          // tentativa, queda no meio é erro de conexão, e não fim de resposta.
          onClosed: () => {
            fechouSemTerminal = true
            setPermissaoPendente(null)
          },
        },
      )
        // A tentativa acabou. Fluxo fechado no meio (e ninguém parou no botão) é queda
        // de conexão: lança para cair no mesmo caminho da falha de rede, com reconexão.
        if (fechouSemTerminal && !controller.signal.aborted) throw new QuedaDeConexao()
        return
      } catch (error) {
      if (controller.signal.aborted) {
        // A pessoa parou no botão Parar. O que já saiu fica, e a resposta passa a **dizer
        // que parou** — o mesmo cartão de qualquer outra interrupção.
        concluirRodada(rodadaId, marcarInterrompida)
      } else if (tentativa >= TENTATIVAS_DE_RECONEXAO) {
        // Dez tentativas e o erro não passou: a rodada para e **diz o erro** — com
        // quantas vezes tentou, para a pessoa saber que não foi desistência. Vale para
        // **todo** erro (regra do dono), não só queda de rede: 401/422/404 e o
        // silêncio estourado também tentam as dez antes de morrer.
        if (ehFalhaDeConexao(error)) setBackend(null)
        const detail =
          error instanceof QuedaDeConexao ? error.message : fraseDeFalha(error)
        const quantas = `${TENTATIVAS_DE_RECONEXAO} tentativas`
        const porque = ehFalhaDeConexao(error)
          ? `[a conexão com o serviço local caiu depois de ${quantas}: ${detail}]`
          : `[o Koda tentou ${quantas} e não conseguiu: ${detail}]`
        concluirRodada(rodadaId, (mensagem) => ({
          ...mensagem,
          text: mensagem.text
            ? `${mensagem.text}\n\n${porque}`
            : `Não consegui falar com o serviço local do Koda depois de ${quantas}. ${detail} ${COMO_DIAGNOSTICAR}`,
        }))
      } else {
        // Ainda há tentativa: a linha «Reconectando…» acende com o contador **desta**
        // insistência (a da conexão), espera o tempo da tentativa, limpa o que a tentativa
        // anterior tinha desenhado e começa de novo. Vale para qualquer erro — regra do dono.
        setReconexao({ tentativa: tentativa + 1, total: TENTATIVAS_DE_RECONEXAO })
        await dormir(esperaDeReconexao(tentativa), controller.signal)
        if (controller.signal.aborted) {
          concluirRodada(rodadaId, marcarInterrompida)
          return
        }
        // A tentativa que vem começa do zero na tela: com `resume`, o backend continua
        // do histórico — o que já estava desenhado aqui repetiria a resposta.
        patchAssistant((mensagem) => ({
          ...mensagem,
          text: '',
          blocos: [],
          steps: [],
          reasoning: undefined,
          todos: [],
        }))
        setPermissaoPendente(null)
        continue
      }
    } finally {
      setPermissaoPendente(null)
      // A rodada acabou: nenhuma insistência fica para trás, e a linha sai de cena.
      setReconexao(null)
      // A rodada acabou: nenhum sub-agente dela está trabalhando. As abas ficam — o que ele
      // fez continua à vista —, mas nenhuma delas diz que ainda tem alguém ali.
      setSubs((atual) => atual.map((item) => ({ ...item, vivo: false })))
    }
    }
  }

  /**
   * Guarda a mensagem para depois — o «manda outro prompt por cima».
   *
   * O agente está trabalhando: a resposta em curso é que está usando a conversa, e
   * enviar agora poria duas respostas brigando pelo mesmo histórico. A mensagem espera
   * a vez na fila, presa à conversa em que nasceu, e sai quando a rodada daqui terminar
   * (ver o efeito logo abaixo). Quem chama é o `handleSend`, que sabe pela `rodadasRef`
   * se há rodada viva — sem depender de prop nenhuma.
   */
  const handleEnfileirar = (payload: SendPayload) => {
    // `conversationIdRef`, e não o estado: enfileirar pode acontecer num retorno
    // assíncrono, e a ref é o valor de agora.
    escreverFila((atual) => [
      ...atual,
      { id: newId(), conversa: conversationIdRef.current, payload },
    ])
  }

  /** Tira uma mensagem da fila — desistiu, ou ela voltou para a caixa pelo lápis. */
  const handleRemoverDaFila = (id: string) => {
    escreverFila((atual) => atual.filter((item) => item.id !== id))
  }

  /**
   * O envio mais recente, lido por efeito sem prender o efeito a este render.
   *
   * `handleSend` muda de identidade a cada render (não é memoizado), e um efeito que
   * dependesse dele rodaria a cada render. A ref guarda o de agora — que é o que vale
   * quando o efeito dispara.
   */
  const handleSendRef = useRef(handleSend)
  handleSendRef.current = handleSend

  /**
   * O `busy` da vista anterior. A fila só dispara na **transição** — trabalhando →
   * parado —, e não em qualquer mexida no estado enquanto parado.
   *
   * Sem esta marca o primeiro disparo já mudava a fila, o efeito corria de novo por
   * causa da dependência `fila`, e a fila **inteira** sairia de uma vez: três correções
   * escritas durante uma resposta virariam três rodadas paralelas. A fila é o contrário
   * disso — uma mensagem de cada vez, cada uma depois da resposta da anterior. Foi a
   * bancada `fila-check.tsx` que pegou este despertar sozinho.
   */
  const busyAnteriorRef = useRef(busy)

  /**
   * A fila anda sozinha: quando o trabalho desta conversa termina, a primeira mensagem
   * esperando sai.
   *
   * Duas travas, ambas pela mesma razão — a fila é da conversa:
   * 1. só dispara na transição trabalhando → parado, isto é, quando a rodada desta
   *    conversa acabou (a rodada de outra conversa não segura a fila desta, e
   *    vice-versa);
   * 2. só manda o que pertence a esta conversa — trocar de conversa não leva a fila
   *    junto, e a mensagem esperando não vaza na conversa errada.
   *
   * O item sai da fila **antes** de ser mandado: se o envio falhar, ele não fica preso
   * esperando uma rodada que não existe mais. Quem o efeito lê é o `filaRef`, não o
   * estado — é a lista de agora, não a do render em que ele foi montado.
   */
  useEffect(() => {
    const estavaTrabalhando = busyAnteriorRef.current
    busyAnteriorRef.current = busy
    if (busy || !estavaTrabalhando) return
    const proximo = filaRef.current[0]
    if (!proximo || proximo.conversa !== conversa) return
    escreverFila((atual) => atual.slice(1))
    void handleSendRef.current(proximo.payload)
  }, [busy, conversa, fila])

  /**
   * Manda uma mensagem da fila **agora**, no meio da resposta.
   *
   * É o «manda outro prompt por cima pra arrumar o que fiz» no sentido literal: a rodada
   * em curso é interrompida — a resposta pela metade fica marcada como interrompida,
   * como em qualquer Parar — e a mensagem segue no mesmo instante.
   *
   * A ordem importa, e é esta:
   * 1. a mensagem sai da fila **antes** — senão o disparo automático a pegaria no vão
   *    entre a rodada parar e a nova nascer, e as duas sairiam juntas;
   * 2. a rodada é parada antes do envio — o `handleSend` decide pela `rodadasRef`, e
   *    com a rodada ainda na lista a mensagem nova seria enfileirada em vez de enviada;
   * 3. o envio vem no **mesmo** bater do clique: o React agrupa os estados das três
   *    mexidas, a tela nunca vê o «sem rodada» no meio do caminho, e o efeito da fila
   *    não dispara no vão — só a rodada nova nasce.
   *
   * O resto da fila fica como estava: enviar agora uma mensagem não é desistir das
   * seguintes — elas continuam esperando a vez.
   */
  const handleEnviarAgora = (id: string) => {
    const item = filaRef.current.find((espera) => espera.id === id)
    if (!item) return
    escreverFila((atual) => atual.filter((espera) => espera.id !== id))
    if (rodada) pararRodada(rodada.id)
    void handleSendRef.current(item.payload)
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
      model: modeloSeguro(anterior?.model),
      reasoning: anterior?.reasoning ?? true,
      web: anterior?.web ?? false,
      effort: anterior?.effort ?? EFFORT_PADRAO,
      project_path:
        anterior?.project_path ?? projects.find((item) => item.id === projectId)?.caminho ?? null,
    })
  }

  /**
   * Retoma a tarefa que fechou no meio — a ação do botão do cartão de "tarefa não concluída".
   *
   * Vai como `resume`, e **não** como uma mensagem: o backend continua do histórico que já
   * existe e não grava turno de usuário. Assim a conversa não ganha uma bolha de pessoa com
   * a palavra "continue" — o que existia antes era exatamente isso, a tela mostrando o
   * próprio dono pedindo a palavra mágica que o produto deveria saber sozinho.
   *
   * Os ajustes são os da última rodada, iguais aos de "rodar de novo": quem pediu para
   * seguir não quer reconferir modelo e esforço.
   */
  const retomarTarefa = () => {
    if (busy) return
    const anterior = ultimoPayloadRef.current
    void handleSend({
      text: '',
      resume: true,
      attachments: [],
      model: modeloSeguro(anterior?.model),
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
        // O motivo só existe quando foi o app que fechou a porta (conta barrada no painel).
        // Uma sessão que a pessoa encerrou sozinha não tem o que explicar.
        motivo={motivoDaSessao}
        onEntrou={(nova) => {
          setMotivoDaSessao(null)
          setConta(nova)
          setSessao('dentro')
        }}
      />
    )
  }
  if (!backendInicializado) {
    return (
      <Abertura
        aguardandoBackend
        backendDemorando={backendDemorando}
        onTentarNovamente={() => {
          setBackendDemorando(false)
          setTentativaManualBackend((atual) => atual + 1)
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
          resultLabel={searching ? `${matchingIds.size} de ${visiveis.length}` : null}
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
          onOpenPresente={() => {
            setAbaDoPresente('free')
            setView('presente')
          }}
          onOpenStore={() => setView('store')}
          painelAberto={painelAberto}
          onTogglePainel={() => setPainelAberto((aberto) => !aberto)}
          onAbrirBarraCamera={() => setBarraCameraAberta(true)}
        />
      ) : null}

      {/*
       * A barra lateral fica **fora** do cabeçalho e do `main`, como sobreposição: ela não
       * empurra o layout, cobre a conversa e é o `z-[60]` do app — acima do cabeçalho, da
       * linha de tarefas, das gavetas e dos menus. Só existe na tela de conversa; nos ajustes
       * a tela é inteira e não há conversa para listar.
       */}
      {view === 'chat' ? (
        <PainelLateral
          aberto={painelAberto}
          onFechar={() => setPainelAberto(false)}
          // A aba Código mostra a pasta do projeto aberto. Não há outra fonte: o painel não
          // escolhe pasta, ele mostra a que já está em uso.
          projeto={projects.find((item) => item.id === projectId) ?? null}
          // As sessões de sub-agente vivas: a área Subs abre uma aba por uma delas. Vêm
          // daqui porque quem as alimenta é o stream da conversa, que é deste lado.
          subs={subs}
        />
      ) : null}

      {/*
       * A segunda barra lateral, irmã da primeira: a que o botão da câmera abre. Abre
       * **do mesmo lado** (`left-0`), ocupando a metade esquerda onde a PainelLateral
       * também abre; com as duas abertas, esta fica por cima (última da pilha). Mesmo
       * `z-[60]`, mesma casca.
       */}
      {view === 'chat' ? (
        <BarraLateralCamera
          aberto={barraCameraAberta}
          onFechar={() => setBarraCameraAberta(false)}
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
            {/* `busy` é o que diz se o agente está mesmo trabalhando: sem ele o painel
                girava para sempre numa conversa interrompida. */}
            <ToDosMenu todos={todosAtivos} rodando={busy} />
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
            conversations: remoteUsage?.conversations ?? usageCounts.conversations,
            dias: remoteUsage?.dias ?? usageCounts.dias,
            daily: remoteUsage ? janelaDoServidor(remoteUsage.daily) : usageCounts.daily,
            weekly: remoteUsage ? janelaDoServidor(remoteUsage.weekly) : usageCounts.weekly,
            monthly: remoteUsage ? janelaDoServidor(remoteUsage.monthly) : usageCounts.monthly,
            // Os rótulos do catálogo da casa são strings; o tipo do menu aceita JSX
            // por causa dos contadores do submenu de skills.
            model: modeloAtivo
              ? (findModel(modeloAtivo, modelosVisiveis).label as string)
              : 'Nenhum modelo disponível',
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
          model={modeloAtivo}
          onModelChange={escolherModelo}
          remoteModels={catalogoDoMenu}
          modelosBloqueados={modelosForaDoMenu}
          skills={skills}
          mcps={mcps}
          onAddSkill={handleAddSkill}
          onAddMcp={handleAddMcp}
          agents={agents}
          onSaveAgent={handleSaveAgent}
          onDeleteAgent={handleDeleteAgent}
          mostrarRodape={mostrarRodape}
          onToggleRodape={() => setMostrarRodape((value) => !value)}
          mostrarTraces={mostrarTraces}
          onToggleTraces={() => setMostrarTraces((value) => !value)}
          appearance={appearance}
          onAppearanceChange={(patch) =>
            setAppearance((current) => ({ ...current, ...patch }))
          }
          contaKoda={conta}
          planoDaConta={planoDaConta}
          onAssinaturaMudou={atualizarPlano}
          onSignOut={handleSignOut}
          initialSection={settingsSection}
        />
      ) : view === 'presente' ? (
        // A página do presente entra **no mesmo if/else** dos ajustes, e não como irmã solta:
        // quem não está em `settings` cai no chat, então um `{view === 'presente' ? … : null}`
        // desenhava a página por cima da tela inicial — o defeito que ele viu.
        <Presente
          onClose={() => setView('chat')}
          abaInicial={abaDoPresente}
          planoDaConta={planoDaConta}
          aoAssinar={(plano) => {
            setCompraDoCheckout({ tipo: 'plano', plano })
            setView('checkout')
          }}
          // O pacote de créditos entra no **mesmo** checkout: o caminho do dinheiro é um só.
          aoComprarCreditos={(creditos, valorCentavos) => {
            setCompraDoCheckout({ tipo: 'creditos', creditos, valorCentavos })
            setView('checkout')
          }}
        />
      ) : view === 'checkout' && compraDoCheckout ? (
        // O checkout é uma **vista**, e não uma terceira aba da área: ele não é alcançável sem
        // um produto escolhido, e uma aba aberta por engano mostraria a tela sem saber o que
        // está cobrando. Voltar leva de onde a pessoa saiu — «Planos» ou «Moedas».
        <CheckoutScreen
          compra={compraDoCheckout}
          // Assinou: o plano mudou no painel e a tela precisa saber **agora**. A sonda de
          // sessão roda de tempo em tempo, e esperar por ela deixaria o perfil dizendo «Free»
          // para quem acabou de pagar.
          onAssinou={atualizarPlano}
          // Depois de comemorar, a tela leva a pessoa para o chat sozinha — que é onde ela
          // quer estar. «Voltar» (a seta) continua levando para a área, para quem quiser
          // conferir o que acabou de comprar.
          onIrParaOChat={() => setView('chat')}
          onClose={() => {
            setAbaDoPresente(compraDoCheckout.tipo === 'plano' ? 'planos' : 'moedas')
            setView('presente')
          }}
        />
      ) : view === 'store' ? (
        // A Store entra no **mesmo if/else** das outras áreas, e não como irmã solta: quem não
        // está numa vista cai no chat, então uma condição solta desenharia a Store por cima da
        // conversa — o mesmo defeito que a área do presente já teve.
        <Store onClose={() => setView('chat')} onConectoresMudaram={handleConectoresMudaram} />
      ) : (
        <main className="flex min-h-0 flex-1 flex-col">
        {/*
         * A roda (e o trackpad) avisam a intenção **antes** de a rolagem acontecer: é o que
         * faz o acompanhamento parar no primeiro movimento para cima, e não depois.
         */}
        <div
          ref={listaRef}
          onScroll={aoRolar}
          onWheel={(evento) => aoRolarComRoda(evento.deltaY)}
          className={[
            // **`overscroll-contain`**: a roda para no fim da conversa. Sem isto, o scroll
            // vaza para a casca e é ela que anda — a conversa fica parada e a interface
            // inteira sobe, que é exatamente o «me joga pra cima» de quem está lendo o
            // histórico. A casca é `overflow-hidden`, mas `overflow: hidden` ainda guarda
            // `scrollTop`: quem rola ali não vê barra, só o conteúdo deslocado.
            //
            // **`transition-[opacity]`, e não `transition-all`**: animar a *altura* de um
            // container que rola faz o conteúdo andar junto com a animação sempre que o
            // composer muda de tamanho (a fila, o cartão de permissão, a caixa de escrever
            // crescendo). Aqui a única coisa que precisa animar é a conversa aparecendo.
            //
            // **`[overflow-anchor:none]`**: o Chrome reancora a rolagem sozinho quando
            // algo acima da viewport muda de altura — o raciocínio que fecha, o bloco em
            // construção que vira desenho, a ficha que aparece. Reancorar é mover a tela
            // sem ninguém pedir; quem decide a posição aqui é o `seguirOFimRef`, e só ele.
            'min-h-0 overflow-y-auto overscroll-contain transition-[opacity] duration-500 [overflow-anchor:none]',
            EASE,
            hasMessages ? 'flex-1 opacity-100' : 'flex-none opacity-0',
          ].join(' ')}
        >
          <div ref={conteudoRef} className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6">
            {visiveis.map((message) => {
              const dimmed = searching && !matchingIds.has(message.id)
              const blocos = message.blocos ?? []
              /** A resposta sendo escrita agora: é nela que a linha de trabalho aparece. */
              const ehViva = message.id === viva?.id
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
                    <ToolSteps steps={message.steps} resumido />
                  ) : null}
                  {mostrarTraces && message.reasoning && blocos.length === 0 ? (
                    // Caminho de exceção: pensamento sem nenhum bloco (mensagem antiga).
                    <Reasoning texto={message.reasoning} ativo={false} />
                  ) : null}
                  {blocos.length > 0 ? (
                    // A resposta chegou em partes: pensamento, fala e ferramenta saem na
                    // ordem em que aconteceram, um embaixo do outro.
                    blocos.map((bloco, indice) => {
                      const ultimo = indice === blocos.length - 1
                      if (bloco.tipo === 'passo') {
                        // Os passos seguidos viram **uma** linha na posição do primeiro deles
                        // ("2 ferramentas", com a duração somada), e o detalhe de cada
                        // chamada abre no clique. Mostrar o passo cru um embaixo do outro
                        // empurrava a conversa para baixo e escondia a resposta.
                        if (blocos[indice - 1]?.tipo === 'passo') return null
                        let fim = indice
                        while (blocos[fim + 1]?.tipo === 'passo') fim += 1
                        const grupo = blocos
                          .slice(indice, fim + 1)
                          .map((item) => (item as { passo: ToolStep }).passo)
                        return <ToolSteps key={`passos-${indice}`} steps={grupo} resumido />
                      }
                      if (bloco.tipo === 'compactacao') {
                        return (
                          <CartaoDeCompactacao
                            key={`compacta-${indice}`}
                            aviso={bloco.compactacao}
                          />
                        )
                      }
                      if (bloco.tipo === 'raciocinio') {
                        // Raciocínio é o rascunho do modelo: só aparece com os traces ligados.
                        // Ligado, só fica aberto o que ainda está no fim da resposta viva:
                        // assim que vem fala, ferramenta ou o fim da mensagem, ele fecha.
                        if (!mostrarTraces) return null
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
                   * está fazendo. Aparece **sempre** enquanto a resposta está viva, e não só
                   * quando a tela fica calada: com o passo da ferramenta logo acima, a
                   * linha logo abaixo é o que mostra que a tarefa não parou ali.
                   *
                   * Uma linha só, e ela troca: durante a insistência (a conexão caindo ou o
                   * provedor falhando) é a «Reconectando… NN/NN» que fala — no lugar dos
                   * segundos. As duas juntas eram o defeito que o dono reprovou: a linha
                   * daqui e a solta lá de baixo acendiam ao mesmo tempo.
                   */}
                  {ehViva ? (
                    reconexao ? (
                      <ReconnectingLine
                        tentativa={reconexao.tentativa}
                        total={reconexao.total}
                      />
                    ) : (
                      <WorkingLine passo={passoEmCurso} segundos={segundosDaResposta} />
                    )
                  ) : null}
                  {/* A ficha fecha a resposta: só quando ela terminou de verdade. */}
                  {message.elapsedMs ? (
                    <MessageFooter
                      texto={message.text}
                      tokens={message.tokens ?? null}
                      tokensTotal={message.tokensTotal ?? null}
                      modelo={message.model ?? null}
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
                  {message.incompleto && message.id === visiveis.at(-1)?.id ? (
                    <TarefaIncompleta
                      motivo={message.motivo}
                      pendentes={message.pendentes}
                      executou={message.executou}
                      retomavel={message.retomavel}
                      ocupado={busy}
                      onRetomar={retomarTarefa}
                    />
                  ) : null}
                </div>
              )
            })}

            {/*
              A linha **solta**: só quando a resposta viva não está nesta lista — a
              conversa foi trocada no meio da rodada, e a linha não tem mensagem para
              morar. É a mesma regra de uma linha só: «Reconectando… NN/NN» durante a
              insistência, «Trabalhando…» no resto. Quando a viva está na lista, quem
              mostra a linha é ela (lá em cima) — nos dois lugares ao mesmo tempo é que
              nascia a dupla que o dono reprovou.
            */}
            {!viva && reconexao ? (
              <ReconnectingLine tentativa={reconexao.tentativa} total={reconexao.total} />
            ) : waiting ? (
              <WorkingLine segundos={segundosDaResposta} />
            ) : null}
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

          <div className="relative flex w-full max-w-3xl flex-col gap-2.5">
            {/*
             * O atalho do fim.
             *
             * Só existe quando há para onde descer — ou seja, quando a pessoa subiu e o
             * acompanhamento está desligado. É ele que resolve o incômodo de ter de rolar
             * uma resposta longa na mão: um clique desce tudo e o acompanhamento volta.
             */}
            {hasMessages && !noFim ? (
              <button
                type="button"
                onClick={irParaOFim}
                aria-label="Ir para o fim da conversa"
                title="Ir para o fim"
                className="menu-in absolute -top-12 right-0 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-koda-surface text-koda-fg/75 ring-1 ring-koda-fg/12 shadow-[0_10px_30px_-12px_var(--koda-shadow)] transition-colors duration-150 hover:bg-koda-fg/10 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
              >
                <ChevronDown className="h-[18px] w-[18px]" strokeWidth={1.8} />
              </button>
            ) : null}
            <Composer
              onSend={handleSend}
              onStop={handleStop}
              busy={busy}
              // Só a fila desta conversa: a de outra não aparece aqui, e o que ela tem
              // não é mandado daqui.
              fila={fila.filter((item) => item.conversa === conversa)}
              onEnviarAgora={handleEnviarAgora}
              onRemoverDaFila={handleRemoverDaFila}
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
              model={modeloAtivo}
              onModelChange={escolherModelo}
              remoteModels={catalogoDoMenu}
              modelosBloqueados={modelosForaDoMenu}
              provedoresLogados={gruposLogados}
              contextoPorModelo={contextoPorModelo}
              contextoJanela={janelaDoContexto}
              moedas={saldoDeMoedas}
              agentes={agents}
              skills={skills}
              mcps={mcps}
            />
            {versaoNova ? (
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
