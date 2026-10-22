import { maisDias } from '../utils/datas.js';
import type { PaymentRow } from '../models/payments.js';

/**
 * A regra do reembolso, num lugar só.
 *
 * Ela é usada em **dois** pontos e precisa dar a mesma resposta nos dois: no cancelamento, que
 * decide se estorna, e no perfil da conta, que diz até quando dá. Duas cópias da mesma conta de
 * datas divergem no primeiro dia em que alguém mexer numa delas — e aí a tela promete um prazo
 * que o servidor recusa.
 *
 * **Sete dias** é o prazo que o dono definiu, e coincide com o direito de arrependimento do
 * Código de Defesa do Consumidor para compra fora do estabelecimento. Contado do **pagamento**,
 * e não do início da assinatura: o reembolso é de uma cobrança, e numa assinatura mensal cada
 * renovação é uma cobrança nova, com o seu próprio prazo.
 */
export const DIAS_DE_REEMBOLSO = 7;

/** Até quando esta cobrança pode ser estornada — `null` quando não há cobrança paga. */
export function prazoDeEstorno(pago: PaymentRow | null): string | null {
  if (!pago?.pago_em) return null;
  try {
    return maisDias(pago.pago_em, DIAS_DE_REEMBOLSO);
  } catch {
    // Data estranha no banco não pode derrubar a rota: sem prazo, não há estorno.
    return null;
  }
}

/**
 * A cobrança ainda está dentro do prazo?
 *
 * A comparação é de strings ISO, que ordenam igual a datas — mesmo formato, mesmo fuso. É a
 * mesma convenção que o resto do projeto usa para comparar datas guardadas em texto.
 */
export function dentroDoPrazoDeEstorno(pago: PaymentRow | null, agora: string): boolean {
  const prazo = prazoDeEstorno(pago);
  return prazo !== null && prazo > agora;
}
