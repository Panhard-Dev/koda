import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowUp, Bot, ChevronDown, ListTodo, LoaderCircle, Square } from 'lucide-react'
import { answerApproval, fraseDeFalha, listModels, streamChat } from '../api/client'
import type { ApiModel, ApiProject, ApiTodo, ToolStep } from '../api/client'
import { EFFORT_PADRAO } from '../effort'
import { MODEL_LABELS, MODELO_PADRAO, modelMenu } from '../models'
import { atualizarModelosCom400, lerModelosCom400 } from '../modelos-com-400'
import BolhaUsuario from './BolhaUsuario'
import FalaDoModelo from './FalaDoModelo'
import KodaLogo from './KodaLogo'
import { Menu } from './Menu'
import Reasoning from './Reasoning'
import TarefaIncompleta from './TarefaIncompleta'
import ToolSteps from './ToolSteps'
import WorkingLine from './WorkingLine'

/**
 * A aba **Subs** — uma conversa do painel, separada da conversa de baixo.
 *
 * É um chat de verdade: fala com o mesmo backend, no mesmo projeto, e o agente trabalha nela
 * com as mesmas ferramentas. O que muda é o **prompt box**, e de propósito: aqui ele é três
 * peças soltas — a caixa, o seletor de modelo e o botão de enviar —, sem a silhueta única do
 * compositor do chat. Quem está no painel quer perguntar uma coisa e voltar; a caixa de baixo
 * é o lugar onde a conversa principal mora.
 *
 * ## O que o stream manda, e o que a tela faz com isso
 *
 * Tudo o que o chat principal trata, esta aba trata — inclusive o que **para o agente**:
 *
 * - `tool_call`/`tool_result` → o cartão da ferramenta, com o diff quando ela escreve arquivo;
 * - `todos` → a linha do plano. Sem ela, o `update_todos` do agente não teria onde aparecer;
 * - `done` → a marca de tarefa não concluída, com o Retomar.
 *
 * **Não tem cartão de permissão, e não é esquecimento:** a rodada vai como `livre`, então o
 * agente não pergunta antes de mexer na máquina. Um pedido de permissão sem cartão na tela
 * deixaria o agente parado para sempre esperando uma resposta que ninguém tem onde dar — pior
 * do que a pergunta que o cartão existe para fazer. O `approval_request` continua tratado como
 * rede: se um chegar assim mesmo (backend de versão anterior), ele é respondido sozinho.
 *
 * ## Por que ela é separada, e não a mesma conversa
 *
 * A conversa daqui tem id próprio, criado pelo backend na primeira mensagem. Duas razões: a
 * conversa principal continua sendo uma só (o painel não encosta nela), e a daqui não some
 * quando o painel fecha. O preço é que ela **aparece no histórico** como qualquer outra —
 * ela é uma conversa de verdade, e escondê-la seria mentir sobre o que o backend gravou.
 *
 * ## O que ela não tem, e é escolha
 *
 * Sem anexos, sem busca na web e sem o ajuste de esforço. São as peças do chat principal;
 * trazer todas para cá faria desta aba uma segunda cópia dele, e o pedido era o contrário —
 * uma caixa simples.
 */

/**
 * A sessão de um sub-agente lançado: o que ele escreveu e o que ele rodou.
 *
 * Ela **não** nasce aqui — quem a alimenta é o stream da conversa de cima, que é quem lança
 * o sub-agente. O Subs só desenha uma aba por uma destas, e por isso o tipo mora aqui: é
 * aqui que ele é usado, e os dois lados que o produzem importam daqui.
 */
export type SessaoDeSub = {
  chamada: string
  agente: string
  texto: string
  passos: ToolStep[]
  /** Ainda está trabalhando? Falso quando a rodada que o lançou terminou. */
  vivo: boolean
}

/**
 * O teto de abas da área Subs: a conversa mais os sub-agentes que uma rodada pode lançar.
 *
 * Não são dois números soltos — é o mesmo teto visto dos dois lados, e é por isso que a
 * conta fecha em quatro: uma aba de conversa e três de sub-agente.
 */
