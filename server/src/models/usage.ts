/**
 * O uso **da conta**, medido na nuvem.
 *
 * O backend local (dentro do instalador) mede — ele vê a resposta acontecendo e sabe o
 * `elapsed_ms` e o `tokens_total`. Mas ele é do **PC**, não da conta: o limite precisa morar
 * onde a pessoa não alcança, e é por isso que o app **relata** para cá.
 *
 * ## Por que uma linha por resposta
 *
 * `UNIQUE (user_id, message_id)` faz o relato ser **idempotente**: reenviar (rede caiu depois
 * do 200, retry, reinstalação que reconta) não duplica. Um contador somado não teria como
 * saber que já contou aquela resposta, e o preço de errar é cobrar o dobro de quem teve a
 * rede ruim.
 */

export interface UsoRelatado {
  id: string;
  userId: string;
  messageId: string;
  conversationId: string | null;
  model: string | null;
  /** `YYYY-MM-DD` no relógio de quem respondeu — o dia vira à meia-noite dele. */
  dia: string;
  /** `YYYY-MM` no mesmo relógio — o mês de calendário das moedas. */
  mes: string;
  tempoMs: number;
  tokens: number;
  agora: string;
}

/** Uma janela de uso, no mesmo formato que o app já desenha. */
export interface JanelaDeUso {
  tempo_ms: number;
  tokens_por_modelo: Record<string, number>;
}

/**
 * Grava o gasto de **uma** resposta. Devolve `false` quando aquela resposta já tinha sido
 * contada — o que **não** é erro: é o reenvio do app batendo na chave única.
 */
export async function registrar(db: D1Database, dados: UsoRelatado): Promise<boolean> {
  const resultado = await db
    .prepare(
      `INSERT OR IGNORE INTO usage_events
         (id, user_id, message_id, conversation_id, model, dia, mes, tempo_ms, tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      dados.id,
      dados.userId,
      dados.messageId,
      dados.conversationId,
      dados.model,
      dados.dia,
      dados.mes,
      dados.tempoMs,
      dados.tokens,
      dados.agora,
    )
    .run();
  return (resultado.meta.changes ?? 0) > 0;
}

/**
 * A janela que começa em `desde` (inclusive), por comparação de texto — `YYYY-MM-DD` ordena
 * igual a data, o mesmo truque que o resto do projeto usa para guardar data em texto.
 */
export async function janelaDesde(db: D1Database, userId: string, desde: string): Promise<JanelaDeUso> {
  const [tempo, modelos] = await Promise.all([
    db
      .prepare('SELECT COALESCE(SUM(tempo_ms), 0) AS ms FROM usage_events WHERE user_id = ? AND dia >= ?')
      .bind(userId, desde)
      .first<{ ms: number | null }>(),
    db
      .prepare(
        `SELECT model, COALESCE(SUM(tokens), 0) AS tokens
           FROM usage_events
          WHERE user_id = ? AND dia >= ? AND model IS NOT NULL
          GROUP BY model`,
      )
      .bind(userId, desde)
      .all<{ model: string; tokens: number }>(),
  ]);
  return {
    tempo_ms: Number(tempo?.ms ?? 0),
    tokens_por_modelo: Object.fromEntries(
      (modelos.results ?? [])
        .filter((linha) => Number(linha.tokens) > 0)
        .map((linha) => [String(linha.model), Number(linha.tokens)]),
    ),
  };
}

/** A janela do **mês de calendário** (`YYYY-MM` exato) — a das moedas. */
export async function janelaDoMes(db: D1Database, userId: string, mes: string): Promise<JanelaDeUso> {
  const [tempo, modelos] = await Promise.all([
    db
      .prepare('SELECT COALESCE(SUM(tempo_ms), 0) AS ms FROM usage_events WHERE user_id = ? AND mes = ?')
      .bind(userId, mes)
      .first<{ ms: number | null }>(),
    db
      .prepare(
        `SELECT model, COALESCE(SUM(tokens), 0) AS tokens
           FROM usage_events
          WHERE user_id = ? AND mes = ? AND model IS NOT NULL
          GROUP BY model`,
      )
      .bind(userId, mes)
      .all<{ model: string; tokens: number }>(),
  ]);
  return {
    tempo_ms: Number(tempo?.ms ?? 0),
    tokens_por_modelo: Object.fromEntries(
      (modelos.results ?? [])
        .filter((linha) => Number(linha.tokens) > 0)
        .map((linha) => [String(linha.model), Number(linha.tokens)]),
    ),
  };
}

/** Mensagens por dia, para o mapa de atividade. */
export async function diasComUso(db: D1Database, userId: string, desde: string): Promise<Record<string, number>> {
  const linhas = await db
    .prepare(
      'SELECT dia, COUNT(*) AS total FROM usage_events WHERE user_id = ? AND dia >= ? GROUP BY dia',
    )
    .bind(userId, desde)
    .all<{ dia: string; total: number }>();
  return Object.fromEntries((linhas.results ?? []).map((linha) => [String(linha.dia), Number(linha.total)]));
}

/** Quantas mensagens e quantas conversas esta conta já teve. */
export async function totais(
  db: D1Database,
  userId: string,
): Promise<{ messages: number; conversations: number }> {
  const linha = await db
    .prepare(
      `SELECT COUNT(*) AS mensagens,
              COUNT(DISTINCT conversation_id) AS conversas
         FROM usage_events WHERE user_id = ?`,
    )
    .bind(userId)
    .first<{ mensagens: number; conversas: number }>();
  return { messages: Number(linha?.mensagens ?? 0), conversations: Number(linha?.conversas ?? 0) };
}
