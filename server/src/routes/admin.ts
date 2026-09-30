import { Hono } from 'hono';
import type { Aplicacao } from '../types.js';
import { exigirAdmin, exigirPapel } from '../middlewares/autenticacao.js';
import { exigirCsrf } from '../middlewares/csrf.js';
import { limitar } from '../middlewares/limite.js';
import * as auth from '../controllers/adminAuthController.js';
import * as contas from '../controllers/adminAccountsController.js';
import * as modelos from '../controllers/adminModelsController.js';
import * as releases from '../controllers/adminReleasesController.js';
import * as auditoria from '../controllers/adminAuditController.js';

/**
 * API administrativa. Tudo em /admin/api/* exige JWT de admin válido
 * (`exigirAdmin`) e, quando a credencial vem de cookie, token CSRF válido.
 */
export const rotasAdmin = new Hono<Aplicacao>();

/* --- Login/renovação: públicos, mas com limite agressivo e CSRF --- */
rotasAdmin.post(
  '/auth/login',
  limitar({ escopo: 'admin-login', limite: 10, janelaMs: 60_000, bloqueioMs: 300_000 }),
  exigirCsrf,
  auth.entrar,
);
rotasAdmin.post('/auth/refresh', limitar({ escopo: 'admin-refresh', limite: 30 }), auth.renovarToken);
rotasAdmin.post('/auth/logout', exigirCsrf, auth.sair);

/* --- Daqui para baixo: só admin --- */
rotasAdmin.use('/api/*', exigirAdmin());
rotasAdmin.use('/api/*', exigirCsrf);
rotasAdmin.use('/api/*', limitar({ escopo: 'admin-api', limite: 300, por: 'ator' }));

rotasAdmin.get('/api/me', auth.perfil);
rotasAdmin.get('/api/overview', contas.painel);

/* Segurança do próprio admin */
rotasAdmin.post('/api/security/password', auth.trocarSenha);
rotasAdmin.post('/api/security/totp/setup', auth.prepararTotp);
rotasAdmin.post('/api/security/totp/enable', auth.ativarTotp);
rotasAdmin.post('/api/security/totp/disable', auth.desativarTotp);
rotasAdmin.post('/api/security/sessions/revoke-all', auth.revogarSessoes);

/* Contas */
rotasAdmin.get('/api/accounts', contas.listar);
rotasAdmin.post('/api/accounts', contas.criar);
rotasAdmin.get('/api/accounts/:id', contas.detalhar);
rotasAdmin.post('/api/accounts/:id/ban', contas.banir);
rotasAdmin.post('/api/accounts/:id/suspend', contas.suspender);
rotasAdmin.post('/api/accounts/:id/reactivate', contas.reativar);
rotasAdmin.post('/api/accounts/:id/notify', contas.avisar);
rotasAdmin.post('/api/accounts/:id/delete', contas.remover);
rotasAdmin.post('/api/accounts/:id/restore', contas.restaurar);
rotasAdmin.put('/api/accounts/:id/models/:modelId', contas.definirModelo);
// Hard delete é irreversível: só superadmin.
rotasAdmin.delete('/api/accounts/:id', exigirPapel(['superadmin']), contas.deletarDefinitivo);

/* Modelos */
rotasAdmin.get('/api/models', modelos.listar);
rotasAdmin.post('/api/models', modelos.criar);
rotasAdmin.get('/api/models/:id', modelos.obter);
rotasAdmin.patch('/api/models/:id', modelos.editar);
rotasAdmin.post('/api/models/:id/activate', modelos.ativarGlobal);
rotasAdmin.post('/api/models/:id/deactivate', modelos.ativarGlobal);
rotasAdmin.post('/api/models/:id/restore', modelos.restaurar);
rotasAdmin.post('/api/models/:id/users/:userId', modelos.definirParaUsuario);
rotasAdmin.delete('/api/models/:id', modelos.remover);

/* Arquivos */
rotasAdmin.get('/api/uploads', modelos.listarArquivos);
rotasAdmin.post('/api/uploads', modelos.enviarArquivo);
rotasAdmin.delete('/api/uploads/:id', modelos.removerArquivo);

/* Releases */
rotasAdmin.get('/api/releases', releases.listar);
rotasAdmin.post('/api/releases', releases.publicar);
rotasAdmin.patch('/api/releases/:id', releases.editar);
rotasAdmin.post('/api/releases/:id/publish', releases.definirPublicacao);
rotasAdmin.post('/api/releases/:id/unpublish', releases.definirPublicacao);
rotasAdmin.delete('/api/releases/:id', releases.remover);

/* Auditoria */
rotasAdmin.get('/api/audit', auditoria.listar);
rotasAdmin.get('/api/audit/verify', auditoria.verificar);
rotasAdmin.get('/api/audit/logins', auditoria.tentativasDeLogin);
