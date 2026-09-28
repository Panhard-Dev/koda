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
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pathlib import Path

from .. import approvals, contexto, host_auth, projects
from ..config import Settings
from ..db import Database
from ..deps import call, database, provider
from ..identidade import regras as regras_identidade
from ..identidade import remover_intro
from ..providers import ChatOptions, ChatTurn, ProviderError
from ..repository import append_message, ensure_conversation, get_conversation, new_id
from ..repository import usage as usage_for
from ..schemas import ApprovalDecision, ChatRequest, Message, TodoItem, ToolStepOut, sse
from .skills import indice_para_agente
from ..tools import PROMPT_FERRAMENTAS, executar as rodar_ferramentas
from ..tools.loop import Emit, Resultado

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


@router.post("/chat/approval", tags=["chat"])
async def approval(payload: ApprovalDecision, request: Request) -> dict[str, object]:
    """Resposta do cartão de permissão.

    O passo que pediu está parado esperando exatamente este `id` — a decisão destrava o
    loop que está no meio do stream daquela mensagem.
    """
    pendentes: dict[str, asyncio.Future[str]] = getattr(request.app.state, "aprovacoes", {})
    futuro = pendentes.get(payload.id)
    if futuro is None or futuro.done():
        raise HTTPException(
            status_code=404, detail="essa permissão não está mais esperando resposta"
        )
    futuro.set_result(payload.decisao)
    return {"ok": True, "decisao": payload.decisao}


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
                    f"O provider '{engine.name}' não sabe chamar ferramentas. Suba o host "
                    "(KODA_PROVIDER=host) ou use um provedor OpenAI-compatível com tools."
                )
            },
        )
        return

    started = time.perf_counter()
    conversation_id, turns = await call(_prepare, db, payload, now_ms())
    resumo, turns, compactados = contexto.compactar_turnos(
        turns, request.app.state.settings.contexto_tokens
    )
    yield sse("start", {"conversation_id": conversation_id, "at": now_ms(), "tools": False})
    if compactados:
        yield sse(
            "delta",
            {
                "text": f"_(histórico compactado: {compactados} mensagens antigas viraram "
                "resumo, para a conversa caber no contexto)_\n\n"
            },
        )

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

    options = _options(payload, request.app.state.settings.assistente, resumo)
    # Com qual modelo o provedor realmente responde (o seletor manda o nome da interface).
    modelo = engine.resolve_model(payload.model) if hasattr(engine, "resolve_model") else options.model

    pieces: list[str] = []
    stored = False
    if compactados:
        # A nota entra no texto gravado junto com a resposta: quem relê a conversa depois
        # precisa saber que parte do histórico virou resumo (e não que sumiu).
        nota = _nota_de_compactacao(compactados)
        pieces.append(nota)
        yield sse("delta", {"text": nota})
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
                "tokens": message.tokens,
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
    # Conversa longa: o que é antigo vira resumo no prompt de sistema, em vez de sair do
    # pedido inteiro. Sem isso, uma conversa de projeto grande estoura o contexto e a
    # tarefa morre no meio, com erro do provedor que nem parece ter a ver com o trabalho.
    resumo, turns, compactados = contexto.compactar_turnos(
        turns, settings.contexto_tokens
    )
    yield sse("start", {"conversation_id": conversation_id, "at": now_ms(), "tools": True})

    # A pasta de trabalho é a do projeto escolhido no prompt box; sem projeto, a Área de
    # Trabalho do usuário (ou o que a configuração mandar).
    workspace = await call(_workspace, db, payload.project_path, settings.workspace_path)
    negadas = settings.tools_negadas
    limite = settings.tool_output_limit
    # Skills ligadas do projeto entram no prompt: o agente fica sabendo que elas
    # existem e lê o SKILL.md com read_file quando a tarefa combina.
    skills_prompt = indice_para_agente(settings)
    mensagens: list[dict[str, object]] = [
        {
            "role": "system",
            "content": (
                f"{PROMPT_FERRAMENTAS}\n{regras_identidade(settings.assistente)}\n"
                f"Pasta de trabalho atual: {workspace}"
                + (f"\n\n{resumo}" if resumo else "")
                + (f"\n\n{skills_prompt}" if skills_prompt else "")
            ),
        }
    ]
    mensagens += [{"role": turn.role, "content": turn.text} for turn in turns]

    pedacos: list[str] = []
    #: Última lista de tarefas que o agente registrou — vai gravada na mensagem.
    plano: list[dict[str, object]] = []
    if compactados:
        # Mesma nota do modo texto, e pelo mesmo motivo: ela fica no que está gravado.
        nota = _nota_de_compactacao(compactados)
        pedacos.append(nota)
    passos: list[ToolStepOut] = []
    resultado = Resultado(texto="", passos=[], completou=False, uso={})
    stored = False
    fim: asyncio.Queue[tuple[str, dict[str, object]] | None] = asyncio.Queue()

    async def emit(evento: str, dados: dict[str, object]) -> None:
        if evento == "tool_result":
            # O que fica gravado é o que aparece na tela: saída limitada.
            dados = {**dados, "output": str(dados.get("output", ""))[:limite]}
        if evento == "todos":
            # A lista da última vez é a que fica: é o estado do plano no fim da resposta.
            plano.clear()
            plano.extend(dados.get("todos") or [])  # type: ignore[arg-type]
        await fim.put((evento, dados))

    modo_permissao = await call(_modo_de_permissao, db)

    async def aprovar(acao: dict[str, object]) -> str:
        return await _pedir_permissao(request, db, modo_permissao, emit, acao)

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
                # "Tudo automático" é isso: sem cartão **e** sem trava de pasta. Antes o
                # modo só calava o cartão — a ferramenta de arquivo continuava recusando
                # o que estivesse fora da pasta e mandava o modelo **pedir autorização na
                # conversa**, que é o oposto do que a pessoa escolheu.
                acesso_livre=settings.acesso_livre or modo_permissao == "auto",
                reasoning=payload.reasoning,
                effort=_effort(payload),
                aprovar=None if modo_permissao == "auto" else aprovar,
                # Teto de contexto da tarefa: passando dele, o histórico do loop compacta
                # em vez de estourar o que o provedor aceita.
                orcamento=settings.contexto_tokens,
            )
        finally:
            await fim.put(None)

    loop_task: asyncio.Task[Resultado] | None = None

    try:
        if compactados:
            yield sse("delta", {"text": _nota_de_compactacao(compactados)})
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

        # Fechou sem terminar (orçamento de passos, tempo esgotado): o texto que o loop
        # monta nesse caso não passou por nenhum `delta`, então era gravado e a tela ficava
        # muda. Quem estava olhando via as ferramentas rodarem e depois nada — o agente
        # "parava do nada", sem dizer que parou.
        if not resultado.completou and resultado.texto.strip():
            if resultado.texto.strip() not in "".join(pedacos):
                # O fechamento honesto entra na **lista de pedaços**, e não só na tela: sem
                # isto ele era mostrado e não ficava gravado, então reabrir a conversa
                # mostrava a tarefa sem a frase que diz o que ficou faltando.
                pedaco = f"\n\n{resultado.texto.strip()}"
                pedacos.append(pedaco)
                yield sse("delta", {"text": pedaco})

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
            _store,
            db,
            conversation_id,
            texto,
            modelo,
            elapsed_ms,
            passos,
            _tokens(resultado.uso),
            resultado.todos or plano,
            resultado.contexto or None,
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
                "tokens": message.tokens,
                # O medidor de contexto ao lado do modelo lê daqui, sem recarregar nada.
                "contexto": resultado.contexto or None,
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
            if texto or plano:
                _store(
                    db,
                    conversation_id,
                    texto,
                    None,
                    None,
                    passos,
                    None,
                    resultado.todos or plano,
                    resultado.contexto or None,
                )


