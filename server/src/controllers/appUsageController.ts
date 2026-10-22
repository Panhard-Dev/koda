import type { ContextoApp } from '../types.js';
import { corpoJson, consulta } from '../middlewares/validacao.js';
import { consultaDeUsoSchema, relatoDeUsoSchema } from '../validation/schemas.js';
import * as uso from '../models/usage.js';
import { uuid } from '../utils/crypto.js';
import { naoAutenticado } from '../utils/errors.js';

/**
 * O uso da conta, medido **na nuvem**.
 *
 * O backend local mede (é ele que vê a resposta acontecendo) e o app relata para cá. É esta
 * rota que faz o limite pertencer à conta: o que está no PC é só a coleta, e o que manda é
 * o que está aqui. Sem isso, trocar de máquina recomeçava o limite e reinstalar apagava o
 * gasto — limite no cliente é limite que o cliente contorna.
 */

/** POST /api/usage — o app relata o que **uma** resposta gastou. */
export async function registrarUso(c: ContextoApp) {
  const ator = c.get('ator');
  if (!ator.id) throw naoAutenticado('invalid_subject');
  const dados = await corpoJson(c, relatoDeUsoSchema);

  const contou = await uso.registrar(c.env.DB, {
    id: uuid(),
    userId: ator.id,
    messageId: dados.message_id,
    conversationId: dados.conversation_id ?? null,
    model: dados.model ?? null,
    dia: dados.dia,
    mes: dados.mes,
    tempoMs: dados.tempo_ms,
    tokens: dados.tokens,
    agora: new Date().toISOString(),
  });

  // `contou: false` **não** é erro: é o reenvio do app batendo na chave única. Devolver 200
  // nos dois casos é o que deixa o app repetir sem medo.
  return c.json({ ok: true, contou });
}

/**
 * GET /api/usage — as janelas da conta.
 *
 * As datas de corte vêm do **cliente** (`dia`, `semana`, `mes`): o dia vira à meia-noite de
 * quem usa, e o app já sabe calcular isso (`src/plan.ts`). O Worker só compara texto — data
 * ISO ordena igual a data —, e assim não há uma segunda regra de fuso para divergir da
 * primeira.
 */
export async function meuUso(c: ContextoApp) {
  const ator = c.get('ator');
  if (!ator.id) throw naoAutenticado('invalid_subject');
  const filtro = consulta(c, consultaDeUsoSchema);

  // O mapa de atividade olha um ano para trás, contado do dia que o cliente mandou.
  const inicioDoMapa = new Date(`${filtro.dia}T00:00:00.000Z`);
  inicioDoMapa.setUTCDate(inicioDoMapa.getUTCDate() - 364);
  const desde = inicioDoMapa.toISOString().slice(0, 10);

  const [daily, weekly, monthly, dias, totais] = await Promise.all([
    uso.janelaDesde(c.env.DB, ator.id, filtro.dia),
    uso.janelaDesde(c.env.DB, ator.id, filtro.semana),
    uso.janelaDoMes(c.env.DB, ator.id, filtro.mes),
    uso.diasComUso(c.env.DB, ator.id, desde),
    uso.totais(c.env.DB, ator.id),
  ]);

  return c.json({
    ok: true,
    daily,
    weekly,
    monthly,
    conversations: totais.conversations,
    messages: totais.messages,
    dias,
  });
}