export const ABAS_DO_SUBS = 4

/** Quantos sub-agentes cabem: o resto das abas é a conversa. */
export const SUBS_POR_RODADA = ABAS_DO_SUBS - 1

/** Uma fala da conversa daqui — só o que a tela precisa para desenhar. */
type Fala = {
  id: string
  role: 'user' | 'assistant'
  texto: string
  raciocinio: string
  passos: ToolStep[]
  /** A rodada parou antes de terminar o que foi pedido. */
  incompleto: boolean
  motivo: string | null
  pendentes: string[]
  executou: number
  retomavel: boolean
}

const falaVazia = (role: Fala['role'], texto = ''): Fala => ({
  id: novoId(),
  role,
  texto,
  raciocinio: '',
  passos: [],
  incompleto: false,
  motivo: null,
  pendentes: [],
  executou: 0,
  retomavel: false,
})

/**
 * O estado da aba — e ele mora **fora** do componente, de propósito.
 *
 * O painel desmonta o conteúdo da aba que sai: trocar para «Código» e voltar apagaria a
 * conversa, e fechar o painel apagaria de novo. Uma conversa não é do painel — ela é do
 * backend, com id e tudo, e a tela só a mostra.
 *
 * O mesmo vale para a resposta que está sendo escrita: quem escreve é o `streamChat`, e ele
 * continua de pé enquanto a aba não está à vista. Com o estado num `useState`, os pedaços que
 * chegassem nesse meio-tempo iriam para um componente que não existe mais — e a resposta
 * apareceria cortada ao voltar.
 *
 * Vive o tempo do app. Recarregar a página começa outra conversa.
 */
type Estado = {
  /** A conversa no backend. `null` até a primeira mensagem — quem cria é o backend. */
  conversa: string | null
  modelo: string
  /** O que está digitado na caixa. O rascunho também não pode sumir na troca de aba. */
  rascunho: string
  falas: Fala[]
  ocupado: boolean
  /** Quando a resposta em curso começou, para a linha de trabalho contar os segundos. */
  inicio: number
  segundos: number
  /** O catálogo do seletor. `null` = ainda não foi pedido. */
  catalogo: ApiModel[] | null
  /** O plano que o agente registrou (`update_todos`). */
  todos: ApiTodo[]
  /** Qual aba está à vista: `conversa` ou o id da chamada de um sub-agente. */
  aba: string
}

/** A aba da conversa — a que existe sempre. As outras são de sub-agente. */
const ABA_DA_CONVERSA = 'conversa'

let estado: Estado = {
  conversa: null,
  modelo: MODELO_PADRAO,
  rascunho: '',
  falas: [],
  ocupado: false,
  inicio: 0,
  segundos: 0,
  catalogo: null,
  todos: [],
  aba: ABA_DA_CONVERSA,
}

const ouvintes = new Set<() => void>()

const assinar = (avisar: () => void) => {
  ouvintes.add(avisar)
  return () => {
    ouvintes.delete(avisar)
  }
}

/** O retrato de agora. Só troca de identidade quando algo muda — é o que o React exige. */
const ler = () => estado

const mudar = (mudanca: Partial<Estado>) => {
  estado = { ...estado, ...mudanca }
  ouvintes.forEach((avisar) => avisar())
}

/** A rodada em curso, para o botão Parar alcançá-la mesmo depois de a aba ser remontada. */
let pararAtual: AbortController | null = null

const novoId = () => crypto.randomUUID()

