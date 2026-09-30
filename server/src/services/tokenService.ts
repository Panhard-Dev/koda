import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import type { Config, Role } from '../config/env.js';
import { EMISSOR, agoraS, assinarToken, verificarToken } from '../utils/jwt.js';
import type { ClaimsAccess, ClaimsRefresh } from '../utils/jwt.js';
import { randomBase64Url, sha256Hex, uuid } from '../utils/crypto.js';
import { naoAutenticado } from '../utils/errors.js';
import * as tokens from '../models/refreshTokens.js';
import * as admins from '../models/admins.js';
import * as usuarios from '../models/users.js';

export const COOKIE_ACCESS = 'koda_admin_at';
export const COOKIE_REFRESH = 'koda_admin_rt';
export const COOKIE_CSRF = 'koda_admin_csrf';

export interface Sujeito {
  tipo: 'admin' | 'user';
  id: string;
  email: string | null;
  papel: Role | 'user';
  /**
   * Nome de exibição da conta, quando existe (o painel o chama de `display_name`).
   *
   * Vai junto na sessão porque o app precisa dizer ao assistente com quem está falando —
   * e buscar isso numa segunda requisição depois de entrar só para exibir um nome é
   * trabalho à toa. Admin não tem: fica ausente.
   */
  nome?: string | null;
}

