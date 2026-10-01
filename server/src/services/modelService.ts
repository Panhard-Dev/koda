import type { Contexto } from '../types.js';
import * as catalogo from '../models/catalogModels.js';
import type { FiltroModelos, ModeloRow } from '../models/catalogModels.js';
import * as excecoes from '../models/userModels.js';
import { conflito, naoEncontrado, requisicaoInvalida } from '../utils/errors.js';
import { uuid } from '../utils/crypto.js';
import { auditar } from './auditService.js';

const SLUG = /^[a-z0-9][a-z0-9._-]{1,44}$/;
const TIPOS = ['chat', 'imagem', 'audio', 'embedding', 'ferramenta'] as const;

export interface EntradaModelo {
  slug?: string;
  name: string;
  description?: string | null;
  provider?: string;
  kind?: string;
  contextWindow?: number | null;
  ativo?: boolean;
  sortOrder?: number;
  metadata?: Record<string, unknown> | null;
  assetId?: string | null;
}

function validar(entrada: EntradaModelo, exigirSlug: boolean): void {
  if (exigirSlug) {
    if (!entrada.slug || !SLUG.test(entrada.slug)) {
      throw requisicaoInvalida('slug deve ter 2 a 45 caracteres: letras minusculas, numeros, ponto, hifen ou _');
    }
  }
  if (!entrada.name || entrada.name.trim().length < 2 || entrada.name.length > 80) {
    throw requisicaoInvalida('nome deve ter entre 2 e 80 caracteres');
  }
  if (entrada.description && entrada.description.length > 500) {
    throw requisicaoInvalida('descricao deve ter no maximo 500 caracteres');
  }
  if (entrada.kind && !(TIPOS as readonly string[]).includes(entrada.kind)) {
    throw requisicaoInvalida(`tipo deve ser um de: ${TIPOS.join(', ')}`);
  }
  if (entrada.contextWindow !== undefined && entrada.contextWindow !== null) {
    if (!Number.isInteger(entrada.contextWindow) || entrada.contextWindow < 128 || entrada.contextWindow > 10_000_000) {
      throw requisicaoInvalida('context_window deve ser inteiro entre 128 e 10000000');
    }
  }
  if (entrada.metadata) {
    const texto = JSON.stringify(entrada.metadata);
    if (texto.length > 4_000) throw requisicaoInvalida('metadata grande demais (limite 4000 caracteres)');
  }
}

export async function listar(
  db: D1Database,
  filtro: FiltroModelos & { pagina: number; porPagina: number },
): Promise<{ linhas: ModeloRow[]; total: number; pagina: number; porPagina: number }> {
  const { linhas, total } = await catalogo.listar(db, filtro);
  return { linhas, total, pagina: filtro.pagina, porPagina: filtro.porPagina };
}

export async function obter(db: D1Database, id: string): Promise<{ modelo: ModeloRow; excecoes: unknown[] }> {
  const modelo = await catalogo.buscarPorId(db, id);
  if (!modelo) throw naoEncontrado('modelo nao encontrado');
  const lista = await excecoes.listarPorModelo(db, id);
  return { modelo, excecoes: lista };
}

export async function criar(db: D1Database, contexto: Contexto, entrada: EntradaModelo): Promise<ModeloRow> {
  validar(entrada, true);
  const slug = (entrada.slug as string).toLowerCase();
  const existente = await catalogo.buscarPorSlug(db, slug);
  if (existente) throw conflito('slug_em_uso', 'ja existe modelo com este slug');

  const id = uuid();
  const agora = new Date().toISOString();
  await catalogo.criar(db, {
    id,
    slug,
    name: entrada.name.trim(),
    description: entrada.description?.trim() ?? null,
    provider: entrada.provider?.trim() || 'host',
    kind: entrada.kind ?? 'chat',
    contextWindow: entrada.contextWindow ?? null,
    ativo: entrada.ativo ?? true,
    sortOrder: entrada.sortOrder ?? 0,
    metadata: JSON.stringify(entrada.metadata ?? {}),
    agora,
  });
  await auditar(db, contexto, {
    action: 'model.create',
    targetType: 'model',
    targetId: id,
    after: { slug, name: entrada.name, ativo: entrada.ativo ?? true },
  });
  const criado = await catalogo.buscarPorId(db, id);
  if (!criado) throw naoEncontrado('modelo recem-criado nao encontrado');
  return criado;
}

export async function editar(db: D1Database, contexto: Contexto, id: string, entrada: EntradaModelo): Promise<ModeloRow> {
  validar(entrada, false);
  const antes = await catalogo.buscarPorId(db, id);
  if (!antes || antes.deleted_at !== null) throw naoEncontrado('modelo nao encontrado');

  const depois = await catalogo.atualizar(db, id, {
    name: entrada.name.trim(),
    description: entrada.description?.trim() ?? null,
    provider: entrada.provider?.trim() || antes.provider,
    kind: entrada.kind ?? antes.kind,
    contextWindow: entrada.contextWindow === undefined ? antes.context_window : entrada.contextWindow,
    sortOrder: entrada.sortOrder ?? antes.sort_order,
    metadata: JSON.stringify(entrada.metadata ?? safeParse(antes.metadata)),
    assetId: entrada.assetId === undefined ? antes.asset_id : entrada.assetId,
    agora: new Date().toISOString(),
  });
  if (!depois) throw naoEncontrado('modelo nao encontrado');
  await auditar(db, contexto, {
    action: 'model.update',
    targetType: 'model',
    targetId: id,
    before: { name: antes.name, description: antes.description, kind: antes.kind, context_window: antes.context_window },
    after: { name: depois.name, description: depois.description, kind: depois.kind, context_window: depois.context_window },
  });
  return depois;
}

