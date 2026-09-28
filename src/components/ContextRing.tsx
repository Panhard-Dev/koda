/**
 * Medidor de contexto: o anel que diz quanto da janela do modelo já foi usado.
 *
 * O número é **medido**, não estimado: vem do `prompt_tokens` do último passo da resposta
 * (o que o provedor contou do que recebeu), gravado na mensagem pelo backend. O
 * denominador é o teto que o Koda aplica à conversa (`KODA_CONTEXT_TOKENS`), porque o host
 * não publica a janela de cada modelo — medir contra um número inventado daria um
 * percentual bonito e falso.
 *
 * Sem medida (conversa nova, provedor que não conta) o anel aparece vazio, e é isso mesmo:
 * zero é uma informação, e é melhor do que um enfeite que finge saber.
 */
import { useEffect, useState } from 'react'

type ContextRingProps = {
  /** Tokens de entrada medidos no último passo. `0`/`undefined` = ainda não medido. */
  usado?: number
  /** Teto de contexto do modelo, em tokens. */
  janela?: number | null
  /** O agente está trabalhando agora: o anel roda. */
  trabalhando?: boolean
  /** Tamanho do anel, em pixels. */
  tamanho?: number
  className?: string
}

/** Quanto do contexto já foi: verde, amarelo, vermelho — a mesma régua do modo de permissão. */
function cor(fracao: number): string {
  if (fracao >= 0.85) return '#f87171'
  if (fracao >= 0.6) return '#fbbf24'
  return '#34d399'
}

/** `325000` → `325K` · `1_000_000` → `1M` · `900` → `900`. */
export function emK(valor: number): string {
  if (valor >= 1_000_000) return `${(valor / 1_000_000).toFixed(valor % 1_000_000 === 0 ? 0 : 1)}M`
  if (valor >= 1_000) return `${(valor / 1_000).toFixed(valor % 1_000 === 0 ? 0 : 1)}K`
  return String(Math.round(valor))
}

/** O texto que aparece no `title` e ao lado do anel: `32.5% · 325K / 1M contexto usado`. */
export function descricaoDoContexto(usado: number, janela: number | null | undefined): string {
  if (!janela || janela <= 0) return `${emK(usado)} tokens de contexto`
  const fracao = Math.min(1, usado / janela)
  return `${(fracao * 100).toFixed(1)}% · ${emK(usado)} / ${emK(janela)} contexto usado`
}

export default function ContextRing({
  usado = 0,
  janela = null,
  trabalhando = false,
  tamanho = 14,
  className = '',
}: ContextRingProps) {
  // O anel cresce em animação quando o número muda, em vez de saltar — o salto parecia
  // "piscada" no meio da tarefa.
  const [mostrado, setMostrado] = useState(0)
  const alvo = janela && janela > 0 ? Math.min(1, usado / janela) : 0

  useEffect(() => {
    const passo = window.setTimeout(() => setMostrado(alvo), 30)
    return () => window.clearTimeout(passo)
  }, [alvo])

  const traco = 2
  const raio = (tamanho - traco) / 2
  const volta = 2 * Math.PI * raio
  const preenchido = volta * mostrado
  const titulo = descricaoDoContexto(usado, janela)

  return (
    <span
      className={`inline-flex items-center justify-center ${className}`}
      title={titulo}
      aria-label={titulo}
      role="img"
    >
      <svg width={tamanho} height={tamanho} viewBox={`0 0 ${tamanho} ${tamanho}`} aria-hidden>
        {/* Trilho: o que existe de janela. */}
        <circle
          cx={tamanho / 2}
          cy={tamanho / 2}
          r={raio}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.18}
          strokeWidth={traco}
        />
        {/* O que já foi usado, com a cor da faixa. */}
        <circle
          cx={tamanho / 2}
          cy={tamanho / 2}
          r={raio}
          fill="none"
          stroke={cor(alvo)}
          strokeWidth={traco}
          strokeLinecap="round"
          strokeDasharray={`${preenchido} ${volta}`}
          transform={`rotate(-90 ${tamanho / 2} ${tamanho / 2})`}
          style={{ transition: 'stroke-dasharray 400ms ease-out' }}
        />
        {/* Trabalhando: um arco fino girando por cima, para a bolinha "rodar". */}
        {trabalhando && (
          <circle
            cx={tamanho / 2}
            cy={tamanho / 2}
            r={raio}
            fill="none"
            stroke="currentColor"
            strokeWidth={traco}
            strokeLinecap="round"
            strokeDasharray={`${volta * 0.18} ${volta}`}
            className="contexto-girando"
          />
        )}
      </svg>
    </span>
  )
}
