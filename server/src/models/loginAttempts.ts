export interface TentativaRow {
  id: number;
  scope: 'ip' | 'account';
  scope_key: string;
  subject_type: 'admin' | 'user';
  success: number;
  email: string | null;
  ip: string | null;
  user_agent: string | null;
  reason: string | null;
  created_at: string;
}

/**
 * Histórico append-only (triggers no banco recusam UPDATE/DELETE). Serve para
 * contar falhas por IP/conta e para investigar força bruta depois.
 */
export async function registrar(
  db: D1Database,
  dados: {
    scope: 'ip' | 'account';
    scopeKey: string;
    subjectType: 'admin' | 'user';
    sucesso: boolean;
    email: string | null;
    ip: string | null;
    userAgent: string | null;
    motivo: string | null;
    agora: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO login_attempts (scope, scope_key, subject_type, success, email, ip, user_agent, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      dados.scope,
      dados.scopeKey,
      dados.subjectType,
      dados.sucesso ? 1 : 0,
      dados.email,
      dados.ip,
      dados.userAgent,
      dados.motivo,
      dados.agora,
    )
    .run();
}

export async function contarFalhas(
  db: D1Database,
  opcoes: { scope: 'ip' | 'account'; scopeKey: string; desde: string },
): Promise<number> {
  const linha = await db
    .prepare(
      'SELECT COUNT(*) AS total FROM login_attempts WHERE scope = ? AND scope_key = ? AND success = 0 AND created_at >= ?',
    )
    .bind(opcoes.scope, opcoes.scopeKey, opcoes.desde)
    .first<{ total: number }>();
  return Number(linha?.total ?? 0);
}

export async function listarRecentes(db: D1Database, limite = 50): Promise<TentativaRow[]> {
  const resultado = await db
    .prepare('SELECT * FROM login_attempts ORDER BY id DESC LIMIT ?')
    .bind(limite)
    .all<TentativaRow>();
  return resultado.results ?? [];
}

export async function falhasPorIp(db: D1Database, ip: string, desde: string): Promise<TentativaRow[]> {
  const resultado = await db
    .prepare('SELECT * FROM login_attempts WHERE ip = ? AND success = 0 AND created_at >= ? ORDER BY id DESC LIMIT 200')
    .bind(ip, desde)
    .all<TentativaRow>();
  return resultado.results ?? [];
}
