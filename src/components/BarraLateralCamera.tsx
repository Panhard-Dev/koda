import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { EditorDeVideo } from './EditorDeVideo'

/**
 * A segunda barra lateral — a que o botão da câmera abre.
 *
 * É uma sobreposição **irmã** da `PainelLateral`: mesma casca (fundo, borda, X, Esc e
 * clique fora para fechar) e **do mesmo lado** — abre em `left-0`, ocupando a metade
 * esquerda da janela, exatamente onde a outra abre. Fica no mesmo `z-[60]` da primeira;
 * com as duas abertas, esta fica por cima (é a última da pilha), e fechar ela revela a
 * primeira de novo.
 *
 * A largura é `w-4/5`, e é pedido medida: o compositor da conversa é `max-w-3xl` (768px)
 * centralizado, e o pedido foi que a barra o tampe **todo** — `w-1/2` deixava o canto
 * direito dele de fora em janela estreita.
 *
 * Por dentro ela é **vazia de propósito**: o dono pediu só o X. O conteúdo vem quando ele
 * disser o que esta barra mostra.
 */
export function BarraLateralCamera({
  aberto,
  onFechar,
}: {
  aberto: boolean
  onFechar: () => void
}) {
  const caixa = useRef<HTMLElement>(null)

  // O `onFechar` que o App manda é uma função nova a cada render. Guardar numa ref mantém
  // o efeito preso só ao `aberto` — sem isso o ouvinte seria desmontado e remontado a
  // cada render da tela inteira.
  const fecharRef = useRef(onFechar)
  useEffect(() => {
    fecharRef.current = onFechar
  }, [onFechar])

  useEffect(() => {
    if (!aberto) return

    const aoTeclar = (evento: KeyboardEvent) => {
      if (evento.key === 'Escape') fecharRef.current()
    }
    const aoApontar = (evento: PointerEvent) => {
      const alvo = evento.target as Node | null
      if (!alvo || !caixa.current?.contains(alvo)) fecharRef.current()
    }

    window.addEventListener('keydown', aoTeclar)
    // O `setTimeout(0)` é o que impede o clique que **abriu** a barra de chegar aqui e
    // fechá-la no mesmo instante: o ouvinte só passa a existir depois que aquele evento
    // terminou de propagar.
    const id = window.setTimeout(() => {
      document.addEventListener('pointerdown', aoApontar, true)
    }, 0)

    return () => {
      window.clearTimeout(id)
      window.removeEventListener('keydown', aoTeclar)
      document.removeEventListener('pointerdown', aoApontar, true)
    }
  }, [aberto])

  // **Não desmonta ao fechar** — só esconde (`hidden`). Desmontar custava o estado
  // inteiro do editor: o vídeo saía (a URL de objeto era revogada no cleanup), os
  // frames e a transcrição — minutos de CPU — tinham de ser refeitos. Escondido, o
  // `<video>` pausa (o `EditorDeVideo` faz isso quando `aberto` vira false) e reabrir
  // devolve tudo do mesmo ponto.

  return (
    <aside
      ref={caixa}
      aria-label="Barra lateral da câmera"
      className={[
        'painel-in fixed inset-y-0 left-0 z-[60] flex w-4/5 flex-col',
        'border-r border-koda-fg/10 bg-koda-surface shadow-[0_0_44px_rgba(0,0,0,0.45)]',
        aberto ? '' : 'hidden',
      ].join(' ')}
    >
      <div className="flex h-14 shrink-0 items-center justify-end border-b border-koda-fg/10 px-3">
        <button
          type="button"
          aria-label="Fechar barra lateral"
          title="Fechar barra lateral"
          onClick={() => fecharRef.current()}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-koda-fg/55 transition-colors duration-150 hover:bg-koda-fg/10 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
        >
          <X className="h-4 w-4" strokeWidth={1.8} />
        </button>
      </div>

      <EditorDeVideo aberto={aberto} />
    </aside>
  )
}

export default BarraLateralCamera
