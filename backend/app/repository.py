"""Acesso aos dados: conversas, mensagens, uso e conta."""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from .plan import ACCOUNT_DEFAULTS, PLAN
from .schemas import (
    Account,
    Conversation,
    ConversationSummary,
    Message,
    ToolStepOut,
    Usage,
    UsageWindow,
)

TITLE_LIMIT = 40
PREVIEW_LIMIT = 64

#: Marca "não mexe nesse campo" — diferente de `None`, que limpa o valor.
UNSET: Any = object()


def new_id() -> str:
    return str(uuid.uuid4())


def _title_from(text: str) -> str:
    clean = " ".join(text.split())
    return clean[:TITLE_LIMIT].strip() or "Nova conversa"


def _preview(text: str) -> str:
    return " ".join(text.split())[:PREVIEW_LIMIT]


def _carregar_json(valor: object, padrao: list[Any]) -> list[Any]:
    try:
        dados = json.loads(str(valor or "[]"))
    except json.JSONDecodeError:
        return padrao
    return dados if isinstance(dados, list) else padrao


def _row_to_message(row: sqlite3.Row) -> Message:
    colunas = row.keys()
    passos = [
        ToolStepOut.model_validate(item)
        for item in _carregar_json(row["steps"] if "steps" in colunas else "[]", [])
        if isinstance(item, dict)
    ]
    return Message(
        id=row["id"],
        role=row["role"],
        text=row["text"],
        attachments=[str(item) for item in _carregar_json(row["attachments"], [])],
        model=row["model"],
        elapsed_ms=row["elapsed_ms"],
        at=row["at"],
        steps=passos,
    )


def ensure_conversation(
    conn: sqlite3.Connection,
    conversation_id: str | None,
    first_text: str,
    now_ms: int,
) -> str:
    """Devolve o id da conversa, criando uma quando não vier nenhuma."""
    if conversation_id:
        exists = conn.execute(
            "SELECT 1 FROM conversations WHERE id = ?", (conversation_id,)
        ).fetchone()
        if exists:
            return conversation_id

    target = conversation_id or new_id()
    conn.execute(
        "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
        (target, _title_from(first_text), now_ms, now_ms),
    )
    return target


def append_message(conn: sqlite3.Connection, conversation_id: str, message: Message) -> None:
    conn.execute(
        """
        INSERT INTO messages
          (id, conversation_id, role, text, attachments, model, elapsed_ms, at, steps)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            message.id,
            conversation_id,
            message.role,
            message.text,
            json.dumps(message.attachments, ensure_ascii=False),
            message.model,
            message.elapsed_ms,
            message.at,
            json.dumps(
                [passo.model_dump() for passo in message.steps], ensure_ascii=False
            ),
        ),
    )
    conn.execute(
        "UPDATE conversations SET updated_at = ? WHERE id = ?",
        (message.at, conversation_id),
    )


def list_conversations(conn: sqlite3.Connection, limit: int = 30) -> list[ConversationSummary]:
    rows = conn.execute(
        """
        SELECT c.id,
               c.title,
               c.updated_at,
               (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS total,
               (SELECT m.text FROM messages m WHERE m.conversation_id = c.id
                 ORDER BY m.at DESC, m.rowid DESC LIMIT 1) AS last_text
        FROM conversations c
        ORDER BY c.updated_at DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()

    return [
        ConversationSummary(
            id=row["id"],
            title=row["title"],
            preview=_preview(row["last_text"] or "Sem mensagens"),
            message_count=row["total"],
            updated_at=row["updated_at"],
        )
        for row in rows
    ]


def get_conversation(conn: sqlite3.Connection, conversation_id: str) -> Conversation | None:
    row = conn.execute(
        "SELECT * FROM conversations WHERE id = ?", (conversation_id,)
    ).fetchone()
    if row is None:
        return None

    message_rows = conn.execute(
        "SELECT * FROM messages WHERE conversation_id = ? ORDER BY at ASC, rowid ASC",
        (conversation_id,),
    ).fetchall()
    messages = [_row_to_message(item) for item in message_rows]
    last = messages[-1].text if messages else "Sem mensagens"

    return Conversation(
        id=row["id"],
        title=row["title"],
        preview=_preview(last),
        message_count=len(messages),
        updated_at=row["updated_at"],
        messages=messages,
    )


def delete_conversation(conn: sqlite3.Connection, conversation_id: str) -> bool:
    cursor = conn.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))
    return cursor.rowcount > 0


