"""Planos imutáveis e decisões explícitas; texto do modelo não concede permissão."""
from __future__ import annotations

import hashlib
import json
import re
import time
import uuid

from .. import host_auth
from ..db import Database
from ..schemas import ChatRequest

BLOCK = re.compile(r"```(koda-plano|koda-visual)\s*\n(.*?)\n```", re.DOTALL)


def registrar(db: Database, conversation_id: str, payload: ChatRequest, text: str) -> str:
    plan_id = str(uuid.uuid4())
    found = False

    def bind(match: re.Match[str]) -> str:
        nonlocal found
        try:
            data = json.loads(match[2])
        except ValueError:
            return match[0]
        if not isinstance(data, dict) or (match[1] != "koda-plano" and data.get("tipo") != "plano"):
            return match[0]
        if found:
            return match[0]  # um plano acionável por rodada
        found = True
        data["plan_id"] = plan_id
        return f"```{match[1]}\n{json.dumps(data, ensure_ascii=False)}\n```"

    bound = BLOCK.sub(bind, text)
    if not found:
        return text
    with db.connect() as conn:
        conn.execute("UPDATE task_plans SET status='superseded' WHERE conversation_id=? AND status IN ('pending','approved')",
                     (conversation_id,))
        conn.execute("""INSERT INTO task_plans
            (id, conversation_id, owner_account_id, window_id, snapshot, content_hash, content, status, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)""",
            (plan_id, conversation_id, host_auth.proprietario(), host_auth.contexto_atual().window,
             payload.model_copy(update={"conversation_id": conversation_id}).model_dump_json(),
             hashlib.sha256(bound.encode()).hexdigest(), bound, int(time.time()) + 86400))
    return bound


def decidir(db: Database, plan_id: str, decision: str) -> ChatRequest:
    if decision not in {"approve", "reject"}:
        raise ValueError("decisão inválida")
    target = "approved" if decision == "approve" else "rejected"
    with db.connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("""UPDATE task_plans SET status=? WHERE id=? AND owner_account_id=?
            AND window_id=? AND status IN ('pending', ?) AND expires_at>? RETURNING snapshot""",
            (target, plan_id,
             host_auth.proprietario(), host_auth.contexto_atual().window, target, int(time.time()))).fetchone()
        if row is None:
            raise LookupError("plano expirado, substituído ou já decidido")
        payload = ChatRequest.model_validate_json(row["snapshot"])
        return payload.model_copy(update={"resume": True, "approved_plan_id": plan_id,
                                          "text": "", "attachments": []})


def consumir(db: Database, payload: ChatRequest) -> ChatRequest:
    with db.connect() as conn:
        row = conn.execute("""UPDATE task_plans SET status='running' WHERE id=? AND conversation_id=?
            AND owner_account_id=? AND window_id=? AND status='approved' AND expires_at>?
            RETURNING snapshot""", (payload.approved_plan_id, payload.conversation_id,
            host_auth.proprietario(), host_auth.contexto_atual().window, int(time.time()))).fetchone()
        if row is None:
            raise LookupError("aprovação inválida ou já consumida")
        original = ChatRequest.model_validate_json(row["snapshot"])
        return original.model_copy(update={"resume": True, "approved_plan_id": payload.approved_plan_id,
                                            "text": "", "attachments": []})


def em_execucao(db: Database, conversation_id: str) -> bool:
    with db.connect() as conn:
        return conn.execute("""SELECT 1 FROM task_plans WHERE conversation_id=? AND owner_account_id=?
            AND window_id=? AND status IN ('running','interrupted') AND expires_at>?""",
            (conversation_id, host_auth.proprietario(), host_auth.contexto_atual().window,
             int(time.time()))).fetchone() is not None


def finalizar(db: Database, conversation_id: str, completed: bool) -> None:
    """Concluir revoga a execução; interrupção preserva somente a retomada explícita."""
    with db.connect() as conn:
        conn.execute("""UPDATE task_plans SET status=? WHERE conversation_id=?
            AND owner_account_id=? AND window_id=? AND status IN ('running','interrupted')""",
            ('completed' if completed else 'interrupted', conversation_id,
             host_auth.proprietario(), host_auth.contexto_atual().window))


def retomar(db: Database, payload: ChatRequest) -> ChatRequest:
    """Retomar um plano não autoriza trocar projeto, modelo ou capacidades salvas."""
    with db.connect() as conn:
        row = conn.execute("""UPDATE task_plans SET status='running' WHERE conversation_id=?
            AND owner_account_id=? AND window_id=? AND status IN ('running','interrupted')
            AND expires_at>? RETURNING snapshot""", (payload.conversation_id,
            host_auth.proprietario(), host_auth.contexto_atual().window, int(time.time()))).fetchone()
        if row is None:
            return payload
        original = ChatRequest.model_validate_json(row['snapshot'])
        return original.model_copy(update={'resume': True, 'text': '', 'attachments': [],
                                           'approved_plan_id': None})
