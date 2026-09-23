"""POST /api/chat — responde em streaming e grava a conversa.

Dois caminhos, escolhidos por `tools` no corpo:
- **texto**: uma resposta só, em streaming (como antes);
- **agente**: o modelo pode chamar as ferramentas locais entre passos, e cada chamada e
  cada resultado sai como evento (`tool_call` / `tool_result`) para a interface mostrar.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator
from contextlib import suppress

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from ..config import Settings
from ..db import Database
from ..deps import call, database, provider
from ..identidade import regras as regras_identidade
from ..identidade import remover_intro
from ..providers import ChatOptions, ChatTurn, ProviderError
from ..repository import append_message, ensure_conversation, get_conversation, new_id
from ..repository import usage as usage_for
from ..schemas import ChatRequest, Message, ToolStepOut, sse
from ..tools import PROMPT_FERRAMENTAS, executar as rodar_ferramentas
from ..tools.loop import Resultado

router = APIRouter(tags=["chat"])

SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    # Sem isso um proxy pode segurar o stream até o fim da resposta.
    "X-Accel-Buffering": "no",
}


def now_ms() -> int:
    """Epoch em milissegundos — mesma unidade que o front usa para `at`."""
    return int(time.time() * 1000)


# `response_model=None`: a anotação de retorno é um Response, e o FastAPI a usaria
# como modelo de resposta (o stream sairia como `null`).
@router.post("/chat", response_model=None)
async def chat(payload: ChatRequest, request: Request) -> StreamingResponse:
    settings: Settings = request.app.state.settings
    engine = provider(request)
    # O agente é o comportamento normal quando o provedor sabe chamar ferramentas;
    # `tools` no corpo só serve para forçar (true) ou desligar (false) numa mensagem.
    usa_ferramentas = settings.tools if payload.tools is None else payload.tools
    if usa_ferramentas and engine.ready and hasattr(engine, "step"):
        events = _agente(request, settings, payload)
    else:
        events = _texto(request, payload, exigiu_ferramentas=payload.tools is True)
    return StreamingResponse(events, media_type="text/event-stream", headers=SSE_HEADERS)


# --------------------------------------------------------------- modo texto


async def _texto(
    request: Request, payload: ChatRequest, exigiu_ferramentas: bool = False
) -> AsyncIterator[str]:
    db = database(request)
    engine = provider(request)

    if exigiu_ferramentas:
        yield sse(
            "error",
            {
                "message": (
                    f"O provider '{engine.name}' não sabe chamar ferramentas. Use o proxy "
                    "Gemini (KODA_PROVIDER=gemini) ou um provedor OpenAI-compatível com tools."
                )
            },
        )
        return

    started = time.perf_counter()
    conversation_id, turns = await call(_prepare, db, payload, now_ms())
    yield sse("start", {"conversation_id": conversation_id, "at": now_ms(), "tools": False})

    if not engine.ready:
        yield sse(
            "error",
            {
                "message": (
                    "O provider configurado não está pronto: preencha OPENAI_API_KEY no "
                    "backend/.env (ou use KODA_PROVIDER=local) e reinicie o servidor."
                )
            },
        )
        return

    options = _options(payload, request.app.state.settings.assistente)
    # Com qual modelo o provedor realmente responde (o seletor manda o nome da interface).
    modelo = engine.resolve_model(payload.model) if hasattr(engine, "resolve_model") else options.model

    pieces: list[str] = []
    stored = False
    try:
        async for piece in engine.stream(turns, options):
            if piece.reasoning:
                # Raciocínio não é a resposta: vai para a tela para o usuário acompanhar o
                # modelo pensando, mas não entra no texto gravado da mensagem.
                yield sse("reasoning", {"text": piece.text})
                continue
            pieces.append(piece.text)
            yield sse("delta", {"text": piece.text})

        text = "".join(pieces).strip()
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        message = await call(_store, db, conversation_id, text, modelo, elapsed_ms, [])
        stored = True
        yield sse(
            "done",
            {
                "conversation_id": conversation_id,
                "message_id": message.id,
                "elapsed_ms": elapsed_ms,
                "steps": 0,
                "usage": await call(_usage, db, payload.tz_offset_minutes),
            },
        )
    except ProviderError as error:
        yield sse("error", {"message": str(error)})
    finally:
        # Cliente fechou no meio (botão de parar): guarda o que já veio, para o
        # histórico do banco e o da tela ficarem iguais.
        if pieces and not stored:
            text = "".join(pieces).strip()
            if text:
                _store(db, conversation_id, text, modelo, None, [])


# --------------------------------------------------------------- modo agente


async def _agente(
    request: Request, settings: Settings, payload: ChatRequest
) -> AsyncIterator[str]:
    db = database(request)
    engine = provider(request)

    started = time.perf_counter()
    conversation_id, turns = await call(_prepare, db, payload, now_ms())
    yield sse("start", {"conversation_id": conversation_id, "at": now_ms(), "tools": True})

    workspace = settings.workspace_path
    negadas = settings.tools_negadas
    limite = settings.tool_output_limit
    mensagens: list[dict[str, object]] = [
        {
            "role": "system",
            "content": (
                f"{PROMPT_FERRAMENTAS}\n{regras_identidade(settings.assistente)}\n"
                f"Pasta de trabalho atual: {workspace}"
            ),
        }
    ]
    mensagens += [{"role": turn.role, "content": turn.text} for turn in turns]

    pedacos: list[str] = []
    passos: list[ToolStepOut] = []
    resultado = Resultado(texto="", passos=[], completou=False, uso={})
    stored = False
    fim: asyncio.Queue[tuple[str, dict[str, object]] | None] = asyncio.Queue()

    async def emit(evento: str, dados: dict[str, object]) -> None:
        if evento == "tool_result":
            # O que fica gravado é o que aparece na tela: saída limitada.
            dados = {**dados, "output": str(dados.get("output", ""))[:limite]}
        await fim.put((evento, dados))

    async def rodar() -> Resultado:
        try:
            return await rodar_ferramentas(
                engine,
                mensagens,
                workspace=workspace,
                max_steps=payload.max_steps or settings.max_steps,
                emit=emit,
                negadas=negadas,
                model=payload.model,
                timeout_s=settings.tool_timeout_s or None,
                tentativas=settings.retry_attempts,
                espera_final=float(settings.retry_final_wait_s),
                acesso_livre=settings.acesso_livre,
                reasoning=payload.reasoning,
                effort=_effort(payload),
            )
        finally:
            await fim.put(None)

    loop_task: asyncio.Task[Resultado] | None = None

    try:
        loop_task = asyncio.create_task(rodar())

        # O loop roda como tarefa e narra cada passo: a fila entrega na ordem, sem
        # esperar a tarefa terminar para o próximo evento sair.
        while True:
            item = await fim.get()
            if item is None:
                break
            evento, dados = item
            if evento == "delta":
                pedacos.append(str(dados.get("text", "")))
            yield sse(evento, dados)

        resultado = await loop_task

        passos = [
            ToolStepOut(
                name=passo.name,
                arguments=passo.arguments,
                output=passo.output[:limite],
                duration_ms=passo.duration_ms,
                call_id=passo.call_id,
                ok=passo.ok,
            )
            for passo in resultado.passos
        ]

        # O que fica gravado é exatamente o que a tela montou com os deltas.
        texto = "".join(pedacos).strip() or resultado.texto.strip()
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        # O provedor é quem sabe com qual modelo está falando.
        modelo = engine.resolve_model(payload.model)
        message = await call(
            _store, db, conversation_id, texto, modelo, elapsed_ms, passos
        )
        stored = True
        yield sse(
            "done",
            {
                "conversation_id": conversation_id,
                "message_id": message.id,
                "elapsed_ms": elapsed_ms,
                "steps": len(passos),
                "completed": resultado.completou,
                "usage": await call(_usage, db, payload.tz_offset_minutes),
            },
        )
    except ProviderError as error:
        yield sse("error", {"message": str(error)})
    finally:
        # O cliente abortou (botão parar, aba fechada): sem cancelar, a tarefa continua
        # rodando os passos restantes e enfileirando eventos que ninguém mais lê. Uma
        # ferramenta já em execução termina — ela roda em thread e não dá para cortar no
        # meio —, mas o loop não avança para o próximo passo.
        if loop_task is not None:
            loop_task.cancel()  # no-op quando a tarefa já terminou
            with suppress(asyncio.CancelledError, ProviderError):
                await loop_task

        # Parou no meio ou caiu a conexão: guarda o que já saiu, sem perder a tarefa.
        if not stored:
            texto = ("".join(pedacos) or resultado.texto).strip()
            if texto:
                _store(db, conversation_id, texto, None, None, passos)


# --- funções que tocam o SQLite, sempre chamadas via `call` (thread) --------


def _options(payload: ChatRequest, assistente: str) -> ChatOptions:
    return ChatOptions(
        model=payload.model,
        reasoning=payload.reasoning,
        web=payload.web,
        project=payload.project or None,
        attachments=payload.attachments,
        assistente=assistente,
        effort=_effort(payload),
    )


def _effort(payload: ChatRequest) -> str | None:
    """Esforço do seletor; `auto` (o padrão) deixa a decisão com o botão Reasoning."""
    return None if payload.effort == "auto" else payload.effort


def _prepare(
    db: Database, payload: ChatRequest, at_ms: int
) -> tuple[str, list[ChatTurn]]:
    with db.connect() as conn:
        conversation_id = ensure_conversation(conn, payload.conversation_id, payload.text, at_ms)
        append_message(
            conn,
            conversation_id,
            Message(
                id=new_id(),
                role="user",
                text=payload.text,
                attachments=payload.attachments,
                model=payload.model,
                at=at_ms,
            ),
        )
        # Já com a mensagem recém-gravada, para o provider ter o contexto todo.
        conversation = get_conversation(conn, conversation_id)
        turns = _turns(conversation.messages if conversation else [])
    return conversation_id, turns


def _turns(mensagens: list[Message]) -> list[ChatTurn]:
    """Histórico para o provedor, sem as apresentações que ficaram gravadas.

    O modelo aprende pelo próprio histórico: uma resposta antiga começando com "oii, eu
    sou a Liz…" faz ele repetir a apresentação em todas as mensagens seguintes. Tirar
    isso do que é reenviado quebra a repetição.
    """
    turns: list[ChatTurn] = []
    for item in mensagens:
        texto = remover_intro(item.text) if item.role == "assistant" else item.text
        if not texto.strip():
            # Mensagem que era só apresentação: melhor sair do histórico do que ir vazia.
            continue
        turns.append(ChatTurn(role=item.role, text=texto))
    return turns


def _store(
    db: Database,
    conversation_id: str,
    text: str,
    model: str | None,
    elapsed_ms: int | None,
    steps: list[ToolStepOut],
) -> Message:
    message = Message(
        id=new_id(),
        role="assistant",
        text=text,
        model=model,
        elapsed_ms=elapsed_ms,
        at=now_ms(),
        steps=steps,
    )
    with db.connect() as conn:
        append_message(conn, conversation_id, message)
    return message


def _usage(db: Database, tz_offset_minutes: int) -> dict[str, object]:
    with db.connect() as conn:
        return usage_for(conn, now_ms(), tz_offset_minutes).model_dump()
