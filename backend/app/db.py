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
  at              INTEGER NOT NULL,
  steps           TEXT NOT NULL DEFAULT '[]'
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
