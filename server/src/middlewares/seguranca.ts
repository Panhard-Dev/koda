import type { MiddlewareHandler } from 'hono';
import type { Aplicacao } from '../types.js';
import { getConfig } from '../config/env.js';
import { ehHttps } from '../utils/request.js';

/** CSP de página do painel: nada de inline, só o próprio domínio. */
const CSP_PAINEL = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

/** CSP de resposta de dados: não carrega nada, ninguém embute. */
const CSP_DADOS = ["default-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "object-src 'none'"].join('; ');

/**
 * Cabeçalhos de segurança no espírito do helmet, escritos para a plataforma:
 * HSTS só quando é https de verdade, CSP distinta para HTML e para dados.
 */
export const cabecalhosDeSeguranca: MiddlewareHandler<Aplicacao> = async (c, next) => {
  await next();
  const config = getConfig(c.env);
  const seguro = ehHttps(c.req.raw);

  c.header('x-content-type-options', 'nosniff');
  c.header('x-frame-options', 'DENY');
  c.header('referrer-policy', 'no-referrer');
  c.header('permissions-policy', 'accelerometer=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()');
  c.header('cross-origin-opener-policy', 'same-origin');
  c.header('cross-origin-resource-policy', 'same-origin');
  c.header('x-permitted-cross-domain-policies', 'none');
  c.header('x-dns-prefetch-control', 'off');
  c.header('vary', 'Origin');

  if (config.isProduction && seguro) {
    c.header('strict-transport-security', 'max-age=31536000; includeSubDomains; preload');
  }

  const tipo = c.res.headers.get('content-type') ?? '';
  const caminho = new URL(c.req.url).pathname;
  // Arquivos servidos por rota dedicada já trazem cache e CSP próprios.
  const ehAsset = caminho.startsWith('/api/public/assets/') || /\/api\/public\/models\/[^/]+\/image$/.test(caminho);

  c.header('content-security-policy', tipo.includes('text/html') ? CSP_PAINEL : CSP_DADOS);
  if (!ehAsset) c.header('cache-control', 'no-store, no-cache, must-revalidate, private');
};
