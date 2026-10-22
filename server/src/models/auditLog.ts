import { redigir } from '../utils/logger.js';
import { sha256Hex } from '../utils/crypto.js';

export interface EntradaAuditoria {
  createdAt: string;
  actorType: 'admin' | 'user' | 'system';
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  outcome: 'success' | 'failure';
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  beforeState: unknown;
  afterState: unknown;
  details: unknown;
}

export interface AuditoriaRow {
  id: number;
  created_at: string;
  actor_type: string;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  outcome: string;
  ip: string | null;
  user_agent: string | null;
  request_id: string | null;
  before_state: string | null;
  after_state: string | null;
  details: string | null;
  entry_hash: string;
}

export interface FiltroAuditoria {
  action?: string | undefined;
  actorId?: string | undefined;
  targetId?: string | undefined;
  outcome?: 'success' | 'failure' | undefined;
  de?: string | undefined;
  ate?: string | undefined;
  limite: number;
  deslocamento: number;
}

/**
 * Campos que entram no hash, SEMPRE nesta ordem. A verificação recalcula
 * exatamente a mesma assinatura: qualquer alteração de linha é detectada.
 */
const CAMPOS_ASSINADOS = [
  'created_at',
  'actor_type',
  'actor_id',
  'actor_email',
  'action',
  'target_type',
  'target_id',
  'outcome',
  'ip',
  'user_agent',
  'request_id',
  'before_state',
  'after_state',
  'details',
] as const;

function comoTexto(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === 'string') return valor;
  return JSON.stringify(redigir(valor));
}

export async function assinar(campos: (string | null)[]): Promise<string> {
  return sha256Hex(JSON.stringify(campos));
}

/** Append puro: não existe UPDATE/DELETE de auditoria em nenhum caminho. */
export async function registrar(db: D1Database, entrada: EntradaAuditoria): Promise<void> {
  const beforeState = comoTexto(entrada.beforeState);
  const afterState = comoTexto(entrada.afterState);
  const details = comoTexto(entrada.details);

  const entryHash = await assinar([
    entrada.createdAt,
    entrada.actorType,
    entrada.actorId,
    entrada.actorEmail,
    entrada.action,
    entrada.targetType,
    entrada.targetId,
    entrada.outcome,
    entrada.ip,
    entrada.userAgent,
    entrada.requestId,
    beforeState,
    afterState,
    details,
  ]);

  await db
    .prepare(
      `INSERT INTO audit_log
         (created_at, actor_type, actor_id, actor_email, action, target_type, target_id, outcome,
          ip, user_agent, request_id, before_state, after_state, details, entry_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      entrada.createdAt,
      entrada.actorType,
      entrada.actorId,
      entrada.actorEmail,
      entrada.action,
      entrada.targetType,
      entrada.targetId,
      entrada.outcome,
      entrada.ip,
      entrada.userAgent,
      entrada.requestId,
      beforeState,
      afterState,
      details,
      entryHash,
    )
    .run();
}

export async function listar(db: D1Database, filtro: FiltroAuditoria): Promise<{ linhas: AuditoriaRow[]; total: number }> {
  const condicoes: string[] = [];
  const parametros: unknown[] = [];
  if (filtro.action) {
    condicoes.push('action = ?');
    parametros.push(filtro.action);
  }
  if (filtro.actorId) {
    condicoes.push('actor_id = ?');
    parametros.push(filtro.actorId);
  }
  if (filtro.targetId) {
    condicoes.push('target_id = ?');
    parametros.push(filtro.targetId);
  }
  if (filtro.outcome) {
    condicoes.push('outcome = ?');
    parametros.push(filtro.outcome);
  }
  if (filtro.de) {
    condicoes.push('created_at >= ?');
    parametros.push(filtro.de);
  }
  if (filtro.ate) {
    condicoes.push('created_at <= ?');
    parametros.push(filtro.ate);
  }
  const onde = condicoes.length > 0 ? `WHERE ${condicoes.join(' AND ')}` : '';

  const linhas = await db
    .prepare(`SELECT * FROM audit_log ${onde} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .bind(...parametros, filtro.limite, filtro.deslocamento)
    .all<AuditoriaRow>();
  const contagem = await db.prepare(`SELECT COUNT(*) AS total FROM audit_log ${onde}`).bind(...parametros).first<{ total: number }>();
  return { linhas: linhas.results ?? [], total: Number(contagem?.total ?? 0) };
}

/**
 * Recalcula o hash de cada entrada e aponta as adulteradas. Roda em páginas para
 * não estourar memória quando o log crescer.
 */
export async function verificarIntegridade(
  db: D1Database,
  opcoes: { limite?: number; deslocamento?: number } = {},
): Promise<{ ok: boolean; verificadas: number; adulteradas: { id: number; esperado: string; encontrado: string }[] }> {
  const limite = opcoes.limite ?? 500;
  const deslocamento = opcoes.deslocamento ?? 0;
  const linhas = await db
    .prepare('SELECT * FROM audit_log ORDER BY id ASC LIMIT ? OFFSET ?')
    .bind(limite, deslocamento)
    .all<AuditoriaRow>();

  const adulteradas: { id: number; esperado: string; encontrado: string }[] = [];
  for (const linha of linhas.results ?? []) {
    const esperado = await assinar(CAMPOS_ASSINADOS.map((campo) => linha[campo] ?? null));
    if (esperado !== linha.entry_hash) {
      adulteradas.push({ id: linha.id, esperado, encontrado: linha.entry_hash });
    }
  }
  return { ok: adulteradas.length === 0, verificadas: (linhas.results ?? []).length, adulteradas };
}

export async function contar(db: D1Database): Promise<number> {
  const linha = await db.prepare('SELECT COUNT(*) AS total FROM audit_log').first<{ total: number }>();
  return Number(linha?.total ?? 0);
}

export async function ultimasAcoes(db: D1Database, limite = 10): Promise<AuditoriaRow[]> {
  const resultado = await db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').bind(limite).all<AuditoriaRow>();
  return resultado.results ?? [];
}
