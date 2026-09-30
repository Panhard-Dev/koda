import { z } from 'zod';
import { AppError } from '../utils/errors.js';

/**
 * Segredos que NUNCA ficam no repositório: vêm de `wrangler secret put`
 * (produção) ou `.dev.vars` (local). O `.env.example` documenta todos.
 */
export interface Secrets {
  JWT_SECRET?: string;
  JWT_REFRESH_SECRET?: string;
  ADMIN_PASSWORD_HASH?: string;
  TOTP_ENCRYPTION_KEY?: string;
  /**
   * Chave que o host local (c-host) apresenta em `Authorization: Bearer` para
   * usar a API de modelos. Vive AQUI e só aqui: o binário do host não carrega
   * segredo nenhum, ele pergunta a este Worker se a chave recebida vale
   * (ver publicController.autorizarHost). Ausente = ninguém entra.
   */
  SERVE_LIZ_CLIENT_KEY?: string;
  /** Só existe no ambiente de teste (ver vitest.config.ts). */
  ADMIN_TEST_PASSWORD?: string;
  TEST_MIGRATIONS?: unknown;
}

export type Env = Cloudflare.Env & Secrets;

export type Role = 'admin' | 'superadmin';

export interface Config {
  nodeEnv: 'production' | 'development' | 'test';
  isProduction: boolean;
  adminEmail: string | null;
  corsOrigins: string[];
  rateLimitWindowMs: number;
  rateLimitMax: number;
  loginRateLimitMax: number;
  lockoutThreshold: number;
  lockoutWindowMs: number;
  lockoutDurationMs: number;
  accessTtlS: number;
  refreshTtlS: number;
  hashAlgo: 'bcrypt' | 'pbkdf2';
  bcryptCost: number;
  pbkdf2Iterations: number;
  uploadMaxBytes: number;
  allowInsecureHttp: boolean;
  panelEnabled: boolean;
  /**
   * Cadastro pelo app está aberto? Desligado, `/api/auth/register` recusa com 403 —
   * é o interruptor para fechar a porta sem tirar o app do ar nem exigir deploy.
   */
  cadastroAberto: boolean;
  secrets: {
    jwt: string;
    jwtRefresh: string;
    adminPasswordHash: string | null;
    totpKey: string | null;
  };
}

const inteiro = (nome: string, padrao: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((valor) => (valor === undefined || valor.trim() === '' ? padrao : Number(valor)))
    .pipe(z.number().int().min(min, `${nome} deve ser >= ${min}`).max(max, `${nome} deve ser <= ${max}`));

const booleano = (padrao: boolean) =>
  z
    .string()
    .optional()
    .transform((valor) => (valor === undefined ? padrao : ['1', 'true', 'on', 'yes'].includes(valor.toLowerCase())));

const esquema = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']).default('production'),
  ADMIN_EMAIL: z
    .string()
    .max(254)
    .refine((valor) => valor === '' || /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(valor), 'ADMIN_EMAIL invalido')
    .optional(),
  CORS_ORIGIN: z.string().default(''),
  RATE_LIMIT_WINDOW_MS: inteiro('RATE_LIMIT_WINDOW_MS', 60_000, 1_000, 3_600_000),
  RATE_LIMIT_MAX: inteiro('RATE_LIMIT_MAX', 120, 1, 100_000),
  LOGIN_RATE_LIMIT_MAX: inteiro('LOGIN_RATE_LIMIT_MAX', 10, 1, 10_000),
  LOGIN_LOCKOUT_THRESHOLD: inteiro('LOGIN_LOCKOUT_THRESHOLD', 5, 1, 1_000),
  LOGIN_LOCKOUT_WINDOW_MS: inteiro('LOGIN_LOCKOUT_WINDOW_MS', 900_000, 1_000, 86_400_000),
  LOGIN_LOCKOUT_DURATION_MS: inteiro('LOGIN_LOCKOUT_DURATION_MS', 900_000, 1_000, 604_800_000),
  ACCESS_TOKEN_TTL_S: inteiro('ACCESS_TOKEN_TTL_S', 1_200, 60, 3_600),
  REFRESH_TOKEN_TTL_S: inteiro('REFRESH_TOKEN_TTL_S', 604_800, 3_600, 15_552_000),
  HASH_ALGO: z.enum(['bcrypt', 'pbkdf2']).default('bcrypt'),
  BCRYPT_COST: inteiro('BCRYPT_COST', 10, 4, 15),
  PBKDF2_ITERATIONS: inteiro('PBKDF2_ITERATIONS', 100_000, 50_000, 2_000_000),
  UPLOAD_MAX_BYTES: inteiro('UPLOAD_MAX_BYTES', 1_048_576, 1_024, 1_500_000),
  ALLOW_INSECURE_HTTP: booleano(false),
  PANEL_ENABLED: booleano(true),
  CADASTRO_ABERTO: booleano(true),
});

const cache = new WeakMap<object, Config>();

function stringOuNulo(valor: string | undefined): string | null {
  const limpo = (valor ?? '').trim();
  return limpo === '' ? null : limpo;
}

/**
 * Lê, valida e congela a configuração. Erro de configuração nunca chega ao
 * cliente com detalhe: vira 503 `backend_unavailable` e log no servidor.
 */
