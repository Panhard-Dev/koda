export type StatusConta = 'active' | 'suspended' | 'banned';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  status: StatusConta;
  status_reason: string | null;
  suspended_until: string | null;
  status_changed_at: string | null;
  status_changed_by: string | null;
  tokens_valid_from: string;
  failed_attempts: number;
  locked_until: string | null;
  last_login_at: string | null;
  last_login_ip: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface FiltroContas {
  status?: StatusConta | undefined;
  busca?: string | undefined;
  criadoDe?: string | undefined;
  criadoAte?: string | undefined;
  incluirDeletados?: boolean | undefined;
  somenteDeletados?: boolean | undefined;
  ordenar: 'created_at' | 'updated_at' | 'email' | 'status' | 'last_login_at';
  direcao: 'asc' | 'desc';
  limite: number;
  deslocamento: number;
}

/** Colunas permitidas em ORDER BY: qualquer outra coisa vira `created_at`. */
const COLUNA_ORDENACAO: Record<FiltroContas['ordenar'], string> = {
  created_at: 'created_at',
  updated_at: 'updated_at',
  email: 'email',
  status: 'status',
  last_login_at: 'last_login_at',
};

function montarFiltro(filtro: FiltroContas): { onde: string; parametros: unknown[] } {
  const condicoes: string[] = [];
  const parametros: unknown[] = [];

  if (filtro.somenteDeletados) {
    condicoes.push('deleted_at IS NOT NULL');
  } else if (!filtro.incluirDeletados) {
    condicoes.push('deleted_at IS NULL');
  }
  if (filtro.status) {
    condicoes.push('status = ?');
    parametros.push(filtro.status);
  }
  if (filtro.busca) {
    condicoes.push('(email LIKE ? ESCAPE \'\\\' OR COALESCE(display_name, \'\') LIKE ? ESCAPE \'\\\')');
    // O `%` fica no parâmetro: o LIKE continua parametrizado.
    const escapado = filtro.busca.replace(/[\\%_]/g, (c) => `\\${c}`);
    parametros.push(`%${escapado}%`, `%${escapado}%`);
  }
  if (filtro.criadoDe) {
    condicoes.push('created_at >= ?');
    parametros.push(filtro.criadoDe);
  }
  if (filtro.criadoAte) {
    condicoes.push('created_at <= ?');
    parametros.push(filtro.criadoAte);
  }
  return { onde: condicoes.length > 0 ? `WHERE ${condicoes.join(' AND ')}` : '', parametros };
}

export async function listar(
  db: D1Database,
  filtro: FiltroContas,
): Promise<{ linhas: UserRow[]; total: number }> {
  const { onde, parametros } = montarFiltro(filtro);
  const coluna = COLUNA_ORDENACAO[filtro.ordenar] ?? 'created_at';
  const direcao = filtro.direcao === 'asc' ? 'ASC' : 'DESC';

  const linhas = await db
    .prepare(`SELECT * FROM users ${onde} ORDER BY ${coluna} ${direcao}, id ASC LIMIT ? OFFSET ?`)
    .bind(...parametros, filtro.limite, filtro.deslocamento)
    .all<UserRow>();
  const contagem = await db.prepare(`SELECT COUNT(*) AS total FROM users ${onde}`).bind(...parametros).first<{ total: number }>();

  return {
    linhas: linhas.results ?? [],
    total: Number(contagem?.total ?? 0),
  };
}

export async function buscarPorEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<UserRow>();
}

export async function buscarPorId(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
}

