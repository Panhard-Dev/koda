import { Play, TriangleAlert } from 'lucide-react'

/**
 * O cartão de **tarefa não concluída**, no fim de uma rodada que fechou sem terminar.
 *
 * Ele existe porque a resposta do assistente não pode terminar com instrução de uso. Antes,
 * o loop inventava um fechamento — "Não terminei a tarefa… me diga *continue* que eu sigo" —
 * e o produto pedia ao dono a palavra mágica que ele deveria saber sozinho. Agora o texto
 * que fica na conversa é **o que o modelo escreveu**, e o que falta vem para cá, em
 * contrato estruturado (o `done` traz `reason`, `pending_items`, `executed` e `resumable`).
 *
 * Por que um cartão, e não uma frase:
 *
 * - **o motivo é um código**, não uma sentença: `pending_steps`, `time_limit`,
 *   `provider_error`… A tradução para leitura é daqui, e o backend não precisa saber
 *   escrever português de tela (é o `FAILURE_CAUSE_GLOSS` do projeto de origem);
 * - **os itens pendentes têm nome**: quem registrou a lista foi o próprio agente, então o
 *   que faltou aparece com as palavras dele — e não com um resumo nosso por cima;
 * - **o Retomar é uma ação de verdade**: ele manda `resume` e o backend continua o histórico
 *   sem gravar turno de usuário. A bolha com "continue" na tela era o defeito antigo;
 * - **`context_overflow` não retoma**: o mesmo pedido não vai caber depois. Nos outros
 *   motivos, retomar é exatamente o que a pessoa quer.
 *
 * Um clique, e não uma retomada automática: cada tentativa é uma chamada paga, e quem
 * decide se o agente volta a mexer no projeto é quem está olhando.
 */

/** O que cada código de motivo significa, em uma linha de leitura. */
const MOTIVOS: Record<string, string> = {
  pending_steps: 'Ficaram itens do plano que o próprio agente registrou.',
  announced_only: 'O agente anunciou o próximo passo e encerrou sem executá-lo.',
  time_limit: 'O tempo máximo da tarefa acabou antes de terminar.',
  tool_limit: 'O teto de chamadas de ferramenta foi atingido.',
  step_limit: 'O limite de passos desta rodada foi atingido.',
  repeated_tool: 'A mesma chamada se repetiu e o trabalho foi interrompido.',
  empty_response: 'O provedor respondeu vazio várias vezes seguidas.',
  provider_error: 'O provedor caiu e não deu para continuar.',
  context_overflow: 'O pedido não caberia no contexto do modelo, nem reduzido.',
  interrupted: 'A tarefa foi interrompida.',
}

const MOTIVO_PADRAO = 'A rodada terminou antes de concluir o que foi pedido.'

export default function TarefaIncompleta({
  motivo,
  pendentes = [],
  executou = 0,
  retomavel = true,
  onRetomar,
  ocupado = false,
}: {
  /** Código do motivo, direto do `done` (`loop.PARADA_*`). */
  motivo?: string | null
  /** Itens do plano que ficaram em aberto, com o texto que o agente deu. */
  pendentes?: string[]
  /** Quantas ferramentas rodaram de verdade nesta rodada. */
  executou?: number
  /** Falso no único motivo em que retomar não faz sentido: o contexto estourado. */
  retomavel?: boolean
  /** Retoma a tarefa. Sem ele o cartão aparece só com o relatório, sem botão. */
  onRetomar?: () => void
  /** Tem resposta rodando agora: dois turnos ao mesmo tempo não dá. */
  ocupado?: boolean
}) {
  const itens = pendentes.filter(Boolean)
  const podeRetomar = retomavel && Boolean(onRetomar)

  return (
    <div className="msg-in mt-2 flex min-w-0 flex-col gap-2 rounded-xl bg-koda-fg/4 px-3 py-2.5 ring-1 ring-koda-fg/10">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium break-words text-koda-fg/85">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-koda-accent" strokeWidth={1.8} />
          Tarefa não concluída
        </span>

        {podeRetomar ? (
          <button
            type="button"
            disabled={ocupado}
            onClick={onRetomar}
            className="ml-auto flex shrink-0 items-center gap-1.5 rounded-lg bg-koda-accent/15 px-2.5 py-1 text-[12.5px] font-medium text-koda-accent ring-1 ring-koda-accent/25 transition-colors duration-150 hover:bg-koda-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-koda-accent disabled:cursor-default disabled:opacity-50"
          >
            <Play className="h-3 w-3" strokeWidth={2} />
            {ocupado ? 'Retomando…' : 'Retomar'}
          </button>
        ) : null}
      </div>

      <p className="text-[12.5px] leading-snug text-koda-fg/60">
        {(motivo && MOTIVOS[motivo]) || MOTIVO_PADRAO}
        {executou > 0
          ? ' O que já foi executado está no disco — confira antes de repetir.'
          : ''}
      </p>

      {itens.length > 0 ? (
        <ul className="flex flex-col gap-1 text-[12.5px] leading-snug text-koda-fg/70">
          {itens.map((item) => (
            <li key={item} className="flex min-w-0 gap-2">
              <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-koda-accent/60" />
              <span className="min-w-0 break-words">{item}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
