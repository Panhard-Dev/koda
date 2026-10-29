"""Acesso aos dados: conversas, mensagens, uso e conta."""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from .plan import ACCOUNT_DEFAULTS
from .host_auth import proprietario
from . import provider_state
from .schemas import (
    Account,
    AttachmentInfo,
    Conversation,
    ConversationSummary,
    Message,
    TodoItem,
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


def _carregar_anexos(valor: object) -> list[AttachmentInfo]:
    """Lê os anexos gravados na mensagem, tolerando o formato antigo (lista de nomes).

    Antes de o store existir, a coluna guardava só o nome do arquivo. Conversas gravadas
    naquele formato continuam abrindo: o nome vira um anexo sem id, e a tela mostra o
    nome como sempre mostrou.
    """
    itens = _carregar_json(valor, [])
    anexos: list[AttachmentInfo] = []
    for item in itens:
        if isinstance(item, dict):
            try:
                anexos.append(AttachmentInfo.model_validate(item))
            except ValueError:
                continue
        elif isinstance(item, str) and item.strip():
            anexos.append(AttachmentInfo(id="", nome=item, tipo="", tamanho=0))
    return anexos


def _row_to_message(row: sqlite3.Row) -> Message:
    colunas = row.keys()
    try:
        verification = json.loads(row['verification']) if 'verification' in colunas else {}
    except (ValueError, TypeError):
        verification = {}
    passos = [
        ToolStepOut.model_validate(item)
        for item in _carregar_json(row["steps"] if "steps" in colunas else "[]", [])
        if isinstance(item, dict)
    ]
    todos = [
        TodoItem.model_validate(item)
        for item in _carregar_json(row["todos"] if "todos" in colunas else "[]", [])
        if isinstance(item, dict)
    ]
    return Message(
        id=row["id"],
        reasoning_content=provider_state.abrir(row["reasoning_content"]) if "reasoning_content" in colunas else None,
        role=row["role"],
        text=row["text"],
        verification=verification if isinstance(verification, dict) else {},
        attachments=_carregar_anexos(row["attachments"]),
        model=row["model"],
        elapsed_ms=row["elapsed_ms"],
        tokens=row["tokens"] if "tokens" in colunas else None,
        tokens_total=row["tokens_total"] if "tokens_total" in colunas else None,
        contexto=row["contexto"] if "contexto" in colunas else None,
        at=row["at"],
        steps=passos,
        todos=todos,
        incompleto=bool(row["incompleto"]) if "incompleto" in colunas else False,
        motivo=row["motivo"] if "motivo" in colunas else None,
        pendentes=(
            [str(item) for item in _carregar_json(row["pendentes"], []) if str(item).strip()]
            if "pendentes" in colunas
            else []
        ),
        executou=int(row["executou"]) if "executou" in colunas else 0,
        retomavel=bool(row["retomavel"]) if "retomavel" in colunas else True,
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
            "SELECT owner_account_id FROM conversations WHERE id = ?", (conversation_id,)
        ).fetchone()
        if exists:
            if exists["owner_account_id"] != proprietario():
                raise PermissionError("conversa não encontrada")
            return conversation_id

    target = conversation_id or new_id()
    conn.execute(
        "INSERT INTO conversations (id, title, created_at, updated_at, owner_account_id) VALUES (?, ?, ?, ?, ?)",
        (target, _title_from(first_text), now_ms, now_ms, proprietario()),
    )
    return target


def append_message(
    conn: sqlite3.Connection,
    conversation_id: str,
    message: Message,
    conta: str | None = None,
) -> None:
    """Grava a mensagem — e **de quem ela é**.

    `conta` é o e-mail de quem estava logado. É o que separa o uso por conta: sem ela, o
    tempo do dia e as moedas eram da máquina, e trocar de conta no mesmo PC continuava
    mostrando o que a conta anterior tinha gasto.
    """
    _exigir_dono(conn, conversation_id)
    for attachment in message.attachments:
        if attachment.id and not conn.execute("SELECT 1 FROM attachments WHERE id=? AND owner_account_id=? AND state='ready'",
                                              (attachment.id, proprietario())).fetchone():
            raise PermissionError("anexo não encontrado")
    conn.execute(
        """
        INSERT INTO messages
          (id, conversation_id, role, text, attachments, model, elapsed_ms, tokens,
           tokens_total, contexto, at, steps, todos, incompleto, motivo, pendentes, executou,
           retomavel, conta, reasoning_content, verification)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            message.id,
            conversation_id,
            message.role,
            message.text,
            json.dumps(
                [anexo.model_dump() for anexo in message.attachments], ensure_ascii=False
            ),
            message.model,
            message.elapsed_ms,
            message.tokens,
            message.tokens_total,
            message.contexto,
            message.at,
            json.dumps(
                [{**passo.model_dump(), "extra": passo.extra} for passo in message.steps], ensure_ascii=False
            ),
            json.dumps(
                [item.model_dump() for item in message.todos], ensure_ascii=False
            ),
            1 if message.incompleto else 0,
            message.motivo,
            json.dumps(message.pendentes, ensure_ascii=False),
            message.executou,
            1 if message.retomavel else 0,
            conta,
            provider_state.proteger(message.reasoning_content),
            json.dumps(message.verification, ensure_ascii=False),
        ),
    )
    for attachment in message.attachments:
        if attachment.id:
            conn.execute("INSERT OR IGNORE INTO message_attachments (message_id, attachment_id) VALUES (?,?)",
                         (message.id, attachment.id))
    conn.execute(
        "UPDATE conversations SET updated_at = ? WHERE id = ?",
        (message.at, conversation_id),
    )


def resumo_da_conversa(conn: sqlite3.Connection, conversation_id: str) -> tuple[str, int]:
    """O resumo da compactação já guardado, e quantas mensagens antigas ele cobre.

    Devolve `("", 0)` para conversa nova (ou inexistente) — que é o estado de «nada
    resumido ainda».
    """
    row = conn.execute(
        "SELECT resumo, resumo_mensagens FROM conversations WHERE id = ? AND owner_account_id = ?", (conversation_id, proprietario())
    ).fetchone()
    if row is None:
        return ("", 0)
    return (str(row["resumo"] or ""), int(row["resumo_mensagens"] or 0))


def salvar_resumo(
    conn: sqlite3.Connection, conversation_id: str, resumo: str, cobertas: int
) -> None:
    """Guarda o resumo da compactação — e **quantas** mensagens antigas ele cobre.

    É isto que faz a compactação acontecer **uma vez**. Sem guardar, ela era recalculada a
    cada pedido, das mesmas mensagens: o mesmo resumo, o mesmo aviso na tela e o mesmo
    trabalho repetido em toda resposta. No pedido seguinte o histórico começa depois de
    `cobertas`, então o que já virou resumo não volta a virar.
    """
    conn.execute(
        "UPDATE conversations SET resumo = ?, resumo_mensagens = ? WHERE id = ? AND owner_account_id = ? AND resumo_mensagens <= ?",
        (resumo or None, int(cobertas), conversation_id, proprietario(), int(cobertas)),
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
        WHERE c.owner_account_id = ?
        ORDER BY c.updated_at DESC
        LIMIT ?
        """,
        (proprietario(), limit),
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
        "SELECT * FROM conversations WHERE id = ? AND owner_account_id = ?", (conversation_id, proprietario())
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


def mensagens_da_conversa(
    conn: sqlite3.Connection, conversation_id: str, desde: int = 0
) -> list[Message]:
    """As mensagens da conversa **a partir de `desde`** — e não todas.

    Quem monta o prompt só precisa do que vem **depois** do que já virou resumo: o trecho
    coberto nunca é reenviado. Ler a conversa inteira para usar só o rabo custava caro e
    crescia com o tamanho dela — numa conversa de 2.000 mensagens eram ~460 ms **antes do
    primeiro token**, a cada mensagem. Aqui o banco devolve só o que vai ser usado, e o
    índice `idx_messages_conversation` faz o pulo das primeiras ser barato.
    """
    _exigir_dono(conn, conversation_id)
    rows = conn.execute(
        "SELECT * FROM messages WHERE conversation_id = ? ORDER BY at ASC, rowid ASC "
        "LIMIT -1 OFFSET ?",
        (conversation_id, max(0, int(desde))),
    ).fetchall()
    return [_row_to_message(row) for row in rows]


def mensagens_da_tarefa_atual(
    conn: sqlite3.Connection, conversation_id: str
) -> list[Message]:
    """Pedido mais recente e respostas seguintes, inclusive se já viraram resumo.

    A retomada precisa do registro das ferramentas da tarefa em curso. Esse registro pode
    estar fora da janela de contexto viva, então o índice `resumo_mensagens` não serve aqui.
    """
    _exigir_dono(conn, conversation_id)
    rows = conn.execute(
        "SELECT * FROM messages WHERE conversation_id = ? AND rowid >= COALESCE("
        "(SELECT rowid FROM messages WHERE conversation_id = ? AND role = 'user' "
        "ORDER BY rowid DESC LIMIT 1), 0) ORDER BY rowid ASC",
        (conversation_id, conversation_id),
    ).fetchall()
    return [_row_to_message(row) for row in rows]


def delete_conversation(conn: sqlite3.Connection, conversation_id: str) -> bool:
    candidates = [row[0] for row in conn.execute("""SELECT ma.attachment_id FROM message_attachments ma
        JOIN messages m ON m.id=ma.message_id JOIN conversations c ON c.id=m.conversation_id
        WHERE c.id=? AND c.owner_account_id=?""", (conversation_id, proprietario()))]
    cursor = conn.execute("DELETE FROM conversations WHERE id = ? AND owner_account_id = ?", (conversation_id, proprietario()))
    for attachment_id in candidates:
        conn.execute("""UPDATE attachments SET state='deletion_pending' WHERE id=? AND owner_account_id=?
            AND NOT EXISTS(SELECT 1 FROM message_attachments WHERE attachment_id=attachments.id)""",
                     (attachment_id, proprietario()))
    return cursor.rowcount > 0


def clear_conversations(conn: sqlite3.Connection) -> None:
    ids = [row[0] for row in conn.execute("SELECT id FROM conversations WHERE owner_account_id=?", (proprietario(),))]
    for conversation_id in ids:
        delete_conversation(conn, conversation_id)


def _exigir_dono(conn: sqlite3.Connection, conversation_id: str) -> None:
    if not conn.execute("SELECT 1 FROM conversations WHERE id=? AND owner_account_id=?",
                        (conversation_id, proprietario())).fetchone():
        raise PermissionError("conversa não encontrada")


def vincular_legado_verificado(conn: sqlite3.Connection, email: str, account_id: str, created_at: str) -> None:
    """Vincula somente metadados legados consistentes a uma identidade validada na nuvem.

    A criação da conta precisa preceder os dados. Recriar um endereço de e-mail não dá
    acesso ao histórico da antiga conta que usava aquele endereço.
    """
    try:
        created_ms = int(datetime.fromisoformat(created_at.replace("Z", "+00:00")).timestamp() * 1000)
    except (ValueError, TypeError, AttributeError):
        return
    owner = "account:" + account_id
    conn.execute("""UPDATE conversations SET owner_account_id=?
        WHERE owner_account_id=? AND created_at>=?
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=conversations.id
             AND (m.conta IS NULL OR lower(trim(m.conta))!=? OR m.at<?))""",
        (owner, email, created_ms, email, created_ms))
    conn.execute("""UPDATE attachments SET owner_account_id=? WHERE owner_account_id=?
        AND criado_em>=?""", (owner, email, created_ms))


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


def _dias_com_uso(
    conn: sqlite3.Connection,
    now_ms: int,
    tz_offset_minutes: int,
    dias: int = 365,
    conta: str | None = None,
) -> dict[str, int]:
    """Mensagens por dia **no relógio do cliente**, para o mapa de atividade.

    O mapa do ano não é enfeite nem estimativa: cada quadrado é o que ficou no banco desta
    máquina naquele dia. O dia sai do deslocamento do fuso que o cliente manda (o mesmo da
    cota diária), e não do UTC do servidor — senão a noite de quem usa cairia no dia
    seguinte e o mapa pareceria errado justamente em quem conversa tarde.

    `conta` recorta o mapa para quem está logado: o que a outra conta conversou não é
    atividade desta.
    """
    inicio = _window_start_ms(now_ms, tz_offset_minutes, "daily") - (dias - 1) * 86_400_000
    linhas = conn.execute(
        """
        SELECT strftime('%Y-%m-%d', (at - ?) / 1000, 'unixepoch') AS dia,
               COUNT(*) AS total
          FROM messages
         WHERE at >= ? AND conta IS ?
         GROUP BY dia
        """,
        (tz_offset_minutes * 60_000, inicio, conta),
    ).fetchall()
    return {str(linha["dia"]): int(linha["total"]) for linha in linhas if linha["dia"]}


def usage(
    conn: sqlite3.Connection,
    now_ms: int,
    tz_offset_minutes: int,
    conta: str | None = None,
) -> Usage:
    """As cotas **da conta** — e não as da máquina.

    `conta` é o e-mail de quem está logado, e é o recorte que faltava: o gasto pertence a
    quem gastou. Sem ele, trocar de conta no mesmo PC continuava mostrando o tempo do dia e
    as moedas da conta anterior — foi exatamente o que o dono viu.

    Sem conta (ninguém logado) a resposta é **zero**, e não a soma de tudo o que já passou
    por esta máquina: cota sem dono é cota de ninguém.

    **O zero tem de ser dito, não confiado ao `IS ?`.** Em SQLite `NULL IS NULL` é
    verdadeiro, então `conta IS ?` com `None` casava justamente com as linhas **sem dono** —
    a soma caía na história inteira da máquina, que é o oposto do que esta função promete.
    Era esse o defeito: um PC com uso antigo abria a versão nova mostrando `00:00:00` e
    `0000` de moedas **antes** de a conta ser entregue ao backend, porque o `conta=None`
    somava tudo. Com a conta entregue a soma zerava (as linhas antigas são de ninguém), e a
    aba voltava ao cheio — as duas pontas erradas pela mesma causa.
    """

    if conta is None:
        vazio = lambda: UsageWindow(tempo_ms=0, tokens_por_modelo={})  # noqa: E731
        return Usage(
            daily=vazio(),
            weekly=vazio(),
            monthly=vazio(),
            conversations=0,
            messages=0,
            dias={},
        )

    def janela(kind: str) -> UsageWindow:
        inicio = _window_start_ms(now_ms, tz_offset_minutes, kind)

        tempo = conn.execute(
            "SELECT COALESCE(SUM(elapsed_ms), 0) AS ms FROM messages"
            " WHERE at >= ? AND conta IS ?",
            (inicio, conta),
        ).fetchone()

        # `tokens_total` e não `tokens`: é o **custo** — o que o provedor cobrou, com o contexto
        # reenviado em cada passo. É dele que sai a conta das moedas na ficha da resposta, e é
        # ele que tem de sair daqui também, senão a tela de uso e a ficha discordariam.
        modelos = conn.execute(
            "SELECT model, COALESCE(SUM(tokens_total), 0) AS tokens FROM messages"
            " WHERE at >= ? AND model IS NOT NULL AND conta IS ?"
            " GROUP BY model",
            (inicio, conta),
        ).fetchall()

        return UsageWindow(
            tempo_ms=int(tempo["ms"]),
            tokens_por_modelo={
                str(linha["model"]): int(linha["tokens"])
                for linha in modelos
                if int(linha["tokens"]) > 0
            },
        )

    # As contagens também são da conta: a conversa entra se tem mensagem **dela**.
    totals = conn.execute(
        "SELECT (SELECT COUNT(*) FROM messages WHERE conta IS ?) AS messages,"
        "       (SELECT COUNT(DISTINCT conversation_id) FROM messages WHERE conta IS ?)"
        "       AS conversations",
        (conta, conta),
    ).fetchone()

    return Usage(
        daily=janela("daily"),
        weekly=janela("weekly"),
        monthly=janela("monthly"),
        conversations=int(totals["conversations"]),
        messages=int(totals["messages"]),
        dias=_dias_com_uso(conn, now_ms, tz_offset_minutes, conta=conta),
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
