import * as auditoria from '../models/auditLog.js';
import type { Ator, Contexto } from '../types.js';
import { erroInterno, mensagemDeErro } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export interface EntradaAuditoriaAcao {
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  outcome?: 'success' | 'failure';
  before?: unknown;
  after?: unknown;
  details?: unknown;
}

export function contextoDe(parcial: {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
  ator: Ator;
}): Contexto {
  return {
    ip: parcial.ip,
    userAgent: parcial.userAgent,
    requestId: parcial.requestId,
    ator: parcial.ator,
  };
}

/**
 * Grava a ação administrativa. Falha aqui é falha da operação: log de auditoria
 * perdido em silêncio é pior do que um 500 na cara do operador.
 */
export async function auditar(db: D1Database, contexto: Contexto, entrada: EntradaAuditoriaAcao): Promise<void> {
  try {
    await auditoria.registrar(db, {
      createdAt: new Date().toISOString(),
      actorType: contexto.ator.tipo,
      actorId: contexto.ator.id,
      actorEmail: contexto.ator.email,
      action: entrada.action,
      targetType: entrada.targetType ?? null,
      targetId: entrada.targetId ?? null,
      outcome: entrada.outcome ?? 'success',
      ip: contexto.ip,
      userAgent: contexto.userAgent,
      requestId: contexto.requestId,
      beforeState: entrada.before ?? null,
      afterState: entrada.after ?? null,
      details: entrada.details ?? null,
    });
  } catch (erro) {
    logger.error('auditoria.falhou', {
      action: entrada.action,
      targetId: entrada.targetId,
      requestId: contexto.requestId,
      erro: mensagemDeErro(erro),
    });
    throw erroInterno(`nao foi possivel registrar auditoria: ${mensagemDeErro(erro)}`);
  }
}

/** Audita sem requisição (rotina de sistema, ex.: admin criado no bootstrap). */
export async function auditarSistema(
  db: D1Database,
  entrada: EntradaAuditoriaAcao & { author?: { id: string | null; email: string | null } },
): Promise<void> {
  await auditar(
    db,
    {
      ip: null,
      userAgent: 'sistema',
      requestId: `sistema-${Date.now().toString(36)}`,
      ator: { tipo: 'system', id: entrada.author?.id ?? null, email: entrada.author?.email ?? null, papel: null },
    },
    entrada,
  );
}

export const registroDeAuditoria = auditoria;
