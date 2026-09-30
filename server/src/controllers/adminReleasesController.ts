import type { ContextoApp } from '../types.js';
import { corpoJson, consulta, parametros } from '../middlewares/validacao.js';
import {
  filtroReleasesSchema,
  identificadorParamSchema,
  releaseEdicaoSchema,
  releaseEntradaSchema,
} from '../validation/schemas.js';
import * as versoes from '../services/versionService.js';
import { contextoDe } from '../services/auditService.js';

function contexto(c: ContextoApp) {
  return contextoDe({
    ip: c.get('ip'),
    userAgent: c.get('userAgent'),
    requestId: c.get('requestId'),
    ator: c.get('ator'),
  });
}

/** GET /admin/api/releases */
export async function listar(c: ContextoApp) {
  const filtro = consulta(c, filtroReleasesSchema);
  const dados = await versoes.listar(c.env.DB, {
    pagina: filtro.pagina,
    porPagina: filtro.por_pagina,
    incluirNaoPublicadas: filtro.incluir_nao_publicadas || true,
  });
  return c.json({ ok: true, releases: dados.linhas, total: dados.total, pagina: dados.pagina, por_pagina: dados.porPagina });
}

/** POST /admin/api/releases */
export async function publicar(c: ContextoApp) {
  const dados = await corpoJson(c, releaseEntradaSchema);
  const release = await versoes.publicar(c.env.DB, c.get('config'), contexto(c), {
    version: dados.version,
    downloadUrl: dados.download_url,
    notes: dados.notes ?? null,
    channel: dados.channel,
    mandatory: dados.mandatory ?? false,
    minSupportedVersion: dados.min_supported_version ?? null,
    publicado: dados.publicado ?? true,
  });
  return c.json({ ok: true, release }, 201);
}

/** PATCH /admin/api/releases/:id */
export async function editar(c: ContextoApp) {
  const { id } = parametros(c, identificadorParamSchema);
  const dados = await corpoJson(c, releaseEdicaoSchema);
  const release = await versoes.editar(c.env.DB, c.get('config'), contexto(c), id, {
    downloadUrl: dados.download_url,
    notes: dados.notes ?? null,
    channel: dados.channel,
    mandatory: dados.mandatory,
    minSupportedVersion: dados.min_supported_version ?? null,
  });
  return c.json({ ok: true, release });
}

/** POST /admin/api/releases/:id/publish | /unpublish */
export async function definirPublicacao(c: ContextoApp) {
  const { id } = parametros(c, identificadorParamSchema);
  const publicado = c.req.path.endsWith('/publish');
  const release = await versoes.definirPublicacao(c.env.DB, contexto(c), id, publicado);
  return c.json({ ok: true, release });
}

/** DELETE /admin/api/releases/:id */
export async function remover(c: ContextoApp) {
  const { id } = parametros(c, identificadorParamSchema);
  await versoes.remover(c.env.DB, contexto(c), id);
  return c.json({ ok: true });
}
