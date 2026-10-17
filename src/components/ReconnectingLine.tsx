import ThinkingMark from './ThinkingMark'

/**
 * A linha de «reconectando» — a mesma linha de trabalho do Koda, dizendo que a
 * conexão caiu e que ela está sendo refeita.
 *
 * É a WorkingLine (`components/WorkingLine.tsx`) com o texto e a informação trocados:
 * no lugar dos segundos correndo, o contador de tentativas (`01/10`). De propósito a
 * mesma forma: quem está olhando já sabe ler aquela linha, e uma linha nova, com
 * outro desenho, pareceria outro problema.
 *
 * O contador é a prova de vida aqui também — «reconectando» sem número é uma
 * espera que pode ser eterna; `01/10` diz que há um fim e quantos passos faltam.
 */
export default function ReconnectingLine({
  tentativa,
  total,
}: {
  /** Qual tentativa é esta (1 = a primeira). Sem ela, a linha não mostra contador. */
  tentativa?: number
  /** Total de tentativas antes de desistir. */
  total?: number
}) {
  const dois = (valor: number) => String(valor).padStart(2, '0')
  const comContador = tentativa != null && total != null
  return (
    <div className="flex items-center gap-3 py-0.5" role="status" aria-live="polite">
      <ThinkingMark className="h-3.5 w-auto shrink-0 text-koda-fg/70" />
      <span className="min-w-0 truncate text-[13px] text-koda-fg/45">
        Reconectando<span className="text-koda-fg/75">…</span>
      </span>
      {comContador ? (
        <span className="ml-auto shrink-0 font-mono text-[11.5px] tabular-nums text-koda-fg/30">
          {dois(tentativa)}/{dois(total)}
        </span>
      ) : null}
    </div>
  )
}
