"""Histórico: listar, abrir, criar e apagar conversas."""

from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException, Request

from ..db import Database
from ..deps import call, database
from ..repository import (
    delete_conversation,
    ensure_conversation,
    get_conversation,
    list_conversations,
)
from ..schemas import Conversation, ConversationSummary

router = APIRouter(prefix="/conversations", tags=["conversations"])


def _list(db: Database, limit: int) -> list[ConversationSummary]:
    with db.connect() as conn:
        return list_conversations(conn, limit)


def _get(db: Database, conversation_id: str) -> Conversation | None:
    with db.connect() as conn:
        return get_conversation(conn, conversation_id)


def _create(db: Database, title: str | None) -> Conversation:
    with db.connect() as conn:
        at_ms = int(time.time() * 1000)
        conversation_id = ensure_conversation(conn, None, title or "", at_ms)
        if title:
            conn.execute("UPDATE conversations SET title = ? WHERE id = ?", (title, conversation_id))
        conversation = get_conversation(conn, conversation_id)
    if conversation is None:  # pragma: no cover - só se alguém apagar no meio
        raise HTTPException(status_code=500, detail="não consegui criar a conversa")
    return conversation


def _delete(db: Database, conversation_id: str) -> bool:
    with db.connect() as conn:
        return delete_conversation(conn, conversation_id)


@router.get("", response_model=list[ConversationSummary])
async def index(request: Request, limit: int = 30) -> list[ConversationSummary]:
    return await call(_list, database(request), max(1, min(limit, 100)))


@router.post("", response_model=Conversation, status_code=201)
async def create(request: Request, title: str | None = None) -> Conversation:
    return await call(_create, database(request), title)


@router.get("/{conversation_id}", response_model=Conversation)
async def show(conversation_id: str, request: Request) -> Conversation:
    conversation = await call(_get, database(request), conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="conversa não encontrada")
    return conversation


@router.delete("/{conversation_id}", status_code=204)
async def destroy(conversation_id: str, request: Request) -> None:
    removed = await call(_delete, database(request), conversation_id)
    if not removed:
        raise HTTPException(status_code=404, detail="conversa não encontrada")
