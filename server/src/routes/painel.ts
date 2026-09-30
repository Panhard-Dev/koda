import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { Aplicacao } from '../types.js';
import { adminOpcional } from '../middlewares/autenticacao.js';
import { exigirCsrf } from '../middlewares/csrf.js';
import { limitar } from '../middlewares/limite.js';
import * as painel from '../controllers/panelController.js';
import * as acoesContas from '../controllers/panelAcoesContas.js';
import * as acoesCatalogo from '../controllers/panelAcoesCatalogo.js';

/** Sem sessão válida, qualquer página do painel manda para o login. */
const exigirAdminPainel: MiddlewareHandler<Aplicacao> = async (c, next) => {
  const ator = await adminOpcional(c);
  if (!ator) {
    const caminho = new URL(c.req.url).pathname;
    return c.redirect(`/admin/login?proximo=${encodeURIComponent(caminho)}`, 303);
  }
  await next();
};



export const rotasPainel = new Hono<Aplicacao>();

/* Estáticos e login */
rotasPainel.get('/assets/painel.css', painel.servirCss);
rotasPainel.get('/assets/painel.js', painel.servirJs);
rotasPainel.get('/login', painel.telaLogin);
rotasPainel.post(
  '/login',
  limitar({ escopo: 'painel-login', limite: 10, janelaMs: 60_000, bloqueioMs: 300_000 }),
  exigirCsrf,
  painel.entrarPeloPainel,
);
rotasPainel.post('/logout', exigirCsrf, painel.sairDoPainel);

/* Páginas */
rotasPainel.get('/', exigirAdminPainel, painel.paginaInicial);
rotasPainel.get('/contas', exigirAdminPainel, painel.listarContasPainel);
rotasPainel.get('/contas/:id', exigirAdminPainel, painel.detalharContaPainel);
rotasPainel.get('/modelos', exigirAdminPainel, painel.listarModelosPainel);
rotasPainel.get('/versoes', exigirAdminPainel, painel.listarVersoesPainel);
rotasPainel.get('/auditoria', exigirAdminPainel, painel.listarAuditoriaPainel);
rotasPainel.get('/seguranca', exigirAdminPainel, painel.paginaDeSeguranca);

/* Ações de conta */
rotasPainel.post('/contas', exigirAdminPainel, exigirCsrf, acoesContas.criarConta);
rotasPainel.post('/contas/:id/banir', exigirAdminPainel, exigirCsrf, acoesContas.banirConta);
rotasPainel.post('/contas/:id/suspender', exigirAdminPainel, exigirCsrf, acoesContas.suspenderConta);
rotasPainel.post('/contas/:id/reativar', exigirAdminPainel, exigirCsrf, acoesContas.reativarConta);
rotasPainel.post('/contas/:id/remover', exigirAdminPainel, exigirCsrf, acoesContas.removerConta);
rotasPainel.post('/contas/:id/restaurar', exigirAdminPainel, exigirCsrf, acoesContas.restaurarConta);
rotasPainel.post('/contas/:id/avisar', exigirAdminPainel, exigirCsrf, acoesContas.avisarConta);
rotasPainel.post('/contas/:id/modelos', exigirAdminPainel, exigirCsrf, acoesContas.definirModeloConta);

/* Ações de modelo */
rotasPainel.post('/modelos', exigirAdminPainel, exigirCsrf, acoesContas.criarModelo);
rotasPainel.post('/modelos/:id/editar', exigirAdminPainel, exigirCsrf, acoesContas.editarModelo);
rotasPainel.post('/modelos/:id/alternar', exigirAdminPainel, exigirCsrf, acoesContas.alternarModelo);
rotasPainel.post('/modelos/:id/remover', exigirAdminPainel, exigirCsrf, acoesContas.removerModelo);
rotasPainel.post('/modelos/:id/restaurar', exigirAdminPainel, exigirCsrf, acoesContas.restaurarModelo);
rotasPainel.post('/modelos/:id/imagem', exigirAdminPainel, exigirCsrf, acoesContas.enviarImagemModelo);

/* Ações de release */
rotasPainel.post('/versoes', exigirAdminPainel, exigirCsrf, acoesCatalogo.publicarVersao);
rotasPainel.post('/versoes/:id/publicar', exigirAdminPainel, exigirCsrf, acoesCatalogo.definirPublicacaoVersao);
rotasPainel.post('/versoes/:id/despublicar', exigirAdminPainel, exigirCsrf, acoesCatalogo.definirPublicacaoVersao);
rotasPainel.post('/versoes/:id/remover', exigirAdminPainel, exigirCsrf, acoesCatalogo.removerVersao);

/* Ações de segurança */
rotasPainel.post('/seguranca/senha', exigirAdminPainel, exigirCsrf, acoesCatalogo.trocarSenhaPainel);
rotasPainel.post('/seguranca/totp/preparar', exigirAdminPainel, exigirCsrf, acoesCatalogo.prepararTotpPainel);
rotasPainel.post('/seguranca/totp/ativar', exigirAdminPainel, exigirCsrf, acoesCatalogo.ativarTotpPainel);
rotasPainel.post('/seguranca/totp/desativar', exigirAdminPainel, exigirCsrf, acoesCatalogo.desativarTotpPainel);
rotasPainel.post('/seguranca/sessoes/revogar', exigirAdminPainel, exigirCsrf, acoesCatalogo.revogarSessoesPainel);
