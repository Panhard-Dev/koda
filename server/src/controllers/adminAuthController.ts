import { getCookie } from 'hono/cookie';
import type { ContextoApp } from '../types.js';
import { corpoJson } from '../middlewares/validacao.js';
import {
  alterarSenhaSchema,
  loginAdminSchema,
  refreshSchema,
  totpConfirmacaoSchema,
} from '../validation/schemas.js';
import { auditar, contextoDe } from '../services/auditService.js';
import { encerrar, loginAdmin, renovar } from '../services/authService.js';
import { hashSenha, politicaDeSenha, verificarSenha } from '../services/passwordService.js';
import {
  COOKIE_REFRESH,
  definirCookies,
  limparCookies,
  novoTokenCsrf,
  revogarTudo,
} from '../services/tokenService.js';
import * as admins from '../models/admins.js';
import {
  cifrarSegredo,
  codigoValido,
  decifrarSegredo,
  gerarCodigosRecuperacao,
  gerarSegredoTotp,
  lerRecuperacao,
  urlOtpauth,
} from '../services/totpService.js';
import { acessoNegado, erroApi, naoAutenticado, requisicaoInvalida } from '../utils/errors.js';

function contexto(c: ContextoApp) {
  return contextoDe({
    ip: c.get('ip'),
    userAgent: c.get('userAgent'),
    requestId: c.get('requestId'),
    ator: c.get('ator'),
  });
}

async function adminAtual(c: ContextoApp) {
  const ator = c.get('ator');
  const admin = ator.id ? await admins.buscarPorId(c.env.DB, ator.id) : null;
  if (!admin) throw naoAutenticado('invalid_token', 'admin inexistente');
  return admin;
}

/** POST /admin/auth/login */
export async function entrar(c: ContextoApp) {
  const cfg = c.get('config');
  const dados = await corpoJson(c, loginAdminSchema);
  const { sessao, sujeito } = await loginAdmin(c.env.DB, cfg, contexto(c), {
    email: dados.email,
    senha: dados.senha,
    totp: dados.totp ?? null,
  });
  const csrfToken = novoTokenCsrf();
  definirCookies(c, cfg, sessao, csrfToken);

  return c.json({
    ok: true,
    access_token: sessao.accessToken,
    refresh_token: sessao.refreshToken,
    token_type: 'Bearer',
    expires_in: cfg.accessTtlS,
    access_expira_em: sessao.accessExpiraEm,
    csrf_token: csrfToken,
    admin: { id: sujeito.id, email: sujeito.email, papel: sujeito.papel },
  });
}

/** POST /admin/auth/refresh */
export async function renovarToken(c: ContextoApp) {
  const cfg = c.get('config');
  const corpo = await corpoJson(c, refreshSchema);
  const refreshToken = corpo.refresh_token ?? getCookie(c, COOKIE_REFRESH) ?? null;
  if (!refreshToken) throw acessoNegado('missing_refresh', 'refresh token ausente');

  const { sessao, sujeito } = await renovar(c.env.DB, cfg, contexto(c), refreshToken, 'admin');
  const csrfToken = novoTokenCsrf();
  definirCookies(c, cfg, sessao, csrfToken);
  return c.json({
    ok: true,
    access_token: sessao.accessToken,
    refresh_token: sessao.refreshToken,
    token_type: 'Bearer',
    expires_in: cfg.accessTtlS,
    csrf_token: csrfToken,
    admin: { id: sujeito.id, email: sujeito.email, papel: sujeito.papel },
  });
}

/** POST /admin/auth/logout */
export async function sair(c: ContextoApp) {
  const corpo = await corpoJson(c, refreshSchema);
  const refreshToken = corpo.refresh_token ?? getCookie(c, COOKIE_REFRESH) ?? null;
  await encerrar(c.env.DB, contexto(c), refreshToken);
  limparCookies(c);
  return c.json({ ok: true });
}

/** GET /admin/api/me */
export async function perfil(c: ContextoApp) {
  const admin = await adminAtual(c);
  return c.json({
    ok: true,
    admin: {
      id: admin.id,
      email: admin.email,
      papel: admin.role,
      totp_ativo: admin.totp_enabled === 1,
      ultimo_login: admin.last_login_at,
      ultimo_ip: admin.last_login_ip,
      criado_em: admin.created_at,
    },
  });
}

