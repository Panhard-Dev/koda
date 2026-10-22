import type { ContextoApp } from '../types.js';
import { corpoJson, consulta, parametros } from '../middlewares/validacao.js';
import {
  ativacaoModeloSchema,
  filtroModelosSchema,
  identificadorParamSchema,
  modeloEntradaSchema,
  overrideSchema,
} from '../validation/schemas.js';
import * as modelos from '../services/modelService.js';
import * as uploads from '../services/uploadService.js';
import { contextoDe } from '../services/auditService.js';
import { requisicaoInvalida } from '../utils/errors.js';

function contexto(c: ContextoApp) {
  return contextoDe({
    ip: c.get('ip'),
    userAgent: c.get('userAgent'),
    requestId: c.get('requestId'),
    ator: c.get('ator'),
  });
}

/** GET /admin/api/models */
export async function listar(c: ContextoApp) {
  const filtro = consulta(c, filtroModelosSchema);
  const dados = await modelos.listar(c.env.DB, {
    ativo: filtro.ativo,
    busca: filtro.busca,
    incluirDeletados: filtro.incluir_deletados,
    ordenar: filtro.ordenar,
    direcao: filtro.direcao,
    limite: filtro.por_pagina,
    deslocamento: (filtro.pagina - 1) * filtro.por_pagina,
    pagina: filtro.pagina,
    porPagina: filtro.por_pagina,
  });
  return c.json({ ok: true, modelos: dados.linhas, total: dados.total, pagina: dados.pagina, por_pagina: dados.porPagina });
}

/** GET /admin/api/models/:id */
export async function obter(c: ContextoApp) {
  const { id } = parametros(c, identificadorParamSchema);
  return c.json({ ok: true, ...(await modelos.obter(c.env.DB, id)) });
}

/** POST /admin/api/models */
export async function criar(c: ContextoApp) {
  const dados = await corpoJson(c, modeloEntradaSchema);
  const modelo = await modelos.criar(c.env.DB, contexto(c), {
    slug: dados.slug,
    name: dados.name,
    description: dados.description ?? null,
    provider: dados.provider,
    kind: dados.kind,
    contextWindow: dados.context_window ?? null,
    ativo: dados.ativo ?? true,
    sortOrder: dados.sort_order,
    metadata: dados.metadata ?? {},
    assetId: dados.asset_id ?? null,
  });
  return c.json({ ok: true, modelo }, 201);
}

/** PATCH /admin/api/models/:id */
export async function editar(c: ContextoApp) {
  const { id } = parametros(c, identificadorParamSchema);
  const dados = await corpoJson(c, modeloEntradaSchema);
  const modelo = await modelos.editar(c.env.DB, contexto(c), id, {
    name: dados.name,
    description: dados.description ?? null,
    provider: dados.provider,
    kind: dados.kind,
    contextWindow: dados.context_window ?? null,
    sortOrder: dados.sort_order,
    metadata: dados.metadata ?? {},
    assetId: dados.asset_id ?? null,
  });
  return c.json({ ok: true, modelo });
}

/** POST /admin/api/models/:id/activate | /deactivate (global) */
export async function ativarGlobal(c: ContextoApp) {
  const { id } = parametros(c, identificadorParamSchema);
  const dados = await corpoJson(c, ativacaoModeloSchema);
  const modelo = await modelos.ativarGlobal(c.env.DB, contexto(c), id, dados.ativo);
  return c.json({ ok: true, modelo, escopo: 'global' });
}

/** POST /admin/api/models/:id/restore */
export async function restaurar(c: ContextoApp) {
  const { id } = parametros(c, identificadorParamSchema);
  const modelo = await modelos.restaurar(c.env.DB, contexto(c), id);
  return c.json({ ok: true, modelo });
}

/** DELETE /admin/api/models/:id?definitivo=1 */
export async function remover(c: ContextoApp) {
  const { id } = parametros(c, identificadorParamSchema);
  const definitivo = ['1', 'true'].includes((c.req.query('definitivo') ?? '').toLowerCase());
  const resultado = await modelos.remover(c.env.DB, contexto(c), { id, definitivo });
  return c.json({ ok: true, ...resultado });
}

/** POST /admin/api/models/:id/users/:userId — ativação individual. */
export async function definirParaUsuario(c: ContextoApp) {
  const modelId = c.req.param('id') ?? '';
  const userId = c.req.param('userId') ?? '';
  if (!modelId || !userId) throw requisicaoInvalida('ids obrigatorios');
  const dados = await corpoJson(c, overrideSchema);
  await modelos.alternarParaUsuario(c.env.DB, contexto(c), { modelId, userId, habilitado: dados.habilitado });

  const efetivos = await modelos.efetivosParaUsuario(c.env.DB, userId);
  return c.json({ ok: true, escopo: 'usuario', modelos_efetivos: efetivos.map((item) => item.slug) });
}

/** POST /admin/api/uploads (multipart/form-data) */
export async function enviarArquivo(c: ContextoApp) {
  const cfg = c.get('config');
  const declarado = Number(c.req.header('content-length') ?? '0');
  if (Number.isFinite(declarado) && declarado > cfg.uploadMaxBytes + 4_096) {
    throw requisicaoInvalida(`corpo maior que o limite de ${cfg.uploadMaxBytes} bytes`);
  }

  let formulario: FormData;
  try {
    formulario = await c.req.formData();
  } catch {
    throw requisicaoInvalida('envie multipart/form-data com o campo arquivo');
  }

  const arquivo = formulario.get('arquivo');
  if (!(arquivo instanceof File)) throw requisicaoInvalida('campo arquivo ausente');
  const bytes = new Uint8Array(await arquivo.arrayBuffer());
  const kindBruto = formulario.get('kind');
  const kind = typeof kindBruto === 'string' && /^[a-z0-9-]{2,32}$/.test(kindBruto) ? kindBruto : 'model-image';

  const salvo = await uploads.salvar(c.env.DB, cfg, contexto(c), {
    arquivo: { nome: arquivo.name, mimeDeclarado: arquivo.type, bytes },
    kind,
  });

  const modelId = formulario.get('model_id');
  if (typeof modelId === 'string' && modelId !== '') {
    const modelo = await modelos.obter(c.env.DB, modelId);
    await modelos.editar(c.env.DB, contexto(c), modelId, {
      name: modelo.modelo.name,
      description: modelo.modelo.description,
      provider: modelo.modelo.provider,
      kind: modelo.modelo.kind,
      contextWindow: modelo.modelo.context_window,
      sortOrder: modelo.modelo.sort_order,
      assetId: salvo.id,
    });
  }

  return c.json({ ok: true, arquivo: salvo }, 201);
}

/** GET /admin/api/uploads */
export async function listarArquivos(c: ContextoApp) {
  const lista = await uploads.listarAssets(c.env.DB, 'model-image');
  return c.json({ ok: true, arquivos: lista });
}

/** DELETE /admin/api/uploads/:id */
export async function removerArquivo(c: ContextoApp) {
  const { id } = parametros(c, identificadorParamSchema);
  await uploads.removerAsset(c.env.DB, contexto(c), id);
  return c.json({ ok: true });
}
