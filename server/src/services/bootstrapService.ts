import type { Config, Env } from '../config/env.js';
import * as admins from '../models/admins.js';
import { uuid } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';
import { auditarSistema } from './auditService.js';

const FORMATOS_ACEITOS = ['$bcrypt$', '$pbkdf2-sha256$', '$2a$', '$2b$', '$2y$'];

export function hashDeSenhaValido(hash: string | null): boolean {
  if (!hash || hash.length < 20) return false;
  return FORMATOS_ACEITOS.some((prefixo) => hash.startsWith(prefixo));
}

/**
 * Garante que o admin do `.env` existe. Roda a cada requisição (uma consulta
 * indexada) em vez de memoizar: assim um banco recriado volta a ter o admin.
 * A senha em claro nunca passa por aqui — só o hash do ambiente.
 */
export async function garantirAdminDoAmbiente(
  env: Env,
  cfg: Config,
): Promise<{ criado: boolean; motivo?: string }> {
  if (!cfg.adminEmail) return { criado: false, motivo: 'ADMIN_EMAIL ausente' };

  const existente = await admins.buscarPorEmail(env.DB, cfg.adminEmail);
  if (existente) return { criado: false, motivo: 'ja existe' };

  const hash = cfg.secrets.adminPasswordHash;
  if (!hashDeSenhaValido(hash)) {
    logger.warn('bootstrap.sem_hash', {
      motivo: 'ADMIN_PASSWORD_HASH ausente ou fora do formato esperado',
      esperado: 'ex.: $bcrypt$2b$12$... (rode `npm run hash -- --gerar`)',
    });
    return { criado: false, motivo: 'hash ausente' };
  }

  const agora = new Date().toISOString();
  const id = uuid();
  await admins.criar(env.DB, {
    id,
    email: cfg.adminEmail,
    passwordHash: hash as string,
    role: 'superadmin',
    agora,
  });
  await auditarSistema(env.DB, {
    action: 'admin.bootstrap',
    targetType: 'admin',
    targetId: id,
    after: { email: cfg.adminEmail, role: 'superadmin' },
    details: { origem: 'ADMIN_EMAIL + ADMIN_PASSWORD_HASH' },
  });
  logger.info('bootstrap.admin_criado', { email: cfg.adminEmail });
  return { criado: true };
}
