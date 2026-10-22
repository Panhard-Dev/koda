-- ============================================================================
-- Koda Cloud — pagamento e assinatura (Cloudflare D1 / SQLite)
--
-- Três tabelas, e a razão de cada uma existir:
--
--   plans         o catálogo e o **preço**, no servidor.
--   subscriptions o plano de cada conta.
--   payments      cada cobrança, uma linha por tentativa.
--
-- ## Por que o preço mora aqui e não no app
--
-- Preço que o cliente envia é preço que o cliente escolhe. O app manda o
-- **identificador** do plano (`base`, `plus`, `pro`) e o valor cobrado sai
-- desta tabela — o app nunca diz quanto custa. Se um dia a tela mostrar um
-- número diferente, quem cobra continua certo.
--
-- ## Por que dinheiro é INTEGER
--
-- `14.99` não existe em ponto flutuante binário; existe um número muito perto
-- dele. Somar isso algumas vezes e comparar com o total do Mercado Pago é como
-- se descobre que a conta não fecha. Centavos inteiros não têm esse problema.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Catálogo de planos. `id` é estável e é o que o app manda; `nome` é o que se
-- lê e pode mudar sem quebrar cobrança nenhuma.
-- ---------------------------------------------------------------------------
CREATE TABLE plans (
  id              TEXT PRIMARY KEY,
  nome            TEXT NOT NULL,
  -- Centavos. 1499 = R$ 14,99.
  preco_centavos  INTEGER NOT NULL CHECK (preco_centavos > 0),
  horas_por_dia   INTEGER NOT NULL CHECK (horas_por_dia > 0),
  moedas_por_mes  INTEGER NOT NULL CHECK (moedas_por_mes >= 0),
  moedas_por_dia  INTEGER NOT NULL CHECK (moedas_por_dia >= 0),
  -- Plano desligado some da venda mas continua valendo para quem já assinou:
  -- apagar a linha levaria junto o histórico de quem paga por ela.
  ativo           INTEGER NOT NULL DEFAULT 1,
  ordem           INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_plans_ativos ON plans(ativo, ordem);

-- ---------------------------------------------------------------------------
-- A assinatura de cada conta.
--
--   status: pendente  -> cobrança criada, ainda não paga
--           ativa     -> paga
--           atrasada  -> era ativa e a renovação não veio
--           cancelada -> encerrada
--
-- `mp_preapproval_id` é o id da **recorrência** no Mercado Pago. Ele fica
-- separado do id do pagamento de propósito: são objetos diferentes lá — o
-- `preapproval` é o contrato, e cada mês gera um `payment` dentro dele.
-- Enquanto a recorrência não estiver ligada, ele fica NULL e a assinatura é
-- renovada à mão a cada pagamento aprovado.
-- ---------------------------------------------------------------------------
CREATE TABLE subscriptions (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id           TEXT NOT NULL REFERENCES plans(id),
  status            TEXT NOT NULL DEFAULT 'pendente'
                    CHECK (status IN ('pendente', 'ativa', 'atrasada', 'cancelada')),
  mp_preapproval_id TEXT,
  iniciada_em       TEXT,
  renova_em         TEXT,
  cancelada_em      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- **Índice parcial**, e não UNIQUE na coluna: uma conta pode ter uma
-- assinatura encerrada e outra em andamento — o histórico fica. O que não pode
-- existir são duas vivas ao mesmo tempo.
CREATE UNIQUE INDEX idx_subscriptions_viva
  ON subscriptions(user_id)
  WHERE status IN ('pendente', 'ativa', 'atrasada');

CREATE INDEX idx_subscriptions_plan ON subscriptions(plan_id, status);

-- ---------------------------------------------------------------------------
-- Cada cobrança criada. Uma linha por tentativa, e não uma por assinatura:
-- cartão recusado, PIX vencido e PIX pago são três linhas com o mesmo
-- `user_id`, e é isso que permite responder «por que não entrou».
--
-- `mp_payment_id` é UNIQUE porque é por ele que o webhook encontra a linha.
-- Sem a unicidade, uma notificação reentregue (o Mercado Pago reentrega, e
-- reentrega de novo até receber 200) criaria uma segunda linha para o mesmo
-- pagamento e a assinatura seria ativada duas vezes.
-- ---------------------------------------------------------------------------
CREATE TABLE payments (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id            TEXT NOT NULL REFERENCES plans(id),
  mp_payment_id      TEXT UNIQUE,
  metodo             TEXT NOT NULL CHECK (metodo IN ('cartao', 'pix')),
  -- O valor **cobrado**, congelado aqui. Se o preço do plano mudar amanhã, esta
  -- linha continua contando o que foi cobrado hoje.
  valor_centavos     INTEGER NOT NULL CHECK (valor_centavos > 0),
  -- O status cru do Mercado Pago (`pending`, `approved`, `rejected`, ...). Não
  -- traduzimos para um enum nosso: quem manda no vocabulário é quem cobra, e
  -- traduzir perderia `status_detail`, que é onde está o motivo da recusa.
  status             TEXT NOT NULL,
  status_detalhe     TEXT,
  -- Idempotência da criação. O app manda a chave e o Mercado Pago não cria
  -- duas cobranças para a mesma — aqui ela é UNIQUE para que um retry nosso
  -- também não crie duas linhas.
  chave_idempotencia TEXT NOT NULL UNIQUE,
  -- O PIX: o código copia-e-cola e a imagem em base64. Guardados para a tela
  -- poder mostrar de novo a cobrança que ficou pendente, sem pedir outro QR.
  qr_code            TEXT,
  qr_code_base64     TEXT,
  expira_em          TEXT,
  pago_em            TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX idx_payments_user ON payments(user_id, created_at);
CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_payments_plan ON payments(plan_id, created_at);

-- ---------------------------------------------------------------------------
-- O catálogo inicial. Os números são os mesmos que a tela de venda mostra —
-- mas a partir daqui **esta** é a fonte da verdade, e a tela passa a ler daqui.
-- ---------------------------------------------------------------------------
INSERT INTO plans (id, nome, preco_centavos, horas_por_dia, moedas_por_mes, moedas_por_dia, ativo, ordem, created_at, updated_at) VALUES
  ('base', 'Koda Base', 1499,  4,  350,  20, 1, 1, '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z'),
  ('plus', 'Koda Plus', 2999,  5,  680,  70, 1, 2, '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z'),
  ('pro',  'Koda Pro',  4999, 10, 1500, 160, 1, 3, '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z');
