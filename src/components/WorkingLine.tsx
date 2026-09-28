import type { ToolStep } from '../api/client'
import { resumoArgumentos, rotuloFerramenta } from '../tools'
import ThinkingMark from './ThinkingMark'
import { ToolSpinner } from './ToolIcon'

/**
 * A linha que fica viva no fim da resposta enquanto o Koda trabalha.
 *
 * O modelo passa minutos calado: pensando sem escrever, esperando a resposta da
 * ferramenta que ele mesmo pediu, decidindo o próximo passo. Nesses buracos a tela ficava
 * com a última coisa que aconteceu e mais nada — parecia travada. Aqui embaixo fica o
 * sinal de que ainda tem alguém trabalhando, e ele diz **o quê**: a ferramenta em curso
 * com o que ela recebeu, ou só que está trabalhando quando ainda não dá para saber mais.
 *
 * Os segundos correndo não são enfeite: são a prova de que ainda está vivo. Um indicador
 * parado não convence ninguém de que algo está acontecendo.
 */
export default function WorkingLine({
  passo = null,
  segundos,
}: {
  /** Ferramenta anunciada e ainda sem resultado — a coisa mais concreta que dá para dizer. */
  passo?: ToolStep | null
  /** Segundos desde o começo desta resposta (some quando não há o que contar). */
  segundos?: number
}) {
  return (
    <div className="flex items-center gap-3 py-0.5">
      {passo ? (
        <ToolSpinner className="h-3.5 w-3.5 shrink-0 text-koda-accent" />
      ) : (
        <ThinkingMark className="h-3.5 w-auto shrink-0 text-koda-fg/70" />
      )}

      <span className="min-w-0 truncate text-[13px] text-koda-fg/45">
        {passo ? (
          <>
            Rodando <span className="text-koda-fg/75">{rotuloFerramenta(passo.name)}</span>{' '}
            <span className="font-mono text-[11.5px] text-koda-fg/30">
              {resumoArgumentos(passo.arguments, 56)}
            </span>
          </>
        ) : (
          'Trabalhando…'
        )}
      </span>

      {segundos === undefined ? null : (
        <span className="ml-auto shrink-0 font-mono text-[11.5px] tabular-nums text-koda-fg/25">
          {segundos}s
        </span>
      )}
    </div>
  )
}
