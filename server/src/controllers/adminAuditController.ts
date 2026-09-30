import type { ContextoApp } from '../types.js';
import { consulta } from '../middlewares/validacao.js';
import { filtroAuditoriaSchema, verificarAuditoriaSchema } from '../validation/schemas.js';
import * as auditoria from '../models/auditLog.js';
import * as tentativas from '../models/loginAttempts.js';

/** GET /admin/api/audit */
export async function listar(c: ContextoApp) {
  const filtro = consulta(c, filtroAuditoriaSchema);
  const dados = await auditoria.listar(c.env.DB, {
    action: filtro.action,
    actorId: filtro.actor_id,
    targetId: filtro.target_id,
    outcome: filtro.outcome,
    de: filtro.de,
    ate: filtro.ate,
    limite: filtro.por_pagina,
    deslocamento: (filtro.pagina - 1) * filtro.por_pagina,
  });
  return c.json({
    ok: true,
    entradas: dados.linhas,
    total: dados.total,
    pagina: filtro.pagina,
    por_pagina: filtro.por_pagina,
    imutavel: true,
    observacao: 'log append-only: UPDATE e DELETE sao recusados pelo banco',
  });
}

/** GET /admin/api/audit/verify — recalcula o hash de cada entrada. */
export async function verificar(c: ContextoApp) {
  const filtro = consulta(c, verificarAuditoriaSchema);
  const resultado = await auditoria.verificarIntegridade(c.env.DB, {
    limite: filtro.limite,
    deslocamento: filtro.deslocamento,
  });
  return c.json({
    ok: resultado.ok,
    verificadas: resultado.verificadas,
    adulteradas: resultado.adulteradas,
    algoritmo: 'sha256(campos canonicos)',
  });
}

/** GET /admin/api/audit/logins — tentativas recentes (força bruta). */
export async function tentativasDeLogin(c: ContextoApp) {
  const recentes = await tentativas.listarRecentes(c.env.DB, 50);
  return c.json({
    ok: true,
    tentativas: recentes.map((item) => ({
      id: item.id,
      escopo: item.scope,
      chave: item.scope_key,
      sucesso: item.success === 1,
      email: item.email,
      ip: item.ip,
      motivo: item.reason,
      quando: item.created_at,
    })),
  });
}
