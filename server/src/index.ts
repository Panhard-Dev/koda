import { Hono } from 'hono';
import type { Aplicacao } from './types.js';
import { contextoDaRequisicao } from './middlewares/contexto.js';
import { cabecalhosDeSeguranca } from './middlewares/seguranca.js';
import { corsRestritivo } from './middlewares/cors.js';
import { exigirHttps } from './middlewares/https.js';
import { tratadorDeErros, tratadorDeNaoEncontrado } from './middlewares/erros.js';
import { rotasPublicas } from './routes/public.js';
import { rotasApp } from './routes/app.js';
import { rotasAdmin } from './routes/admin.js';
import { rotasPainel } from './routes/painel.js';
import { garantirAdminDoAmbiente } from './services/bootstrapService.js';

const VERSAO_API = '1.0.0';

const app = new Hono<Aplicacao>();

/* Tratamento de erro e 404 antes de qualquer rota. */
app.onError(tratadorDeErros);
app.notFound(tratadorDeNaoEncontrado);

/* Ordem importa: contexto -> segurança -> https -> CORS. */
app.use('*', contextoDaRequisicao);
app.use('*', cabecalhosDeSeguranca);
app.use('*', exigirHttps);
app.use('*', corsRestritivo);

/**
 * Garante o admin do ambiente (ADMIN_EMAIL + ADMIN_PASSWORD_HASH) na primeira
 * requisição do isolate. A senha em claro nunca passa por aqui.
 */
app.use('*', async (c, next) => {
  await garantirAdminDoAmbiente(c.env, c.get('config'));
  await next();
});

app.route('/api/public', rotasPublicas);
app.route('/api', rotasApp);
app.route('/admin', rotasPainel);
app.route('/admin', rotasAdmin);

app.get('/', (c) =>
  c.json({
    ok: true,
    service: 'koda-cloud',
    api_version: VERSAO_API,
    docs: '/admin/login',
    public: ['/api/public/health', '/api/public/version', '/api/public/changelog', '/api/public/models'],
  }),
);

export default app;
