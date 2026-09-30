import type { ContextoApp } from '../types.js';
import { corpoJson, consulta, parametros } from '../middlewares/validacao.js';
import {
  acaoContaSchema,
  avisoSchema,
  criarContaSchema,
  deletarContaSchema,
  filtroContasSchema,
  identificadorParamSchema,
  overrideSchema,
  suspenderContaSchema,
} from '../validation/schemas.js';
import * as contas from '../services/accountService.js';
import * as modelos from '../services/modelService.js';
import * as releases from '../services/versionService.js';
import * as auditoria from '../models/auditLog.js';
import { gerarSenhaAleatoria, hashSenha, politicaDeSenha } from '../services/passwordService.js';
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

/** GET /admin/api/accounts */
export async function listar(c: ContextoApp) {
  const filtro = consulta(c, filtroContasSchema);
  const dados = await contas.listar(c.env.DB, {
    ...(filtro.status ? { status: filtro.status } : {}),
    busca: filtro.busca,
    criadoDe: filtro.criado_de,
    criadoAte: filtro.criado_ate,
    incluirDeletados: filtro.incluir_deletados,
    somenteDeletados: filtro.somente_deletados,
    ordenar: filtro.ordenar,
    direcao: filtro.direcao,
    limite: filtro.por_pagina,
    deslocamento: (filtro.pagina - 1) * filtro.por_pagina,
    pagina: filtro.pagina,
    porPagina: filtro.por_pagina,
  });
  return c.json({
    ok: true,
    contas: dados.linhas.map(contas.publico),
    total: dados.total,
    pagina: dados.pagina,
    por_pagina: dados.porPagina,
    resumo: dados.resumo,
  });
}

/** GET /admin/api/accounts/:id */
export async function detalhar(c: ContextoApp) {
  const { id } = parametros(c, identificadorParamSchema);
  return c.json({ ok: true, ...(await contas.detalhar(c.env.DB, id)) });
}

/** POST /admin/api/accounts */
export async function criar(c: ContextoApp) {
  const cfg = c.get('config');
  const dados = await corpoJson(c, criarContaSchema);
  const senhaTemporaria = dados.senha ?? (await gerarSenhaAleatoria(20));
  const motivo = politicaDeSenha(senhaTemporaria, { email: dados.email });
  if (motivo) throw requisicaoInvalida(motivo);

  const hash = await hashSenha(senhaTemporaria, {
    algo: cfg.hashAlgo,
    bcryptCost: cfg.bcryptCost,
    pbkdf2Iterations: cfg.pbkdf2Iterations,
  });
  const conta = await contas.criarConta(c.env.DB, contexto(c), cfg, {
    email: dados.email,
    senhaHash: hash,
    nome: dados.nome ?? null,
  });
  return c.json(
    {
      ok: true,
      conta: contas.publico(conta),
      // A senha em claro aparece uma única vez, e só quando o painel a gerou.
      ...(dados.senha ? {} : { senha_temporaria: senhaTemporaria, aviso: 'entregue a senha uma unica vez' }),
    },
    201,
  );
}

/** POST /admin/api/accounts/:id/ban */
export async function banir(c: ContextoApp) {
  const { id } = parametros(c, identificadorParamSchema);
  const dados = await corpoJson(c, acaoContaSchema);
  const conta = await contas.banir(c.env.DB, contexto(c), { id, motivo: dados.motivo });
  return c.json({ ok: true, conta: contas.publico(conta), tokens_invalidados: true });
}

/** POST /admin/api/accounts/:id/suspend */
export async function suspender(c: ContextoApp) {
  const { id } = parametros(c, identificadorParamSchema);
  const dados = await corpoJson(c, suspenderContaSchema);
  const conta = await contas.suspender(c.env.DB, contexto(c), { id, motivo: dados.motivo, horas: dados.horas });
  return c.json({ ok: true, conta: contas.publico(conta), tokens_invalidados: true });
}

