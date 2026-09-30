import { getCookie } from 'hono/cookie';
import type { ContextoApp } from '../types.js';
import type { Ator } from '../types.js';
import { corpoForm, consulta, parametros } from '../middlewares/validacao.js';
import {
  filtroContasSchema,
  filtroModelosSchema,
  filtroAuditoriaSchema,
  filtroReleasesSchema,
  formularioLoginSchema,
  identificadorParamSchema,
} from '../validation/schemas.js';
import { AppError } from '../utils/errors.js';
import * as contas from '../services/accountService.js';
import * as modelos from '../services/modelService.js';
import * as versoes from '../services/versionService.js';
import * as auditoria from '../models/auditLog.js';
import * as usuarios from '../models/users.js';
import * as admins from '../models/admins.js';
import { contextoDe } from '../services/auditService.js';
import { loginAdmin } from '../services/authService.js';
import { COOKIE_CSRF, definirCookies, limparCookies, novoTokenCsrf, revogarPorRefresh } from '../services/tokenService.js';
import { COOKIE_REFRESH } from '../services/tokenService.js';
import { pagina, cssDoPainel, jsDoPainel, mensagemDeAviso, mensagemDeErro } from '../views/layout.js';
import { telaDeLogin } from '../views/login.js';
import { paginaPainel, paginaContas, paginaConta } from '../views/painel.js';
import { paginaModelos, paginaVersoes, paginaAuditoria, paginaSeguranca } from '../views/catalogo.js';

import { codigoDeErro } from '../utils/errosDoPainel.js';

// Reexportado: as views e os controllers do painel leem o código daqui.
export { codigoDeErro };

export function csrfDaRequisicao(c: ContextoApp): string | null {
  return getCookie(c, COOKIE_CSRF) ?? null;
}

export function redirecionar(c: ContextoApp, destino: string, dados: { aviso?: string; erro?: string }): Response {
  const url = new URL(destino, new URL(c.req.url).origin);
  if (dados.aviso) url.searchParams.set('aviso', dados.aviso);
  if (dados.erro) url.searchParams.set('erro', dados.erro);
  return c.redirect(url.pathname + url.search, 303);
}

function dadosDoAdmin(c: ContextoApp, ator: Ator, extras: { totp_ativo?: boolean } = {}) {
  return {
    email: ator.email ?? '—',
    papel: String(ator.papel ?? 'admin'),
    totp_ativo: extras.totp_ativo ?? false,
  };
}

/* ------------------------------- GET páginas ------------------------------ */
export async function telaLogin(c: ContextoApp): Promise<Response> {
  const csrfToken = novoTokenCsrf();
  const erro = c.req.query('erro') ?? null;
  const resposta = telaDeLogin({
    csrfToken,
    erro,
    proximo: c.req.query('proximo') ?? '/admin',
    pedirTotp: erro === '2fa-obrigatorio',
  });
  // O token fica em cookie no mesmo caminho: o POST confere os dois.
  resposta.headers.append(
    'set-cookie',
    `${COOKIE_CSRF}=${csrfToken}; Path=/; SameSite=Strict; Max-Age=900${c.get('config').isProduction ? '; Secure' : ''}`,
  );
  return resposta;
}

export async function entrarPeloPainel(c: ContextoApp): Promise<Response> {
  const cfg = c.get('config');
  const dados = await corpoForm(c, formularioLoginSchema);
  try {
    const { sessao, sujeito } = await loginAdmin(
      c.env.DB,
      cfg,
      contextoDe({
        ip: c.get('ip'),
        userAgent: c.get('userAgent'),
        requestId: c.get('requestId'),
        ator: { tipo: 'system', id: null, email: null, papel: null },
      }),
      { email: dados.email, senha: dados.senha, totp: dados.totp ?? null },
    );
    const csrfToken = novoTokenCsrf();
    definirCookies(c, cfg, sessao, csrfToken);
    c.set('ator', { tipo: 'admin', id: sujeito.id, email: sujeito.email, papel: sujeito.papel });
    return redirecionar(c, dados.proximo ?? '/admin', { aviso: 'admin-logado' });
  } catch (erro) {
    return c.redirect(`/admin/login?erro=${encodeURIComponent(codigoDeErro(erro))}`, 303);
  }
}

export async function sairDoPainel(c: ContextoApp): Promise<Response> {
  const refreshToken = getCookie(c, COOKIE_REFRESH) ?? null;
  if (refreshToken) await revogarPorRefresh(c.env.DB, refreshToken, new Date().toISOString()).catch(() => undefined);
  limparCookies(c);
  return c.redirect('/admin/login', 303);
}

