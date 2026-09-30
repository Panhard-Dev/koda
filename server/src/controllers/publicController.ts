import type { ContextoApp } from '../types.js';
import { consulta, corpoJson, parametros } from '../middlewares/validacao.js';
import { autorizacaoHostSchema, checarVersaoSchema } from '../validation/schemas.js';
import * as versoes from '../services/versionService.js';
import * as modelos from '../services/modelService.js';
import * as assets from '../models/assets.js';
import * as catalogo from '../models/catalogModels.js';
import { responderAsset } from '../services/uploadService.js';
import { timingSafeEqualStr } from '../utils/crypto.js';
import { contaDoToken } from '../middlewares/autenticacao.js';
import { naoEncontrado, requisicaoInvalida } from '../utils/errors.js';

const VERSAO_API = '1.0.0';

/** GET /api/public/version?versao=1.0.0&canal=stable */
export async function checarVersao(c: ContextoApp) {
  const filtro = consulta(c, checarVersaoSchema);
  const resultado = await versoes.checarAtualizacao(c.env.DB, c.get('config'), {
    versaoLocal: filtro.versao,
    canal: filtro.canal,
  });
  return c.json({ ok: true, ...resultado });
}

/** GET /api/public/changelog?canal=stable */
export async function changelog(c: ContextoApp) {
  const canal = c.req.query('canal') === 'beta' ? 'beta' : 'stable';
  const lista = await versoes.changelog(c.env.DB, canal);
  return c.json({ ok: true, canal, releases: lista });
}

/** GET /api/public/models */
export async function listarModelos(c: ContextoApp) {
  const lista = await modelos.listaPublica(c.env.DB);
  return c.json({ ok: true, models: lista, total: lista.length });
}

/** GET /api/public/models/:id/image e /api/public/assets/:id */
export async function servirAsset(c: ContextoApp) {
  const id = c.req.param('id') ?? '';
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) throw requisicaoInvalida('id invalido');
  const asset = await assets.buscarPorId(c.env.DB, id);
  if (!asset) throw naoEncontrado('arquivo nao encontrado');
  // Imagem de modelo é pública; qualquer outro tipo exige admin (ver rotas).
  return responderAsset(asset, { publico: asset.kind === 'model-image' });
}

/** GET /api/public/models/:id/image — imagem do modelo (id ou slug). */
export async function servirImagemDoModelo(c: ContextoApp) {
  const chave = c.req.param('id') ?? '';
  if (!/^[A-Za-z0-9._-]{2,64}$/.test(chave)) throw requisicaoInvalida('id invalido');
  const modelo = (await catalogo.buscarPorId(c.env.DB, chave)) ?? (await catalogo.buscarPorSlug(c.env.DB, chave));
  if (!modelo || modelo.asset_id === null) throw naoEncontrado('imagem nao cadastrada');
  const asset = await assets.buscarPorId(c.env.DB, modelo.asset_id);
  if (!asset) throw naoEncontrado('arquivo nao encontrado');
  return responderAsset(asset, { publico: true });
}

/** GET /api/public/health */
export async function saude(c: ContextoApp) {
  return c.json({
    ok: true,
    servico: 'koda-cloud',
    api_version: VERSAO_API,
    ambiente: c.get('config').nodeEnv,
    hora: new Date().toISOString(),
  });
}

/**
 * POST /api/public/host/authorize — o host local pergunta se quem está falando pode.
 *
 * O `c-host` não guarda credencial: ele recebe o que o cliente apresentou e
 * repassa para cá. Assim o binário do host não carrega segredo nenhum — extrair
 * o executável não entrega nada, só a URL deste Worker (que vem do env da máquina).
 *
 * Dois tipos de apresentação valem, e é de propósito que sejam dois:
 *
 * 1. **Chave de serviço** (`SERVE_LIZ_CLIENT_KEY`, só no env deste Worker). Serve
 *    para quem não tem conta — o operador, os testes, outra máquina do estúdio.
 *    Comparada em tempo constante para não vazar por tempo de resposta.
 * 2. **Sessão de conta** (o access token do app). É o caminho normal: o app não
 *    guarda chave nenhuma, manda a sessão de quem entrou e o modelo só responde
 *    para quem está logado. A régua é a mesma das rotas de conta — assinatura,
 *    público `app`, conta existente, não apagada, ativa, fora do piso de emissão
 *    e com a sessão viva — então banir alguém no painel derruba o acesso ao
 *    modelo, não só o login.
 *
 * Fail-closed: sem chave de serviço no env **e** sem conta válida, ninguém entra.
 * A rota é pública por necessidade (o host não tem credencial própria para se
 * apresentar), por isso vive atrás de limite por IP — e por isso responde só
 * sim/não, nunca o valor esperado.
 *
 * 200 `{autorizado:true}` / 401 `{autorizado:false}`. Qualquer outra coisa
 * (429, 5xx) é "não deu para saber", e o host trata como recusa.
 */
export async function autorizarHost(c: ContextoApp) {
  const dados = await corpoJson(c, autorizacaoHostSchema);
  const recebida = dados.chave.trim();
  const esperada = (c.env.SERVE_LIZ_CLIENT_KEY ?? '').trim();

  if (esperada !== '' && timingSafeEqualStr(recebida, esperada)) {
    // Nem a recebida nem a esperada entram em log ou resposta: a recebida pode
    // ser a chave real de alguém, e a esperada é segredo.
    return c.json({ ok: true, autorizado: true });
  }

  if ((await contaDoToken(c, recebida)) !== null) {
    return c.json({ ok: true, autorizado: true });
  }

  return c.json({ ok: false, autorizado: false }, 401);
}
