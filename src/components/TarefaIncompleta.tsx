import { Play } from 'lucide-react'

/**
 * A faixa que aparece quando a rodada fechou **sem terminar**.
 *
 * O backend já insiste sozinho antes de chegar aqui: ele cobra a ferramenta que faltou,
 * devolve o anúncio ao histórico e retoma a tarefa por conta própria (`MAX_RETOMADAS_ANUNCIO`
 * em `backend/app/tools/loop.py`). Isto é o que sobra quando nem isso resolveu — o modelo
 * gastou os orçamentos e a resposta terminou com `completed: false` no evento `done`.
 *
 * Antes desta faixa, o fim desse caminho era a pessoa tendo que ler o que faltou, entender
 * que o agente parou e **digitar "continue"** na mão. Era o passo mais frustrante de todos:
 * a informação toda estava na tela e a ação óbvia não estava a um clique.
 *
 * Um clique, e não um "continuar" automático, por dois motivos: continuar sozinho em cima de
 * um `completed: false` é um laço com orçamento do dono dentro (cada tentativa é uma chamada
 * paga, e um provedor teimoso giraria para sempre); e a retomada é um turno de verdade na
 * conversa — ele fica no histórico. Se o agente vai voltar a mexer no projeto, quem manda é
 * quem está olhando.
 *
 * O texto é neutro de propósito ("ainda falta terminar"), e não uma frase de erro: muita vez
 * metade do trabalho já está no disco e só uma parte ficou pelo caminho.
 */
export default function TarefaIncompleta({
  onContinuar,
  ocupado = false,
}: {
  /** Manda a tarefa seguir de onde parou. Sem ele a faixa não aparece. */
  onContinuar?: () => void
  /** Tem resposta rodando agora: dois turnos ao mesmo tempo não dá. */
  ocupado?: boolean
}) {
  if (!onContinuar) return null

  return (
    <div className="msg-in mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-koda-accent/8 px-3 py-2 ring-1 ring-koda-accent/20">
      <span className="flex min-w-0 items-center gap-2 text-[13px] break-words text-koda-fg/75">
        <Play className="h-3.5 w-3.5 shrink-0 text-koda-accent" strokeWidth={1.8} />
        Ainda falta terminar. Dá para seguir de onde parou.
      </span>

      <button
        type="button"
        disabled={ocupado}
        onClick={onContinuar}
        className="ml-auto flex shrink-0 items-center gap-1.5 rounded-lg bg-koda-accent/15 px-2.5 py-1 text-[12.5px] font-medium text-koda-accent ring-1 ring-koda-accent/25 transition-colors duration-150 hover:bg-koda-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-koda-accent disabled:cursor-default disabled:opacity-50"
      >
        Continuar
      </button>
    </div>
  )
}
