import type { MiddlewareHandler } from 'hono';
import type { Aplicacao } from '../types.js';
import { getConfig } from '../config/env.js';
import { ehHttps } from '../utils/request.js';
import { logger } from '../utils/logger.js';

/**
 * HTTP nunca é atendido em produção: 308 preserva método e corpo no redireciona
 * para https. Em desenvolvimento (ALLOW_INSECURE_HTTP) a passagem é liberada
 * para o `wrangler dev` local funcionar.
 */
export const exigirHttps: MiddlewareHandler<Aplicacao> = async (c, next) => {
  const config = getConfig(c.env);
  const request = c.req.raw;

  if (!ehHttps(request) && !config.allowInsecureHttp) {
    const url = new URL(request.url);
    const destino = `https://${url.host}${url.pathname}${url.search}`;
    logger.warn('http.redirecionado', {
      requestId: c.get('requestId'),
      de: url.host,
      para: 'https',
    });
    return c.redirect(destino, 308);
  }

  await next();
};
