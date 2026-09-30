import * as limites from '../models/rateLimits.js';
import { logger } from '../utils/logger.js';

export interface Consumo {
  permitido: boolean;
  restantes: number;
  resetEm: number;
  bloqueadoAte: number | null;
  hits: number;
}

/**
 * Consome uma unidade do limite. A contagem é atômica no banco, então múltiplas
 * instâncias do Worker (colocation, retries) não conseguem passar do teto.
 */
export async function consumir(
  db: D1Database,
  opcoes: { chave: string; limite: number; janelaMs: number; bloqueioMs?: number; agoraMs?: number },
): Promise<Consumo> {
  const agoraMs = opcoes.agoraMs ?? Date.now();
  const resultado = await limites.consumir(db, {
    bucket: opcoes.chave,
    janelaMs: opcoes.janelaMs,
    limite: opcoes.limite,
    agoraMs,
    bloqueioMs: opcoes.bloqueioMs,
  });
  return {
    permitido: resultado.permitido,
    restantes: Math.max(0, opcoes.limite - resultado.hits),
    resetEm: resultado.resetEm,
    bloqueadoAte: resultado.bloqueadoAte,
    hits: resultado.hits,
  };
}

/** Remove o balde: login bem-sucedido limpa o histórico de falhas da chave. */
export async function resetar(db: D1Database, chave: string): Promise<void> {
  await limites.resetar(db, chave);
}

/**
 * Diz se a chave esta travada sem gastar tentativa. Retorna os segundos
 * restantes ou `null` quando pode seguir. Chamado antes de validar credenciais.
 */
export async function verificarBloqueio(
  db: D1Database,
  opcoes: { chave: string; limite: number; janelaMs: number; agoraMs?: number },
): Promise<number | null> {
  const agoraMs = opcoes.agoraMs ?? Date.now();
  const estado = await limites.consultar(db, opcoes.chave);
  if (!estado) return null;
  if (estado.bloqueadoAte !== null && estado.bloqueadoAte > agoraMs) {
    return Math.ceil((estado.bloqueadoAte - agoraMs) / 1000);
  }
  const fimDaJanela = estado.windowStart + opcoes.janelaMs;
  if (estado.hits >= opcoes.limite && fimDaJanela > agoraMs) {
    return Math.ceil((fimDaJanela - agoraMs) / 1000);
  }
  return null;
}

export function chaveDeLimite(escopo: string, identificador: string): string {
  // O identificador vai normalizado: nunca conteúdo livre de usuário na chave.
  const limpo = identificador.trim().toLowerCase().slice(0, 120);
  return `${escopo}:${limpo === '' ? 'desconhecido' : limpo}`;
}

let consumidos = 0;

/** Limpeza oportunista (1 em cada 200 chamadas) — evita crescer para sempre. */
export async function limparOportunisticamente(db: D1Database): Promise<void> {
  consumidos += 1;
  if (consumidos % 200 !== 0) return;
  try {
    const removidos = await limites.limparAntigos(db, Date.now() - 24 * 60 * 60 * 1000);
    const tokensRemovidos = removidos;
    logger.info('rate_limit.limpeza', { removidos: tokensRemovidos });
  } catch {
    // limpeza é best-effort: nunca derruba a requisição
  }
}
