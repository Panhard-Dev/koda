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
import {
  assinarComCartao,
  assinarComPix,
  cancelarAssinatura,
  comprarCreditos,
  meusCreditos,
  minhaAssinatura,
} from '../controllers/billingController.js';
import { meuUso, registrarUso } from '../controllers/appUsageController.js';

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

/*
 * Cobrança e assinatura.
 *
 * O limite aqui é **por conta** (`por: 'ator'`), e não por IP: uma tentativa de
 * cartão recusado pode ser repetida pela mesma pessoa (cartão errado, depois o
 * certo), e o que precisa parar é a enumeração de cartões por uma conta só. Um
 * limite por IP puniria a casa inteira atrás do mesmo NAT.
 *
 * O teto é baixo porque cada chamada destas custa uma cobrança no Mercado Pago
 * — é a rota mais cara do Worker, e a que mais dói quando abusada.
 */
rotasApp.get('/assinatura', exigirConta(), limitar({ escopo: 'app-assinatura', limite: 120, por: 'ator' }), minhaAssinatura);
rotasApp.post(
  '/assinatura/pix',
  exigirConta(),
  limitar({ escopo: 'app-assinatura-pix', limite: 10, janelaMs: 600_000, bloqueioMs: 300_000, por: 'ator' }),
  assinarComPix,
);
rotasApp.post(
  '/assinatura/cartao',
  exigirConta(),
  limitar({ escopo: 'app-assinatura-cartao', limite: 10, janelaMs: 600_000, bloqueioMs: 300_000, por: 'ator' }),
  assinarComCartao,
);
rotasApp.post(
  '/assinatura/cancelar',
  exigirConta(),
  limitar({ escopo: 'app-assinatura-cancelar', limite: 10, por: 'ator' }),
  cancelarAssinatura,
);

/*
 * Crédito avulso.
 *
 * Mesmo raciocínio do bloco acima: o limite é por conta, e o teto é baixo porque cada chamada
 * custa uma cobrança no Mercado Pago. A leitura do saldo é folgada — é ela que a tela usa para
 * conferir se o PIX caiu, e quem paga PIX espera alguns segundos olhando.
 */
rotasApp.get('/creditos', exigirConta(), limitar({ escopo: 'app-creditos', limite: 240, por: 'ator' }), meusCreditos);
rotasApp.post(
  '/creditos/pix',
  exigirConta(),
  limitar({ escopo: 'app-creditos-pix', limite: 10, janelaMs: 600_000, bloqueioMs: 300_000, por: 'ator' }),
  comprarCreditos,
);

/*
 * Uso da conta — tempo e tokens.
 *
 * É o que faz o **limite** pertencer à conta e não à máquina: o backend local mede (é ele que
 * vê a resposta acontecendo) e o app relata para cá. O teto do relato é folgado porque a
 * chamada é barata e o app pode repetir — quem impede a contagem dupla é a chave única
 * (`user_id`, `message_id`), não o limite.
 */
rotasApp.post('/usage', exigirConta(), limitar({ escopo: 'app-uso', limite: 600, por: 'ator' }), registrarUso);
rotasApp.get('/usage', exigirConta(), limitar({ escopo: 'app-uso-leitura', limite: 240, por: 'ator' }), meuUso);
