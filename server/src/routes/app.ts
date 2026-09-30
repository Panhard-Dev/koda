import { Hono } from 'hono';
import type { Aplicacao } from '../types.js';
import { exigirConta } from '../middlewares/autenticacao.js';
import { limitar } from '../middlewares/limite.js';
import {
  entrar,
  marcarAvisoLido,
  perfil,
  registrar,
  renovarToken,
  sair,
} from '../controllers/appAccountController.js';

/**
 * Rotas das contas comuns do app — separadas do /admin/*. Login aqui usa a
 * tabela `users`; token de admin não serve neste público e vice-versa.
 */
export const rotasApp = new Hono<Aplicacao>();

rotasApp.post('/auth/login', limitar({ escopo: 'app-login', limite: 10, janelaMs: 60_000, bloqueioMs: 300_000 }), entrar);
// Cadastro é mais caro (hash de senha) e mais raro: limite apertado e bloqueio longo.
rotasApp.post(
  '/auth/register',
  limitar({ escopo: 'app-register', limite: 5, janelaMs: 600_000, bloqueioMs: 900_000 }),
  registrar,
);
rotasApp.post('/auth/refresh', limitar({ escopo: 'app-refresh', limite: 30 }), renovarToken);
rotasApp.post('/auth/logout', limitar({ escopo: 'app-logout', limite: 30 }), sair);

rotasApp.get('/account/me', exigirConta(), limitar({ escopo: 'app-me', limite: 120, por: 'ator' }), perfil);
rotasApp.post(
  '/account/notifications/:id/read',
  exigirConta(),
  limitar({ escopo: 'app-avisos', limite: 120, por: 'ator' }),
  marcarAvisoLido,
);
