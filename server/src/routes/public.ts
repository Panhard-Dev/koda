import { Hono } from 'hono';
import type { Aplicacao } from '../types.js';
import { limitar } from '../middlewares/limite.js';
import {
  autorizarHost,
  changelog,
  checarVersao,
  listarConectores,
  listarModelos,
  saude,
  servirAsset,
  servirImagemDoModelo,
} from '../controllers/publicController.js';
import { planosPublicos, webhookDoMercadoPago } from '../controllers/billingController.js';

/**
 * Rotas públicas — as que o próprio app chama. Sem autenticação, com limite
 * por IP e nenhum dado sensível na resposta.
 */
export const rotasPublicas = new Hono<Aplicacao>();

rotasPublicas.get('/health', limitar({ escopo: 'pub-health', limite: 60 }), saude);
rotasPublicas.get('/version', limitar({ escopo: 'pub-version', limite: 120 }), checarVersao);
rotasPublicas.get('/changelog', limitar({ escopo: 'pub-changelog', limite: 60 }), changelog);
// /models fica sem limite de proposito: e a rota que o app e o painel batem
// toda vez que abrem, e a resposta e um catalogo estatico que nao custa D1 nem
// chamada de modelo. O limite por IP aqui so derrubava cliente legitimo atras de
// NAT. O resto das rotas publicas continua limitado.
rotasPublicas.get('/models', listarModelos);
rotasPublicas.get('/models/:id/image', limitar({ escopo: 'pub-asset', limite: 240 }), servirImagemDoModelo);
rotasPublicas.get('/assets/:id', limitar({ escopo: 'pub-asset', limite: 240 }), servirAsset);

/**
 * Autorização do host local. Pública de propósito — o `c-host` não tem
 * credencial própria para se apresentar — então o limite por IP é o que segura
 * o uso como oráculo de "essa chave vale?". O limite é folgado porque o host
 * cacheia o resultado e só pergunta de novo quando o cache vence.
 */
rotasPublicas.post('/host/authorize', limitar({ escopo: 'host-authorize', limite: 120 }), autorizarHost);

/**
 * O catálogo de planos, com o preço que será cobrado.
 *
 * Público porque a tela de planos abre antes de qualquer login e preço não é
 * segredo. É esta rota que tira os preços de dentro do app: enquanto eles
 * estiverem escritos na tela, o número que a pessoa lê e o número que o
 * servidor cobra são dois números diferentes que ninguém comparou.
 */
rotasPublicas.get('/plans', limitar({ escopo: 'pub-plans', limite: 120 }), planosPublicos);

/**
 * A notificação do Mercado Pago.
 *
 * Pública por necessidade — quem chama é o Mercado Pago, não o app — e a porta
 * é a **conferência de assinatura**, não o limite. O limite é folgado de
 * propósito: o Mercado Pago reentrega a mesma notificação várias vezes até
 * receber 200, e apertar aqui faria a reentrega bater no próprio limitador e a
 * cobrança ficar sem confirmação.
 */
rotasPublicas.post('/mp/webhook', limitar({ escopo: 'mp-webhook', limite: 600 }), webhookDoMercadoPago);
