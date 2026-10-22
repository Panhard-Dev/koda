/**
 * Datas de cobrança.
 *
 * O JavaScript soma mês por índice e deixa o excesso transbordar: `31/01` mais
 * um mês vira `03/03` (31 de fevereiro não existe, então ele anda três dias).
 * Quem assina no dia 31 passaria a ser cobrado em março — e o mês seguinte
 * seria o dia 3. O jeito certo é mirar no mês seguinte e **cortar no último dia
 * dele**, que é a regra que todo mundo espera de uma assinatura mensal.
 */
export function maisUmMes(iso: string): string {
  const origem = new Date(iso);
  if (Number.isNaN(origem.getTime())) throw new Error(`data invalida: ${iso}`);

  const dia = origem.getUTCDate();
  const primeiroDoMesSeguinte = new Date(
    Date.UTC(
      origem.getUTCFullYear(),
      origem.getUTCMonth() + 1,
      1,
      origem.getUTCHours(),
      origem.getUTCMinutes(),
      origem.getUTCSeconds(),
      origem.getUTCMilliseconds(),
    ),
  );
  // Dia 0 do mês seguinte ao alvo = último dia do mês do alvo.
  const ultimoDia = new Date(
    Date.UTC(primeiroDoMesSeguinte.getUTCFullYear(), primeiroDoMesSeguinte.getUTCMonth() + 1, 0),
  ).getUTCDate();

  primeiroDoMesSeguinte.setUTCDate(Math.min(dia, ultimoDia));
  return primeiroDoMesSeguinte.toISOString();
}

/**
 * Daqui a N dias, mantendo a hora.
 *
 * É soma de dias de calendário, e não de 24 horas multiplicadas: o fuso do Brasil não tem
 * horário de verão desde 2019, mas escrever `+ 7 * 24 * 60 * 60 * 1000` deixaria o prazo
 * escorregando uma hora por dia em qualquer lugar que ainda tenha. `setUTCDate` não erra isso.
 */
export function maisDias(iso: string, dias: number): string {
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) throw new Error(`data invalida: ${iso}`);
  data.setUTCDate(data.getUTCDate() + dias);
  return data.toISOString();
}
