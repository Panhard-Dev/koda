/** Utilidades pequenas compartilhadas pelo renderer e pelos componentes extras. */

export function formatarValor(valor: unknown): string {
  if (valor === null || valor === undefined) return ''
  if (typeof valor === 'object') {
    try {
      return JSON.stringify(valor)
    } catch {
      return ''
    }
  }
  return String(valor)
}

export async function copiar(texto: string): Promise<boolean> {
  if (!texto) return false
  try {
    await navigator.clipboard.writeText(texto)
    return true
  } catch {
    try {
      const area = document.createElement('textarea')
      area.value = texto
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(area)
      return ok
    } catch {
      return false
    }
  }
}

export function baixarTexto(nome: string, texto: string, tipo = 'text/plain;charset=utf-8') {
  const blob = new Blob([texto], { type: tipo })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = nome
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 4000)
}
