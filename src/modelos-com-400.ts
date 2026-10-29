import type { RemoteModel } from './models'

const CHAVE = 'koda.modelos-com-400'

/** Guarda recusas confirmadas para que uma falha posterior do catálogo não ressuscite o modelo. */
export function lerModelosCom400(): string[] {
  // A sonda antiga confundia 400 de pedido inválido com modelo inexistente.
  // A lista persistida pode conter falsos positivos; o catálogo do host é a fonte atual.
  try { window.localStorage.removeItem(CHAVE) } catch { /* armazenamento indisponível */ }
  return []
}

/** Só uma resposta 200 do próprio modelo desfaz uma recusa 400 anterior. */
export function atualizarModelosCom400(modelos: readonly RemoteModel[]): string[] {
  void modelos
  return lerModelosCom400()
}
