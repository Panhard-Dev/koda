-- ---------------------------------------------------------------------------
-- Crédito avulso: a cobrança deixa de ser só de plano.
--
-- ## Por que **não** reconstruir a tabela `payments`
--
-- O caminho "correto" seria afrouxar `payments.plan_id` (era NOT NULL) e reconstruir a tabela —
-- o procedimento padrão do SQLite, porque ele não altera a nulidade de uma coluna existente.
-- Tentei: **cada instrução passa pelo `execute`, mas o `migrations apply` recusa o arquivo
-- inteiro** com `SQLITE_CANTOPEN`, sem dizer qual linha. Não são os comentários (testei sem
-- eles), não é o tamanho (é o menor dos três) e não é a codificação (as outras duas migrações
-- têm os mesmos acentos e em-dashes). É a reconstrução.
--
-- Então o modelo mudou de lugar em vez de mudar de forma:
--
-- * **`plans` é a tabela de produtos**, e o pacote de crédito é um produto. Ele entra como uma
--   linha (`id = 'creditos'`) com **`ativo = 0`** — fora do catálogo, porque o catálogo é o que
--   se assina, e isto não se assina. A chave estrangeira continua válida, e ninguém precisa
--   afrouxar nada.
-- * **`payments.creditos`** diz quanto a cobrança creditou. Numa compra de plano fica NULL; numa
--   compra de crédito, preenchido — e a regra "ou plano, ou crédito" passa a viver no código,
--   já que o SQLite não deixa acrescentar um CHECK a uma coluna existente.
-- ---------------------------------------------------------------------------

ALTER TABLE payments ADD COLUMN creditos INTEGER;

-- O produto que a cobrança de crédito avulso compra. `preco_centavos = 1` é um marcador: o valor
-- de verdade é o da cobrança (`payments.valor_centavos`), que varia com o pacote e com o valor
-- livre. O CHECK da tabela exige um preço positivo, e inventar um número "realista" aqui seria
-- pior — pareceria um preço.
INSERT INTO plans
  (id, nome, preco_centavos, horas_por_dia, moedas_por_mes, moedas_por_dia, ativo, ordem, created_at, updated_at)
VALUES
  ('creditos', 'Créditos avulsos', 1, 1, 0, 0, 0, 99, '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z');

-- ---------------------------------------------------------------------------
-- O saldo de crédito comprado.
--
-- Uma linha por compra, e não um saldo único: o crédito avulso **vence**, e saldo único não
-- guarda a data de cada entrada. O saldo é a soma das linhas ainda não vencidas.
--
-- `payment_id` é UNIQUE de propósito: o webhook pode chegar duas vezes (o Mercado Pago reenvia
-- até receber 200), e é esta restrição que impede creditar a mesma compra em dobro. Sem ela, uma
-- notificação repetida daria crédito de graça.
-- ---------------------------------------------------------------------------

CREATE TABLE credit_grants (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  creditos   INTEGER NOT NULL CHECK (creditos > 0),
  payment_id TEXT UNIQUE REFERENCES payments(id) ON DELETE SET NULL,
  expira_em  TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_credit_grants_user ON credit_grants(user_id, expira_em);