/** a) Ativação global: vale para todos os usuários de uma vez. */
export async function ativarGlobal(
  db: D1Database,
  contexto: Contexto,
  id: string,
  ativo: boolean,
): Promise<ModeloRow> {
  const antes = await catalogo.buscarPorId(db, id);
  if (!antes || antes.deleted_at !== null) throw naoEncontrado('modelo nao encontrado');
  const depois = await catalogo.definirAtivoGlobal(db, id, ativo, new Date().toISOString());
  if (!depois) throw naoEncontrado('modelo nao encontrado');
  await auditar(db, contexto, {
    action: ativo ? 'model.activate_global' : 'model.deactivate_global',
    targetType: 'model',
    targetId: id,
    before: { is_active: antes.is_active },
    after: { is_active: depois.is_active },
    details: { slug: antes.slug },
  });
  return depois;
}

/** b) Ativação individual: exceção em user_models para um usuário. */
export async function alternarParaUsuario(
  db: D1Database,
  contexto: Contexto,
  entrada: { modelId: string; userId: string; habilitado: boolean | null },
): Promise<void> {
  const modelo = await catalogo.buscarPorId(db, entrada.modelId);
  if (!modelo || modelo.deleted_at !== null) throw naoEncontrado('modelo nao encontrado');
  // Import tardio evita ciclo entre serviços de domínio.
  const { definirModelo } = await import('./accountService.js');
  await definirModelo(db, contexto, entrada);
  await auditar(db, contexto, {
    action: 'model.user_override',
    targetType: 'model',
    targetId: entrada.modelId,
    details: { user_id: entrada.userId, habilitado: entrada.habilitado, slug: modelo.slug },
  });
}

export async function remover(
  db: D1Database,
  contexto: Contexto,
  entrada: { id: string; definitivo: boolean },
): Promise<{ removido: 'logico' | 'definitivo' }> {
  const antes = await catalogo.buscarPorId(db, entrada.id);
  if (!antes) throw naoEncontrado('modelo nao encontrado');

  await auditar(db, contexto, {
    action: entrada.definitivo ? 'model.hard_delete' : 'model.soft_delete',
    targetType: 'model',
    targetId: entrada.id,
    before: { slug: antes.slug, name: antes.name, is_active: antes.is_active, deleted_at: antes.deleted_at },
    details: { irreversivel: entrada.definitivo },
  });

  if (entrada.definitivo) {
    await excecoes.removerPorModelo(db, entrada.id);
    await catalogo.deletarDefinitivo(db, entrada.id);
    return { removido: 'definitivo' };
  }
  await catalogo.deletarLogico(db, entrada.id, new Date().toISOString());
  return { removido: 'logico' };
}

export async function restaurar(db: D1Database, contexto: Contexto, id: string): Promise<ModeloRow> {
  const modelo = await catalogo.buscarPorId(db, id);
  if (!modelo) throw naoEncontrado('modelo nao encontrado');
  const agora = new Date().toISOString();
  await db.prepare('UPDATE catalog_models SET deleted_at = NULL, updated_at = ? WHERE id = ?').bind(agora, id).run();
  const depois = await catalogo.buscarPorId(db, id);
  if (!depois) throw naoEncontrado('modelo nao encontrado');
  await auditar(db, contexto, {
    action: 'model.restore',
    targetType: 'model',
    targetId: id,
    before: { deleted_at: modelo.deleted_at },
    after: { deleted_at: depois.deleted_at },
  });
  return depois;
}

export async function efetivosParaUsuario(db: D1Database, userId: string) {
  return catalogo.listarParaUsuario(db, userId);
}

/**
 * O catálogo do painel do ponto de vista de uma conta: o que ele conhece e o que sobrou.
 *
 * `bloqueados` é a resposta que o app usa — os slugs que o painel conhece mas **não**
 * liberou para esta conta, seja porque o modelo foi desativado globalmente, seja porque
 * existe uma exceção individual desligada. Um slug fora daqui é um modelo que o painel
 * nunca cadastrou; o app continua mostrando, porque quem manda no catálogo de verdade é o
 * host, e o painel só tem o direito de **tirar** o que ele mesmo cadastrou.
 */
export async function catalogoDoPainel(db: D1Database, userId: string) {
  const [todos, efetivos] = await Promise.all([
    catalogo.catalogoSimples(db),
    catalogo.listarParaUsuario(db, userId),
  ]);
  const liberados = new Set(efetivos.map((item) => item.slug));
  return {
    catalogo: todos.map((item) => ({ slug: item.slug, name: item.name, ativo: item.is_active === 1 })),
    bloqueados: todos.filter((item) => !liberados.has(item.slug)).map((item) => item.slug),
  };
}

export async function listaPublica(db: D1Database) {
  const modelos = await catalogo.publicos(db);
  return modelos.map((modelo) => ({
    id: modelo.id,
    slug: modelo.slug,
    name: modelo.name,
    description: modelo.description,
    provider: modelo.provider,
    kind: modelo.kind,
    context_window: modelo.context_window,
    sort_order: modelo.sort_order,
    metadata: safeParse(modelo.metadata),
    image_url: modelo.asset_id ? `/api/public/models/${modelo.id}/image` : null,
  }));
}

export async function resumo(db: D1Database) {
  const [contagem, excecoesAtivas] = await Promise.all([catalogo.contar(db), excecoes.contarExcecoes(db)]);
  return { ...contagem, excecoes: excecoesAtivas };
}

function safeParse(valor: string | null): Record<string, unknown> {
  if (!valor) return {};
  try {
    const dados = JSON.parse(valor) as unknown;
    return typeof dados === 'object' && dados !== null && !Array.isArray(dados) ? (dados as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