def _nota_de_compactacao(compactados: int) -> str:
    """O aviso, em uma linha, de que parte do histórico virou resumo."""
    return (
        f"_(histórico compactado: {compactados} mensagens antigas viraram resumo, para a "
        "conversa caber no contexto)_\n\n"
    )


def _modo_de_permissao(db: Database) -> str:
    with db.connect() as conn:
        return approvals.modo(conn)


def _resolver_permissao(db: Database, acao: dict[str, object], modo_atual: str) -> str:
    with db.connect() as conn:
        return approvals.resolver(conn, acao, modo_atual)


def _lembrar_permissao(db: Database, acao: dict[str, object], decisao: str) -> None:
    with db.connect() as conn:
        approvals.lembrar_tudo(conn, acao, decisao)


async def _pedir_permissao(
    request: Request,
    db: Database,
    modo_atual: str,
    emit: Emit,
    acao: dict[str, object],
) -> str:
    """Decide o que já foi respondido antes; o resto vai para a tela e espera.

    Um «nunca permitir» (ou «sempre permitir») lembrado não passa pela tela de novo; a
    pergunta só aparece no que ainda não tem resposta. Sem resposta em
    `approvals.ESPERA_MAXIMA_S`, a ação é negada — melhor parar do que fazer sozinho.
    """
    politica = await call(_resolver_permissao, db, acao, modo_atual)
    if politica == "sempre":
        return "sempre"
    if politica == "nunca":
        return "nunca"
    if politica == "seguir":
        return "sim"

    pendentes: dict[str, asyncio.Future[str]] = request.app.state.aprovacoes
    identificador = new_id()
    futuro: asyncio.Future[str] = asyncio.get_running_loop().create_future()
    pendentes[identificador] = futuro
    await emit("approval_request", {"id": identificador, **acao})
    try:
        decisao = await asyncio.wait_for(futuro, timeout=approvals.ESPERA_MAXIMA_S)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        decisao = "nao"
    finally:
        pendentes.pop(identificador, None)

    if decisao in ("sempre", "nunca"):
        await call(_lembrar_permissao, db, acao, decisao)
    return decisao


