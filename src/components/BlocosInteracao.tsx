/**
 * A camada de interação dos blocos visuais.
 *
 * ## Por que existe um arquivo só para isto
 *
 * Todo desenho precisa das mesmas três coisas: um balão que segue o mouse, um estado de
 * "isto está destacado" e a tecla Esc para limpar. Escrever isso em cada gráfico seria
 * sete cópias da mesma lógica — e a primeira que ficasse diferente seria a que ninguém
 * conserta. Aqui mora uma vez, e os gráficos só dizem **o que** mostrar.
 *
 * ## O balão é nosso, e não o `title` do navegador
 *
 * O `title` nativo tem dois defeitos que aparecem no uso: demora cerca de um segundo para
 * aparecer, e não dá para formatar. Num gráfico isso é a diferença entre "passar o mouse e
 * entender" e "passar o mouse e esperar". O balão daqui aparece na hora, aceita título,
 * valor e detalhe, e se posiciona sozinho para não sair da tela.
 *
 * ## O destaque é do grupo, não do elemento
 *
 * Clicar numa fatia da pizza precisa apagar as outras, e clicar de novo precisa voltar. Um
 * `Set` de chaves resolve os dois: um elemento só, vários (futuro: seleção múltipla), ou
 * nenhum. Cada gráfico decide o que a chave significa — o índice da série, o nome do ramo.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** O que o balão mostra. `titulo` é a linha forte; o resto vem abaixo, menor. */
export type Dica = {
  titulo: string
  valor?: string
  detalhe?: string
  /** Um quadradinho de cor à esquerda, no tom do elemento apontado. */
  cor?: string
}

/**
 * O estado de interação de um desenho: balão, destaque e as ações.
 *
 * Devolve também `props` — o punhado de handlers que cada elemento espalha em si mesmo.
 * É o que deixa o gráfico curto: em vez de repetir `onMouseEnter`/`onMouseLeave`/`onClick`
 * em cada barra, ele faz `{...props(chave, dica)}`.
 */
export type Interacao = {
  dica: Dica | null
  posicao: { x: number; y: number } | null
  destacados: Set<string>
  estaDestacado: (chave: string) => boolean
  temDestaque: boolean
  /** Os handlers para um elemento: `{...props('fatia-1', { titulo: 'Site', valor: '55' })}`. */
  props: (chave: string, dica: Dica) => {
    onMouseEnter: (e: React.MouseEvent) => void
    onMouseMove: (e: React.MouseEvent) => void
    onMouseLeave: () => void
    onClick: (e: React.MouseEvent) => void
    style: { cursor: string }
  }
  limpar: () => void
}

export function useInteracao(): Interacao {
  const [dica, setDica] = useState<Dica | null>(null)
  const [posicao, setPosicao] = useState<{ x: number; y: number } | null>(null)
  const [destacados, setDestacados] = useState<Set<string>>(new Set())

  const limpar = useCallback(() => {
    setDica(null)
    setPosicao(null)
    setDestacados(new Set())
  }, [])

  // Esc limpa o destaque. Sem isto, quem clica numa fatia e quer voltar tem de acertar o
  // mesmo ponto de novo — e num gráfico pequeno isso é irritante.
  useEffect(() => {
    const tecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') limpar()
    }
    window.addEventListener('keydown', tecla)
    return () => window.removeEventListener('keydown', tecla)
  }, [limpar])

  const props = useCallback(
    (chave: string, conteudo: Dica) => ({
      onMouseEnter: (e: React.MouseEvent) => {
        setDica(conteudo)
        setPosicao({ x: e.clientX, y: e.clientY })
      },
      // O `mousemove` mantém o balão colado no ponteiro: só `mouseenter` deixaria ele
      // parado no lugar onde o mouse entrou, e a pessoa moveria o mouse para longe dele.
      onMouseMove: (e: React.MouseEvent) => {
        setPosicao({ x: e.clientX, y: e.clientY })
      },
      onMouseLeave: () => {
        setDica(null)
        setPosicao(null)
      },
      onClick: (e: React.MouseEvent) => {
        e.stopPropagation()
        setDestacados((atual) => {
          const proximo = new Set(atual)
          if (proximo.has(chave)) proximo.delete(chave)
          else proximo.add(chave)
          return proximo
        })
      },
      style: { cursor: 'pointer' as const },
    }),
    [],
  )

  return {
    dica,
    posicao,
    destacados,
    estaDestacado: (chave: string) => destacados.has(chave),
    temDestaque: destacados.size > 0,
    props,
    limpar,
  }
}

