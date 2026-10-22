import type { Context } from 'hono';
import type { Config, Env, Role } from './config/env.js';

export interface Ator {
  tipo: 'admin' | 'user' | 'system';
  id: string | null;
  email: string | null;
  papel: Role | 'user' | null;
}

export interface Contexto {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
  ator: Ator;
}

export interface Variaveis {
  config: Config;
  env: Env;
  requestId: string;
  ator: Ator;
  ip: string | null;
  userAgent: string | null;
  csrfToken: string | null;
  sessaoFamilia: string | null;
}

export type Aplicacao = { Bindings: Env; Variables: Variaveis };

export type ContextoApp = Context<Aplicacao>;

export const atorAnonimo = (): Ator => ({ tipo: 'system', id: null, email: null, papel: null });