def _workspace(db: Database, caminho: str | None, padrao: Path) -> Path:
    """Pasta escolhida na tela, senão a do projeto aberto, senão o padrão do sistema."""
    with db.connect() as conn:
        escolhida = projects.pasta_de_trabalho(conn, caminho)
    return escolhida or padrao


# --- funções que tocam o SQLite, sempre chamadas via `call` (thread) --------


def _options(payload: ChatRequest, assistente: str, resumo: str = "") -> ChatOptions:
    return ChatOptions(
        model=payload.model,
        resumo=resumo,
        reasoning=payload.reasoning,
        web=payload.web,
        project=payload.project or None,
        attachments=payload.attachments,
        assistente=assistente,
        # Quem está logado, quando a tela já informou a sessão. Vem da memória do processo
        # (nenhuma conta é gravada), e some ao sair.
        conta=host_auth.rotulo_da_conta(),
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


def _tokens(uso: dict[str, Any]) -> int | None:
    """Tokens que um passo custou — `None` quando o provedor não conta."""
    return int(uso.get("total_tokens") or 0) or None


def _store(
    db: Database,
    conversation_id: str,
    text: str,
    model: str | None,
    elapsed_ms: int | None,
    steps: list[ToolStepOut],
    tokens: int | None = None,
    todos: list[dict[str, object]] | None = None,
    contexto: int | None = None,
) -> Message:
    message = Message(
        id=new_id(),
        role="assistant",
        text=text,
        model=model,
        elapsed_ms=elapsed_ms,
        tokens=tokens,
        contexto=contexto,
        at=now_ms(),
        steps=steps,
        todos=[TodoItem.model_validate(item) for item in (todos or [])],
    )
    with db.connect() as conn:
        append_message(conn, conversation_id, message)
    return message


def _usage(db: Database, tz_offset_minutes: int) -> dict[str, object]:
    with db.connect() as conn:
        return usage_for(conn, now_ms(), tz_offset_minutes).model_dump()
