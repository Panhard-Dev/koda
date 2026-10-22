-- Catálogo de conectores MCP — publicado por `GET /api/public/mcps`.
--
-- A tabela é a fonte de verdade do que aparece na aba MCPs da Store: o painel publica, o
-- backend consome, e sem resposta o app cai na lista da casa. Mesma filosofia do catálogo
-- de modelos: a lista vem do painel, não do app — conector novo entra sem release.
--
-- Tudo que não é texto está como `TEXT` (D1 é SQLite): `credencial` guarda um JSON com
-- `{arquivo?, comando?, env?}`, e o backend faz o `JSON.parse` no momento de extrair. Sem
-- essa flexibilidade, cada provedor vira uma coluna nova.

CREATE TABLE catalog_mcps (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  pacote      TEXT NOT NULL DEFAULT '',
  comando     TEXT NOT NULL,
  params      TEXT NOT NULL DEFAULT '',
  login       TEXT NOT NULL DEFAULT '',
  -- `{arquivo?, comando?, env?}`: regra para extrair a credencial depois do login.
  credencial  TEXT,
  doc_url     TEXT NOT NULL DEFAULT '',
  ativo       INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0, 1)),
  ordem       INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);

CREATE INDEX idx_catalog_mcps_ordem
  ON catalog_mcps (ordem ASC, name ASC)
  WHERE deleted_at IS NULL AND ativo = 1;