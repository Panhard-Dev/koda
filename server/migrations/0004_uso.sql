-- ---------------------------------------------------------------------------
-- O uso **da conta** — tempo e tokens — medido na nuvem.
--
-- ## Por que aqui, e não no banco local
--
-- O backend local (que viaja dentro do instalador) já sabe medir: cada resposta grava o
-- `elapsed_ms` e o `tokens_total` na tabela `messages`. Mas ele é **do PC**, não da conta:
-- trocar de conta na mesma máquina separava; trocar de máquina, não — e reinstalar apagava
-- o gasto. Limite que mora no cliente é limite que o cliente contorna.
--
-- Aqui o local passa a ser só o **coletor**: ele mede e o app reporta. Quem guarda — e
-- portanto quem manda — é esta tabela.
--
-- ## Uma linha por mensagem, e não um contador
--
-- `UNIQUE (user_id, message_id)` é o que torna o relato **idempotente**: se o app reenviar
-- (rede caiu depois do 200, retry, reinstalação que reconta), o `INSERT OR IGNORE` não
-- duplica. Um contador somado não tem como saber que já contou aquela resposta — e o
-- resultado de duplicar é cobrar o dobro de quem teve a rede ruim.
--
-- `dia` e `mes` vêm do **relógio do cliente** (o mesmo recorte do plano: o dia vira à
-- meia-noite de quem usa, não na do servidor). Guardados como texto ISO para a comparação
-- de janela ser uma comparação de strings, como o resto do projeto faz com data.
-- ---------------------------------------------------------------------------

CREATE TABLE usage_events (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id      TEXT NOT NULL,
  conversation_id TEXT,
  model           TEXT,
  -- `YYYY-MM-DD` local de quem respondeu.
  dia             TEXT NOT NULL,
  -- `YYYY-MM` local — o mês de calendário das moedas.
  mes             TEXT NOT NULL,
  tempo_ms        INTEGER NOT NULL DEFAULT 0,
  tokens          INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);

-- A chave da idempotência: uma resposta conta uma vez, por mais que o app reenvie.
CREATE UNIQUE INDEX idx_usage_msg ON usage_events(user_id, message_id);
CREATE INDEX idx_usage_dia ON usage_events(user_id, dia);
CREATE INDEX idx_usage_mes ON usage_events(user_id, mes);
