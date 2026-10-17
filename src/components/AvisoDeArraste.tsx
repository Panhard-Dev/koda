import { useEffect, useRef } from 'react'
import { FilePlus2, ImagePlus, Paperclip } from 'lucide-react'

/**
 * O aviso de «arraste o arquivo para cá», desenhado **por cima do prompt box**.
 *
 * ## Por que dentro da caixa, e não na tela toda
 *
 * O padrão da web é o overlay de tela cheia: uma camada escura cobrindo tudo, com o aviso
 * no meio. Aqui não: quem arrasta um arquivo está mirando **a caixa** — é ali que o anexo
 * vai parar —, e escurecer a conversa inteira esconde justamente o contexto que a pessoa
 * estava lendo. O aviso mora dentro da silhueta do Composer, que é onde o arquivo cai.
 *
 * ## A forma é a da caixa, não um retângulo
 *
 * A caixa do Koda não é um retângulo: tem uma **aba** em cima à esquerda (onde ficam a
 * moeda e o cronômetro), uma **rampa** na diagonal e um corpo com cantos arredondados. Um
 * `rounded-2xl` por cima disso deixa os cantos vazando pela forma — aparece como um
 * retângulo torto dentro da silhueta. Aqui o realce é desenhado com o **mesmo path** do
 * Composer, recalculado pelo mesmo `ResizeObserver`, então ele encaixa exatamente.
 *
 * ## As três peças
 *
 * Ícone, título e o limite real do anexo. O limite **não é decorativo**: é a mesma régua
 * que o backend aplica (`MAX_BYTES` em `app/anexos.py`, 32 MB), dita antes de a pessoa
 * tentar e levar o erro. Um "até 20 imagens, 20 MB" de enfeite seria mentira em dois
 * números de uma vez.
 *
 * O `pointer-events-none` é o que faz isto ser aviso e não parede: os eventos de arraste
 * continuam chegando em quem escuta (o `div` do Composer), senão o próprio overlay
 * interceptaria o `drop` e o arquivo nunca cairia.
 */

/** Vários arquivos, do código ao PDF: é o caso comum do Koda. */
const ACEITA = 'código, texto, PDF, imagem e vídeo'

/** As mesmas medidas do path do Composer — a silhueta é uma só. */
const ALTURA_DA_ABA = 34
const RAIO = 22
const RAIO_DA_ABA = 14
const RAMPA = 16

export function AvisoDeArraste({ limiteMb = 32 }: { limiteMb?: number }) {
  const caixaRef = useRef<SVGSVGElement>(null)
  const pathRef = useRef<SVGPathElement>(null)

  // O mesmo desenho do Composer, para o realce ter a forma da caixa e não a de um
  // retângulo. A aba é medida no elemento real (`.pt-\[40px\] > div:first-of-type`), que
  // é quem carrega a largura do cronômetro.
  useEffect(() => {
    const svg = caixaRef.current
    const path = pathRef.current
    const host = svg?.parentElement?.parentElement
    if (!svg || !path || !host) return

    const desenhar = () => {
      const W = host.clientWidth
      const H = host.clientHeight
      const aba = host.querySelector<HTMLElement>('[data-aba]')
      const larguraDaAba = (aba?.scrollWidth ?? 96) + 2
      const n = (v: number) => +v.toFixed(1)
      path.setAttribute(
        'd',
        [
          `M0.5 ${n(H - RAIO)}`,
          `L0.5 ${RAIO_DA_ABA}`,
          `Q0.5 0.5 ${RAIO_DA_ABA} 0.5`,
          `L${n(larguraDaAba)} 0.5`,
          `L${n(larguraDaAba + RAMPA)} ${ALTURA_DA_ABA}`,
          `L${n(W - RAIO)} ${ALTURA_DA_ABA}`,
          `Q${W - 0.5} ${ALTURA_DA_ABA} ${W - 0.5} ${ALTURA_DA_ABA + RAIO}`,
          `L${W - 0.5} ${n(H - RAIO)}`,
          `Q${W - 0.5} ${H - 0.5} ${n(W - RAIO)} ${H - 0.5}`,
          `L${RAIO} ${H - 0.5}`,
          `Q0.5 ${H - 0.5} 0.5 ${n(H - RAIO)}`,
          'Z',
        ].join(' '),
      )
    }
    desenhar()
    const observador = new ResizeObserver(desenhar)
    observador.observe(host)
    return () => observador.disconnect()
  }, [])

  return (
    <div
      className="pointer-events-none absolute inset-0 z-20"
      role="status"
      aria-live="polite"
    >
      {/* O realce: o mesmo path da caixa, preenchido. O `-z-10` não serve aqui — este
          desenho precisa ficar **na frente** do conteúdo, e o `z-20` do pai garante isso. */}
      <svg
        ref={caixaRef}
        className="absolute inset-0 h-full w-full overflow-visible"
        aria-hidden="true"
      >
        <path ref={pathRef} className="fill-koda-input/95 stroke-koda-accent/40" strokeWidth={1.5} />
      </svg>

      {/* O conteúdo, centralizado **no corpo** da caixa (abaixo da aba de 34px). */}
      <div className="absolute inset-x-0 top-[34px] bottom-0 flex flex-col items-center justify-center gap-1.5">
        {/* Os três ícones empilhados, como na referência: uma pilha de tipos de arquivo, e
            não um ícone só. Dizem "qualquer arquivo" sem precisar de legenda. */}
        <div className="relative mb-1 h-11 w-14">
          <span className="absolute top-0 left-0 flex h-8 w-8 -rotate-12 items-center justify-center rounded-lg bg-koda-accent/30 ring-1 ring-koda-accent/40">
            <ImagePlus className="h-4 w-4 text-koda-accent" strokeWidth={2} />
          </span>
          <span className="absolute top-0.5 right-0 flex h-8 w-8 rotate-12 items-center justify-center rounded-lg bg-koda-accent/30 ring-1 ring-koda-accent/40">
            <FilePlus2 className="h-4 w-4 text-koda-accent" strokeWidth={2} />
          </span>
          <span className="absolute bottom-0 left-1/2 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-lg bg-koda-accent shadow-lg">
            <Paperclip className="h-4 w-4 text-koda-input" strokeWidth={2.3} />
          </span>
        </div>

        <p className="text-[15px] font-semibold text-koda-fg">
          Arraste os arquivos para cá
        </p>
        <p className="text-[12px] text-koda-fg/70">
          {ACEITA} · até {limiteMb} MB por arquivo
        </p>
      </div>
    </div>
  )
}

export default AvisoDeArraste
