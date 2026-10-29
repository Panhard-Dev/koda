"""SQLite: conexão, esquema e utilidades.

Abrimos uma conexão por operação. É barato no SQLite e evita dor de cabeça com
threads — as rotas assíncronas chamam o repositório via `asyncio.to_thread`.
"""

from __future__ import annotations

import sqlite3
import json
import time
from collections.abc import Iterator
from contextlib import closing, contextmanager
from pathlib import Path
from . import provider_state

SCHEMA = """
CREATE TABLE IF NOT EXISTS account_permissions (
  owner_account_id TEXT PRIMARY KEY,
  approval_mode TEXT NOT NULL CHECK(approval_mode IN ('plan','manual','default','auto','livre'))
);
CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  -- O resumo do que já saiu do contexto, e **quantas mensagens antigas** ele cobre.
  --
  -- Guardados na conversa porque a compactação é uma decisão que se toma **uma vez**: sem
  -- isto ela era recalculada a cada pedido, das mesmas mensagens, e o aviso «histórico
  -- compactado» reaparecia em toda resposta. Com o resumo guardado, o pedido seguinte já
  -- começa depois das mensagens cobertas — e só volta a compactar quando o que sobrou
  -- encher o orçamento de novo.
  resumo           TEXT,
  resumo_mensagens INTEGER NOT NULL DEFAULT 0
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
  retomavel       INTEGER NOT NULL DEFAULT 1,
  -- A **conta** a que esta mensagem pertence (o e-mail de quem estava logado). É por ela
  -- que o uso — tempo do dia e moedas — é separado: sem esta coluna o gasto era da
  -- máquina, e trocar de conta no mesmo PC continuava mostrando o da conta anterior.
  conta           TEXT,
  reasoning_content TEXT
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

CREATE TABLE IF NOT EXISTS task_plans (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  owner_account_id TEXT NOT NULL,
  window_id TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','superseded','running','completed','interrupted')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_plans_conversation ON task_plans(conversation_id, status);
CREATE TABLE IF NOT EXISTS message_attachments (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  PRIMARY KEY(message_id, attachment_id)
);
CREATE INDEX IF NOT EXISTS idx_message_attachments_attachment ON message_attachments(attachment_id);
"""


