import { useEffect, useRef } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import { formatarCaracteres } from '../duracao'
import { ToolSpinner } from './ToolIcon'

/**
 * O que o modelo pensou antes de dizer alguma coisa — um passo do processo, como as
 * ferramentas.
 *
 * Fica **aberto só enquanto é a última coisa que está acontecendo** e fecha sozinho
 * quando a fala (ou a próxima ferramenta) começa: o pensamento vira uma linha resumida
 * no lugar onde aconteceu, e o que veio depois segue embaixo dele. Sem isso o bloco
 * ficava sempre no topo da mensagem, aberto, empurrando a resposta para longe.
 */
export default function Reasoning({ texto, ativo }: { texto: string; ativo: boolean }) {
  const caixa = useRef<HTMLDivElement>(null)

  // Enquanto pensa, o que interessa é a última linha: a caixa acompanha o texto.
  useEffect(() => {
    if (!ativo) return
    const elemento = caixa.current
    if (elemento) elemento.scrollTop = elemento.scrollHeight
  }, [texto, ativo])

  return (
    <details open={ativo} className="group">
      <summary className="flex cursor-pointer list-none items-center gap-2 py-1 text-koda-fg/50 transition-colors duration-200 select-none hover:text-koda-fg/85">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          {ativo ? (
            <ToolSpinner className="h-3.5 w-3.5 text-koda-accent" />
          ) : (
            <Brain className="h-3.5 w-3.5" strokeWidth={1.7} />
          )}
        </span>

        <span className="shrink-0 text-[12.5px] font-medium">Raciocínio</span>

        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11.5px] tabular-nums text-koda-fg/30">
          {ativo ? 'pensando' : formatarCaracteres(texto.length)}
          <ChevronRight
            className="h-3.5 w-3.5 transition-transform duration-200 group-open:rotate-90"
            strokeWidth={1.7}
          />
        </span>
      </summary>

      <div className="mt-0.5 mb-2 ml-[3px] border-l border-koda-fg/10 pl-3">
        <div
          ref={caixa}
          className="max-h-56 overflow-y-auto text-[12.5px] leading-5 break-words whitespace-pre-wrap text-koda-fg/50"
        >
          {texto}
        </div>
      </div>
    </details>
  )
}
