export interface UserModelRow {
  user_id: string;
  model_id: string;
  enabled: number;
  granted_by: string | null;
  granted_at: string;
}

export interface ExcecaoRow extends UserModelRow {
  email: string;
  status: string;
  display_name: string | null;
}

/** Liga/desliga um modelo para UM usuário (UPSERT: cria a exceção se não houver). */
export async function definir(
  db: D1Database,
  dados: { userId: string; modelId: string; enabled: boolean; autorId: string | null; agora: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO user_models (user_id, model_id, enabled, granted_by, granted_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, model_id) DO UPDATE SET
         enabled = excluded.enabled,
         granted_by = excluded.granted_by,
         granted_at = excluded.granted_at`,
    )
    .bind(dados.userId, dados.modelId, dados.enabled ? 1 : 0, dados.autorId, dados.agora)
    .run();
}

export async function buscar(db: D1Database, userId: string, modelId: string): Promise<UserModelRow | null> {
  return db
    .prepare('SELECT * FROM user_models WHERE user_id = ? AND model_id = ?')
    .bind(userId, modelId)
    .first<UserModelRow>();
}

export async function listarPorUsuario(db: D1Database, userId: string): Promise<UserModelRow[]> {
  const resultado = await db.prepare('SELECT * FROM user_models WHERE user_id = ?').bind(userId).all<UserModelRow>();
  return resultado.results ?? [];
}

export async function listarPorModelo(db: D1Database, modelId: string, limite = 200): Promise<ExcecaoRow[]> {
  const resultado = await db
    .prepare(
      `SELECT um.*, u.email, u.status, u.display_name
         FROM user_models um
         JOIN users u ON u.id = um.user_id
        WHERE um.model_id = ?
        ORDER BY um.granted_at DESC
        LIMIT ?`,
    )
    .bind(modelId, limite)
    .all<ExcecaoRow>();
  return resultado.results ?? [];
}

export async function remover(db: D1Database, userId: string, modelId: string): Promise<void> {
  await db.prepare('DELETE FROM user_models WHERE user_id = ? AND model_id = ?').bind(userId, modelId).run();
}

export async function removerPorModelo(db: D1Database, modelId: string): Promise<void> {
  await db.prepare('DELETE FROM user_models WHERE model_id = ?').bind(modelId).run();
}

export async function contarExcecoes(db: D1Database): Promise<number> {
  const linha = await db.prepare('SELECT COUNT(*) AS total FROM user_models').first<{ total: number }>();
  return Number(linha?.total ?? 0);
}
