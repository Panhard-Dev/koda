import type { Config } from '../config/env.js';
import type { Contexto } from '../types.js';
import * as admins from '../models/admins.js';
import * as usuarios from '../models/users.js';
import * as tentativas from '../models/loginAttempts.js';
import { acessoNegado, bloqueado, naoAutenticado, requisicaoInvalida } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { auditar } from './auditService.js';
import { hashSenha, verificarSenha } from './passwordService.js';
import { chaveDeLimite, consumir, resetar, verificarBloqueio } from './rateLimitService.js';
import {
  codigoValido,
  consumirCodigoRecuperacao,
  decifrarSegredo,
  lerRecuperacao,
} from './totpService.js';
import { emitirSessao, revogarPorRefresh, rotacionarSessao } from './tokenService.js';
import type { Sessao, Sujeito } from './tokenService.js';

export interface ResultadoLogin {
  sessao: Sessao;
  sujeito: Sujeito;
}

const ESC = 'invalid_credentials';

/** Hash usado quando o e-mail não existe: iguala o tempo de resposta. */
let hashFalsoCache: { valor: string; cfg: Config } | null = null;

async function hashFalso(cfg: Config): Promise<string> {
  if (hashFalsoCache && hashFalsoCache.cfg === cfg) return hashFalsoCache.valor;
  const valor = await hashSenha(`isca-${Math.random().toString(36).slice(2)}-${Date.now()}`, {
    algo: cfg.hashAlgo,
    bcryptCost: cfg.hashAlgo === 'bcrypt' ? Math.min(cfg.bcryptCost, 8) : cfg.bcryptCost,
    pbkdf2Iterations: cfg.pbkdf2Iterations,
  });
  hashFalsoCache = { valor, cfg };
  return valor;
}

/**
 * Trava por IP e por conta, checada ANTES de validar credenciais: com o bloqueio
 * ativo nem a senha certa entra (é o que impede varredura de senha).
 */
async function verificarTrava(
  db: D1Database,
  cfg: Config,
  escopo: { ip: string; email: string },
): Promise<void> {
  const chaves = [chaveDeLimite('login-ip', escopo.ip), chaveDeLimite('login-conta', escopo.email)];
  for (const chave of chaves) {
    const restante = await verificarBloqueio(db, {
      chave,
      limite: cfg.lockoutThreshold,
      janelaMs: cfg.lockoutWindowMs,
    });
    if (restante !== null) {
      throw bloqueado('too_many_attempts', restante, `chave ${chave.split(':')[0]}`);
    }
  }
}

async function contabilizarFalha(
  db: D1Database,
  cfg: Config,
  escopo: { ip: string; email: string },
  contexto: Contexto,
  motivo: string,
): Promise<never> {
  const chaves = [chaveDeLimite('login-ip', escopo.ip), chaveDeLimite('login-conta', escopo.email)];
  let bloqueadoAte: number | null = null;
  for (const chave of chaves) {
    const consumo = await consumir(db, {
      chave,
      limite: cfg.lockoutThreshold,
      janelaMs: cfg.lockoutWindowMs,
      bloqueioMs: cfg.lockoutDurationMs,
    });
    if (consumo.bloqueadoAte !== null) bloqueadoAte = Math.max(bloqueadoAte ?? 0, consumo.bloqueadoAte);
  }

  await tentativas.registrar(db, {
    scope: 'ip',
    scopeKey: escopo.ip,
    subjectType: 'admin',
    sucesso: false,
    email: escopo.email,
    ip: contexto.ip,
    userAgent: contexto.userAgent,
    motivo,
    agora: new Date().toISOString(),
  });
  await auditar(db, contexto, {
    action: 'auth.login_failed',
    targetType: 'email',
    targetId: null,
    outcome: 'failure',
    details: { motivo, email: escopo.email, bloqueado_ate: bloqueadoAte },
  });

  if (bloqueadoAte !== null && bloqueadoAte > Date.now()) {
    throw bloqueado('too_many_attempts', Math.ceil((bloqueadoAte - Date.now()) / 1000), 'lockout ativado');
  }
  throw naoAutenticado(ESC, motivo);
}

/**
 * Conta barrada por status: registra a tentativa para investigação, mas NÃO
 * gasta o orçamento de lockout — a senha estava certa, quem recusou foi a
 * política de moderação.
 */