/** POST /admin/api/security/password */
export async function trocarSenha(c: ContextoApp) {
  const cfg = c.get('config');
  const admin = await adminAtual(c);
  const dados = await corpoJson(c, alterarSenhaSchema);

  if (!(await verificarSenha(dados.senha_atual, admin.password_hash))) {
    await auditar(c.env.DB, contexto(c), {
      action: 'admin.password_change',
      targetType: 'admin',
      targetId: admin.id,
      outcome: 'failure',
      details: 'senha atual incorreta',
    });
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

  // Trocar a senha derruba tudo que estava aberto, inclusive esta sessão.
  const { sessoesRevogadas } = await revogarTudo(c.env.DB, { tipo: 'admin', id: admin.id }, new Date().toISOString());
  await auditar(c.env.DB, contexto(c), {
    action: 'admin.password_change',
    targetType: 'admin',
    targetId: admin.id,
    details: { algoritmo: cfg.hashAlgo, sessoes_revogadas: sessoesRevogadas },
  });
  limparCookies(c);
  return c.json({ ok: true, sessoes_revogadas: sessoesRevogadas, relogin_necessario: true });
}

/** POST /admin/api/security/totp/setup — gera o segredo (ainda desligado). */
export async function prepararTotp(c: ContextoApp) {
  const cfg = c.get('config');
  const admin = await adminAtual(c);
  if (!cfg.secrets.totpKey) {
    throw erroApi('totp_indisponivel', 503, '2FA indisponivel neste servidor', 'TOTP_ENCRYPTION_KEY ausente');
  }

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
  await auditar(c.env.DB, contexto(c), {
    action: 'admin.totp_setup',
    targetType: 'admin',
    targetId: admin.id,
    details: 'segredo gerado (ainda nao ativado)',
  });
  return c.json({ ok: true, secret: segredo, otpauth_url: urlOtpauth(admin.email, segredo) });
}

/** POST /admin/api/security/totp/enable — confirma com um código e ativa. */
export async function ativarTotp(c: ContextoApp) {
  const cfg = c.get('config');
  const admin = await adminAtual(c);
  const dados = await corpoJson(c, totpConfirmacaoSchema);
  if (!admin.totp_secret || !cfg.secrets.totpKey) throw requisicaoInvalida('gere o segredo antes de ativar 2FA');

  const segredo = await decifrarSegredo(admin.totp_secret, cfg.secrets.totpKey);
  if (!(await codigoValido(segredo, dados.codigo))) {
    await auditar(c.env.DB, contexto(c), {
      action: 'admin.totp_enable',
      targetType: 'admin',
      targetId: admin.id,
      outcome: 'failure',
      details: 'codigo invalido',
    });
    throw requisicaoInvalida('codigo de 2FA invalido');
  }

  const codigos = await gerarCodigosRecuperacao(8);
  await admins.salvarTotp(
    c.env.DB,
    admin.id,
    { segredo: admin.totp_secret, ativo: true, recuperacao: codigos.map((item) => item.hash) },
    new Date().toISOString(),
  );
  await auditar(c.env.DB, contexto(c), {
    action: 'admin.totp_enable',
    targetType: 'admin',
    targetId: admin.id,
    details: { codigos_de_recuperacao: codigos.length },
  });
  return c.json({ ok: true, recovery_codes: codigos.map((item) => item.codigo) });
}

/** POST /admin/api/security/totp/disable */
export async function desativarTotp(c: ContextoApp) {
  const cfg = c.get('config');
  const admin = await adminAtual(c);
  const dados = await corpoJson(c, totpConfirmacaoSchema);

  let autorizado = false;
  if (admin.totp_secret && cfg.secrets.totpKey) {
    autorizado = await codigoValido(await decifrarSegredo(admin.totp_secret, cfg.secrets.totpKey), dados.codigo);
  }
  if (!autorizado) throw requisicaoInvalida('codigo de 2FA invalido');

  await admins.salvarTotp(c.env.DB, admin.id, { segredo: null, ativo: false, recuperacao: [] }, new Date().toISOString());
  await auditar(c.env.DB, contexto(c), {
    action: 'admin.totp_disable',
    targetType: 'admin',
    targetId: admin.id,
  });
  return c.json({ ok: true });
}

/** POST /admin/api/security/sessions/revoke-all */
export async function revogarSessoes(c: ContextoApp) {
  const admin = await adminAtual(c);
  const { sessoesRevogadas } = await revogarTudo(c.env.DB, { tipo: 'admin', id: admin.id }, new Date().toISOString());
  await auditar(c.env.DB, contexto(c), {
    action: 'admin.sessions_revoked',
    targetType: 'admin',
    targetId: admin.id,
    details: { sessoes_revogadas: sessoesRevogadas },
  });
  limparCookies(c);
  return c.json({ ok: true, sessoes_revogadas: sessoesRevogadas, relogin_necessario: true });
}