def clear_conversations(conn: sqlite3.Connection) -> None:
    conn.execute("DELETE FROM messages")
    conn.execute("DELETE FROM conversations")


def _window_start_ms(now_ms: int, tz_offset_minutes: int, window: str) -> int:
    """Início da janela no relógio do cliente, de volta para epoch UTC em ms."""
    local_now = datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc) - timedelta(
        minutes=tz_offset_minutes
    )
    midnight = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    if window == "daily":
        start = midnight
    elif window == "weekly":
        start = midnight - timedelta(days=local_now.weekday())
    else:
        start = midnight.replace(day=1)
    return int((start + timedelta(minutes=tz_offset_minutes)).timestamp() * 1000)


def usage(conn: sqlite3.Connection, now_ms: int, tz_offset_minutes: int) -> Usage:
    def count_since(start_ms: int) -> int:
        row = conn.execute(
            "SELECT COUNT(*) AS total FROM messages WHERE at >= ?", (start_ms,)
        ).fetchone()
        return int(row["total"])

    totals = conn.execute(
        "SELECT (SELECT COUNT(*) FROM messages) AS messages,"
        "       (SELECT COUNT(*) FROM conversations) AS conversations"
    ).fetchone()

    return Usage(
        daily=UsageWindow(
            used=count_since(_window_start_ms(now_ms, tz_offset_minutes, "daily")),
            limit=PLAN.daily_messages,
        ),
        weekly=UsageWindow(
            used=count_since(_window_start_ms(now_ms, tz_offset_minutes, "weekly")),
            limit=PLAN.weekly_messages,
        ),
        monthly=UsageWindow(
            used=count_since(_window_start_ms(now_ms, tz_offset_minutes, "monthly")),
            limit=PLAN.monthly_messages,
        ),
        conversations=int(totals["conversations"]),
        messages=int(totals["messages"]),
    )


def _row_to_account(row: sqlite3.Row) -> Account:
    return Account(
        name=row["name"],
        plan=row["plan"],
        phone=row["phone"],
        google=bool(row["google"]),
        email=row["email"],
    )


def get_account(conn: sqlite3.Connection) -> Account:
    row = conn.execute("SELECT * FROM account WHERE id = 1").fetchone()
    if row is None:
        conn.execute(
            "INSERT INTO account (id, name, plan, phone, google, email) VALUES (1, ?, ?, ?, ?, ?)",
            (
                ACCOUNT_DEFAULTS["name"],
                ACCOUNT_DEFAULTS["plan"],
                ACCOUNT_DEFAULTS["phone"],
                ACCOUNT_DEFAULTS["google"],
                ACCOUNT_DEFAULTS["email"],
            ),
        )
        row = conn.execute("SELECT * FROM account WHERE id = 1").fetchone()
    return _row_to_account(row)


def update_account(
    conn: sqlite3.Connection, phone: Any = UNSET, google: Any = UNSET
) -> Account:
    """Atualiza só o que foi enviado; `None` em `phone` desvincula de propósito."""
    current = get_account(conn)
    next_phone = current.phone if phone is UNSET else phone
    next_google = current.google if google is UNSET else bool(google)
    conn.execute(
        "UPDATE account SET phone = ?, google = ?, email = ? WHERE id = 1",
        (next_phone, 1 if next_google else 0, "koda@gmail.com" if next_google else None),
    )
    return get_account(conn)


def reset_account(conn: sqlite3.Connection) -> Account:
    conn.execute(
        "UPDATE account SET phone = NULL, google = 0, email = NULL WHERE id = 1"
    )
    return get_account(conn)
