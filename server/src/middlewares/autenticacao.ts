import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Aplicacao, Ator, ContextoApp } from '../types.js';
import type { Role } from '../config/env.js';
import * as admins from '../models/admins.js';
import * as usuarios from '../models/users.js';
import { AppError, acessoNegado, naoAutenticado } from '../utils/errors.js';
import { extrairBearer } from '../utils/request.js';
import {
  COOKIE_ACCESS,
  COOKIE_REFRESH,
  familiaAtiva,
  tokenAnteriorAoPiso,
  validarAccess,
} from '../services/tokenService.js';
import type { ClaimsAccess } from '../utils/jwt.js';

type Papel = Role | 'user';

function tokenDaRequisicao(c: Parameters<MiddlewareHandler<Aplicacao>>[0]): { token: string | null; viaCookie: boolean } {
  const bearer = extrairBearer(c.req.raw);
  if (bearer) return { token: bearer, viaCookie: false };
  const cookie = getCookie(c, COOKIE_ACCESS);
  if (cookie) return { token: cookie, viaCookie: true };
  return { token: null, viaCookie: false };
}

/**
 * Verifica o access token e recarrega o sujeito no banco. Tudo é revalidado a
 * cada requisição: token antigo (piso de emissão), sessão revogada e conta
 * suspensa deixam de funcionar na hora.
 */
/**
 * A conta por trás de um access token do público `app`, com tudo revalidado no banco.
 *
 * Separado de `autenticar` porque o token nem sempre chega no cabeçalho: o host local
 * recebe a chave no corpo e a repassa para o painel, então quem valida precisa de uma
 * porta que aceite um token em mãos. É a mesma régua das rotas de conta — conta
 * existente, não apagada, ativa, fora do piso de emissão e com a sessão viva.
 */
async function contaDoClaims(
  c: Parameters<MiddlewareHandler<Aplicacao>>[0],
  claims: ClaimsAccess,
): Promise<Ator> {
  const agora = new Date().toISOString();
  const conta = await usuarios.buscarPorId(c.env.DB, claims.sub);
  if (!conta || conta.deleted_at !== null) throw naoAutenticado('invalid_token', 'conta inexistente');
  if (tokenAnteriorAoPiso(claims.iat, conta.tokens_valid_from)) {
    throw naoAutenticado('token_revoked', 'token anterior a mudanca de status');
  }
  if (conta.status !== 'active') {
    throw acessoNegado(conta.status === 'banned' ? 'account_banned' : 'account_suspended', 'conta sem acesso');
  }
  if (!(await familiaAtiva(c.env.DB, claims.sid, agora))) {
    throw naoAutenticado('token_revoked', 'sessao encerrada');
  }
  c.set('sessaoFamilia', claims.sid);
  return { tipo: 'user', id: conta.id, email: conta.email, papel: 'user' };
}

/**
 * Essa sessão de conta vale? Sem lançar: `null` para qualquer recusa, motivo junto.
 *
 * É o que a autorização do host local usa — lá a resposta é sim ou não, e um token
 * inválido não pode virar erro 500 na cara de quem só perguntou.
 */
export async function contaDoToken(c: ContextoApp, token: string): Promise<Ator | null> {
  try {
    return await contaDoClaims(c, await validarAccess(token, c.get('config'), 'app'));
  } catch {
    return null;
  }
}

async function autenticar(c: Parameters<MiddlewareHandler<Aplicacao>>[0], publico: 'admin' | 'app'): Promise<Ator> {
  const config = c.get('config');
  const { token } = tokenDaRequisicao(c);
  if (!token) throw naoAutenticado('missing_token');

  let claims;
  try {
    claims = await validarAccess(token, config, publico);
  } catch (erro) {
    // Token legítimo do app tentando rota de admin: 403, não 401.
    if (publico === 'admin' && erro instanceof AppError && erro.code === 'invalid_token') {
      try {
        await validarAccess(token, config, 'app');
        throw acessoNegado('insufficient_role', 'token de conta comum');
      } catch (segundo) {
        if (segundo instanceof AppError && segundo.code === 'insufficient_role') throw segundo;
      }
    }
    throw erro;
  }

  const agora = new Date().toISOString();
  if (publico === 'admin') {
    const admin = await admins.buscarPorId(c.env.DB, claims.sub);
    if (!admin) throw naoAutenticado('invalid_token', 'admin inexistente');
    if (admin.locked_until !== null && admin.locked_until > agora) {
      throw acessoNegado('account_locked', 'admin temporariamente bloqueado');
    }
    if (tokenAnteriorAoPiso(claims.iat, admin.tokens_valid_from)) {
      throw naoAutenticado('token_revoked', 'token anterior a troca de credenciais');
    }
    if (!(await familiaAtiva(c.env.DB, claims.sid, agora))) {
      throw naoAutenticado('token_revoked', 'sessao encerrada');
    }
    c.set('sessaoFamilia', claims.sid);
    return { tipo: 'admin', id: admin.id, email: admin.email, papel: admin.role };
  }

  return contaDoClaims(c, claims);
}

/** Rotas /admin/*: JWT válido + papel de admin. */
export function exigirAdmin(opcoes: { papeis?: Papel[] } = {}): MiddlewareHandler<Aplicacao> {
  const permitidos = opcoes.papeis ?? ['admin', 'superadmin'];
  return async (c, next) => {
    const ator = await autenticar(c, 'admin');
    if (ator.papel === null || !permitidos.includes(ator.papel)) {
      throw acessoNegado('insufficient_role', `papel ${String(ator.papel)} sem permissao`);
    }
    c.set('ator', ator);
    await next();
  };
}

/** Checa o papel já autenticado (usar depois de exigirAdmin). */
export function exigirPapel(papeis: Papel[]): MiddlewareHandler<Aplicacao> {
  return async (c, next) => {
    const ator = c.get('ator');
    if (ator.papel === null || !papeis.includes(ator.papel)) {
      throw acessoNegado('insufficient_role', `papel ${String(ator.papel)} sem permissao`);
    }
    await next();
  };
}

/** Rotas de conta do app: JWT do público `app` e conta ativa. */
export function exigirConta(): MiddlewareHandler<Aplicacao> {
  return async (c, next) => {
    const ator = await autenticar(c, 'app');
    c.set('ator', ator);
    await next();
  };
}

/**
 * Tenta autenticar sem exigir: o painel usa tanto nas páginas (GET) quanto nas
 * ações de formulário (POST). Nunca lança — quem chama decide o que fazer sem
 * ator (no painel, voltar para o login).
 */
export async function adminOpcional(c: ContextoApp): Promise<Ator | null> {
  try {
    const ator = await autenticar(c, 'admin');
    c.set('ator', ator);
    return ator;
  } catch {
    return null;
  }
}

export function tokenDeRefresh(c: ContextoApp): string | null {
  return getCookie(c, COOKIE_REFRESH) ?? null;
}
