export interface ModeloRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  provider: string;
  kind: string;
  context_window: number | null;
  is_active: number;
  sort_order: number;
  metadata: string;
  asset_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ModeloParaUsuario extends ModeloRow {
  habilitado_usuario: number;
  tem_excecao: number;
}

export interface FiltroModelos {
  ativo?: boolean | undefined;
  busca?: string | undefined;
  incluirDeletados?: boolean | undefined;
  ordenar: 'sort_order' | 'name' | 'created_at';
  direcao: 'asc' | 'desc';
  limite: number;
  deslocamento: number;
}

const COLUNA_ORDENACAO: Record<FiltroModelos['ordenar'], string> = {
  sort_order: 'sort_order',
  name: 'name',
  created_at: 'created_at',
};

export async function listar(db: D1Database, filtro: FiltroModelos): Promise<{ linhas: ModeloRow[]; total: number }> {
  const condicoes: string[] = [];
  const parametros: unknown[] = [];
  if (!filtro.incluirDeletados) condicoes.push('deleted_at IS NULL');
  if (filtro.ativo !== undefined) {
    condicoes.push('is_active = ?');
    parametros.push(filtro.ativo ? 1 : 0);
  }
  if (filtro.busca) {
    condicoes.push("(slug LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')");
    const escapado = filtro.busca.replace(/[\\%_]/g, (c) => `\\${c}`);
    parametros.push(`%${escapado}%`, `%${escapado}%`);
  }
  const onde = condicoes.length > 0 ? `WHERE ${condicoes.join(' AND ')}` : '';
  const coluna = COLUNA_ORDENACAO[filtro.ordenar] ?? 'sort_order';
  const direcao = filtro.direcao === 'desc' ? 'DESC' : 'ASC';

  const linhas = await db
    .prepare(`SELECT * FROM catalog_models ${onde} ORDER BY ${coluna} ${direcao}, id ASC LIMIT ? OFFSET ?`)
    .bind(...parametros, filtro.limite, filtro.deslocamento)
    .all<ModeloRow>();
  const contagem = await db
    .prepare(`SELECT COUNT(*) AS total FROM catalog_models ${onde}`)
    .bind(...parametros)
    .first<{ total: number }>();
  return { linhas: linhas.results ?? [], total: Number(contagem?.total ?? 0) };
}

/**
 * Modelos que um usuário realmente enxerga: ativos globalmente E sem exceção
 * individual desligada (`user_models`). Sem linha em user_models, herda o global.
 */
export async function listarParaUsuario(db: D1Database, userId: string): Promise<ModeloParaUsuario[]> {
  const resultado = await db
    .prepare(
      `SELECT m.*, COALESCE(um.enabled, m.is_active) AS habilitado_usuario,
              CASE WHEN um.user_id IS NULL THEN 0 ELSE 1 END AS tem_excecao
         FROM catalog_models m
         LEFT JOIN user_models um ON um.model_id = m.id AND um.user_id = ?
        WHERE m.deleted_at IS NULL AND m.is_active = 1 AND COALESCE(um.enabled, 1) = 1
        ORDER BY m.sort_order ASC, m.name ASC`,
    )
    .bind(userId)
    .all<ModeloParaUsuario>();
  return resultado.results ?? [];
}

export async function publicos(db: D1Database): Promise<ModeloRow[]> {
  const resultado = await db
    .prepare('SELECT * FROM catalog_models WHERE deleted_at IS NULL AND is_active = 1 ORDER BY sort_order ASC, name ASC')
    .all<ModeloRow>();
  return resultado.results ?? [];
}

/**
 * O catálogo inteiro, incluindo os **desligados** — só o que uma conta precisa saber.
 *
 * `publicos` responde "o que está ligado"; esta responde "o que o painel conhece, e em
 * que estado". A diferença é a que deixa o app distinguir **desativado** de **desconhecido**:
 * com só a lista dos ativos, um modelo desligado e um modelo que o painel nunca viu chegam
 * iguais (nenhum dos dois aparece), e o app não teria como esconder um sem esconder o outro.
 */
export async function catalogoSimples(
  db: D1Database,
): Promise<{ slug: string; name: string; is_active: number }[]> {
  const resultado = await db
    .prepare(
      'SELECT slug, name, is_active FROM catalog_models WHERE deleted_at IS NULL ORDER BY sort_order ASC, name ASC',
    )
    .all<{ slug: string; name: string; is_active: number }>();
  return resultado.results ?? [];
}

export async function buscarPorId(db: D1Database, id: string): Promise<ModeloRow | null> {
  return db.prepare('SELECT * FROM catalog_models WHERE id = ?').bind(id).first<ModeloRow>();
}

export async function buscarPorSlug(db: D1Database, slug: string): Promise<ModeloRow | null> {
  return db.prepare('SELECT * FROM catalog_models WHERE slug = ?').bind(slug).first<ModeloRow>();
}

export async function criar(db: D1Database, dados: {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  provider: string;
  kind: string;
  contextWindow: number | null;
  ativo: boolean;
  sortOrder: number;
  metadata: string;
  agora: string;
}): Promise<void> {
  await db
    .prepare(
      `INSERT INTO catalog_models
         (id, slug, name, description, provider, kind, context_window, is_active, sort_order, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      dados.id,
      dados.slug,
      dados.name,
      dados.description,
      dados.provider,
      dados.kind,
      dados.contextWindow,
      dados.ativo ? 1 : 0,
      dados.sortOrder,
      dados.metadata,
      dados.agora,
      dados.agora,
    )
    .run();
}

export async function atualizar(db: D1Database, id: string, dados: {
  name: string;
  description: string | null;
  provider: string;
  kind: string;
  contextWindow: number | null;
  sortOrder: number;
  metadata: string;
  assetId: string | null;
  agora: string;
}): Promise<ModeloRow | null> {
  return db
    .prepare(
      `UPDATE catalog_models
          SET name = ?, description = ?, provider = ?, kind = ?, context_window = ?, sort_order = ?,
              metadata = ?, asset_id = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
        RETURNING *`,
    )
    .bind(
      dados.name,
      dados.description,
      dados.provider,
      dados.kind,
      dados.contextWindow,
      dados.sortOrder,
      dados.metadata,
      dados.assetId,
      dados.agora,
      id,
    )
    .first<ModeloRow>();
}

export async function definirAtivoGlobal(db: D1Database, id: string, ativo: boolean, agora: string): Promise<ModeloRow | null> {
  return db
    .prepare('UPDATE catalog_models SET is_active = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL RETURNING *')
    .bind(ativo ? 1 : 0, agora, id)
    .first<ModeloRow>();
}

export async function deletarLogico(db: D1Database, id: string, agora: string): Promise<ModeloRow | null> {
  return db
    .prepare('UPDATE catalog_models SET deleted_at = ?, is_active = 0, updated_at = ? WHERE id = ? AND deleted_at IS NULL RETURNING *')
    .bind(agora, agora, id)
    .first<ModeloRow>();
}

export async function deletarDefinitivo(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM catalog_models WHERE id = ?').bind(id).run();
}

export async function contar(db: D1Database): Promise<{ total: number; ativos: number }> {
  const linha = await db
    .prepare('SELECT COUNT(*) AS total, SUM(is_active) AS ativos FROM catalog_models WHERE deleted_at IS NULL')
    .first<{ total: number; ativos: number | null }>();
  return { total: Number(linha?.total ?? 0), ativos: Number(linha?.ativos ?? 0) };
}