class Database:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    def initialize(self) -> None:
        """Cria a pasta, o arquivo e o esquema (idempotente)."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as conn:
            version = conn.execute("PRAGMA user_version").fetchone()[0]
            if version < 3 and conn.execute("SELECT 1 FROM sqlite_master WHERE name='conversations'").fetchone():
                backup = self.path.with_name(self.path.name + f".pre-audit-{time.time_ns()}.bak")
                with closing(sqlite3.connect(backup)) as destination:
                    conn.backup(destination)
            conn.executescript(SCHEMA)
            conn.execute("BEGIN IMMEDIATE")
            self._migrar(conn)
            if version < 3:
                conn.execute("PRAGMA user_version=3")

    @staticmethod
    def _migrar(conn: sqlite3.Connection) -> None:
        """Bancos antigos ganham as colunas novas sem perder o que já têm."""
        plan_schema = conn.execute("SELECT sql FROM sqlite_master WHERE name='task_plans'").fetchone()[0]
        if "'completed'" not in plan_schema:
            conn.execute("ALTER TABLE task_plans RENAME TO task_plans_v2")
            definition = SCHEMA[SCHEMA.index('CREATE TABLE IF NOT EXISTS task_plans ('):]
            conn.execute(definition.split(';', 1)[0])
            conn.execute("INSERT INTO task_plans SELECT * FROM task_plans_v2")
            conn.execute("DROP TABLE task_plans_v2")
            conn.execute("CREATE INDEX idx_task_plans_conversation ON task_plans(conversation_id, status)")
        colunas = {row["name"] for row in conn.execute("PRAGMA table_info(messages)")}
        if "verification" not in colunas:
            conn.execute("ALTER TABLE messages ADD COLUMN verification TEXT NOT NULL DEFAULT '{}'")
        if "reasoning_content" not in colunas:
            conn.execute("ALTER TABLE messages ADD COLUMN reasoning_content TEXT")
        # Estado privado serve à continuidade recente, não é arquivo permanente.
        conn.execute("UPDATE messages SET reasoning_content=NULL WHERE at<?",
                     (int(time.time() * 1000) - 7 * 86400 * 1000,))
        # Migra o estado legado em texto cru; falha de proteção descarta só esse estado
        # privado, sem apagar mensagem, resposta ou evidência das ferramentas.
        for row in conn.execute("SELECT id, reasoning_content FROM messages WHERE reasoning_content IS NOT NULL AND reasoning_content NOT LIKE 'dpapi-v1:%'").fetchall():
            conn.execute("UPDATE messages SET reasoning_content=? WHERE id=?",
                         (provider_state.proteger(row["reasoning_content"]), row["id"]))
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
        # O **custo** da resposta, em tokens: a soma de `total_tokens`, e não de
        # `completion_tokens`. São números diferentes de propósito — `tokens` é o tamanho do
        # que a resposta escreveu, e este é o que o provedor cobra. É daqui que sai a conta das
        # moedas, e por isso ele é guardado em separado: mensagem antiga fica com `NULL`, e a
        # ficha simplesmente não mostra o gasto em vez de mostrar um número inventado.
        if "tokens_total" not in colunas:
            conn.execute("ALTER TABLE messages ADD COLUMN tokens_total INTEGER")
        # A conta dona da mensagem. As linhas antigas ficam com `NULL` — não há como saber
        # de quem eram, e chutar a conta de hoje carimbaria o gasto de outra pessoa nela.
        if "conta" not in colunas:
            conn.execute("ALTER TABLE messages ADD COLUMN conta TEXT")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_conta ON messages(conta, at)")

        # O resumo da compactação, na conversa. Conversa antiga nasce sem resumo e com zero
        # mensagens cobertas — que é exatamente o estado dela: nada foi resumido ainda.
        colunas_conversa = {
            row["name"] for row in conn.execute("PRAGMA table_info(conversations)")
        }
        if "resumo" not in colunas_conversa:
            conn.execute("ALTER TABLE conversations ADD COLUMN resumo TEXT")
        if "resumo_mensagens" not in colunas_conversa:
            conn.execute(
                "ALTER TABLE conversations ADD COLUMN resumo_mensagens INTEGER NOT NULL DEFAULT 0"
            )
        if "owner_account_id" not in colunas_conversa:
            conn.execute("ALTER TABLE conversations ADD COLUMN owner_account_id TEXT")
            # Só migra quando TODAS as mensagens identificam a mesma conta.
            conn.execute("""UPDATE conversations SET owner_account_id = (
                SELECT MIN(lower(trim(conta))) FROM messages WHERE conversation_id = conversations.id
            ) WHERE id IN (SELECT conversation_id FROM messages GROUP BY conversation_id
                HAVING COUNT(*) = COUNT(NULLIF(trim(conta), ''))
                   AND COUNT(DISTINCT lower(trim(conta))) = 1)""")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_conversations_owner ON conversations(owner_account_id, updated_at)")
        attachment_columns = {row["name"] for row in conn.execute("PRAGMA table_info(attachments)")}
        if "owner_account_id" not in attachment_columns:
            conn.execute("ALTER TABLE attachments ADD COLUMN owner_account_id TEXT")
            owners: dict[str, set[str | None]] = {}
            for row in conn.execute("SELECT m.attachments, c.owner_account_id FROM messages m JOIN conversations c ON c.id=m.conversation_id"):
                try:
                    items = json.loads(row["attachments"])
                except (ValueError, TypeError):
                    continue
                if not isinstance(items, list):
                    continue
                for item in items:
                    if isinstance(item, dict) and isinstance(item.get("id"), str):
                        owners.setdefault(item["id"], set()).add(row["owner_account_id"])
            for attachment_id, accounts in owners.items():
                if len(accounts) == 1 and None not in accounts:
                    conn.execute("UPDATE attachments SET owner_account_id=? WHERE id=?", (next(iter(accounts)), attachment_id))
        if "state" not in attachment_columns:
            conn.execute("ALTER TABLE attachments ADD COLUMN state TEXT NOT NULL DEFAULT 'ready'")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_attachments_owner ON attachments(owner_account_id, state)")
        permission_columns = {row["name"] for row in conn.execute("PRAGMA table_info(approval_rules)")}
        if "owner_account_id" not in permission_columns:
            conn.execute("ALTER TABLE approval_rules ADD COLUMN owner_account_id TEXT")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_approval_owner ON approval_rules(owner_account_id, kind, scope)")
        if conn.execute("PRAGMA user_version").fetchone()[0] < 2:
            conn.execute("""INSERT OR IGNORE INTO message_attachments (message_id, attachment_id)
                SELECT m.id, a.id FROM messages m JOIN conversations c ON c.id=m.conversation_id,
                  json_each(CASE WHEN json_valid(m.attachments) THEN m.attachments ELSE '[]' END) j
                JOIN attachments a ON a.id=CASE WHEN j.type='object' THEN json_extract(j.value, '$.id') ELSE NULL END
                WHERE a.owner_account_id=c.owner_account_id""")

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
