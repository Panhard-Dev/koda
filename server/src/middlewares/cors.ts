import type { MiddlewareHandler } from 'hono';
import type { Aplicacao } from '../types.js';
import { getConfig } from '../config/env.js';
import { origemDaRequisicao } from '../utils/request.js';

const METODOS = 'GET, POST, PATCH, PUT, DELETE, OPTIONS';
const CABECALHOS = 'content-type, authorization, x-koda-csrf, x-requested-with';

/**
 * Loopback (qualquer porta) — a máquina de quem desenvolve.
 *
 * O app instalado roda em `tauri.localhost`, que é o `CORS_ORIGIN` do serviço. Já quem
 * abre a interface com `npm run dev` está em `http://localhost:5173` — ou na porta que o
 * Vite escolher — e mesmo assim precisa falar com o Worker publicado: a sessão mora no
 * painel, não existe cópia local para apontar. Por isso o loopback vale em **todos** os
 * ambientes, e não só fora de produção: sem isso o desenvolvimento no navegador bate no
 * preflight e a tela de login responde "não consegui falar com o painel".
 *
 * Isto não abre nada que não estivesse aberto: a autenticação é por token no cabeçalho
 * `authorization` e o app não usa cookie de sessão — não há credencial ambiente que uma
 * página de outro site consiga carregar sozinha. E um serviço local em outra porta é
 * outra origem: não lê o `localStorage` onde o app guarda a renovação da sessão.
 */
const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

/**
 * CORS com whitelist explícita do CORS_ORIGIN. Origem fora da lista não recebe
 * cabeçalho nenhum — o navegador barra sozinho. Nunca `*` com credenciais.
 */
export const corsRestritivo: MiddlewareHandler<Aplicacao> = async (c, next) => {
  const config = getConfig(c.env);
  const origem = origemDaRequisicao(c.req.raw);

  c.header('vary', 'Origin');

  const permitida = origem !== null && (config.corsOrigins.includes(origem) || LOOPBACK.test(origem));

  if (origem && permitida) {
    c.header('access-control-allow-origin', origem);
    c.header('access-control-allow-credentials', 'true');
    c.header('access-control-allow-methods', METODOS);
    c.header('access-control-allow-headers', CABECALHOS);
    c.header('access-control-max-age', '600');
    c.header('access-control-expose-headers', 'x-request-id, x-ratelimit-remaining, x-ratelimit-reset');
  }

  if (c.req.method === 'OPTIONS') {
    // Preflight: 204 sem `allow-origin` quando a origem não é permitida.
    return c.body(null, 204);
  }

  await next();
};
