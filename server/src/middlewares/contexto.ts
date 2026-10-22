import type { MiddlewareHandler } from 'hono';
import type { Aplicacao } from '../types.js';
import { getConfig } from '../config/env.js';
import { ipDaRequisicao, userAgentDaRequisicao } from '../utils/request.js';
import { randomHex } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';

/** Id de correlação: aparece na resposta, no log e na auditoria da requisição. */
export const contextoDaRequisicao: MiddlewareHandler<Aplicacao> = async (c, next) => {
  const requestId = c.req.header('cf-ray') ?? randomHex(8);
  const config = getConfig(c.env);

  c.set('config', config);
  c.set('env', c.env);
  c.set('requestId', requestId);
  c.set('ip', ipDaRequisicao(c.req.raw));
  c.set('userAgent', userAgentDaRequisicao(c.req.raw));
  c.set('ator', { tipo: 'system', id: null, email: null, papel: null });
  c.set('csrfToken', null);
  c.set('sessaoFamilia', null);

  const inicio = Date.now();
  await next();

  c.header('x-request-id', requestId);
  const url = new URL(c.req.url);
  logger.info('http.requisicao', {
    requestId,
    metodo: c.req.method,
    caminho: url.pathname,
    status: c.res.status,
    duracao_ms: Date.now() - inicio,
    ip: c.get('ip'),
  });
};
