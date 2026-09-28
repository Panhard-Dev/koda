import { useEffect } from 'react'
import { Minus, Square, X } from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'

/**
 * Rodando dentro do app Tauri? O webview dele expõe `__TAURI_INTERNALS__`;
 * no navegador (Vite puro) não — e aí os controles de janela nem existem.
 */
export const DENTRO_DO_TAURI =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

const BOTAO_CLASSE = [
  'flex h-8 w-10 items-center justify-center rounded-lg',
  'text-koda-fg/55 transition-colors duration-150 focus-visible:outline-none',
].join(' ')

/**
 * Atalhos de janela que o Windows espera e o webview não dá de graça.
 *
 * O **F11** é o caso: a janela é `decorations: false`, então não há barra de título nem
 * menu do sistema para tratar tela cheia — sem este gancho, a tecla não fazia nada. Usa o
 * fullscreen **do Tauri** (e não o do navegador): a janela inteira vira tela cheia, sem
 * sobrar faixa e sem perder os controles de janela quando volta.
 *
 * Chamar **uma vez** no App: cada `<WindowControls />` é só desenho, e quatro listeners
 * para a mesma tecla seria quatro vezes o mesmo trabalho.
 */
export function useAtalhosDaJanela() {
  useEffect(() => {
    if (!DENTRO_DO_TAURI) return
    const aoTeclar = (evento: KeyboardEvent) => {
      if (evento.key !== 'F11') return
      evento.preventDefault()
      const janela = getCurrentWindow()
      void janela.isFullscreen().then((cheia) => janela.setFullscreen(!cheia))
    }
    window.addEventListener('keydown', aoTeclar)
    return () => window.removeEventListener('keydown', aoTeclar)
  }, [])
}

/**
 * Botões da titlebar customizada (minimizar / maximizar / fechar), no padrão do
 * Windows. Só renderiza algo dentro do Tauri — no navegador devolve `null`.
 */
export function WindowControls() {
  if (!DENTRO_DO_TAURI) return null
  const janela = getCurrentWindow()

  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        title="Minimizar"
        aria-label="Minimizar"
        onClick={() => void janela.minimize()}
        className={`${BOTAO_CLASSE} hover:bg-koda-fg/10 hover:text-koda-fg`}
      >
        <Minus className="h-4 w-4" strokeWidth={1.8} />
      </button>
      <button
        type="button"
        title="Maximizar ou restaurar"
        aria-label="Maximizar ou restaurar"
        onClick={() => void janela.toggleMaximize()}
        className={`${BOTAO_CLASSE} hover:bg-koda-fg/10 hover:text-koda-fg`}
      >
        <Square className="h-[11px] w-[11px]" strokeWidth={2} />
      </button>
      <button
        type="button"
        title="Fechar"
        aria-label="Fechar"
        onClick={() => void janela.close()}
        className={`${BOTAO_CLASSE} hover:bg-red-500/85 hover:text-white`}
      >
        <X className="h-4 w-4" strokeWidth={1.8} />
      </button>
    </div>
  )
}

export default WindowControls