export async function criar(
  db: D1Database,
  dados: { id: string; email: string; passwordHash: string; displayName?: string | null; agora: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (id, email, password_hash, display_name, tokens_valid_from, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(dados.id, dados.email, dados.passwordHash, dados.displayName ?? null, dados.agora, dados.agora, dados.agora)
    .run();
}

export async function atualizarPerfil(
  db: D1Database,
  id: string,
  dados: { displayName?: string | null; agora: string },
): Promise<void> {
  await db.prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?').bind(dados.displayName ?? null, dados.agora, id).run();
}

export async function registrarLoginOk(db: D1Database, id: string, ip: string, agora: string): Promise<void> {
  await db
    .prepare(
      `UPDATE users SET last_login_at = ?, last_login_ip = ?, failed_attempts = 0, locked_until = NULL, updated_at = ?
       WHERE id = ?`,
    )
    .bind(agora, ip, agora, id)
    .run();
}

export async function registrarFalha(
  db: D1Database,
  id: string,
  opcoes: { limite: number; travarAte: string; agora: string },
): Promise<{ failed_attempts: number; locked_until: string | null } | null> {
  return db
    .prepare(
      `UPDATE users
         SET failed_attempts = failed_attempts + 1,
             locked_until = CASE WHEN failed_attempts + 1 >= ? THEN ? ELSE locked_until END,
             updated_at = ?
       WHERE id = ?
       RETURNING failed_attempts, locked_until`,
    )
    .bind(opcoes.limite, opcoes.travarAte, opcoes.agora, id)
    .first<{ failed_attempts: number; locked_until: string | null }>();
}

/**
 * Muda o status e — na mesma instrução — marca que nenhum token emitido antes
 * deste instante vale mais. É a invalidação imediata ao suspender/banir.
 */
export async function definirStatus(
  db: D1Database,
  id: string,
  dados: {
    status: StatusConta;
    motivo?: string | null;
    suspensoAte?: string | null;
    autorId: string;
    agora: string;
  },
): Promise<UserRow | null> {
  return db
    .prepare(
      `UPDATE users
         SET status = ?, status_reason = ?, suspended_until = ?, status_changed_at = ?, status_changed_by = ?,
             tokens_valid_from = ?, failed_attempts = 0, locked_until = NULL, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
       RETURNING *`,
    )
    .bind(
      dados.status,
      dados.motivo ?? null,
      dados.suspensoAte ?? null,
      dados.agora,
      dados.autorId,
      dados.agora,
      dados.agora,
      id,
    )
    .first<UserRow>();
}

/** Soft delete: some da listagem padrão, mas continua recuperável. */
export async function deletarLogico(db: D1Database, id: string, agora: string, autorId: string): Promise<UserRow | null> {
  return db
    .prepare(
      `UPDATE users
         SET deleted_at = ?, tokens_valid_from = ?, status = 'banned', status_reason = COALESCE(status_reason, 'conta removida'),
             status_changed_at = ?, status_changed_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
       RETURNING *`,
    )
    .bind(agora, agora, agora, autorId, agora, id)
    .first<UserRow>();
}

export async function restaurar(db: D1Database, id: string, agora: string, autorId: string): Promise<UserRow | null> {
  return db
    .prepare(
      `UPDATE users
         SET deleted_at = NULL, status = 'active', status_reason = NULL, suspended_until = NULL,
             status_changed_at = ?, status_changed_by = ?, tokens_valid_from = ?, updated_at = ?
       WHERE id = ?
       RETURNING *`,
    )
    .bind(agora, autorId, agora, agora, id)
    .first<UserRow>();
}

/** Hard delete: remove a linha (FKs com ON DELETE CASCADE limpam o resto). */
export async function deletarDefinitivo(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
}

export async function invalidarTokens(db: D1Database, id: string, agora: string): Promise<void> {
  await db.prepare('UPDATE users SET tokens_valid_from = ?, updated_at = ? WHERE id = ?').bind(agora, agora, id).run();
}

export async function contarPorStatus(db: D1Database): Promise<Record<string, number>> {
  const resultado = await db
    .prepare('SELECT status, COUNT(*) AS total FROM users WHERE deleted_at IS NULL GROUP BY status')
    .all<{ status: string; total: number }>();
  const saida: Record<string, number> = { active: 0, suspended: 0, banned: 0 };
  for (const linha of resultado.results ?? []) saida[linha.status] = Number(linha.total ?? 0);
  return saida;
}