export function getConfig(env: Env): Config {
  const guardado = cache.get(env as object);
  if (guardado) return guardado;

  const bruto = esquema.safeParse({
    NODE_ENV: env.NODE_ENV,
    ADMIN_EMAIL: env.ADMIN_EMAIL,
    CORS_ORIGIN: env.CORS_ORIGIN,
    RATE_LIMIT_WINDOW_MS: env.RATE_LIMIT_WINDOW_MS,
    RATE_LIMIT_MAX: env.RATE_LIMIT_MAX,
    LOGIN_RATE_LIMIT_MAX: env.LOGIN_RATE_LIMIT_MAX,
    LOGIN_LOCKOUT_THRESHOLD: env.LOGIN_LOCKOUT_THRESHOLD,
    LOGIN_LOCKOUT_WINDOW_MS: env.LOGIN_LOCKOUT_WINDOW_MS,
    LOGIN_LOCKOUT_DURATION_MS: env.LOGIN_LOCKOUT_DURATION_MS,
    ACCESS_TOKEN_TTL_S: env.ACCESS_TOKEN_TTL_S,
    REFRESH_TOKEN_TTL_S: env.REFRESH_TOKEN_TTL_S,
    HASH_ALGO: env.HASH_ALGO,
    BCRYPT_COST: env.BCRYPT_COST,
    PBKDF2_ITERATIONS: env.PBKDF2_ITERATIONS,
    UPLOAD_MAX_BYTES: env.UPLOAD_MAX_BYTES,
    ALLOW_INSECURE_HTTP: env.ALLOW_INSECURE_HTTP,
    PANEL_ENABLED: env.PANEL_ENABLED,
    CADASTRO_ABERTO: env.CADASTRO_ABERTO,
  });

  if (!bruto.success) {
    throw configError(bruto.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const dados = bruto.data;

  const jwt = stringOuNulo(env.JWT_SECRET);
  const jwtRefresh = stringOuNulo(env.JWT_REFRESH_SECRET);
  const faltando: string[] = [];
  if (!jwt) faltando.push('JWT_SECRET');
  if (!jwtRefresh) faltando.push('JWT_REFRESH_SECRET');
  if (jwt && jwt.length < 32) faltando.push('JWT_SECRET (minimo de 32 caracteres)');
  if (jwtRefresh && jwtRefresh.length < 32) faltando.push('JWT_REFRESH_SECRET (minimo de 32 caracteres)');
  if (jwt && jwtRefresh && jwt === jwtRefresh) {
    faltando.push('JWT_REFRESH_SECRET deve ser diferente de JWT_SECRET');
  }
  if (faltando.length > 0) throw configError(`segredos ausentes/invalidos: ${faltando.join(', ')}`);

  const isProduction = dados.NODE_ENV === 'production';

  // A chave do TOTP precisa ser AES-256: 32 bytes em base64.
  const totpKey = stringOuNulo(env.TOTP_ENCRYPTION_KEY);
  if (totpKey) {
    const tamanho = tamanhoBase64Bytes(totpKey);
    if (tamanho !== 32) {
      throw configError(`TOTP_ENCRYPTION_KEY deve ter 32 bytes em base64 (recebido ${tamanho})`);
    }
  }

  const config: Config = {
    nodeEnv: dados.NODE_ENV,
    isProduction,
    adminEmail: stringOuNulo(dados.ADMIN_EMAIL)?.toLowerCase() ?? null,
    corsOrigins: dados.CORS_ORIGIN.split(',')
      .map((item) => item.trim())
      .filter((item) => item !== ''),
    rateLimitWindowMs: dados.RATE_LIMIT_WINDOW_MS,
    rateLimitMax: dados.RATE_LIMIT_MAX,
    loginRateLimitMax: dados.LOGIN_RATE_LIMIT_MAX,
    lockoutThreshold: dados.LOGIN_LOCKOUT_THRESHOLD,
    lockoutWindowMs: dados.LOGIN_LOCKOUT_WINDOW_MS,
    lockoutDurationMs: dados.LOGIN_LOCKOUT_DURATION_MS,
    accessTtlS: dados.ACCESS_TOKEN_TTL_S,
    refreshTtlS: dados.REFRESH_TOKEN_TTL_S,
    hashAlgo: dados.HASH_ALGO,
    bcryptCost: dados.BCRYPT_COST,
    pbkdf2Iterations: dados.PBKDF2_ITERATIONS,
    uploadMaxBytes: dados.UPLOAD_MAX_BYTES,
    // Em produção HTTP nunca é aceito, mesmo que a variável mande abrir.
    allowInsecureHttp: isProduction ? false : dados.ALLOW_INSECURE_HTTP,
    panelEnabled: dados.PANEL_ENABLED,
    cadastroAberto: dados.CADASTRO_ABERTO,
    secrets: {
      jwt: jwt as string,
      jwtRefresh: jwtRefresh as string,
      adminPasswordHash: stringOuNulo(env.ADMIN_PASSWORD_HASH),
      totpKey,
    },
  };

  if (isProduction && config.corsOrigins.length === 0) {
    throw configError('CORS_ORIGIN precisa listar ao menos uma origem em producao');
  }

  cache.set(env as object, config);
  return config;
}

/** Tamanho em bytes de um valor base64 — usado para validar a chave do TOTP. */
function tamanhoBase64Bytes(valor: string): number {
  const limpo = valor.replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]+$/.test(limpo)) return -1;
  return Math.floor((limpo.length * 3) / 4);
}

function configError(detalhe: string): AppError {
  return new AppError('backend_unavailable', 503, 'Servico temporariamente indisponivel', detalhe);
}
