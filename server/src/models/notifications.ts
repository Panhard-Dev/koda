export interface NotificacaoRow {
  id: string;
  user_id: string;
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'critical';
  read_at: string | null;
  sent_by: string | null;
  created_at: string;
}

export async function criar(
  db: D1Database,
  dados: {
    id: string;
    userId: string;
    titulo: string;
    corpo: string;
    severidade: 'info' | 'warning' | 'critical';
    autorId: string | null;
    agora: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO notifications (id, user_id, title, body, severity, sent_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(dados.id, dados.userId, dados.titulo, dados.corpo, dados.severidade, dados.autorId, dados.agora)
    .run();
}

export async function listarPorUsuario(db: D1Database, userId: string, limite = 50): Promise<NotificacaoRow[]> {
  const resultado = await db
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .bind(userId, limite)
    .all<NotificacaoRow>();
  return resultado.results ?? [];
}

export async function listarRecentes(db: D1Database, limite = 50): Promise<(NotificacaoRow & { email: string })[]> {
  const resultado = await db
    .prepare(
      `SELECT n.*, u.email FROM notifications n JOIN users u ON u.id = n.user_id
        ORDER BY n.created_at DESC LIMIT ?`,
    )
    .bind(limite)
    .all<NotificacaoRow & { email: string }>();
  return resultado.results ?? [];
}

export async function marcarLido(db: D1Database, id: string, userId: string, agora: string): Promise<void> {
  await db
    .prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL')
    .bind(agora, id, userId)
    .run();
}

export async function contarNaoLidas(db: D1Database, userId: string): Promise<number> {
  const linha = await db
    .prepare('SELECT COUNT(*) AS total FROM notifications WHERE user_id = ? AND read_at IS NULL')
    .bind(userId)
    .first<{ total: number }>();
  return Number(linha?.total ?? 0);
}