export async function paginaInicial(c: ContextoApp): Promise<Response> {
  const ator = c.get('ator');
  const admin = ator.id ? await admins.buscarPorId(c.env.DB, ator.id) : null;

  const [resumoContas, resumoModelos, resumoReleases, totalAuditoria, ultimas] = await Promise.all([
    usuarios.contarPorStatus(c.env.DB),
    modelos.resumo(c.env.DB),
    versoes.resumo(c.env.DB),
    auditoria.contar(c.env.DB),
    auditoria.ultimasAcoes(c.env.DB, 10),
  ]);

  return pagina({
    titulo: 'Painel',
    secao: 'painel',
    csrfToken: csrfDaRequisicao(c),
    admin: dadosDoAdmin(c, ator, { totp_ativo: admin?.totp_enabled === 1 }),
    aviso: c.req.query('aviso') ?? null,
    erro: c.req.query('erro') ?? null,
    conteudo: paginaPainel({
      csrf: csrfDaRequisicao(c),
      admin: {
        email: ator.email ?? '—',
        papel: String(ator.papel ?? 'admin'),
        ultimo_login: admin?.last_login_at ?? null,
      },
      contas: resumoContas,
      modelos: resumoModelos,
      releases: resumoReleases,
      auditoria: { total: totalAuditoria, ultimas },
    }),
  });
}

export async function listarContasPainel(c: ContextoApp): Promise<Response> {
  const filtro = consulta(c, filtroContasSchema);
  const dados = await contas.listar(c.env.DB, {
    ...(filtro.status ? { status: filtro.status } : {}),
    busca: filtro.busca,
    incluirDeletados: filtro.incluir_deletados,
    somenteDeletados: filtro.somente_deletados,
    ordenar: filtro.ordenar,
    direcao: filtro.direcao,
    limite: filtro.por_pagina,
    deslocamento: (filtro.pagina - 1) * filtro.por_pagina,
    pagina: filtro.pagina,
    porPagina: filtro.por_pagina,
  });
  const ator = c.get('ator');
  const admin = ator.id ? await admins.buscarPorId(c.env.DB, ator.id) : null;

  return pagina({
    titulo: 'Contas',
    secao: 'contas',
    csrfToken: csrfDaRequisicao(c),
    admin: dadosDoAdmin(c, ator, { totp_ativo: admin?.totp_enabled === 1 }),
    aviso: c.req.query('aviso') ?? null,
    erro: c.req.query('erro') ?? null,
    conteudo: paginaContas({
      csrf: csrfDaRequisicao(c),
      contas: dados.linhas,
      total: dados.total,
      pagina: filtro.pagina,
      porPagina: filtro.por_pagina,
      filtro: { status: filtro.status, busca: filtro.busca },
    }),
  });
}

export async function detalharContaPainel(c: ContextoApp): Promise<Response> {
  const { id } = parametros(c, identificadorParamSchema);
  const detalhe = await contas.detalhar(c.env.DB, id);
  const catalogo = await modelos.efetivosParaUsuario(c.env.DB, id);
  const ator = c.get('ator');
  const admin = ator.id ? await admins.buscarPorId(c.env.DB, ator.id) : null;

  return pagina({
    titulo: `Conta ${detalhe.conta.email}`,
    secao: 'contas',
    csrfToken: csrfDaRequisicao(c),
    admin: dadosDoAdmin(c, ator, { totp_ativo: admin?.totp_enabled === 1 }),
    aviso: c.req.query('aviso') ?? null,
    erro: c.req.query('erro') ?? null,
    conteudo: paginaConta({
      csrf: csrfDaRequisicao(c),
      conta: detalhe.conta,
      excecoes: detalhe.excecoes,
      avisos: detalhe.avisos,
      sessoesAtivas: detalhe.sessoesAtivas,
      historico: detalhe.historico,
      modelosDisponiveis: catalogo,
    }),
  });
}

export async function listarModelosPainel(c: ContextoApp): Promise<Response> {
  const filtro = consulta(c, filtroModelosSchema);
  const dados = await modelos.listar(c.env.DB, {
    ativo: filtro.ativo,
    busca: filtro.busca,
    incluirDeletados: filtro.incluir_deletados || true,
    ordenar: filtro.ordenar,
    direcao: filtro.direcao,
    limite: filtro.por_pagina,
    deslocamento: (filtro.pagina - 1) * filtro.por_pagina,
    pagina: filtro.pagina,
    porPagina: filtro.por_pagina,
  });
  const ator = c.get('ator');
  const admin = ator.id ? await admins.buscarPorId(c.env.DB, ator.id) : null;

  return pagina({
    titulo: 'Modelos',
    secao: 'modelos',
    csrfToken: csrfDaRequisicao(c),
    admin: dadosDoAdmin(c, ator, { totp_ativo: admin?.totp_enabled === 1 }),
    aviso: c.req.query('aviso') ?? null,
    erro: c.req.query('erro') ?? null,
    conteudo: paginaModelos({ csrf: csrfDaRequisicao(c), modelos: dados.linhas, total: dados.total }),
  });
}