async function recusarPorStatus(
  db: D1Database,
  contexto: Contexto,
  escopo: { ip: string; email: string },
  motivo: string,
): Promise<never> {
  await tentativas.registrar(db, {
    scope: 'account',
    scopeKey: escopo.email,
    subjectType: 'user',
    sucesso: false,
    email: escopo.email,
    ip: contexto.ip,
    userAgent: contexto.userAgent,
    motivo,
    agora: new Date().toISOString(),
  });
  await auditar(db, contexto, {
    action: 'auth.login_blocked',
    targetType: 'user',
    targetId: null,
    outcome: 'failure',
    details: { motivo, email: escopo.email },
  });
  throw acessoNegado(motivo, 'conta sem acesso');
}

async function limparFalhas(db: D1Database, ip: string, email: string): Promise<void> {
  await resetar(db, chaveDeLimite('login-ip', ip));
  await resetar(db, chaveDeLimite('login-conta', email));
}

export async function loginAdmin(
  db: D1Database,
  cfg: Config,
  contexto: Contexto,
  entrada: { email: string; senha: string; totp?: string | null },
): Promise<ResultadoLogin> {
  const email = entrada.email.trim().toLowerCase();
  const ip = contexto.ip ?? 'desconhecido';
  await verificarTrava(db, cfg, { ip, email });

  const admin = await admins.buscarPorEmail(db, email);

  // Sem conta: mesmo trabalho de hash para não vazar quem existe.
  if (!admin) {
    await verificarSenha(entrada.senha, await hashFalso(cfg));
    await contabilizarFalha(db, cfg, { ip, email }, contexto, 'conta inexistente');
  }
  const conta = admin as admins.AdminRow;

  const agoraIso = new Date().toISOString();
  if (conta.locked_until !== null && conta.locked_until > agoraIso) {
    throw bloqueado('account_locked', Math.ceil((Date.parse(conta.locked_until) - Date.now()) / 1000));
  }

  const senhaOk = await verificarSenha(entrada.senha, conta.password_hash);
  if (!senhaOk) {
    const falha = await admins.registrarFalha(db, conta.id, {
      limite: cfg.lockoutThreshold,
      travarAte: new Date(Date.now() + cfg.lockoutDurationMs).toISOString(),
      agora: agoraIso,
    });
    if (falha?.locked_until && falha.locked_until > agoraIso) {
      await auditar(db, contexto, {
        action: 'admin.locked',
        targetType: 'admin',
        targetId: conta.id,
        outcome: 'failure',
        details: { motivo: 'tentativas de senha', tentativas: falha.failed_attempts },
      });
    }
    await contabilizarFalha(db, cfg, { ip, email }, contexto, 'senha incorreta');
  }

  if (conta.totp_enabled === 1) {
    const codigo = (entrada.totp ?? '').trim();
    if (codigo === '') throw requisicaoInvalida('codigo de 2FA obrigatorio');
    let autorizado = false;
    if (conta.totp_secret && cfg.secrets.totpKey) {
      try {
        autorizado = await codigoValido(await decifrarSegredo(conta.totp_secret, cfg.secrets.totpKey), codigo);
      } catch {
        autorizado = false;
      }
    }
    if (!autorizado) {
      const resultado = await consumirCodigoRecuperacao(lerRecuperacao(conta.totp_recovery), codigo);
      if (resultado.valido) {
        await admins.registrarRecuperacao(db, conta.id, resultado.restantes, agoraIso);
        autorizado = true;
        await auditar(db, contexto, {
          action: 'admin.totp_recovery_used',
          targetType: 'admin',
          targetId: conta.id,
          details: { restantes: resultado.restantes.length },
        });
      }
    }
    if (!autorizado) {
      await contabilizarFalha(db, cfg, { ip, email }, contexto, 'codigo 2FA invalido');
    }
  }

  await limparFalhas(db, ip, email);
  await admins.registrarLoginOk(db, conta.id, ip, agoraIso);
  await auditar(db, contexto, {
    action: 'admin.login',
    targetType: 'admin',
    targetId: conta.id,
    after: { email: conta.email, papel: conta.role },
  });

  const sujeito: Sujeito = { tipo: 'admin', id: conta.id, email: conta.email, papel: conta.role };
  const sessao = await emitirSessao(db, cfg, { sujeito, aud: 'admin', ip: contexto.ip, userAgent: contexto.userAgent });
  return { sessao, sujeito };
}

