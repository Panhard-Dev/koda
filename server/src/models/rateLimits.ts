export interface ResultadoLimite {
  hits: number;
  windowStart: number;
  resetEm: number;
  permitido: boolean;
  bloqueadoAte: number | null;
}

/**
 * Contador por janela fixa em UMA instrução (UPSERT + RETURNING): não existe
 * janela entre ler e escrever, então requisições simultâneas não furam o limite.
 */
export async function consumir(
  db: D1Database,
  opcoes: { bucket: string; janelaMs: number; limite: number; agoraMs: number; bloqueioMs?: number },
): Promise<ResultadoLimite> {
  const linha = await db
    .prepare(
      `INSERT INTO rate_limits (bucket, window_start, hits, blocked_until, updated_at)
       VALUES (?, ?, 1, NULL, ?)
       ON CONFLICT(bucket) DO UPDATE SET
         hits = CASE WHEN ? - rate_limits.window_start >= ? THEN 1 ELSE rate_limits.hits + 1 END,
         window_start = CASE WHEN ? - rate_limits.window_start >= ? THEN ? ELSE rate_limits.window_start END,
         blocked_until = CASE
           WHEN (CASE WHEN ? - rate_limits.window_start >= ? THEN 1 ELSE rate_limits.hits + 1 END) > ?
             THEN MAX(COALESCE(rate_limits.blocked_until, 0), ? + COALESCE(?, 0))
           ELSE rate_limits.blocked_until
         END,
         updated_at = ?
       RETURNING window_start, hits, blocked_until`,
    )
    .bind(
      opcoes.bucket,
      opcoes.agoraMs,
      new Date(opcoes.agoraMs).toISOString(),
      opcoes.agoraMs,
      opcoes.janelaMs,
      opcoes.agoraMs,
      opcoes.janelaMs,
      opcoes.agoraMs,
      opcoes.agoraMs,
      opcoes.janelaMs,
      opcoes.limite,
      opcoes.agoraMs,
      opcoes.bloqueioMs ?? 0,
      opcoes.agoraMs,
    )
    .first<{ window_start: number; hits: number; blocked_until: number | null }>();

  const windowStart = Number(linha?.window_start ?? opcoes.agoraMs);
  const hits = Number(linha?.hits ?? 1);
  const bloqueadoAte = linha?.blocked_until ?? null;
  return {
    hits,
    windowStart,
    resetEm: windowStart + opcoes.janelaMs,
    permitido: hits <= opcoes.limite && (bloqueadoAte === null || bloqueadoAte <= opcoes.agoraMs),
    bloqueadoAte,
  };
}

/** Estado atual sem consumir (usado para checar bloqueio antes de autenticar). */
export async function consultar(db: D1Database, bucket: string): Promise<ResultadoLimite | null> {
  const linha = await db
    .prepare('SELECT window_start, hits, blocked_until FROM rate_limits WHERE bucket = ?')
    .bind(bucket)
    .first<{ window_start: number; hits: number; blocked_until: number | null }>();
  if (!linha) return null;
  return {
    hits: Number(linha.hits),
    windowStart: Number(linha.window_start),
    resetEm: Number(linha.window_start),
    permitido: linha.blocked_until === null || Number(linha.blocked_until) <= Date.now(),
    bloqueadoAte: linha.blocked_until,
  };
}

/** Zera o balde (usado quando o login dá certo e a conta sai da mira). */
export async function resetar(db: D1Database, bucket: string): Promise<void> {
  await db.prepare('DELETE FROM rate_limits WHERE bucket = ?').bind(bucket).run();
}

/** Limpeza de baldes velhos: chamada de vez em quando, não a cada requisição. */
export async function limparAntigos(db: D1Database, antesMs: number): Promise<number> {
  const resultado = await db.prepare('DELETE FROM rate_limits WHERE updated_at < ?').bind(new Date(antesMs).toISOString()).run();
  return Number(resultado.meta?.changes ?? 0);
}