export interface Sessao {
  accessToken: string;
  refreshToken: string;
  familia: string;
  accessExpiraEm: string;
  refreshExpiraEm: string;
  accessTtlS: number;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const hashDoRefresh = (token: string): Promise<string> => sha256Hex(`refresh:${token}`);

/**
 * Emite o par access + refresh. O refresh só existe em claro na resposta: no
 * banco fica o SHA-256 dele.
 */
export async function emitirSessao(
  db: D1Database,
  cfg: Config,
  opcoes: {
    sujeito: Sujeito;
    aud: 'admin' | 'app';
    ip: string | null;
    userAgent: string | null;
    familia?: string;
  },
): Promise<Sessao> {
  const agora = agoraS();
  const familia = opcoes.familia ?? uuid();
  const refreshToken = randomBase64Url(48);
  const accessExpira = agora + cfg.accessTtlS;
  const refreshExpira = agora + cfg.refreshTtlS;

  const claims: ClaimsAccess = {
    sub: opcoes.sujeito.id,
    typ: 'access',
    aud: opcoes.aud,
    iss: EMISSOR,
    iat: agora,
    exp: accessExpira,
    sid: familia,
    role: opcoes.sujeito.papel,
    ...(opcoes.sujeito.email ? { email: opcoes.sujeito.email } : {}),
  };

  await tokens.criar(db, {
    id: uuid(),
    subjectType: opcoes.sujeito.tipo,
    subjectId: opcoes.sujeito.id,
    tokenHash: await hashDoRefresh(refreshToken),
    familyId: familia,
    expiraEm: iso(refreshExpira * 1000),
    ip: opcoes.ip,
    userAgent: opcoes.userAgent,
    agora: iso(agora * 1000),
  });

  return {
    accessToken: await assinarToken(claims, cfg.secrets.jwt),
    refreshToken,
    familia,
    accessExpiraEm: iso(accessExpira * 1000),
    refreshExpiraEm: iso(refreshExpira * 1000),
    accessTtlS: cfg.accessTtlS,
  };
}

/**
 * Rotação de refresh: o token apresentado é queimado e um novo nasce na mesma
 * família. Token já usado de novo = sinal de roubo → a família inteira cai.
 */
export async function rotacionarSessao(
  db: D1Database,
  cfg: Config,
  opcoes: { refreshToken: string; aud: 'admin' | 'app'; ip: string | null; userAgent: string | null },
): Promise<{ sessao: Sessao; sujeito: Sujeito }> {
  const agora = new Date().toISOString();
  const linha = await tokens.buscarPorHash(db, await hashDoRefresh(opcoes.refreshToken));
  if (!linha) throw naoAutenticado('invalid_token', 'refresh desconhecido');

  if (linha.revoked_at !== null) {
    // Reuso: alguém tem uma cópia. Derruba a família toda.
    await tokens.revogarFamilia(db, linha.family_id, agora);
    throw naoAutenticado('refresh_reuse', 'refresh token reutilizado');
  }
  if (linha.expires_at <= agora) throw naoAutenticado('token_expired', 'refresh expirado');
  if (linha.subject_type === 'admin' ? opcoes.aud !== 'admin' : opcoes.aud !== 'app') {
    throw naoAutenticado('invalid_token', 'publico do refresh nao confere');
  }

  const sujeito = await carregarSujeito(db, linha.subject_type, linha.subject_id, agora);
  if (!sujeito) throw naoAutenticado('invalid_token', 'sujeito inexistente ou inativo');

  // Marca o uso ANTES de emitir o novo: se outra requisição chegar com o mesmo
  // token, o `changes` será 0 e ela falha (rotação de uso único).
  const consumo = await tokens.marcarUsado(db, linha.id, 'pendente', agora);
  if (consumo.changes !== 1) {
    await tokens.revogarFamilia(db, linha.family_id, agora);
    throw naoAutenticado('refresh_reuse', 'refresh token ja utilizado');
  }

  const sessao = await emitirSessao(db, cfg, {
    sujeito,
    aud: opcoes.aud,
    ip: opcoes.ip,
    userAgent: opcoes.userAgent,
    familia: linha.family_id,
  });
  return { sessao, sujeito };
}

export async function carregarSujeito(
  db: D1Database,
  tipo: 'admin' | 'user',
  id: string,
  agora: string,
): Promise<Sujeito | null> {
  if (tipo === 'admin') {
    const admin = await admins.buscarPorId(db, id);
    if (!admin) return null;
    if (admin.locked_until !== null && admin.locked_until > agora) return null;
    return { tipo: 'admin', id: admin.id, email: admin.email, papel: admin.role };
  }
  const conta = await usuarios.buscarPorId(db, id);
  if (!conta || conta.deleted_at !== null) return null;
  if (conta.status !== 'active') return null;
  // O nome entra aqui também: é por esta função que passa **toda renovação**, e sem ele um
  // refresh devolveria a conta sem nome — o app regravaria a sessão sem ele e o assistente
  // esqueceria com quem estava falando no meio do dia.
  return {
    tipo: 'user',
    id: conta.id,
    email: conta.email,
    papel: 'user',
    nome: conta.display_name,
  };
}

export async function revogarPorRefresh(db: D1Database, refreshToken: string, agora: string): Promise<void> {
  const linha = await tokens.buscarPorHash(db, await hashDoRefresh(refreshToken));
  if (!linha) return;
  await tokens.revogar(db, linha.id, agora);
}

/**
 * Invalidação imediata: revoga todos os refresh ativos E marca o piso de
 * emissão. Qualquer access token já emitido deixa de valer no próximo uso.
 */
export async function revogarTudo(
  db: D1Database,
  alvo: { tipo: 'admin' | 'user'; id: string },
  agora: string,
): Promise<{ sessoesRevogadas: number }> {
  const sessoesRevogadas = await tokens.revogarTudoDoSujeito(db, alvo.tipo === 'admin' ? 'admin' : 'user', alvo.id, agora);
  if (alvo.tipo === 'admin') await admins.invalidarTokens(db, alvo.id, agora);
  else await usuarios.invalidarTokens(db, alvo.id, agora);
  return { sessoesRevogadas };
}

export async function familiaAtiva(db: D1Database, familia: string, agora: string): Promise<boolean> {
  const linhas = await db
    .prepare('SELECT COUNT(*) AS total FROM refresh_tokens WHERE family_id = ? AND revoked_at IS NULL AND expires_at > ?')
    .bind(familia, agora)
    .first<{ total: number }>();
  return Number(linhas?.total ?? 0) > 0;
}

/**
 * Diz se o token é anterior ao piso de emissão do sujeito. A tolerância de 1
 * segundo existe porque `iat` só tem precisão de segundo.
 */
export function tokenAnteriorAoPiso(iatSegundos: number, pisoIso: string): boolean {
  const piso = Date.parse(pisoIso);
  if (!Number.isFinite(piso)) return false;
  return iatSegundos * 1000 + 1000 < piso;
}

export async function validarAccess(
  token: string,
  cfg: Config,
  aud: 'admin' | 'app',
): Promise<ClaimsAccess> {
  return verificarToken<ClaimsAccess>(token, cfg.secrets.jwt, { typ: 'access', aud });
}

export async function validarRefreshClaims(token: string, cfg: Config): Promise<ClaimsRefresh> {
  return verificarToken<ClaimsRefresh>(token, cfg.secrets.jwt, { typ: 'refresh', aud: 'admin' });
}

/* ----------------------------------------------------------------------------
 * Cookies do painel: httpOnly + SameSite=Strict + Secure em produção.
 * O CSRF ganha um cookie legível porque o token precisa ser ecoado no header.
 * ------------------------------------------------------------------------- */
export function definirCookies(c: Context, cfg: Config, sessao: Sessao, csrfToken: string): void {
  const base = {
    path: '/',
    httpOnly: true,
    sameSite: 'Strict' as const,
    secure: cfg.isProduction,
  };
  setCookie(c, COOKIE_ACCESS, sessao.accessToken, { ...base, maxAge: cfg.accessTtlS });
  setCookie(c, COOKIE_REFRESH, sessao.refreshToken, { ...base, path: '/admin/auth', maxAge: cfg.refreshTtlS });
  setCookie(c, COOKIE_CSRF, csrfToken, {
    path: '/',
    httpOnly: false,
    sameSite: 'Strict',
    secure: cfg.isProduction,
    maxAge: cfg.refreshTtlS,
  });
}

export function limparCookies(c: Context): void {
  deleteCookie(c, COOKIE_ACCESS, { path: '/' });
  deleteCookie(c, COOKIE_REFRESH, { path: '/admin/auth' });
  deleteCookie(c, COOKIE_CSRF, { path: '/' });
}

export function novoTokenCsrf(): string {
  return randomBase64Url(32);
}