export async function loginConta(
  db: D1Database,
  cfg: Config,
  contexto: Contexto,
  entrada: { email: string; senha: string },
): Promise<ResultadoLogin> {
  const email = entrada.email.trim().toLowerCase();
  const ip = contexto.ip ?? 'desconhecido';
  await verificarTrava(db, cfg, { ip, email });

  const conta = await usuarios.buscarPorEmail(db, email);
  if (!conta || conta.deleted_at !== null) {
    await verificarSenha(entrada.senha, await hashFalso(cfg));
    await contabilizarFalha(db, cfg, { ip, email }, contexto, 'conta inexistente ou removida');
  }
  const usuario = conta as usuarios.UserRow;

  const agoraIso = new Date().toISOString();
  if (usuario.locked_until !== null && usuario.locked_until > agoraIso) {
    throw bloqueado('account_locked', Math.ceil((Date.parse(usuario.locked_until) - Date.now()) / 1000));
  }

  const senhaOk = await verificarSenha(entrada.senha, usuario.password_hash);
  if (!senhaOk) {
    const falha = await usuarios.registrarFalha(db, usuario.id, {
      limite: cfg.lockoutThreshold,
      travarAte: new Date(Date.now() + cfg.lockoutDurationMs).toISOString(),
      agora: agoraIso,
    });
    await auditar(db, contexto, {
      action: 'user.locked',
      targetType: 'user',
      targetId: usuario.id,
      outcome: 'failure',
      details: { tentativas: falha?.failed_attempts ?? null },
    }).catch(() => undefined);
    await contabilizarFalha(db, cfg, { ip, email }, contexto, 'senha incorreta');
  }

  // Suspensão vencida volta sozinha; banimento e suspensão valendo barram.
  if (usuario.status === 'suspended' && usuario.suspended_until !== null && usuario.suspended_until <= agoraIso) {
    await usuarios.definirStatus(db, usuario.id, {
      status: 'active',
      motivo: null,
      suspensoAte: null,
      autorId: 'sistema',
      agora: agoraIso,
    });
    await auditar(db, contexto, {
      action: 'account.suspension_expired',
      targetType: 'user',
      targetId: usuario.id,
      details: { suspenso_ate: usuario.suspended_until },
    });
  } else if (usuario.status === 'banned') {
    await recusarPorStatus(db, contexto, { ip, email }, 'account_banned');
  } else if (usuario.status === 'suspended') {
    await recusarPorStatus(db, contexto, { ip, email }, 'account_suspended');
  }

  await limparFalhas(db, ip, email);
  await usuarios.registrarLoginOk(db, usuario.id, ip, agoraIso);
  await auditar(db, contexto, {
    action: 'user.login',
    targetType: 'user',
    targetId: usuario.id,
    after: { email: usuario.email },
  });

  const sujeito: Sujeito = {
    tipo: 'user',
    id: usuario.id,
    email: usuario.email,
    papel: 'user',
    nome: usuario.display_name,
  };
  const sessao = await emitirSessao(db, cfg, { sujeito, aud: 'app', ip: contexto.ip, userAgent: contexto.userAgent });
  return { sessao, sujeito };
}

export async function renovar(
  db: D1Database,
  cfg: Config,
  contexto: Contexto,
  refreshToken: string,
  aud: 'admin' | 'app',
): Promise<ResultadoLogin> {
  try {
    const { sessao, sujeito } = await rotacionarSessao(db, cfg, {
      refreshToken,
      aud,
      ip: contexto.ip,
      userAgent: contexto.userAgent,
    });
    await auditar(db, contexto, {
      action: 'auth.refresh',
      targetType: sujeito.tipo,
      targetId: sujeito.id,
      details: { publico: aud },
    });
    return { sessao, sujeito };
  } catch (erro) {
    if (erro instanceof Error && erro.name === 'AppError') {
      const codigo = (erro as { code?: string }).code;
      if (codigo === 'refresh_reuse') {
        logger.warn('auth.refresh_reuse', { requestId: contexto.requestId, ip: contexto.ip });
        await auditar(db, contexto, {
          action: 'auth.refresh_reuse',
          outcome: 'failure',
          details: 'refresh reutilizado: familia revogada',
        });
      }
    }
    throw erro;
  }
}

export async function encerrar(
  db: D1Database,
  contexto: Contexto,
  refreshToken: string | null,
): Promise<void> {
  const agora = new Date().toISOString();
  if (refreshToken) await revogarPorRefresh(db, refreshToken, agora);
  await auditar(db, contexto, {
    action: 'auth.logout',
    targetType: contexto.ator.tipo,
    targetId: contexto.ator.id,
    details: { tinha_refresh: refreshToken !== null },
  });
}
