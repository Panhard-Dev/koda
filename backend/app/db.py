"""SQLite: conexão, esquema e utilidades.

Abrimos uma conexão por operação. É barato no SQLite e evita dor de cabeça com
threads — as rotas assíncronas chamam o repositório via `asyncio.to_thread`.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text            TEXT NOT NULL,
  attachments     TEXT NOT NULL DEFAULT '[]',
  model           TEXT,
  elapsed_ms      INTEGER,
  tokens          INTEGER,
  contexto        INTEGER,
  at              INTEGER NOT NULL,
  steps           TEXT NOT NULL DEFAULT '[]',
  todos           TEXT NOT NULL DEFAULT '[]',
  -- O desfecho da rodada. Sem isto, reabrir a conversa perdia a informação de que a
  -- tarefa parou no meio: o plano voltava com um item «em andamento» e nada rodando.
  incompleto      INTEGER NOT NULL DEFAULT 0,
  motivo          TEXT,
  pendentes       TEXT NOT NULL DEFAULT '[]',
  executou        INTEGER NOT NULL DEFAULT 0,
  retomavel       INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, at);
CREATE INDEX IF NOT EXISTS idx_messages_at ON messages(at);

CREATE TABLE IF NOT EXISTS account (
  id     INTEGER PRIMARY KEY CHECK (id = 1),
  name   TEXT NOT NULL,
  plan   TEXT NOT NULL,
  phone  TEXT,
  google INTEGER NOT NULL DEFAULT 0,
  email  TEXT
);

-- Pastas de verdade: cada projeto é uma pasta do disco, com o caminho completo
-- guardado aqui (o app nunca guarda só o nome — nome muda de máquina para máquina).
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  path         TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);

-- O que é do app, não da conta: pasta aberta agora e como o agente pede permissão.
CREATE TABLE IF NOT EXISTS app_settings (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  approval_mode TEXT NOT NULL DEFAULT 'default',
  project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL
);

-- Decisões que valem para sempre («sempre permitir» / «nunca permitir»).
CREATE TABLE IF NOT EXISTS approval_rules (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  scope      TEXT NOT NULL,
  decision   TEXT NOT NULL CHECK (decision IN ('sempre', 'nunca')),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approval_rules_kind ON approval_rules(kind, scope);

-- Anexos da conversa. O conteúdo **não** mora aqui: fica no store próprio (uma pasta ao
-- lado do banco, fora do workspace). Esta tabela é só o índice — id, nome e o caminho no
-- store. É por `id` que a ferramenta `read_attachment` alcança o arquivo; `read_file`
-- continua preso à pasta de trabalho.
CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT PRIMARY KEY,
  nome        TEXT NOT NULL,
  nome_seguro TEXT NOT NULL,
  caminho     TEXT NOT NULL,
  mime        TEXT NOT NULL,
  tamanho     INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  criado_em   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attachments_criado ON attachments(criado_em);
"""


class Database:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    def initialize(self) -> None:
        """Cria a pasta, o arquivo e o esquema (idempotente)."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as conn:
            conn.executescript(SCHEMA)
            self._migrar(conn)

    @staticmethod
    def _migrar(conn: sqlite3.Connection) -> None:
        """Bancos antigos ganham as colunas novas sem perder o que já têm."""
        colunas = {row["name"] for row in conn.execute("PRAGMA table_info(messages)")}
        if "steps" not in colunas:
            conn.execute("ALTER TABLE messages ADD COLUMN steps TEXT NOT NULL DEFAULT '[]'")
        if "tokens" not in colunas:
            conn.execute("ALTER TABLE messages ADD COLUMN tokens INTEGER")
        if "contexto" not in colunas:
            conn.execute("ALTER TABLE messages ADD COLUMN contexto INTEGER")
        if "todos" not in colunas:
            conn.execute("ALTER TABLE messages ADD COLUMN todos TEXT NOT NULL DEFAULT '[]'")
        # O desfecho da rodada. Mensagem antiga nasce **completa**: é o que ela era antes
        # desta coluna existir, e marcar tudo o que já está no banco como «não concluída»
        # encheria o histórico de cartões de tarefa que terminou.
        if "incompleto" not in colunas:
            conn.execute(
                "ALTER TABLE messages ADD COLUMN incompleto INTEGER NOT NULL DEFAULT 0"
            )
        if "motivo" not in colunas:
            conn.execute("ALTER TABLE messages ADD COLUMN motivo TEXT")
        if "pendentes" not in colunas:
            conn.execute(
                "ALTER TABLE messages ADD COLUMN pendentes TEXT NOT NULL DEFAULT '[]'"
            )
        if "executou" not in colunas:
            conn.execute(
                "ALTER TABLE messages ADD COLUMN executou INTEGER NOT NULL DEFAULT 0"
            )
        if "retomavel" not in colunas:
            conn.execute(
                "ALTER TABLE messages ADD COLUMN retomavel INTEGER NOT NULL DEFAULT 1"
            )

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
