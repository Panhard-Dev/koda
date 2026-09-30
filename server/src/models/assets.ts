export interface AssetRow {
  id: string;
  filename: string;
  original_name: string | null;
  mime: string;
  size: number;
  sha256: string;
  kind: string;
  uploaded_by: string | null;
  created_at: string;
}

export interface AssetComConteudo extends AssetRow {
  data: ArrayBuffer;
}

export async function criar(
  db: D1Database,
  dados: {
    id: string;
    filename: string;
    originalName: string | null;
    mime: string;
    size: number;
    sha256: string;
    kind: string;
    data: ArrayBuffer;
    uploadedBy: string | null;
    agora: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO assets (id, filename, original_name, mime, size, sha256, kind, data, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      dados.id,
      dados.filename,
      dados.originalName,
      dados.mime,
      dados.size,
      dados.sha256,
      dados.kind,
      dados.data,
      dados.uploadedBy,
      dados.agora,
    )
    .run();
}

export async function buscarPorId(db: D1Database, id: string): Promise<AssetComConteudo | null> {
  return db.prepare('SELECT * FROM assets WHERE id = ?').bind(id).first<AssetComConteudo>();
}

export async function listar(db: D1Database, kind: string | null, limite = 100): Promise<AssetRow[]> {
  const resultado = await db
    .prepare('SELECT id, filename, original_name, mime, size, sha256, kind, uploaded_by, created_at FROM assets WHERE (? IS NULL OR kind = ?) ORDER BY created_at DESC LIMIT ?')
    .bind(kind, kind, limite)
    .all<AssetRow>();
  return resultado.results ?? [];
}

export async function deletar(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM assets WHERE id = ?').bind(id).run();
}

export async function contar(db: D1Database): Promise<{ total: number; bytes: number }> {
  const linha = await db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(size), 0) AS bytes FROM assets').first<{ total: number; bytes: number }>();
  return { total: Number(linha?.total ?? 0), bytes: Number(linha?.bytes ?? 0) };
}
