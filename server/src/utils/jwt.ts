import type { Role } from '../config/env.js';
import { deUtf8, fromBase64Url, hmacSha256, toBase64Url, utf8 } from './crypto.js';
import { naoAutenticado } from './errors.js';

export const EMISSOR = 'koda-cloud';
export type Publico = 'admin' | 'app';
export type Papel = Role | 'user';

export interface ClaimsBase {
  sub: string;
  typ: 'access' | 'refresh';
  aud: Publico;
  iss: string;
  iat: number;
  exp: number;
  /** Id da sessão (linha de refresh_tokens) — permite revogar um aparelho só. */
  sid: string;
}

export interface ClaimsAccess extends ClaimsBase {
  typ: 'access';
  role: Papel;
  email?: string;
}

export interface ClaimsRefresh extends ClaimsBase {
  typ: 'refresh';
}

export type Claims = ClaimsAccess | ClaimsRefresh;

interface Cabecalho {
  alg?: string;
  typ?: string;
}

export const agoraS = (): number => Math.floor(Date.now() / 1000);

async function assinar(dados: string, segredo: string): Promise<string> {
  const bytes = await hmacSha256(utf8(segredo), utf8(dados));
  return toBase64Url(bytes);
}

/** Assina HS256 (JWT compacto). Só o servidor conhece o segredo. */
export async function assinarToken(claims: Claims, segredo: string): Promise<string> {
  const cabecalho = toBase64Url(utf8(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const corpo = toBase64Url(utf8(JSON.stringify(claims)));
  const assinatura = await assinar(`${cabecalho}.${corpo}`, segredo);
  return `${cabecalho}.${corpo}.${assinatura}`;
}

/**
 * Verifica assinatura, algoritmo, emissor, público, tipo e validade.
 * `alg: none` e troca de algoritmo são recusados de saída.
 */
export async function verificarToken<T extends Claims>(
  token: string,
  segredo: string,
  esperado: { typ: 'access' | 'refresh'; aud: Publico },
): Promise<T> {
  const partes = token.split('.');
  if (partes.length !== 3) throw naoAutenticado('invalid_token', 'token malformado');
  const cabecalhoB64 = partes[0] as string;
  const corpoB64 = partes[1] as string;
  const assinaturaB64 = partes[2] as string;

  let cabecalho: Cabecalho;
  let claims: T;
  try {
    cabecalho = JSON.parse(deUtf8(fromBase64Url(cabecalhoB64))) as Cabecalho;
    claims = JSON.parse(deUtf8(fromBase64Url(corpoB64))) as T;
  } catch {
    throw naoAutenticado('invalid_token', 'token ilegivel');
  }

  if (cabecalho.alg !== 'HS256' || cabecalho.typ !== 'JWT') {
    throw naoAutenticado('invalid_token', `algoritmo nao permitido: ${String(cabecalho.alg)}`);
  }
  if (typeof claims !== 'object' || claims === null) throw naoAutenticado('invalid_token', 'claims ausentes');

  // `crypto.subtle.verify` compara em tempo constante.
  const chave = await crypto.subtle.importKey(
    'raw',
    utf8(segredo).slice().buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valido = await crypto.subtle.verify(
    'HMAC',
    chave,
    fromBase64Url(assinaturaB64).slice().buffer as ArrayBuffer,
    utf8(`${cabecalhoB64}.${corpoB64}`).slice().buffer as ArrayBuffer,
  );
  if (!valido) throw naoAutenticado('invalid_token', 'assinatura invalida');

  if (claims.iss !== EMISSOR) throw naoAutenticado('invalid_token', 'emissor invalido');
  if (claims.aud !== esperado.aud) throw naoAutenticado('invalid_token', 'publico invalido');
  if (claims.typ !== esperado.typ) throw naoAutenticado('invalid_token', 'tipo de token invalido');
  if (typeof claims.sub !== 'string' || claims.sub === '') throw naoAutenticado('invalid_token', 'sub ausente');

  const agora = agoraS();
  if (typeof claims.exp !== 'number' || claims.exp <= agora) {
    throw naoAutenticado('token_expired', 'token expirado');
  }
  if (typeof claims.iat !== 'number' || claims.iat > agora + 120) {
    throw naoAutenticado('invalid_token', 'iat invalido');
  }
  return claims;
}
