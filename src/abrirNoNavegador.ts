/**
 * Abre um endereço no navegador do sistema.
 *
 * Dentro do app empacotado, `window.open` não sai do webview: no Linux (WebKitGTK) ele
 * simplesmente não abre nada, e no Windows abre uma janela do próprio Tauri. O login dos
 * provedores precisa do navegador de verdade — é lá que a pessoa já tem a sessão do
 * provedor (Google, OpenAI, …), e é ele que consegue voltar para o callback local que o
 * backend está escutando. Por isso o pedido passa pelo plugin `opener`, que chama o
 * navegador padrão do sistema.
 *
 * No navegador (desenvolvimento com o Vite) o `window.open` continua valendo: ali o
 * próprio navegador é o destino.
 */
import { isTauri } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'

export function abrirNoNavegador(url: string): void {
  if (!isTauri()) {
    window.open(url, '_blank', 'noopener,noreferrer')
    return
  }
  // O plugin responde por `invoke`; se ele não estiver no build (app antigo), o link que
  // a tela já mostra continua sendo a saída — por isso o fallback em vez de sumir.
  void openUrl(url).catch(() => {
    window.open(url, '_blank', 'noopener,noreferrer')
  })
}
