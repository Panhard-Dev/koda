/**
 * O catálogo de planos.
 *
 * Leitura só: quem escreve é a migration (e, mais para frente, o painel). O
 * app nunca manda preço — ele manda o `id` do plano, e o valor cobrado sai
 * daqui. Ver o cabeçalho da migration `0002_pagamentos.sql`.
 */
export interface PlanRow {
  id: string;
  nome: string;
  /** Centavos. 1499 = R$ 14,99. */
  preco_centavos: number;
  horas_por_dia: number;
  moedas_por_mes: number;
  moedas_por_dia: number;
  ativo: number;
  ordem: number;
  created_at: string;
  updated_at: string;
}

/** Os planos à venda, na ordem em que a tela mostra. */
export async function listarAtivos(db: D1Database): Promise<PlanRow[]> {
  const resultado = await db
    .prepare('SELECT * FROM plans WHERE ativo = 1 ORDER BY ordem ASC, id ASC')
    .all<PlanRow>();
  return resultado.results ?? [];
}

/**
 * Um plano pelo id, **ativo ou não**.
 *
 * A busca não filtra `ativo` de propósito: quem já assina um plano que saiu de
 * linha continua renovando, e recusar aqui faria a renovação de quem paga
 * parar de funcionar por causa de uma decisão de vitrine.
 */
export async function buscarPorId(db: D1Database, id: string): Promise<PlanRow | null> {
  return db.prepare('SELECT * FROM plans WHERE id = ?').bind(id).first<PlanRow>();
}