export default function Subs({
  projeto,
  subs = [],
}: {
  projeto: ApiProject | null
  /** As sessões de sub-agente lançadas pela conversa de cima — uma aba para cada. */
  subs?: SessaoDeSub[]
}) {
  const { modelo, rascunho, falas, ocupado, segundos, catalogo, todos, aba } =
    useSyncExternalStore(assinar, ler)
  const [modelosCom400, setModelosCom400] = useState<string[]>(lerModelosCom400)
  const listaRef = useRef<HTMLDivElement>(null)

  /**
   * A aba que está mesmo à vista.
   *
   * O estado guarda o que a pessoa escolheu; se aquela sessão saiu da lista (o teto de abas
   * empurrou a mais velha para fora), a conversa é o lugar certo — e não uma aba que não
   * existe mais.
   */
  const abaAtiva = subs.some((item) => item.chamada === aba) ? aba : ABA_DA_CONVERSA
  const sessao = subs.find((item) => item.chamada === abaAtiva) ?? null

  const caminhoDoProjeto = projeto?.existe ? projeto.caminho : null

  // O catálogo é o mesmo do seletor de baixo: quem lista os modelos é o backend. Fica no
  // estado de fora para não repetir o pedido a cada troca de aba.
  useEffect(() => {
    if (estado.catalogo) return
    void (async () => {
      try {
        const modelos = await listModels()
        const recusados = atualizarModelosCom400(modelos)
        setModelosCom400(recusados)
        const disponiveis = modelMenu(modelos, recusados).flatMap((grupo) =>
          (grupo.options ?? []).map((item) => item.value),
        )
        mudar({
          catalogo: modelos,
          modelo: disponiveis.includes(estado.modelo) ? estado.modelo : (disponiveis[0] ?? ''),
        })
      } catch {
        // A consulta falhou; aguarda a próxima tentativa sem oferecer modelos não testados.
        const disponiveis = modelMenu([], lerModelosCom400()).flatMap((grupo) =>
          (grupo.options ?? []).map((item) => item.value),
        )
        mudar({
          catalogo: [],
          modelo: disponiveis.includes(estado.modelo) ? estado.modelo : (disponiveis[0] ?? ''),
        })
      }
    })()
  }, [])

  useEffect(() => {
    if (catalogo?.length !== 0) return
    let cancelado = false
    let consultando = false
    const timer = window.setInterval(() => {
      if (consultando) return
      consultando = true
      void listModels()
        .then((modelos) => {
          if (cancelado || modelos.length === 0) return
          const recusados = atualizarModelosCom400(modelos)
          setModelosCom400(recusados)
          const disponiveis = modelMenu(modelos, recusados).flatMap((grupo) =>
            (grupo.options ?? []).map((item) => item.value),
          )
          mudar({
            catalogo: modelos,
            modelo: disponiveis.includes(estado.modelo) ? estado.modelo : (disponiveis[0] ?? ''),
          })
        })
        .catch(() => {})
        .finally(() => { consultando = false })
    }, 5_000)
    return () => {
      cancelado = true
      window.clearInterval(timer)
    }
  }, [catalogo])

  // O relógio da linha de trabalho: um indicador parado não convence ninguém de que ainda
  // tem alguém trabalhando.
  useEffect(() => {
    if (!ocupado) return
    const id = window.setInterval(
      () => mudar({ segundos: Math.round((Date.now() - estado.inicio) / 1000) }),
      400,
    )
    return () => window.clearInterval(id)
  }, [ocupado])

  // Desce ao fim a cada pedaço que chega: quem pergunta aqui quer ver a resposta.
  useEffect(() => {
    const caixa = listaRef.current
    if (caixa) caixa.scrollTop = caixa.scrollHeight
  }, [falas])

  const mexer = (id: string, mudarFala: (fala: Fala) => Fala) =>
    mudar({ falas: estado.falas.map((fala) => (fala.id === id ? mudarFala(fala) : fala)) })

  /**
   * Manda o que está na caixa — ou **retoma** a tarefa que parou no meio.
   *
   * `resume` não é uma mensagem: o backend continua o histórico que já existe e não grava
   * turno de usuário. Por isso ele não desenha bolha nenhuma aqui.
   */
  const enviar = async (resume = false) => {
    const texto = estado.rascunho.trim()
    if (estado.ocupado) return
    if (!estado.modelo) return
    if (!resume && !texto) return

    const resposta = falaVazia('assistant')
    const novas = resume ? [resposta] : [falaVazia('user', texto), resposta]
    mudar({
      rascunho: resume ? estado.rascunho : '',
      falas: [...estado.falas, ...novas],
      ocupado: true,
      inicio: Date.now(),
      segundos: 0,
    })

    const controller = new AbortController()
    pararAtual = controller

    try {
      await streamChat(
        {
          text: resume ? '' : texto,
          model: estado.modelo,
          reasoning: true,
          effort: EFFORT_PADRAO,
          web: false,
          project_path: caminhoDoProjeto,
          attachments: [],
          conversation_id: estado.conversa,
          tz_offset_minutes: new Date().getTimezoneOffset(),
          // Livre: esta aba não tem cartão de permissão, e um pedido sem cartão deixaria o
          // agente parado esperando resposta. Vale para esta rodada só — o modo guardado do
          // app não muda, e o chat de baixo continua seguindo o dele.
          livre: true,
          ...(resume ? { resume: true } : {}),
        },
        {
          signal: controller.signal,
          onStart: (dados) => mudar({ conversa: dados.conversation_id }),
          onDelta: (pedaco) =>
            mexer(resposta.id, (fala) => ({ ...fala, texto: fala.texto + pedaco })),
          onReasoning: (pedaco) =>
            mexer(resposta.id, (fala) => ({ ...fala, raciocinio: fala.raciocinio + pedaco })),
          onToolCall: (dados) =>
            mexer(resposta.id, (fala) => ({
              ...fala,
              passos: [
                ...fala.passos,
                {
                  name: dados.name,
                  arguments: dados.arguments,
                  output: '',
                  duration_ms: 0,
                  call_id: dados.id,
                  ok: true,
                  mcp: dados.mcp ?? null,
                },
              ],
            })),
          onToolResult: (dados) =>
            mexer(resposta.id, (fala) => ({
              ...fala,
              passos: fala.passos.map((passo) =>
                passo.call_id === dados.id
                  ? {
                      ...passo,
                      output: dados.output,
                      duration_ms: dados.duration_ms,
                      ok: dados.ok,
                      mcp: dados.mcp ?? passo.mcp ?? null,
                    }
                  : passo,
              ),
            })),
          onTodos: (dados) => mudar({ todos: dados.todos }),
          // A rodada vai como `livre`, então isto **não** deveria chegar. Se chegar — backend
          // de uma versão anterior, ou o modo trocado no meio do caminho —, o Subs responde
          // «sim» sozinho em vez de pendurar a rodada para sempre: é o que «livre» quer dizer
          // aqui, e um pedido sem cartão não tem quem responda.
          onApprovalRequest: (dados) => {
            void answerApproval(dados.id, 'sim')
          },
          onDone: (dados) =>
            mexer(resposta.id, (fala) => ({
              ...fala,
              incompleto: dados.completed === false,
              motivo: dados.reason ?? null,
              pendentes: dados.pending_items ?? [],
              executou: dados.executed ?? 0,
              retomavel: dados.resumable ?? false,
            })),
          onError: (mensagem) =>
            mexer(resposta.id, (fala) => ({
              ...fala,
              texto: fala.texto ? `${fala.texto}\n\n${mensagem}` : mensagem,
            })),
        },
      )
    } catch (erro) {
      if (!controller.signal.aborted) {
        const motivo = fraseDeFalha(erro)
        mexer(resposta.id, (fala) => ({
          ...fala,
          texto: fala.texto ? `${fala.texto}\n\n[${motivo}]` : motivo,
        }))
      }
    } finally {
      if (pararAtual === controller) pararAtual = null
      mudar({ ocupado: false })
    }
  }

  const parar = () => {
    pararAtual?.abort()
    pararAtual = null
    mudar({ ocupado: false })
  }

  const rotuloDoModelo =
    catalogo?.find((item) => item.value === modelo)?.label ?? MODEL_LABELS[modelo] ?? modelo
  const feitos = todos.filter((item) => item.feito).length
  const emCurso =
    todos.find((item) => item.atual && !item.feito) ?? todos.find((item) => !item.feito)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* As abas só existem quando há sub-agente lançado: sem nenhum, a área é a conversa e
          mais nada — uma barra de uma aba só seria moldura sem conteúdo. */}
      {subs.length > 0 ? (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-koda-fg/10 px-2 py-1.5">
          <AbaDoSub
            ativa={abaAtiva === ABA_DA_CONVERSA}
            rotulo="Conversa"
            vivo={false}
            onClick={() => mudar({ aba: ABA_DA_CONVERSA })}
          />
          {subs.map((item) => (
            <AbaDoSub
              key={item.chamada}
              ativa={abaAtiva === item.chamada}
              rotulo={item.agente}
              vivo={item.vivo}
              onClick={() => mudar({ aba: item.chamada })}
            />
          ))}
        </div>
      ) : null}

      {sessao ? (
        <PainelDoSub sessao={sessao} />
      ) : (
        <>
      <div ref={listaRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {falas.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6">
            <p className="max-w-[38ch] text-center text-[12.5px] leading-relaxed text-koda-fg/40">
              Uma conversa separada da de baixo, no mesmo projeto
              {projeto?.nome ? ` (${projeto.nome})` : ''}. Pergunte aqui o que quiser — a
              conversa principal não é tocada.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {falas.map((fala, indice) =>
              fala.role === 'user' ? (
                <div key={fala.id} className="flex justify-end">
                  <BolhaUsuario texto={fala.texto} />
                </div>
              ) : (
                <div key={fala.id} className="flex min-w-0 flex-col gap-1.5">
                  {fala.raciocinio ? (
                    <Reasoning texto={fala.raciocinio} ativo={ocupado && !fala.texto} />
                  ) : null}
                  {fala.passos.length > 0 ? <ToolSteps steps={fala.passos} resumido /> : null}
                  {fala.texto ? <FalaDoModelo texto={fala.texto} /> : null}
                  {/* A resposta ainda sem nada na tela: a linha de trabalho é a única prova
                      de que tem alguém ali. Depois do primeiro texto ela desce para o fim. */}
                  {ocupado && !fala.texto && fala.passos.length === 0 && !fala.raciocinio ? (
                    <WorkingLine segundos={segundos} />
                  ) : null}
                  {/* Só na última: numa rodada antiga, retomar pegaria um assunto que a
                      conversa já deixou para trás. */}
                  {fala.incompleto && indice === falas.length - 1 ? (
                    <TarefaIncompleta
                      motivo={fala.motivo}
                      pendentes={fala.pendentes}
                      executou={fala.executou}
                      retomavel={fala.retomavel}
                      ocupado={ocupado}
                      onRetomar={() => void enviar(true)}
                    />
                  ) : null}
                </div>
              ),
            )}
            {ocupado && falas.at(-1)?.texto ? <WorkingLine segundos={segundos} /> : null}
          </div>
        )}
      </div>

      {/* O plano que o agente registrou, em uma linha: sem isto o `update_todos` dele não
          teria onde aparecer, e uma tarefa longa ficaria sem rumo à vista. */}
      {todos.length > 0 ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-koda-fg/8 px-3 py-1.5">
          <ListTodo className="h-3.5 w-3.5 shrink-0 text-koda-fg/40" strokeWidth={1.8} />
          <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-koda-fg/45">
            {feitos}/{todos.length}
          </span>
          <span className="min-w-0 truncate text-[11.5px] text-koda-fg/60">
            {emCurso?.texto ?? 'plano concluído'}
          </span>
        </div>
      ) : null}

      {/*
       * O prompt box — três peças soltas, e é o pedido: a caixa, o modelo e o enviar, cada um
       * com a sua borda. Nada de silhueta única aqui.
       */}
      <div className="flex shrink-0 flex-col gap-2 border-t border-koda-fg/10 px-3 py-3">
        <textarea
          value={rascunho}
          onChange={(evento) => mudar({ rascunho: evento.target.value })}
          onKeyDown={(evento) => {
            // Enter manda, Shift+Enter quebra a linha — o de sempre numa caixa de conversa.
            if (evento.key === 'Enter' && !evento.shiftKey) {
              evento.preventDefault()
              void enviar()
            }
          }}
          rows={2}
          placeholder="Escreva aqui…"
          spellCheck={false}
          className="w-full resize-none rounded-xl bg-koda-input px-3 py-2 text-[13.5px] leading-5 text-koda-fg ring-1 ring-koda-fg/10 transition-colors placeholder:text-koda-fg/35 focus:outline-none focus:ring-koda-accent/60"
        />

        <div className="flex items-center gap-2">
          {/* O `Menu` já desenha o `<button>` do gatilho: o que vai aqui é o conteúdo dele, e
              a cara vem no `triggerClassName`. */}
          <Menu
            options={modelMenu(catalogo, modelosCom400)}
            value={modelo}
            onSelect={(valor) => mudar({ modelo: valor })}
            direction="up"
            align="start"
            label="Modelo"
            panelClassName="w-64"
            triggerClassName="flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[12.5px] text-koda-fg/70 ring-1 ring-koda-fg/10 transition-colors duration-150 hover:bg-koda-fg/8 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
          >
            <KodaLogo className="h-3.5 w-auto shrink-0" color="currentColor" />
            <span className="max-w-[150px] truncate">{modelo ? rotuloDoModelo : 'Nenhum modelo disponível'}</span>
            <ChevronDown className="h-3 w-3 shrink-0" strokeWidth={2} />
          </Menu>

          {ocupado ? (
            <button
              type="button"
              aria-label="Parar"
              title="Parar"
              onClick={parar}
              className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-koda-fg/15 text-koda-fg transition-colors duration-150 hover:bg-koda-fg/25 focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
            >
              <Square className="h-3 w-3 fill-current" strokeWidth={0} />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Enviar"
              title="Enviar"
              disabled={!rascunho.trim() || !modelo}
              onClick={() => void enviar()}
              className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-koda-accent-strong text-white transition-opacity duration-150 hover:opacity-90 focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none disabled:cursor-default disabled:opacity-35"
            >
              <ArrowUp className="h-4 w-4" strokeWidth={2} />
            </button>
          )}
        </div>
      </div>
        </>
      )}
    </div>
  )
}

