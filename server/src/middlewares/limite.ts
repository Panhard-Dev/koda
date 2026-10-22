import type { MiddlewareHandler } from 'hono';
import type { Aplicacao } from '../types.js';
import { chaveDeLimite, consumir, limparOportunisticamente } from '../services/rateLimitService.js';
import { bloqueado } from '../utils/errors.js';

export interface OpcoesLimite {
  escopo: string;
  limite?: number;
  janelaMs?: number;
  /** `ip` (padrão) ou `ator` quando a rota já exige autenticação. */
  por?: 'ip' | 'ator';
  bloqueioMs?: number;
}

/**
 * Limite por janela fixa contado no D1 (atômico). Devolve os cabeçalhos
 * padrão e responde 429 com `Retry-After` sem revelar detalhe interno.
 */
export function limitar(opcoes: OpcoesLimite): MiddlewareHandler<Aplicacao> {
  return async (c, next) => {
    const config = c.get('config');
    const limite = opcoes.limite ?? config.rateLimitMax;
    const janelaMs = opcoes.janelaMs ?? config.rateLimitWindowMs;
    const identificador = opcoes.por === 'ator' ? (c.get('ator').id ?? c.get('ip') ?? 'desconhecido') : (c.get('ip') ?? 'desconhecido');
    const chave = chaveDeLimite(opcoes.escopo, identificador);

    const consumo = await consumir(c.env.DB, { chave, limite, janelaMs, bloqueioMs: opcoes.bloqueioMs });
    c.header('x-ratelimit-limit', String(limite));
    c.header('x-ratelimit-remaining', String(consumo.restantes));
    c.header('x-ratelimit-reset', String(Math.ceil(consumo.resetEm / 1000)));

    if (!consumo.permitido) {
      const retryAfterS = Math.max(1, Math.ceil(((consumo.bloqueadoAte ?? consumo.resetEm) - Date.now()) / 1000));
      c.header('retry-after', String(retryAfterS));
      await limparOportunisticamente(c.env.DB);
      throw bloqueado('rate_limited', retryAfterS, `escopo ${opcoes.escopo}`);
    }

    await next();
    await limparOportunisticamente(c.env.DB);
  };
}