export async function listarVersoesPainel(c: ContextoApp): Promise<Response> {
  const filtro = consulta(c, filtroReleasesSchema);
  const dados = await versoes.listar(c.env.DB, {
    pagina: filtro.pagina,
    porPagina: filtro.por_pagina,
    incluirNaoPublicadas: true,
  });
  const ator = c.get('ator');
  const admin = ator.id ? await admins.buscarPorId(c.env.DB, ator.id) : null;

  return pagina({
    titulo: 'Versoes',
    secao: 'versoes',
    csrfToken: csrfDaRequisicao(c),
    admin: dadosDoAdmin(c, ator, { totp_ativo: admin?.totp_enabled === 1 }),
    aviso: c.req.query('aviso') ?? null,
    erro: c.req.query('erro') ?? null,
    conteudo: paginaVersoes({ csrf: csrfDaRequisicao(c), releases: dados.linhas, total: dados.total }),
  });
}

export async function listarAuditoriaPainel(c: ContextoApp): Promise<Response> {
  const filtro = consulta(c, filtroAuditoriaSchema);
  const dados = await auditoria.listar(c.env.DB, {
    action: filtro.action,
    actorId: filtro.actor_id,
    targetId: filtro.target_id,
    outcome: filtro.outcome,
    de: filtro.de,
    ate: filtro.ate,
    limite: filtro.por_pagina,
    deslocamento: (filtro.pagina - 1) * filtro.por_pagina,
  });
  const verificar = c.req.query('verificar') === '1';
  const integridade = verificar ? await auditoria.verificarIntegridade(c.env.DB, { limite: 500 }) : undefined;
  const ator = c.get('ator');
  const admin = ator.id ? await admins.buscarPorId(c.env.DB, ator.id) : null;

  return pagina({
    titulo: 'Auditoria',
    secao: 'auditoria',
    csrfToken: csrfDaRequisicao(c),
    admin: dadosDoAdmin(c, ator, { totp_ativo: admin?.totp_enabled === 1 }),
    aviso: verificar && integridade?.ok ? 'auditoria-ok' : (c.req.query('aviso') ?? null),
    erro: verificar && integridade && !integridade.ok ? 'erro-interno' : (mensagemDeErro(c.req.query('erro')) ? 'erro-interno' : null),
    conteudo: paginaAuditoria({
      csrf: csrfDaRequisicao(c),
      entradas: dados.linhas,
      total: dados.total,
      pagina: filtro.pagina,
      porPagina: filtro.por_pagina,
      filtro: { action: filtro.action, actor_id: filtro.actor_id, target_id: filtro.target_id, outcome: filtro.outcome },
      ...(integridade ? { integridade } : {}),
    }),
  });
}

export async function paginaDeSeguranca(c: ContextoApp): Promise<Response> {
  const ator = c.get('ator');
  const admin = ator.id ? await admins.buscarPorId(c.env.DB, ator.id) : null;
  if (!admin) return c.redirect('/admin/login', 303);

  return pagina({
    titulo: 'Seguranca',
    secao: 'seguranca',
    csrfToken: csrfDaRequisicao(c),
    admin: dadosDoAdmin(c, ator, { totp_ativo: admin.totp_enabled === 1 }),
    aviso: c.req.query('aviso') ?? null,
    erro: c.req.query('erro') ?? null,
    conteudo: paginaSeguranca({
      csrf: csrfDaRequisicao(c),
      admin: {
        email: admin.email,
        papel: admin.role,
        totp_ativo: admin.totp_enabled === 1,
        ultimo_login: admin.last_login_at,
        ultimo_ip: admin.last_login_ip,
      },
    }),
  });
}

/* ------------------------------ assets estáticos ------------------------- */
export function servirCss(c: ContextoApp): Response {
  void c;
  return new Response(cssDoPainel(), {
    headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });
}

export function servirJs(c: ContextoApp): Response {
  void c;
  return new Response(jsDoPainel(), {
    headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });
}

export const internos = { mensagemDeAviso };