/**
 * O balão. Fica no `body` por `fixed`, para não ser cortado pelo `overflow` do cartão do
 * bloco — o container da conversa rola, e um balão absoluto dentro dele sairia pela borda.
 */
export function Balao({ dica, posicao }: { dica: Dica | null; posicao: { x: number; y: number } | null }) {
  const caixa = useRef<HTMLDivElement>(null)
  const [ajuste, setAjuste] = useState({ x: 0, y: 0 })

  useEffect(() => {
    const el = caixa.current
    if (!el || !posicao) return
    const r = el.getBoundingClientRect()
    // Vira para a esquerda/cima quando não cabe: sem isto o balão sai da janela nos
    // elementos da ponta direita, que é justamente onde mais se passa o mouse.
    const x = posicao.x + 14 + r.width > window.innerWidth ? -r.width - 14 : 14
    const y = posicao.y + 14 + r.height > window.innerHeight ? -r.height - 14 : 14
    setAjuste({ x, y })
  }, [posicao, dica])

  if (!dica || !posicao) return null

  // **Portal pro `body`, e não pro lugar da árvore.** O `#root` tem `zoom`
  // (`index.css`, `--koda-zoom`), e `zoom` quebra `position: fixed`: as coordenadas
  // `left/top` (pixels de viewport) ficam escaladas pelo zoom do ancestral, e o balão
  // aparece longe do mouse — às vezes até fora do container. Renderizar direto no
  // `body` tira o balão do contexto de zoom, e o `fixed` volta a ser relativo à janela
  // de verdade. (Afetava o balão dos gráficos do Koda e da UI generativa.)
  return createPortal(
    <div
      ref={caixa}
      className="pointer-events-none fixed z-50 max-w-[260px] rounded-lg border border-koda-fg/15 bg-koda-surface px-2.5 py-1.5 shadow-[0_8px_24px_-8px_var(--koda-shadow)]"
      style={{ left: posicao.x + ajuste.x, top: posicao.y + ajuste.y }}
      role="tooltip"
    >
      <div className="flex items-center gap-1.5">
        {dica.cor ? (
          <span className={`${dica.cor} h-2 w-2 shrink-0 rounded-sm bg-current`} />
        ) : null}
        <span className="text-[12.5px] font-medium text-koda-fg">{dica.titulo}</span>
      </div>
      {dica.valor ? (
        <p className="mt-0.5 font-mono text-[12px] text-koda-accent">{dica.valor}</p>
      ) : null}
      {dica.detalhe ? (
        <p className="mt-0.5 text-[11.5px] text-koda-fg/55">{dica.detalhe}</p>
      ) : null}
    </div>,
    document.body,
  )
}

/**
 * O botão de limpar, que só aparece quando há algo destacado.
 *
 * Sem ele o destaque é uma armadilha: a pessoa clica, tudo apaga em volta, e ela não sabe
 * como voltar. `Esc` funciona, mas ninguém adivinha — o botão é o caminho visível.
 */
export function LimparDestaque({ interacao }: { interacao: Interacao }) {
  if (!interacao.temDestaque) return null
  return (
    <button
      type="button"
      onClick={interacao.limpar}
      className="self-start rounded-md px-2 py-0.5 text-[11.5px] text-koda-fg/50 transition-colors hover:bg-koda-fg/8 hover:text-koda-fg/80"
    >
      limpar seleção ({interacao.destacados.size})
    </button>
  )
}

/**
 * O tom de cada série, em ciclo.
 *
 * Sai das variáveis do tema por um motivo prático: a IA não escolhe cor, e o gráfico
 * precisa funcionar no claro e no escuro sem ninguém ajustar nada. A ordem é de contraste
 * decrescente — as primeiras séries são as que mais aparecem, e são as mais legíveis.
 */
export const TONS = [
  'text-koda-accent',
  'text-sky-400',
  'text-emerald-400',
  'text-amber-400',
  'text-rose-400',
  'text-violet-400',
  'text-teal-400',
  'text-orange-400',
] as const

export const tom = (i: number) => TONS[i % TONS.length]

/** Opacidade do elemento quando há outro destacado: some sem sumir do lugar. */
export const apagado = (interacao: Interacao, chave: string) =>
  interacao.temDestaque && !interacao.estaDestacado(chave)
