export interface RefreshRow {
  id: string;
  subject_type: 'admin' | 'user';
  subject_id: string;
  token_hash: string;
  family_id: string;
  expires_at: string;
  revoked_at: string | null;
  replaced_by: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

export async function criar(
  db: D1Database,
  dados: {
    id: string;
    subjectType: 'admin' | 'user';
    subjectId: string;
    tokenHash: string;
    familyId: string;
    expiraEm: string;
    ip: string | null;
    userAgent: string | null;
    agora: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO refresh_tokens (id, subject_type, subject_id, token_hash, family_id, expires_at, ip, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      dados.id,
      dados.subjectType,
      dados.subjectId,
      dados.tokenHash,
      dados.familyId,
      dados.expiraEm,
      dados.ip,
      dados.userAgent,
      dados.agora,
    )
    .run();
}

export async function buscarPorHash(db: D1Database, tokenHash: string): Promise<RefreshRow | null> {
  return db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').bind(tokenHash).first<RefreshRow>();
}

export async function marcarUsado(
  db: D1Database,
  id: string,
  substituidoPor: string,
  agora: string,
): Promise<{ changes: number }> {
  // O `revoked_at IS NULL` transforma a rotação em operação atômica: dois usos
  // simultâneos do mesmo refresh token só um ganha (`changes` 0 para o outro).
  const resultado = await db
    .prepare('UPDATE refresh_tokens SET revoked_at = ?, replaced_by = ? WHERE id = ? AND revoked_at IS NULL')
    .bind(agora, substituidoPor, id)
    .run();
  return { changes: Number(resultado.meta?.changes ?? 0) };
}

export async function revogar(db: D1Database, id: string, agora: string): Promise<void> {
  await db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(agora, id).run();
}

export async function revogarFamilia(db: D1Database, familyId: string, agora: string): Promise<number> {
  const resultado = await db
    .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL')
    .bind(agora, familyId)
    .run();
  return Number(resultado.meta?.changes ?? 0);
}

export async function revogarTudoDoSujeito(
  db: D1Database,
  subjectType: 'admin' | 'user',
  subjectId: string,
  agora: string,
): Promise<number> {
  const resultado = await db
    .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE subject_type = ? AND subject_id = ? AND revoked_at IS NULL')
    .bind(agora, subjectType, subjectId)
    .run();
  return Number(resultado.meta?.changes ?? 0);
}

export async function contarAtivos(db: D1Database, subjectType: 'admin' | 'user', subjectId: string): Promise<number> {
  const linha = await db
    .prepare(
      'SELECT COUNT(*) AS total FROM refresh_tokens WHERE subject_type = ? AND subject_id = ? AND revoked_at IS NULL AND expires_at > ?',
    )
    .bind(subjectType, subjectId, new Date().toISOString())
    .first<{ total: number }>();
  return Number(linha?.total ?? 0);
}

export async function limparExpirados(db: D1Database, antesDe: string): Promise<number> {
  const resultado = await db.prepare('DELETE FROM refresh_tokens WHERE expires_at < ?').bind(antesDe).run();
  return Number(resultado.meta?.changes ?? 0);
}

export function familiaAtiva(linha: RefreshRow, agora: string): boolean {
  return linha.revoked_at === null && linha.expires_at > agora;
}
