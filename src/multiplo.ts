/**
 * O multiplicador de uso de um modelo, no padrão da interface.
 *
 * O Accio publica o número como `usage_multiple` (0.03, 3.5, …): quantos créditos o modelo
 * consome por uso. A interface é pt-BR e a régua de tempo já usa vírgula; aqui não é
 * diferente — «0,03x», «3,5x». `null` quando o provedor não informa o multiplicador.
 */
export function textoDoMultiplo(valor: number | null | undefined): string | null {
  // Zero não é «de graça»: é o `auto` do Accio, que não tem multiplicador próprio. O app
  // do Accio também não desenha o selo nesse caso.
  if (typeof valor !== 'number' || !Number.isFinite(valor) || valor <= 0) return null
  const numero = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(valor)
  return `${numero}x`
}

/**
 * A cor do selo, na mesma lógica do app do Accio: caro acima de 1,5x, barato abaixo de 0,2x,
 * e neutro no meio. É o que deixa o multiplicador legível de relance numa lista de 42.
 */
export function tomDoMultiplo(valor: number | null | undefined): 'caro' | 'barato' | 'neutro' {
  if (typeof valor !== 'number' || !Number.isFinite(valor)) return 'neutro'
  if (valor >= 1.5) return 'caro'
  if (valor < 0.2) return 'barato'
  return 'neutro'
}
