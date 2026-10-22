/**
 * O saldo de crédito comprado avulso.
 *
 * ## Por que uma linha por compra, e não um número
 *
 * O crédito avulso **vence** (90 dias). Um saldo único não guarda a data de cada entrada, e sem
 * a data não há como vencer nada — o saldo só cresceria. Cada compra vira uma linha com a sua
 * validade, e o saldo é a soma das que ainda não venceram.
 *
 * ## A restrição que impede crédito de graça
 *
 * `payment_id` é UNIQUE. O Mercado Pago reenvia a notificação até receber 200, e sem essa
 * restrição uma repetição creditaria a mesma compra duas vezes. Aqui, a segunda tentativa
 * simplesmente não insere — e a rota não precisa saber que houve repetição.
 */
export interface CreditGrantRow {
  id: string;
  user_id: string;
  creditos: number;
  payment_id: string | null;
  expira_em: string;
  created_at: string;
}

/**
 * Credita uma compra. **Idempotente por construção:** se já existe crédito para este pagamento,
 * não faz nada e devolve `false`.
 *
 * O `INSERT OR IGNORE` conta com o UNIQUE de `payment_id` — é ele que faz a repetição do webhook
 * virar uma linha só. Devolver `false` deixa quem chama saber que não houve crédito novo.
 */
export async function conceder(
  db: D1Database,
  dados: {
    id: string;
    userId: string;
    creditos: number;
    paymentId: string;
    expiraEm: string;
    agora: string;
  },
): Promise<boolean> {
  const resultado = await db
    .prepare(
      `INSERT OR IGNORE INTO credit_grants
         (id, user_id, creditos, payment_id, expira_em, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(dados.id, dados.userId, dados.creditos, dados.paymentId, dados.expiraEm, dados.agora)
    .run();
  return (resultado.meta.changes ?? 0) > 0;
}

/**
 * Credita **à mão**, pelo painel — sem cobrança por trás.
 *
 * `payment_id` fica `NULL` de propósito: a coluna é a amarração com a cobrança do Mercado Pago,
 * e um crédito dado pelo admin não tem uma. O `UNIQUE` dela não atrapalha — no SQLite (e no D1)
 * valores nulos não colidem entre si, então cada concessão manual é uma linha nova, que é o que
 * se quer: o crédito dado hoje e o dado amanhã têm validades diferentes.
 *
 * Não é idempotente (não há `INSERT OR IGNORE`): cada clique no painel é uma concessão. Quem
 * responde por isso é a auditoria, que grava quem deu, quanto e por quê.
 */
export async function concederManual(
  db: D1Database,
  dados: { id: string; userId: string; creditos: number; expiraEm: string; agora: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO credit_grants (id, user_id, creditos, payment_id, expira_em, created_at)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    )
    .bind(dados.id, dados.userId, dados.creditos, dados.expiraEm, dados.agora)
    .run();
}

/**
 * O saldo em vigor: a soma das compras ainda não vencidas.
 *
 * A comparação é de strings ISO, que ordenam igual a datas — o mesmo formato que o resto do
 * projeto usa para guardar data em texto. Compra vencida **não** entra: é o que faz a validade
 * de 90 dias valer alguma coisa.
 */
export async function saldoDe(db: D1Database, userId: string, agora: string): Promise<number> {
  const linha = await db
    .prepare(
      `SELECT COALESCE(SUM(creditos), 0) AS saldo
         FROM credit_grants
        WHERE user_id = ? AND expira_em > ?`,
    )
    .bind(userId, agora)
    .first<{ saldo: number | null }>();
  return Number(linha?.saldo ?? 0);
}

/** O que vence nos próximos dias — a tela usa para avisar antes de perder crédito. */
export async function vencendoEm(
  db: D1Database,
  userId: string,
  agora: string,
): Promise<{ creditos: number; expira_em: string } | null> {
  const linha = await db
    .prepare(
      `SELECT creditos, expira_em
         FROM credit_grants
        WHERE user_id = ? AND expira_em > ?
        ORDER BY expira_em ASC
        LIMIT 1`,
    )
    .bind(userId, agora)
    .first<{ creditos: number; expira_em: string }>();
  return linha ?? null;
}
