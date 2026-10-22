/**
 * O serviço público do catálogo de MCPs: o que `GET /api/public/mcps` devolve.
 *
 * Mesma linha do `listaPublica` de modelos: o painel é quem publica, e o app consome. O
 * retorno é o objeto cru do D1 (sem tratamento de `metadata`), porque o backend do app é
 * quem valida campo por campo e cai na lista da casa se algo fugir do contrato.
 */
import type { D1Database } from '@cloudflare/workers-types';
import * as catalogo from '../models/catalogMcps.js';
import type { ConectorPublico } from '../models/catalogMcps.js';

export async function listaPublica(db: D1Database): Promise<ConectorPublico[]> {
  return await catalogo.publicos(db);
}