/** POST /admin/api/accounts/:id/reactivate */
export async function reativar(c: ContextoApp) {
  const { id } = parametros(c, identificadorParamSchema);
  const dados = await corpoJson(c, acaoContaSchema);
  const conta = await contas.reativar(c.env.DB, contexto(c), { id, motivo: dados.motivo });
  return c.json({ ok: true, conta: contas.publico(conta) });
}

/** POST /admin/api/accounts/:id/delete (soft delete) */
export async function remover(c: ContextoApp) {
  const { id } = parametros(c, identificadorParamSchema);
  const dados = await corpoJson(c, deletarContaSchema);
  const conta = await contas.deletarLogico(c.env.DB, contexto(c), { id, motivo: dados.motivo });
  return c.json({ ok: true, conta: contas.publico(conta), soft_delete: true, tokens_invalidados: true });
}

/** POST /admin/api/accounts/:id/restore */
export async function restaurar(c: ContextoApp) {
  const { id } = parametros(c, identificadorParamSchema);
  const dados = await corpoJson(c, acaoContaSchema);
  const conta = await contas.restaurar(c.env.DB, contexto(c), { id, motivo: dados.motivo });
  return c.json({ ok: true, conta: contas.publico(conta) });
}

/** DELETE /admin/api/accounts/:id?confirmacao=email (hard delete, superadmin) */
export async function deletarDefinitivo(c: ContextoApp) {
  const { id } = parametros(c, identificadorParamSchema);
  const dados = await corpoJson(c, deletarContaSchema);
  const confirmacao = dados.confirmacao ?? c.req.query('confirmacao') ?? '';
  const resultado = await contas.deletarDefinitivo(c.env.DB, contexto(c), { id, confirmacao });
  return c.json({ ok: true, ...resultado });
}

/** POST /admin/api/accounts/:id/notify */
export async function avisar(c: ContextoApp) {
  const { id } = parametros(c, identificadorParamSchema);
  const dados = await corpoJson(c, avisoSchema);
  const notificacaoId = await contas.avisar(c.env.DB, contexto(c), {
    id,
    titulo: dados.titulo,
    corpo: dados.corpo,
    severidade: dados.severidade,
  });
  return c.json({ ok: true, notificacao_id: notificacaoId }, 201);
}

/** PUT /admin/api/accounts/:id/models/:modelId */
export async function definirModelo(c: ContextoApp) {
  const corpo = await corpoJson(c, overrideSchema);
  const modelId = c.req.param('modelId') ?? '';
  const userId = c.req.param('id') ?? '';
  if (!modelId || !userId) throw requisicaoInvalida('ids obrigatorios');
  await modelos.alternarParaUsuario(c.env.DB, contexto(c), {
    userId,
    modelId,
    habilitado: corpo.habilitado,
  });
  const efetivos = await modelos.efetivosParaUsuario(c.env.DB, userId);
  return c.json({ ok: true, modelos_efetivos: efetivos.map((item) => item.slug) });
}

/** GET /admin/api/overview */
export async function painel(c: ContextoApp) {
  const [resumoContas, resumoModelos, resumoReleases] = await Promise.all([
    c.env.DB.prepare('SELECT status, COUNT(*) AS total FROM users WHERE deleted_at IS NULL GROUP BY status').all<{
      status: string;
      total: number;
    }>(),
    modelos.resumo(c.env.DB),
    releases.resumo(c.env.DB),
  ]);
  const porStatus: Record<string, number> = { active: 0, suspended: 0, banned: 0 };
  for (const linha of resumoContas.results ?? []) porStatus[linha.status] = Number(linha.total);

  const [totalAuditoria, ultimas] = await Promise.all([auditoria.contar(c.env.DB), auditoria.ultimasAcoes(c.env.DB, 10)]);

  return c.json({
    ok: true,
    contas: porStatus,
    modelos: resumoModelos,
    releases: resumoReleases,
    auditoria: { total: totalAuditoria, ultimas },
    admin: c.get('ator'),
  });
}
