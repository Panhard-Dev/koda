import { Archive, Minimize2, Scissors, TriangleAlert } from 'lucide-react'
import type { Compactacao as Aviso } from '../compactacao'

/**
 * O momento em que a conversa foi compactada — como um cartão, e não como uma frase em
 * itálico perdida no meio da resposta.
 *
 * A compactação é uma coisa que **aconteceu** com a conversa, não algo que o modelo disse.
 * Antes ela saía como `_(histórico compactado: 13 mensagens…)_` no corpo do texto: quem
 * lia não sabia se aquilo era o modelo falando, uma sobra do sistema, ou um erro. Aqui ela
 * ganha o que qualquer acontecimento precisa para ser entendido em um segundo — ícone,
 * título, uma frase do que mudou e, quando o provedor conta, o número: quantos milhares de
 * tokens saíram do contexto.
 *
 * Entra com um movimento curto e um brilho que atravessa a borda uma vez: o cartão marca o
 * ponto exato da conversa em que o corte aconteceu, e o brilho é o que faz o olho parar ali
 * em vez de passar batido por mais um bloco de texto.
 */
export default function Compactacao({ aviso }: { aviso: Aviso }) {
  const { titulo, detalhe, icone: Icone, numero, tons } = descrever(aviso)

  return (
    <div className="compact-in relative my-0.5 overflow-hidden rounded-2xl bg-koda-accent/6 ring-1 ring-koda-accent/15">
      <span
        aria-hidden
        className="compact-shine pointer-events-none absolute inset-y-0 -left-1/3 w-1/4 bg-gradient-to-r from-transparent via-koda-accent/12 to-transparent"
      />

      <div className="relative flex items-start gap-3 px-3.5 py-3">
        <span
          className={[
            'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-xl',
            tons,
          ].join(' ')}
        >
          <Icone className="h-3.5 w-3.5" strokeWidth={1.8} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[12.5px] font-medium text-koda-fg/85">{titulo}</span>
            {numero ? (
              <span className="rounded-md bg-koda-fg/8 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-koda-fg/55">
                {numero}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-[12px] leading-[18px] text-koda-fg/45">{detalhe}</p>
        </div>
      </div>
    </div>
  )
}

/** "120k" — número de tokens como o resto da interface conta, curto o bastante para um selo. */
function emMilhares(tokens: number): string {
  if (tokens < 1000) return `${tokens}`
  return `${Math.round(tokens / 1000)}k`
}

function descrever(aviso: Aviso): {
  titulo: string
  detalhe: string
  icone: typeof Archive
  numero: string | null
  tons: string
} {
  const normal = 'bg-koda-accent/15 text-koda-accent'
  const alerta = 'bg-koda-fg/10 text-koda-fg/70'

  switch (aviso.motivo) {
    case 'historico': {
      const quantas = aviso.compactados ?? 0
      return {
        titulo: 'Histórico compactado',
        detalhe:
          quantas === 1
            ? 'Uma mensagem antiga virou resumo, para a conversa caber no contexto.'
            : `${quantas} mensagens antigas viraram resumo, para a conversa caber no contexto.`,
        icone: Archive,
        numero: quantas ? `${quantas} mensagens` : null,
        tons: normal,
      }
    }

    case 'contexto': {
      const antes = aviso.tokensAntes
      const depois = aviso.tokensDepois
      const economia = antes !== null && depois !== null ? antes - depois : null
      return {
        titulo: 'Contexto enxugado',
        detalhe:
          'O que já foi feito virou resumo; o trabalho segue de onde parou, com o contexto do tamanho certo.',
        icone: Minimize2,
        numero:
          antes !== null && depois !== null
            ? `~${emMilhares(antes)} → ~${emMilhares(depois)}${
                economia && economia > 0 ? ` (−${emMilhares(economia)})` : ''
              }`
            : null,
        tons: normal,
      }
    }

    case 'reducao':
      return {
        titulo: 'Contexto reduzido',
        detalhe:
          'O provedor recusou o tamanho do pedido. O Koda encolheu o contexto e continuou daqui.',
        icone: Scissors,
        numero: aviso.tokensDepois !== null ? `~${emMilhares(aviso.tokensDepois)}` : null,
        tons: alerta,
      }

    case 'corte':
      return {
        titulo: 'Resposta cortada no teto de tokens',
        detalhe: 'O modelo bateu o limite de saída e o Koda seguiu do que veio completo.',
        icone: TriangleAlert,
        numero: null,
        tons: alerta,
      }
  }
}
