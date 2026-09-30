import type { Role } from '../config/env.js';

export interface AdminRow {
  id: string;
  email: string;
  password_hash: string;
  role: Role;
  totp_secret: string | null;
  totp_enabled: number;
  totp_recovery: string;
  failed_attempts: number;
  locked_until: string | null;
  tokens_valid_from: string;
  last_login_at: string | null;
  last_login_ip: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Todo acesso é por prepared statement com parâmetros vinculados: e-mail com
 * `' OR 1=1 --` continua sendo um e-mail inválido, nunca SQL.
 */
export async function buscarPorEmail(db: D1Database, email: string): Promise<AdminRow | null> {
  return db.prepare('SELECT * FROM admins WHERE email = ? AND deleted_at IS NULL').bind(email).first<AdminRow>();
}

export async function buscarPorId(db: D1Database, id: string): Promise<AdminRow | null> {
  return db.prepare('SELECT * FROM admins WHERE id = ? AND deleted_at IS NULL').bind(id).first<AdminRow>();
}

export async function contar(db: D1Database): Promise<number> {
  const linha = await db.prepare('SELECT COUNT(*) AS total FROM admins WHERE deleted_at IS NULL').first<{ total: number }>();
  return linha?.total ?? 0;
}

export async function criar(
  db: D1Database,
  dados: { id: string; email: string; passwordHash: string; role: Role; agora: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO admins (id, email, password_hash, role, tokens_valid_from, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(dados.id, dados.email, dados.passwordHash, dados.role, dados.agora, dados.agora, dados.agora)
    .run();
}

export async function registrarLoginOk(db: D1Database, id: string, ip: string, agora: string): Promise<void> {
  await db
    .prepare(
      `UPDATE admins
         SET last_login_at = ?, last_login_ip = ?, failed_attempts = 0, locked_until = NULL, updated_at = ?
       WHERE id = ?`,
    )
    .bind(agora, ip, agora, id)
    .run();
}

/**
 * Uma única instrução faz incremento e travamento — sem ler-depois-escrever,
 * então duas tentativas simultâneas não conseguem "escapar" do contador.
 */
export async function registrarFalha(
  db: D1Database,
  id: string,
  opcoes: { limite: number; travarAte: string; agora: string },
): Promise<{ failed_attempts: number; locked_until: string | null } | null> {
  return db
    .prepare(
      `UPDATE admins
         SET failed_attempts = failed_attempts + 1,
             locked_until = CASE WHEN failed_attempts + 1 >= ? THEN ? ELSE locked_until END,
             updated_at = ?
       WHERE id = ?
       RETURNING failed_attempts, locked_until`,
    )
    .bind(opcoes.limite, opcoes.travarAte, opcoes.agora, id)
    .first<{ failed_attempts: number; locked_until: string | null }>();
}

export async function limparFalhas(db: D1Database, id: string, agora: string): Promise<void> {
  await db
    .prepare('UPDATE admins SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?')
    .bind(agora, id)
    .run();
}

export async function travar(db: D1Database, id: string, ate: string, agora: string): Promise<void> {
  await db.prepare('UPDATE admins SET locked_until = ?, updated_at = ? WHERE id = ?').bind(ate, agora, id).run();
}

/** Derruba todo token já emitido (usado ao trocar senha, ativar 2FA, banir). */
export async function invalidarTokens(db: D1Database, id: string, agora: string): Promise<void> {
  await db
    .prepare('UPDATE admins SET tokens_valid_from = ?, locked_until = NULL, failed_attempts = 0, updated_at = ? WHERE id = ?')
    .bind(agora, agora, id)
    .run();
}

export async function atualizarSenha(db: D1Database, id: string, passwordHash: string, agora: string): Promise<void> {
  await db
    .prepare('UPDATE admins SET password_hash = ?, tokens_valid_from = ?, updated_at = ? WHERE id = ?')
    .bind(passwordHash, agora, agora, id)
    .run();
}

export async function salvarTotp(
  db: D1Database,
  id: string,
  dados: { segredo: string | null; ativo: boolean; recuperacao: string[] },
  agora: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE admins SET totp_secret = ?, totp_enabled = ?, totp_recovery = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(dados.segredo, dados.ativo ? 1 : 0, JSON.stringify(dados.recuperacao), agora, id)
    .run();
}

export async function registrarRecuperacao(
  db: D1Database,
  id: string,
  recuperacao: string[],
  agora: string,
): Promise<void> {
  await db
    .prepare('UPDATE admins SET totp_recovery = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(recuperacao), agora, id)
    .run();
}
