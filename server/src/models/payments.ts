export type MetodoPagamento = 'cartao' | 'pix';

export interface PaymentRow {
  id: string;
  user_id: string;
  /**
   * O plano que a cobrança ativa — ou `null` quando ela compra crédito avulso.
   *
   * Uma cobrança faz **uma** das duas coisas: ou ativa um plano, ou credita. O produto
   * `creditos` existe em `plans` para a chave estrangeira continuar válida, mas o que diz o que
   * esta linha é, é a coluna `creditos` abaixo.
   */
  plan_id: string | null;
  /** Quantos créditos a cobrança creditou. `null` numa compra de plano. */
  creditos: number | null;
  mp_payment_id: string | null;
  metodo: MetodoPagamento;
  valor_centavos: number;
  status: string;
  status_detalhe: string | null;
  chave_idempotencia: string;
  qr_code: string | null;
  qr_code_base64: string | null;
  expira_em: string | null;
  pago_em: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A cobrança já criada com esta chave de idempotência — ou `null`.
 *
 * É a primeira coisa que a criação de cobrança consulta. O app manda a chave
 * junto; se a resposta anterior se perdeu no caminho e ele tentar de novo, ele
 * recebe **a mesma cobrança** em vez de uma segunda. Cobrar duas vezes é o
 * único erro desta tela que o cliente percebe no extrato.
 */
export async function buscarPorChave(db: D1Database, chave: string): Promise<PaymentRow | null> {
  return db.prepare('SELECT * FROM payments WHERE chave_idempotencia = ?').bind(chave).first<PaymentRow>();
}

export async function buscarPorId(db: D1Database, id: string): Promise<PaymentRow | null> {
  return db.prepare('SELECT * FROM payments WHERE id = ?').bind(id).first<PaymentRow>();
}

export async function criar(
  db: D1Database,
  dados: {
    id: string;
    userId: string;
    /** `null` numa compra de crédito avulso — ver `creditos`. */
    planId: string | null;
    /** Quantos créditos a compra credita. `null` (ou ausente) numa compra de plano. */
    creditos?: number | null;
    metodo: MetodoPagamento;
    valorCentavos: number;
    chaveIdempotencia: string;
    status: string;
    agora: string;
  },
): Promise<PaymentRow> {
  return db
    .prepare(
      `INSERT INTO payments
         (id, user_id, plan_id, creditos, metodo, valor_centavos, chave_idempotencia, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .bind(
      dados.id,
      dados.userId,
      dados.planId,
      dados.creditos ?? null,
      dados.metodo,
      dados.valorCentavos,
      dados.chaveIdempotencia,
      dados.status,
      dados.agora,
      dados.agora,
    )
    .first<PaymentRow>() as Promise<PaymentRow>;
}

/**
 * Grava o id que o Mercado Pago deu à cobrança.
 *
 * Vem **depois** de a cobrança existir lá, e é o que o webhook usa para
 * reencontrar esta linha. Se este UPDATE falhar, a cobrança ainda é
 * reencontrável pelo `external_reference` (que é o nosso `id`) — é para isso
 * que ele vai no corpo do pagamento.
 */
export async function definirMpId(
  db: D1Database,
  id: string,
  mpPaymentId: string,
  agora: string,
): Promise<PaymentRow | null> {
  return db
    .prepare('UPDATE payments SET mp_payment_id = ?, updated_at = ? WHERE id = ? RETURNING *')
    .bind(mpPaymentId, agora, id)
    .first<PaymentRow>();
}

/** Guarda o QR do PIX, para a tela poder reexibir a cobrança pendente. */
export async function guardarQr(
  db: D1Database,
  id: string,
  dados: { qrCode: string | null; qrCodeBase64: string | null; expiraEm: string | null; agora: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE payments SET qr_code = ?, qr_code_base64 = ?, expira_em = ?, updated_at = ?
        WHERE id = ?`,
    )
    .bind(dados.qrCode, dados.qrCodeBase64, dados.expiraEm, dados.agora, id)
    .run();
}

/**
 * O status que o Mercado Pago devolveu, gravado cru.
 *
 * `pago_em` só é escrito quando o status vira `approved` — e só na primeira
 * vez (`COALESCE`): a data de pagamento não muda porque o webhook foi
 * reentregue.
 */
export async function registrarStatus(
  db: D1Database,
  id: string,
  dados: { status: string; statusDetalhe: string | null; agora: string; pago: boolean },
): Promise<PaymentRow | null> {
  return db
    .prepare(
      `UPDATE payments
          SET status = ?, status_detalhe = ?,
              pago_em = CASE WHEN ? = 1 THEN COALESCE(pago_em, ?) ELSE pago_em END,
              updated_at = ?
        WHERE id = ?
        RETURNING *`,
    )
    .bind(dados.status, dados.statusDetalhe, dados.pago ? 1 : 0, dados.agora, dados.agora, id)
    .first<PaymentRow>();
}

/** As cobranças ainda em aberto da conta — o que a tela mostra como «aguardando». */
export async function pendentesDoUsuario(db: D1Database, userId: string): Promise<PaymentRow[]> {
  const resultado = await db
    .prepare(
      `SELECT * FROM payments
        WHERE user_id = ? AND status IN ('pending', 'in_process', 'authorized')
        ORDER BY created_at DESC LIMIT 10`,
    )
    .bind(userId)
    .all<PaymentRow>();
  return resultado.results ?? [];
}

/**
 * A última cobrança **aprovada** da conta — a que um cancelamento tem de estornar.
 *
 * Só entra linha com `mp_payment_id`: é ele que o Mercado Pago precisa para estornar, e uma
 * aprovada sem ele (não deveria existir) não teria como devolver o dinheiro.
 */
export async function ultimoAprovado(db: D1Database, userId: string): Promise<PaymentRow | null> {
  return db
    .prepare(
      `SELECT * FROM payments
        WHERE user_id = ? AND status = 'approved' AND mp_payment_id IS NOT NULL
        ORDER BY COALESCE(pago_em, created_at) DESC LIMIT 1`,
    )
    .bind(userId)
    .first<PaymentRow>();
}
