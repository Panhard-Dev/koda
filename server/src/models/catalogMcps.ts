/**
 * O catálogo de conectores MCP, lido do D1.
 *
 * O espelho de `catalogModels.ts` para o MCP: uma linha por conector ativo, ordenada pelo
 * `ordem` que o painel publicou. O painel é a fonte de verdade — o app só lê.
 */
import type { D1Database } from '@cloudflare/workers-types';

export interface ConectorRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  pacote: string;
  comando: string;
  params: string;
  login: string;
  credencial: string | null;
  doc_url: string;
  ativo: number;
  ordem: number;
}

/** O que a tela da Store mostra, depois de `safeParse(credencial)`. */
export interface ConectorPublico {
  id: string;
  slug: string;
  name: string;
  description: string;
  pacote: string;
  comando: string;
  params: string;
  login: string;
  credencial: Record<string, string> | null;
  doc_url: string;
}

/** Os conectores ativos e em ordem, sem os que o painel riscou (`deleted_at`). */
export async function publicos(db: D1Database): Promise<ConectorPublico[]> {
  const resultado = await db
    .prepare(
      'SELECT id, slug, name, description, pacote, comando, params, login, credencial, doc_url, ativo, ordem ' +
        'FROM catalog_mcps WHERE deleted_at IS NULL AND ativo = 1 ' +
        'ORDER BY ordem ASC, name ASC',
    )
    .all<ConectorRow>();
  return (resultado.results ?? []).map((linha) => ({
    id: linha.id,
    slug: linha.slug,
    name: linha.name,
    description: linha.description,
    pacote: linha.pacote,
    comando: linha.comando,
    params: linha.params,
    login: linha.login,
    credencial: safeParse(linha.credencial),
    doc_url: linha.doc_url,
  }));
}

function safeParse(valor: string | null): Record<string, string> | null {
  if (!valor) return null;
  try {
    const dados = JSON.parse(valor) as unknown;
    if (typeof dados !== 'object' || dados === null || Array.isArray(dados)) return null;
    return dados as Record<string, string>;
  } catch {
    return null;
  }
}