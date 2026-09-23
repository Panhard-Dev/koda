import { ChevronRight, TriangleAlert } from 'lucide-react'
import type { ToolStep } from '../api/client'
import { rotuloFerramenta } from '../tools'
import { ToolIcon, ToolSpinner } from './ToolIcon'

const resumoArgs = (argumentos: Record<string, unknown>, limite = 96) => {
  const partes = Object.entries(argumentos).map(([chave, valor]) => {
    const texto = typeof valor === 'string' ? valor : JSON.stringify(valor)
    const curto = (texto ?? '').replace(/\s+/g, ' ').slice(0, 44)
    return `${chave}: ${curto}${(texto ?? '').length > 44 ? '…' : ''}`
  })
  const resumo = partes.join(' · ')
  return resumo.length > limite ? `${resumo.slice(0, limite)}…` : resumo
}

/**
 * Ferramentas que o modelo chamou nesta resposta: uma linha seca por chamada — ícone da
 * ação, o que ela tocou e quanto levou. Nada de caixa, fundo ou borda em volta: o realce
 * é só o texto acendendo no hover. O resultado abre como texto indentado atrás de um fio,
 * igual ao que foi gravado no histórico.
 */
export default function ToolSteps({ steps }: { steps: ToolStep[] }) {
  if (steps.length === 0) return null

  return (
    <div className="flex flex-col msg-in">
      {steps.map((step, index) => {
        const rodando = step.output === '' && step.duration_ms === 0
        const chave = step.call_id || `${step.name}-${index}`
        const resumo = resumoArgs(step.arguments)

        return (
          <details key={chave} className="group">
            <summary
              title={`${step.name}(${resumo})`}
              className="flex cursor-pointer list-none items-center gap-2 py-1 text-koda-fg/50 transition-colors duration-200 select-none hover:text-koda-fg/85"
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                {rodando ? (
                  <ToolSpinner className="h-3.5 w-3.5 text-koda-accent" />
                ) : step.ok ? (
                  <ToolIcon name={step.name} className="h-3.5 w-3.5" />
                ) : (
                  <TriangleAlert className="h-3.5 w-3.5" strokeWidth={1.7} />
                )}
              </span>

              <span className="shrink-0 text-[12.5px] font-medium">
                {rotuloFerramenta(step.name)}
              </span>

              <span className="min-w-0 truncate font-mono text-[11.5px] text-koda-fg/30">
                {resumo}
              </span>

              <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11.5px] tabular-nums text-koda-fg/30">
                {rodando ? 'rodando' : step.ok ? `${step.duration_ms} ms` : 'falhou'}
                <ChevronRight
                  className="h-3.5 w-3.5 transition-transform duration-200 group-open:rotate-90"
                  strokeWidth={1.7}
                />
              </span>
            </summary>

            <div className="mt-0.5 mb-2 ml-[3px] border-l border-koda-fg/10 pl-3">
              <p className="font-mono text-[10px] tracking-wider text-koda-fg/25 uppercase">
                {step.name}
              </p>
              <pre className="mt-1 max-h-64 overflow-auto font-mono text-[11.5px] leading-5 whitespace-pre-wrap text-koda-fg/50">
                {step.output || 'sem saída'}
              </pre>
            </div>
          </details>
        )
      })}
    </div>
  )
}
