import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Aplicacao } from '../types.js';
import { COOKIE_CSRF } from '../services/tokenService.js';
import { acessoNegado } from '../utils/errors.js';
import { extrairBearer } from '../utils/request.js';
import { timingSafeEqualStr } from '../utils/crypto.js';

const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);

async function tokenEnviado(c: Parameters<MiddlewareHandler<Aplicacao>>[0]): Promise<string> {
  const doCabecalho = c.req.header('x-koda-csrf') ?? '';
  if (doCabecalho !== '') return doCabecalho;

  const tipo = c.req.header('content-type') ?? '';
  if (!tipo.includes('form')) return '';
  try {
    const corpo = await c.req.parseBody();
    const campo = corpo['csrf'];
    return typeof campo === 'string' ? campo : '';
  } catch {
    return '';
  }
}

/**
 * Duplo envio (double submit): o cookie CSRF não é httpOnly e o cliente devolve
 * o valor no cabeçalho `x-koda-csrf` (fetch) ou no campo oculto `csrf` (form).
 * Requisição com Bearer não carrega credencial ambiente — CSRF não se aplica.
 */
export const exigirCsrf: MiddlewareHandler<Aplicacao> = async (c, next) => {
  if (METODOS_SEGUROS.has(c.req.method) || extrairBearer(c.req.raw)) {
    await next();
    return;
  }

  // Sem cookie não existe credencial ambiente para terceiro usar: é cliente de
  // API (JSON) ou primeira chamada.
  if ((c.req.header('cookie') ?? '') === '') {
    await next();
    return;
  }

  const doCookie = getCookie(c, COOKIE_CSRF) ?? '';
  const enviado = await tokenEnviado(c);
  if (doCookie === '' || enviado === '' || !timingSafeEqualStr(doCookie, enviado)) {
    throw acessoNegado('invalid_csrf', 'token CSRF ausente ou divergente');
  }
  c.set('csrfToken', doCookie);
  await next();
};
