/** Limites do plano Free nesta build. Nada é cobrado: servem de régua para a tela de uso. */
export const PLAN = {
  name: 'Free',
  dailyMessages: 20,
  weeklyMessages: 100,
  monthlyMessages: 300,
}

/** Data local em `AAAA-MM-DD`, para o fuso do usuário — `toISOString` seria UTC. */
export const dayKey = (date: Date) =>
  [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')

const short = (date: Date) => date.toLocaleDateString('pt-BR')

/** Segunda-feira 00:00 da semana da data dada. */
export const weekStart = (date = new Date()) => {
  const start = new Date(date)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
  return start
}

/** Dia 1º do mês da data dada, à meia-noite. */
export const monthStart = (date = new Date()) =>
  new Date(date.getFullYear(), date.getMonth(), 1)

/** Amanhã: quando a cota diária volta. */
export const dailyReset = (date = new Date()) =>
  short(new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1))

/** Próxima segunda: quando a cota semanal volta. */
export const weeklyReset = (date = new Date()) => {
  const next = weekStart(date)
  next.setDate(next.getDate() + 7)
  return short(next)
}

/** Dia 1º do mês seguinte: quando a cota mensal volta. */
export const monthlyReset = (date = new Date()) =>
  short(new Date(date.getFullYear(), date.getMonth() + 1, 1))

/** Porcentagem usada, limitada a 100 — igual à barra do print. */
export const percentUsed = (used: number, limit: number) =>
  Math.min(100, limit === 0 ? 0 : (used / limit) * 100)

export const remaining = (used: number, limit: number) => Math.max(0, limit - used)
