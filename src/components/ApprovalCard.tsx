import { AlertTriangle, Loader2, ShieldQuestion } from 'lucide-react'
import type { DecisaoPermissao, PedidoPermissao } from '../api/client'

/**
 * O cartão de permissão, logo acima do prompt box.
 *
 * O agente **para** aqui: o passo não roda enquanto ninguém responder. Por isso o cartão
 * diz, em português, o que vai acontecer, mostra o comando/caminho exato em destaque e
 * avisa o que «sempre» e «nunca» passam a valer — quem responde precisa saber se está
 * liberando só esta vez ou para sempre.
 */

const RISCO: Record<PedidoPermissao['risco'], { rotulo: string; classe: string }> = {
  baixo: { rotulo: 'baixo', classe: 'bg-koda-fg/8 text-koda-fg/55' },
  medio: { rotulo: 'médio', classe: 'bg-amber-400/12 text-amber-300' },
  alto: { rotulo: 'alto', classe: 'bg-red-500/15 text-red-400' },
}

export function ApprovalCard({
  pedido,
  respondendo = false,
  erro = null,
  onDecidir,
}: {
  pedido: PedidoPermissao
  respondendo?: boolean
  erro?: string | null
  onDecidir: (decisao: DecisaoPermissao) => void
}) {
  const risco = RISCO[pedido.risco] ?? RISCO.medio
  const alto = pedido.risco === 'alto'

  const botao = [
    'rounded-xl px-3 py-1.5 text-[12.5px] font-medium ring-1 transition-colors duration-150',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-koda-accent',
    'disabled:cursor-default disabled:opacity-50',
  ].join(' ')

  return (
    <div className="msg-in mb-2 rounded-2xl bg-koda-panel p-3.5 ring-1 ring-koda-fg/10">
      <div className="flex items-start gap-2.5">
        <span
          className={[
            'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg',
            alto ? 'bg-red-500/15 text-red-400' : 'bg-koda-accent/15 text-koda-accent',
          ].join(' ')}
        >
          {alto ? (
            <AlertTriangle className="h-3.5 w-3.5" strokeWidth={1.9} />
          ) : (
            <ShieldQuestion className="h-3.5 w-3.5" strokeWidth={1.9} />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-[13.5px] font-semibold text-koda-fg">{pedido.titulo}</p>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold tracking-wide uppercase ${risco.classe}`}
            >
              risco {risco.rotulo}
            </span>
          </div>

          <p className="mt-1 text-[12.5px] leading-5 text-koda-fg/65">{pedido.explicacao}</p>

          {pedido.resumo ? (
            <p className="mt-1.5 max-h-24 overflow-y-auto rounded-lg bg-koda-bg/60 px-2.5 py-1.5 font-mono text-[11.5px] break-all text-koda-fg/80">
              {pedido.resumo}
            </p>
          ) : null}

          {erro ? (
            <p role="alert" className="mt-1.5 text-[12px] text-red-400">
              {erro}
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-end gap-1.5">
        {respondendo ? (
          <span className="mr-auto flex items-center gap-1.5 text-[12px] text-koda-fg/45">
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
            Respondendo…
          </span>
        ) : (
          <span className="mr-auto max-w-[60%] text-[11.5px] leading-4 text-koda-fg/40">
            «Sempre» e «nunca» lembram para {pedido.lembrar}.
          </span>
        )}

        <button
          type="button"
          disabled={respondendo}
          onClick={() => onDecidir('sim')}
          className={`${botao} bg-koda-accent-strong text-white ring-transparent hover:bg-koda-accent-strong/85`}
        >
          Sim
        </button>
        <button
          type="button"
          disabled={respondendo}
          onClick={() => onDecidir('sempre')}
          className={`${botao} text-koda-fg/85 ring-koda-fg/15 hover:bg-koda-fg/8`}
        >
          Sempre permitir
        </button>
        <button
          type="button"
          disabled={respondendo}
          onClick={() => onDecidir('nao')}
          className={`${botao} text-koda-fg/70 ring-koda-fg/12 hover:bg-koda-fg/8`}
        >
          Não
        </button>
        <button
          type="button"
          disabled={respondendo}
          onClick={() => onDecidir('nunca')}
          className={`${botao} text-red-400 ring-red-500/25 hover:bg-red-500/10`}
        >
          Nunca permitir
        </button>
      </div>
    </div>
  )
}

export default ApprovalCard