/** Uma aba da área: a conversa ou um sub-agente lançado. */
function AbaDoSub({
  ativa,
  rotulo,
  vivo,
  onClick,
}: {
  ativa: boolean
  rotulo: string
  vivo: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-selected={ativa}
      role="tab"
      onClick={onClick}
      title={rotulo}
      className={[
        'flex h-7 max-w-[42%] shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12px] whitespace-nowrap transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-koda-accent',
        ativa
          ? 'bg-koda-fg/12 text-koda-fg'
          : 'text-koda-fg/55 hover:bg-koda-fg/8 hover:text-koda-fg',
      ].join(' ')}
    >
      {vivo ? (
        <LoaderCircle className="h-3 w-3 shrink-0 animate-spin text-koda-accent" strokeWidth={2} />
      ) : (
        <Bot className="h-3.5 w-3.5 shrink-0 text-koda-fg/45" strokeWidth={1.8} />
      )}
      <span className="min-w-0 truncate">{rotulo}</span>
    </button>
  )
}

/**
 * O que um sub-agente está fazendo, na aba dele.
 *
 * Sem caixa de mensagem e sem botão de enviar: a pessoa não fala com o sub-agente — quem
 * fala com ele é o principal, e a tarefa dele veio de lá. Aqui só se **vê** o trabalho.
 */
function PainelDoSub({ sessao }: { sessao: SessaoDeSub }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <div className="flex flex-col gap-3">
        {sessao.passos.length > 0 ? <ToolSteps steps={sessao.passos} resumido /> : null}
        {sessao.texto ? <FalaDoModelo texto={sessao.texto} /> : null}
        {/* Enquanto ele trabalha, a linha fica de pé — é a prova de que tem alguém ali,
            mesmo quando ele está calado esperando uma ferramenta. */}
        {sessao.vivo ? <WorkingLine /> : null}
      </div>
    </div>
  )
}
