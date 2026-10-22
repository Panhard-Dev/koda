import type { ContextoApp } from '../types.js';
import { corpoForm, parametros } from '../middlewares/validacao.js';
import {
  alterarSenhaSchema,
  identificadorParamSchema,
  releaseEntradaSchema,
  totpConfirmacaoSchema,
} from '../validation/schemas.js';
import * as versoes from '../services/versionService.js';
import * as admins from '../models/admins.js';
import { hashSenha, politicaDeSenha, verificarSenha } from '../services/passwordService.js';
import {
  cifrarSegredo,
  codigoValido,
  decifrarSegredo,
  gerarCodigosRecuperacao,
  gerarSegredoTotp,
  lerRecuperacao,
  urlOtpauth,
} from '../services/totpService.js';
import { revogarTudo } from '../services/tokenService.js';
import { naoAutenticado, requisicaoInvalida } from '../utils/errors.js';
import { pagina } from '../views/layout.js';
import { paginaCodigosRecuperacao, paginaTotpPreparado } from '../views/catalogo.js';
import { csrfDaRequisicao, redirecionar } from './panelController.js';
import { contexto, executar } from './panelComum.js';

const VERSOES = '/admin/versoes';
const SEGURANCA = '/admin/seguranca';

/* -------------------------------- Versoes -------------------------------- */
export async function publicarVersao(c: ContextoApp): Promise<Response> {
  const cfg = c.get('config');
  const dados = await corpoForm(c, releaseEntradaSchema);
  return executar(c, VERSOES, 'versao-publicada', async () => {
    await versoes.publicar(c.env.DB, cfg, contexto(c), {
      version: dados.version,
      downloadUrl: dados.download_url,
      notes: dados.notes ?? null,
      channel: dados.channel,
      mandatory: dados.mandatory ?? false,
      minSupportedVersion: dados.min_supported_version ?? null,
      publicado: dados.publicado ?? true,
    });
  });
}

export async function definirPublicacaoVersao(c: ContextoApp): Promise<Response> {
  const { id } = parametros(c, identificadorParamSchema);
  const publicado = c.req.path.endsWith('/publicar');
  return executar(c, VERSOES, 'versao-atualizada', async () => {
    await versoes.definirPublicacao(c.env.DB, contexto(c), id, publicado);
  });
}

export async function removerVersao(c: ContextoApp): Promise<Response> {
  const { id } = parametros(c, identificadorParamSchema);
  return executar(c, VERSOES, 'versao-atualizada', async () => {
    await versoes.remover(c.env.DB, contexto(c), id);
  });
}

/* ------------------------------- Seguranca ------------------------------- */
async function adminAtual(c: ContextoApp) {
  const ator = c.get('ator');
  const admin = ator.id ? await admins.buscarPorId(c.env.DB, ator.id) : null;
  if (!admin) throw naoAutenticado('invalid_token', 'admin inexistente');
  return admin;
}

export async function trocarSenhaPainel(c: ContextoApp): Promise<Response> {
  const cfg = c.get('config');
  const dados = await corpoForm(c, alterarSenhaSchema);
  return executar(c, '/admin/login', 'senha-trocada', async () => {
    const admin = await adminAtual(c);
    if (!(await verificarSenha(dados.senha_atual, admin.password_hash))) {
      throw naoAutenticado('invalid_credentials', 'senha atual incorreta');
    }
    const motivo = politicaDeSenha(dados.senha_nova, { email: admin.email });
    if (motivo) throw requisicaoInvalida(motivo);
    const hash = await hashSenha(dados.senha_nova, {
      algo: cfg.hashAlgo,
      bcryptCost: cfg.bcryptCost,
      pbkdf2Iterations: cfg.pbkdf2Iterations,
    });
    await admins.atualizarSenha(c.env.DB, admin.id, hash, new Date().toISOString());
  });
}

export async function prepararTotpPainel(c: ContextoApp): Promise<Response> {
  const cfg = c.get('config');
  const admin = await adminAtual(c);
  if (!cfg.secrets.totpKey) return redirecionar(c, SEGURANCA, { erro: 'erro-interno' });

  const segredo = gerarSegredoTotp();
  await admins.salvarTotp(
    c.env.DB,
    admin.id,
    {
      segredo: await cifrarSegredo(segredo, cfg.secrets.totpKey),
      ativo: false,
      recuperacao: lerRecuperacao(admin.totp_recovery),
    },
    new Date().toISOString(),
  );
  return pagina({
    titulo: 'Confirmar 2FA',
    secao: 'seguranca',
    csrfToken: csrfDaRequisicao(c),
    admin: { email: admin.email, papel: admin.role, totp_ativo: false },
    conteudo: paginaTotpPreparado({ csrf: csrfDaRequisicao(c), segredo, otpauthUrl: urlOtpauth(admin.email, segredo) }),
  });
}

export async function ativarTotpPainel(c: ContextoApp): Promise<Response> {
  const cfg = c.get('config');
  const admin = await adminAtual(c);
  const dados = await corpoForm(c, totpConfirmacaoSchema);
  if (!admin.totp_secret || !cfg.secrets.totpKey) return redirecionar(c, SEGURANCA, { erro: 'entrada-invalida' });

  const segredo = await decifrarSegredo(admin.totp_secret, cfg.secrets.totpKey);
  if (!(await codigoValido(segredo, dados.codigo))) return redirecionar(c, SEGURANCA, { erro: '2fa-invalido' });

  const codigos = await gerarCodigosRecuperacao(8);
  await admins.salvarTotp(
    c.env.DB,
    admin.id,
    { segredo: admin.totp_secret, ativo: true, recuperacao: codigos.map((item) => item.hash) },
    new Date().toISOString(),
  );
  return pagina({
    titulo: '2FA ativado',
    secao: 'seguranca',
    csrfToken: csrfDaRequisicao(c),
    admin: { email: admin.email, papel: admin.role, totp_ativo: true },
    conteudo: paginaCodigosRecuperacao({ csrf: csrfDaRequisicao(c), codigos: codigos.map((item) => item.codigo) }),
  });
}

export async function desativarTotpPainel(c: ContextoApp): Promise<Response> {
  const cfg = c.get('config');
  const admin = await adminAtual(c);
  const dados = await corpoForm(c, totpConfirmacaoSchema);

  let autorizado = false;
  if (admin.totp_secret && cfg.secrets.totpKey) {
    autorizado = await codigoValido(await decifrarSegredo(admin.totp_secret, cfg.secrets.totpKey), dados.codigo);
  }
  if (!autorizado) return redirecionar(c, SEGURANCA, { erro: '2fa-invalido' });

  await admins.salvarTotp(c.env.DB, admin.id, { segredo: null, ativo: false, recuperacao: [] }, new Date().toISOString());
  return redirecionar(c, SEGURANCA, { aviso: 'totp-desativado' });
}

export async function revogarSessoesPainel(c: ContextoApp): Promise<Response> {
  const admin = await adminAtual(c);
  await revogarTudo(c.env.DB, { tipo: 'admin', id: admin.id }, new Date().toISOString());
  return redirecionar(c, '/admin/login', { aviso: 'sessoes-revogadas' });
}
