import { ChevronRight, TriangleAlert, Wrench } from 'lucide-react'
import type { ToolStep } from '../api/client'
import { formatarDuracao } from '../duracao'
import { resumoArgumentos, rotuloFerramenta } from '../tools'
import { ToolIcon, ToolSpinner } from './ToolIcon'

/**
 * Ferramentas que o modelo chamou nesta resposta: uma linha seca por chamada — ícone da
 * ação, o que ela tocou e quanto levou. Nada de caixa, fundo ou borda em volta: o realce
 * é só o texto acendendo no hover. O resultado abre como texto indentado atrás de um fio,
 * igual ao que foi gravado no histórico.
 *
 * `resumido` é o modo de uso normal: em vez da lista aberta, **uma** linha dizendo quantas
 * ferramentas rodaram e quanto levou, com o detalhe (e os caminhos) atrás de um clique. A
 * conversa de quem só quer a resposta fica limpa, e quem quer saber o que o agente fez
 * continua a um clique de distância.
 */
export default function ToolSteps({
  steps,
  resumido = false,
}: {
  steps: ToolStep[]
  resumido?: boolean
}) {
  if (steps.length === 0) return null

  const linhas = steps.map((step, index) => (
    <Linha key={step.call_id || `${step.name}-${index}`} step={step} />
  ))

  if (!resumido) return <div className="flex flex-col msg-in">{linhas}</div>

  const rodando = steps.some((step) => step.output === '' && step.duration_ms === 0)
  const total = steps.reduce((soma, step) => soma + step.duration_ms, 0)

  return (
    <details className="group msg-in">
      <summary className="flex cursor-pointer list-none items-center gap-2 py-1 text-koda-fg/50 transition-colors duration-200 select-none hover:text-koda-fg/85">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          {rodando ? (
            <ToolSpinner className="h-3.5 w-3.5 text-koda-accent" />
          ) : (
            <Wrench className="h-3.5 w-3.5" strokeWidth={1.7} />
          )}
        </span>

        <span className="shrink-0 text-[12.5px] font-medium">
          {steps.length === 1 ? '1 ferramenta' : `${steps.length} ferramentas`}
        </span>

        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11.5px] tabular-nums text-koda-fg/30">
          {rodando ? 'rodando' : total > 0 ? formatarDuracao(total) : ''}
          <ChevronRight
            className="h-3.5 w-3.5 transition-transform duration-200 group-open:rotate-90"
            strokeWidth={1.7}
          />
        </span>
      </summary>

      <div className="mt-0.5 mb-2 ml-[3px] flex flex-col border-l border-koda-fg/10 pl-3">
        {linhas}
      </div>
    </details>
  )
}

/** Uma chamada: o que rodou, o que tocou, quanto levou — e o resultado atrás do clique. */
function Linha({ step }: { step: ToolStep }) {
  const rodando = step.output === '' && step.duration_ms === 0
  const resumo = resumoArgumentos(step.arguments)

  return (
    <details className="group">
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
          {rodando ? 'rodando' : step.ok ? formatarDuracao(step.duration_ms) : 'falhou'}
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
        {/*
          * `break-words` para a saída não virar rolagem lateral: um JSON numa linha,
          * um base64 ou uma URL de download são o caso comum aqui, e rolar de lado
          * dentro de um bloco de saída esconde justamente o fim da linha, que é onde
          * costuma estar o erro. O `overflow-auto` continua no lugar para altura.
          */}
        <pre className="mt-1 max-h-64 overflow-auto font-mono text-[11.5px] leading-5 break-words whitespace-pre-wrap text-koda-fg/50">
          {step.output || 'sem saída'}
        </pre>
      </div>
    </details>
  )
}
