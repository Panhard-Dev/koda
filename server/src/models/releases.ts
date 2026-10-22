export interface ReleaseRow {
  id: string;
  version: string;
  version_key: string;
  is_prerelease: number;
  download_url: string;
  notes: string | null;
  channel: 'stable' | 'beta';
  mandatory: number;
  min_supported_version: string | null;
  published: number;
  published_at: string | null;
  published_by: string | null;
  created_at: string;
  updated_at: string;
}

export async function criar(
  db: D1Database,
  dados: {
    id: string;
    version: string;
    versionKey: string;
    isPrerelease: boolean;
    downloadUrl: string;
    notes: string | null;
    channel: 'stable' | 'beta';
    mandatory: boolean;
    minSupportedVersion: string | null;
    publicado: boolean;
    autorId: string | null;
    agora: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO releases
         (id, version, version_key, is_prerelease, download_url, notes, channel, mandatory,
          min_supported_version, published, published_at, published_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      dados.id,
      dados.version,
      dados.versionKey,
      dados.isPrerelease ? 1 : 0,
      dados.downloadUrl,
      dados.notes,
      dados.channel,
      dados.mandatory ? 1 : 0,
      dados.minSupportedVersion,
      dados.publicado ? 1 : 0,
      dados.publicado ? dados.agora : null,
      dados.publicado ? dados.autorId : null,
      dados.agora,
      dados.agora,
    )
    .run();
}

export async function atualizar(
  db: D1Database,
  id: string,
  dados: {
    downloadUrl: string;
    notes: string | null;
    channel: 'stable' | 'beta';
    mandatory: boolean;
    minSupportedVersion: string | null;
    agora: string;
  },
): Promise<ReleaseRow | null> {
  return db
    .prepare(
      `UPDATE releases
          SET download_url = ?, notes = ?, channel = ?, mandatory = ?, min_supported_version = ?, updated_at = ?
        WHERE id = ?
        RETURNING *`,
    )
    .bind(dados.downloadUrl, dados.notes, dados.channel, dados.mandatory ? 1 : 0, dados.minSupportedVersion, dados.agora, id)
    .first<ReleaseRow>();
}

export async function definirPublicacao(
  db: D1Database,
  id: string,
  publicado: boolean,
  autorId: string | null,
  agora: string,
): Promise<ReleaseRow | null> {
  return db
    .prepare(
      `UPDATE releases
          SET published = ?, published_at = ?, published_by = ?, updated_at = ?
        WHERE id = ?
        RETURNING *`,
    )
    .bind(publicado ? 1 : 0, publicado ? agora : null, publicado ? autorId : null, agora, id)
    .first<ReleaseRow>();
}

export async function buscarPorId(db: D1Database, id: string): Promise<ReleaseRow | null> {
  return db.prepare('SELECT * FROM releases WHERE id = ?').bind(id).first<ReleaseRow>();
}

export async function buscarPorVersao(db: D1Database, version: string): Promise<ReleaseRow | null> {
  return db.prepare('SELECT * FROM releases WHERE version = ?').bind(version).first<ReleaseRow>();
}

/**
 * Última versão publicada. `is_prerelease ASC` garante que um beta não seja
 * oferecido como atualização de quem está no canal estável.
 */
export async function ultimaPublicada(db: D1Database, canal: 'stable' | 'beta' | null): Promise<ReleaseRow | null> {
  const base =
    'SELECT * FROM releases WHERE published = 1 AND (? IS NULL OR channel = ?) AND (? = 1 OR is_prerelease = 0)';
  return db
    .prepare(`${base} ORDER BY is_prerelease ASC, version_key DESC, version DESC LIMIT 1`)
    .bind(canal, canal, canal === 'beta' ? 1 : 0)
    .first<ReleaseRow>();
}

export async function listar(db: D1Database, opcoes: { limite: number; deslocamento: number; incluirNaoPublicadas: boolean }): Promise<{ linhas: ReleaseRow[]; total: number }> {
  const onde = opcoes.incluirNaoPublicadas ? '' : 'WHERE published = 1';
  const linhas = await db
    .prepare(`SELECT * FROM releases ${onde} ORDER BY is_prerelease ASC, version_key DESC LIMIT ? OFFSET ?`)
    .bind(opcoes.limite, opcoes.deslocamento)
    .all<ReleaseRow>();
  const contagem = await db.prepare(`SELECT COUNT(*) AS total FROM releases ${onde}`).first<{ total: number }>();
  return { linhas: linhas.results ?? [], total: Number(contagem?.total ?? 0) };
}

export async function deletar(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM releases WHERE id = ?').bind(id).run();
}

export async function contar(db: D1Database): Promise<{ total: number; publicadas: number }> {
  const linha = await db
    .prepare('SELECT COUNT(*) AS total, SUM(published) AS publicadas FROM releases')
    .first<{ total: number; publicadas: number | null }>();
  return { total: Number(linha?.total ?? 0), publicadas: Number(linha?.publicadas ?? 0) };
}
