/**
 * Datas e janelas do uso.
 *
 * Aqui morava também o `PLAN` com os tetos de mensagens (20/dia, 100/semana, 300/mês). Ele saiu
 * quando a tela de Uso passou a mostrar **tempo gasto e créditos**, sem comparar com teto — e
 * teto de mensagens que não é o que se cobra é um número que confunde mais do que informa.
 */

/** Data local em `AAAA-MM-DD`, para o fuso do usuário — `toISOString` seria UTC. */
export const dayKey = (date: Date) =>
  [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')

const short = (date: Date) => date.toLocaleDateString('pt-BR')

/** Hoje às 00:00 — o começo da janela diária. */
export const dayStart = (date = new Date()) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate())

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
