const CHAVE = 'koda.modelos-bloqueados'

type Registro = { conta: string; modelos: string[] }

/** O recorte do painel é por conta e sobrevive à abertura antes da próxima consulta. */
export function lerModelosBloqueados(conta: string | undefined): string[] {
  if (!conta) return []
  try {
    const valor = JSON.parse(window.localStorage.getItem(CHAVE) ?? 'null') as Registro | null
    return valor?.conta === conta && Array.isArray(valor.modelos)
      ? valor.modelos.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

export function guardarModelosBloqueados(conta: string | undefined, modelos: string[]): void {
  if (!conta) return
  try {
    window.localStorage.setItem(CHAVE, JSON.stringify({ conta, modelos }))
  } catch {
    // A resposta do painel ainda vale nesta execução.
  }
}
