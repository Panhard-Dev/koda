export type StatusAssinatura = 'pendente' | 'ativa' | 'atrasada' | 'cancelada';

export interface SubscriptionRow {
  id: string;
  user_id: string;
  plan_id: string;
  status: StatusAssinatura;
  mp_preapproval_id: string | null;
  iniciada_em: string | null;
  renova_em: string | null;
  cancelada_em: string | null;
  created_at: string;
  updated_at: string;
}

/** A assinatura viva da conta — ou `null` se ela nunca assinou nada. */
export async function buscarViva(db: D1Database, userId: string): Promise<SubscriptionRow | null> {
  return db
    .prepare(
      `SELECT * FROM subscriptions
        WHERE user_id = ? AND status IN ('pendente', 'ativa', 'atrasada')
        ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(userId)
    .first<SubscriptionRow>();
}

/**
 * Garante a assinatura **pendente** da conta para este plano.
 *
 * É o primeiro passo de uma cobrança: antes de existir pagamento, a conta já
 * precisa ter dito qual plano está tentando assinar. Se já houver uma viva, ela
 * é reaproveitada — duas assinaturas vivas para a mesma conta é o estado que o
 * índice parcial do banco proíbe, e criar aqui estouraria o INSERT.
 */
export async function garantirPendente(
  db: D1Database,
  dados: { id: string; userId: string; planId: string; agora: string },
): Promise<SubscriptionRow> {
  const viva = await buscarViva(db, dados.userId);
  if (viva) return viva;

  return db
    .prepare(
      `INSERT INTO subscriptions (id, user_id, plan_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'pendente', ?, ?)
       RETURNING *`,
    )
    .bind(dados.id, dados.userId, dados.planId, dados.agora, dados.agora)
    .first<SubscriptionRow>() as Promise<SubscriptionRow>;
}

/**
 * Ativa (ou renova) a assinatura depois de um pagamento aprovado.
 *
 * `iniciada_em` só é escrito na **primeira** vez: renovar não é começar de
 * novo, e reescrever a data faria a tela dizer que a pessoa assinou hoje toda
 * vez que ela pagasse mais um mês.
 */
export async function ativar(
  db: D1Database,
  dados: { userId: string; planId: string; agora: string; renovaEm: string },
): Promise<SubscriptionRow | null> {
  const viva = await buscarViva(db, dados.userId);
  if (!viva) return null;

  return db
    .prepare(
      `UPDATE subscriptions
          SET plan_id = ?, status = 'ativa',
              iniciada_em = COALESCE(iniciada_em, ?),
              renova_em = ?, cancelada_em = NULL, updated_at = ?
        WHERE id = ?
        RETURNING *`,
    )
    .bind(dados.planId, dados.agora, dados.renovaEm, dados.agora, viva.id)
    .first<SubscriptionRow>();
}

/** Encerra a assinatura viva da conta. Sem `user_id` não há o que encerrar. */
export async function cancelar(db: D1Database, userId: string, agora: string): Promise<SubscriptionRow | null> {
  return db
    .prepare(
      `UPDATE subscriptions
          SET status = 'cancelada', cancelada_em = ?, updated_at = ?
        WHERE user_id = ? AND status IN ('pendente', 'ativa', 'atrasada')
        RETURNING *`,
    )
    .bind(agora, agora, userId)
    .first<SubscriptionRow>();
}

/**
 * Põe o plano **em vigor** na assinatura viva da conta.
 *
 * Não é só trocar o `plan_id`. Uma assinatura pode estar viva e **`pendente`** — é o que sobra
 * de um checkout que começou e não foi pago —, e o app só considera o plano em vigor com status
 * `ativa`/`atrasada` (`assinaturaVale`, em `src/api/cloud.ts`). Trocar só o plano deixaria o
 * painel dizendo «Koda Pro» e o app dizendo «Plano Free» — o defeito que apareceu no teste do
 * dono. Quem dá o plano por aqui é o admin, então ele entra **valendo**: o status vira `ativa`.
 *
 * As datas só são preenchidas quando **faltam** (`COALESCE`): numa assinatura que já era
 * `ativa`, quem manda em `iniciada_em`/`renova_em` é a cobrança, e reescrevê-las faria a tela
 * dizer que a conta renovou por causa de um clique no painel.
 */
export async function definirPlano(
  db: D1Database,
  dados: { userId: string; planId: string; agora: string; renovaEm: string },
): Promise<SubscriptionRow | null> {
  return db
    .prepare(
      `UPDATE subscriptions
          SET plan_id = ?, status = 'ativa',
              iniciada_em = COALESCE(iniciada_em, ?),
              renova_em = COALESCE(renova_em, ?),
              cancelada_em = NULL, updated_at = ?
        WHERE user_id = ? AND status IN ('pendente', 'ativa', 'atrasada')
        RETURNING *`,
    )
    .bind(dados.planId, dados.agora, dados.renovaEm, dados.agora, dados.userId)
    .first<SubscriptionRow>();
}

/**
 * Dá uma assinatura **ativa** à conta — o caso de quem estava no Free.
 *
 * Não passa por `garantirPendente` de propósito: ali não existe cobrança para esperar, e uma
 * assinatura `pendente` faria o app mostrar um plano que ainda não valeu. O `renova_em` sai um
 * mês à frente porque a tela mostra a data de renovação, e conta ativa sem data mostraria "—".
 */
export async function criarAtiva(
  db: D1Database,
  dados: { id: string; userId: string; planId: string; agora: string; renovaEm: string },
): Promise<SubscriptionRow> {
  return db
    .prepare(
      `INSERT INTO subscriptions (id, user_id, plan_id, status, iniciada_em, renova_em, created_at, updated_at)
       VALUES (?, ?, ?, 'ativa', ?, ?, ?, ?)
       RETURNING *`,
    )
    .bind(dados.id, dados.userId, dados.planId, dados.agora, dados.renovaEm, dados.agora, dados.agora)
    .first<SubscriptionRow>() as Promise<SubscriptionRow>;
}
