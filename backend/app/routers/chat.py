"""POST /api/chat — responde em streaming e grava a conversa.

Dois caminhos, escolhidos por `tools` no corpo:
- **texto**: uma resposta só, em streaming (como antes);
- **agente**: o modelo pode chamar as ferramentas locais entre passos, e cada chamada e
  cada resultado sai como evento (`tool_call` / `tool_result`) para a interface mostrar.
"""

from __future__ import annotations

import asyncio
import base64
import json
import threading
import time
import logging
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pathlib import Path

from .. import anexos, caminhos_marcados, economia, host_auth, mcp, projects, ui_documento, video
from ..agent import contexto
from ..agent import dsml
from ..agent import plans
from ..agent import repeticao
from ..contracts.approval import PendingApproval
from pydantic import BaseModel
from typing import Literal
from ..policy import approvals
from ..config import Settings
from ..db import Database
from ..deps import call, database, provider
from ..identidade import regras as regras_identidade
from ..identidade import remover_intro
from ..providers import (
    ChatOptions,
    ChatTurn,
    ProviderError,
    build_provider,
    conteudo_do_turno,
    system_prompt,
)
from ..providers.openai_compat import HostProvider
from ..repository import (
    append_message,
    ensure_conversation,
    get_conversation,
    mensagens_da_conversa,
    mensagens_da_tarefa_atual,
    new_id,
    resumo_da_conversa,
    salvar_resumo,
)
from ..repository import usage as usage_for
from ..schemas import (
    ApprovalDecision,
    AttachmentInfo,
    ChatRequest,
    Message,
    TodoItem,
    ToolStepOut,
    sse,
)
from .skills import indice_para_agente
from ..skills import SkillStore
from ..agent.loop import PROMPT_FERRAMENTAS, executar as rodar_ferramentas
from ..tools import ferramentas, registry
from ..ui_generativa import FiltroKodaUI, filtrar_stream, rebaixar_koda_ui
from ..agent.loop import (
    ALO_DE_RACIOCINIO,
    AVISO_DE_RACIOCINIO_EM_LOOP,
    CONTINUAR_TRUNCADA,
    EXECUTAR_PLANO_APROVADO,
    MAX_ALOS_DE_RACIOCINIO,
    PARADA_ABORTADA,
    PARADA_PROVEDOR,
    PLANEJAMENTO,
    RETOMAR_TAREFA,
    Emit,
    Resultado,
    motivo_do_provedor,
)

router = APIRouter(tags=["chat"])


class PlanDecision(BaseModel):
    id: str
    decision: Literal["approve", "reject"]


@router.post("/chat/plan/decision")
async def plan_decision(payload: PlanDecision, request: Request) -> dict[str, object]:
    try:
        execution = await call(plans.decidir, database(request), payload.id, payload.decision)
    except LookupError as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"ok": True, "execution": execution.model_dump() if payload.decision == "approve" else None}

SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    # Sem isso um proxy pode segurar o stream até o fim da resposta.
    "X-Accel-Buffering": "no",
}

#: Quanto o fechamento do stream espera o loop morrer depois de cancelado. O Parar não pode
#: depender de uma ferramenta que já está em execução (ela roda em thread e não dá para
#: cortar no meio): passado o teto, a resposta fecha e o processo já foi derrubado.
CANCELAMENTO_MAX_S = 5.0

#: De quanto em quanto tempo o stream manda um sinal de vida enquanto o agente trabalha
#: calado (provedor pensando, ferramenta rodando). O cliente conta esse silêncio para
#: decidir reconectar — 15 s de intervalo mantém a paciência dele (60 s) folgada.
SINAL_DE_VIDA_S = 15.0

#: Sentinela do sinal de vida na fila de eventos. Não é `None` (que é o fim) nem uma
#: tupla `(evento, dados)`: quando ele aparece, o stream emite um comentário vazio.
_SINAL_DE_VIDA = object()


def _registrar_passo_do_stream(
    evento: str,
    dados: dict[str, object],
    passos: list[ToolStepOut],
    chamadas: dict[str, dict[str, object]],
    limite: int,
) -> dict[str, object]:
    """Mantém na memória os passos concluídos mesmo se o cliente fechar o stream.

    O resultado final normalmente traz `resultado.passos`, mas quando o navegador cancela
    a rodada o `await loop_task` é cancelado antes de copiá-los. Sem este registro
    incremental, o cartão dizia que a tarefa parou, mas a mensagem não guardava nenhuma
    leitura executada — a retomada reiniciava na primeira linha. Os metadados opacos são
    consumidos aqui e nunca enviados à interface.
    """
    if evento == "tool_call":
        identificador = str(dados.get("id") or "")
        if identificador:
            argumentos = dados.get("arguments")
            chamadas[identificador] = {
                "name": str(dados.get("name") or ""),
                "arguments": argumentos if isinstance(argumentos, dict) else {},
                "raw_arguments": str(dados.get("_raw_arguments") or ""),
                "extra": dados.get("_provider_extra"),
                "mcp": dados.get("mcp"),
            }
        return {
            chave: valor for chave, valor in dados.items()
            if chave not in {"_raw_arguments", "_provider_extra"}
        }

    if evento != "tool_result":
        return dados

    dados = {**dados, "output": str(dados.get("output", ""))[:limite]}
    identificador = str(dados.get("id") or "")
    if identificador and not any(passo.call_id == identificador for passo in passos):
        chamada = chamadas.pop(identificador, {})
        argumentos = chamada.get("arguments")
        passos.append(ToolStepOut(
            name=str(dados.get("name") or chamada.get("name") or ""),
            arguments=argumentos if isinstance(argumentos, dict) else {},
            output=str(dados.get("output", "")),
            duration_ms=max(0, int(dados.get("duration_ms") or 0)),
            call_id=identificador,
            executed=bool(dados.get("executed", False)),
            status=str(dados.get("status") or ("success" if dados.get("ok") else "blocked")),
            ok=bool(dados.get("ok", False)),
            raw_arguments=str(chamada.get("raw_arguments") or ""),
            mcp=dados.get("mcp") if isinstance(dados.get("mcp"), dict)
            else (chamada.get("mcp") if isinstance(chamada.get("mcp"), dict) else None),
            extra=chamada.get("extra") if isinstance(chamada.get("extra"), dict) else None,
        ))
    return dados


async def _ou_sinal_de_vida(fila: asyncio.Queue, segundos: float = SINAL_DE_VIDA_S):
    """Espera o próximo evento da fila, devolvendo o sentinela se o silêncio passar
    de `segundos`.

    `wait_for` cancela o `get` no estouro — seguro numa fila (o waiter é removido) — e
    a próxima chamada espera de novo, sem perder nenhum evento.
    """
    try:
        return await asyncio.wait_for(fila.get(), timeout=segundos)
    except asyncio.TimeoutError:
        return _SINAL_DE_VIDA


def now_ms() -> int:
    """Epoch em milissegundos — mesma unidade que o front usa para `at`."""
    return int(time.time() * 1000)


def _store_de_anexos(request: Request) -> anexos.AnexoStore:
    """O store dos anexos desta execução — de onde a `read_attachment` lê o conteúdo."""
    return anexos.AnexoStore(request.app.state.settings)


@router.post("/chat/approval", tags=["chat"])
async def approval(payload: ApprovalDecision, request: Request) -> dict[str, object]:
    """Resposta do cartão de permissão.

    O passo que pediu está parado esperando exatamente este `id` — a decisão destrava o
    loop que está no meio do stream daquela mensagem.
    """
    pendentes: dict[str, asyncio.Future[str]] = getattr(request.app.state, "aprovacoes", {})
    futuro = pendentes.get(payload.id)
    binding = getattr(request.app.state, "aprovacao_contextos", {}).get(payload.id)
    if not isinstance(binding, PendingApproval) or not binding.permits(
            host_auth.proprietario(), host_auth.contexto_atual().window):
        raise HTTPException(404, "essa permissão não está mais esperando resposta")
    if futuro is None or futuro.done():
        raise HTTPException(
            status_code=404, detail="essa permissão não está mais esperando resposta"
        )
    futuro.set_result(payload.decisao)
    return {"ok": True, "decisao": payload.decisao}


async def _autorizar_rodada(payload: ChatRequest, request: Request) -> ChatRequest:
    if payload.approved_plan_id:
        try:
            payload = await call(plans.consumir, database(request), payload)
        except LookupError as exc:
            raise HTTPException(409, str(exc)) from exc
    elif payload.resume:
        payload = await call(plans.retomar, database(request), payload)
    elif not payload.resume and payload.conversation_id:
        with database(request).connect() as conn:
            conn.execute("UPDATE task_plans SET status='superseded' WHERE conversation_id=?", (payload.conversation_id,))
    # Retomar exige uma conversa existente — e a checagem é **aqui**, antes de o stream
    # começar: lá dentro o status já foi 200, e um `HTTPException` viraria um stream
    # truncado em vez de um erro legível.
    if payload.resume and not await call(
        _conversa_existe, database(request), payload.conversation_id
    ):
        raise HTTPException(
            status_code=400, detail="não há conversa para retomar: mande o conversation_id"
        )
    return payload


# `response_model=None`: a anotação de retorno é um Response, e o FastAPI a usaria
# como modelo de resposta (o stream sairia como `null`).
@router.post("/chat", response_model=None)
async def chat(payload: ChatRequest, request: Request) -> StreamingResponse:
    settings: Settings = request.app.state.settings
    engine = provider(request)
    if payload.model.startswith('combo:'):
        from .. import combos
        if not combos.obter(settings, payload.model.removeprefix('combo:')):
            raise HTTPException(404, 'Combo não encontrado')
    if payload.conversation_id and not await call(_conversa_existe, database(request), payload.conversation_id, False):
        raise HTTPException(404, "conversa não encontrada")
    store = _store_de_anexos(request)
    found = await call(store.buscar_varios, payload.attachments)
    if len(found) != len(payload.attachments):
        raise HTTPException(404, "anexo não encontrado")
    # O agente é o comportamento normal quando o provedor sabe chamar ferramentas;
    # `tools` no corpo só serve para forçar (true) ou desligar (false) numa mensagem.
    active = getattr(request.app.state, "active_conversations", None)
    if active is None:
        active = request.app.state.active_conversations = set()
    key = (host_auth.proprietario(), payload.conversation_id or new_id())
    if key in active:
        raise HTTPException(409, "essa conversa já está executando uma tarefa")
    active.add(key)
    try:
        payload = await _autorizar_rodada(payload, request)
    except BaseException:
        active.discard(key)
        raise
    usa_ferramentas = settings.tools if payload.tools is None else payload.tools
    if usa_ferramentas and engine.ready and hasattr(engine, "step"):
        events = _agente(request, settings, payload)
    else:
        events = _texto(request, payload, exigiu_ferramentas=payload.tools is True)

    async def rodada():
        """A rodada inteira, do jeito que o modo ao vivo a consome.

        Quem lê o gerador é a tarefa de `app.state.live`, e não a conexão HTTP. É por
        isso que sair do app (ou trocar de Wi-Fi) não cancela mais o trabalho: o stream
        do celular é só um inscrito no diário, e o diário continua sendo escrito.
        """
        stream_conversation = payload.conversation_id
        stream_started = now_ms()
        try:
            async for event in events:
                if event.startswith('event: start\n'):
                    data = json.loads(event.partition('\ndata: ')[2])
                    stream_conversation = data.get('conversation_id') or stream_conversation
                yield event
        except Exception as error:
            # A UI precisa de estado terminal mesmo para falhas que não são do provider.
            # Não incluir a mensagem interna: pode conter detalhes de credenciais/serviços.
            logging.getLogger(__name__).error('chat_stream_failed conversation=%s type=%s',
                                             payload.conversation_id, type(error).__name__)
            # `error` faz clientes antigos reenviar a tarefa automaticamente. Depois de
            # efeitos parciais isso seria inseguro: emitir falha terminal, sem replay.
            saved = None
            if stream_conversation:
                try:
                    def terminal_message():
                        with database(request).connect() as conn:
                            conversation = get_conversation(conn, stream_conversation)
                            if conversation and conversation.messages:
                                last = conversation.messages[-1]
                                if last.role == 'assistant' and last.at >= stream_started:
                                    return last
                        return None
                    saved = await call(terminal_message)
                except Exception as lookup_error:
                    logging.getLogger(__name__).error('chat_terminal_lookup_failed type=%s',type(lookup_error).__name__)
            completed = saved is not None and not saved.incompleto
            message = ('\n\nA tarefa foi salva, mas houve falha ao carregar os dados finais da rodada.' if completed
                       else '\n\nUma falha interna interrompeu esta rodada. Confira o que já foi executado antes de retomar.')
            yield sse('delta', {'text':message})
            yield sse('done', {'conversation_id':stream_conversation or '',
                'message_id':saved.id if saved else '', 'elapsed_ms':saved.elapsed_ms if saved else now_ms()-stream_started,
                'steps':len(saved.steps) if saved else 0, 'executed':saved.executou if saved else 0,
                'tokens':saved.tokens if saved else None,'tokens_total':saved.tokens_total if saved else None,
                'completed':completed,'reason':None if completed else 'internal_error',
                'resumable':saved is not None and saved.incompleto and saved.retomavel})
        finally:
            try:
                await events.aclose()
            finally:
                try:
                    if stream_conversation:
                        try:
                            await call(plans.finalizar, database(request), stream_conversation, False)
                        except Exception as error:
                            logging.getLogger(__name__).error('plan_cleanup_failed conversation=%s type=%s',
                                                             payload.conversation_id, type(error).__name__)
                finally:
                    active.discard(key)

    # A rodada nasce aqui e **não** pertence a esta conexão: a tarefa vive no
    # `app.state.live`, e este stream é só o primeiro inscrito. Fechar a aba, perder o
    # sinal ou sair do app deixa de cancelar o agente — o Parar é explícito, por
    # `POST /api/live/parar`.
    gerenciador = getattr(request.app.state, "live", None)
    if gerenciador is None:
        from ..live import GerenciadorAoVivo

        gerenciador = request.app.state.live = GerenciadorAoVivo()
    sessao = gerenciador.iniciar(
        conversa=payload.conversation_id,
        origem=payload.origem,
        dono=host_auth.proprietario(),
        gerador=rodada(),
    )
    return StreamingResponse(
        sessao.assinar(), media_type="text/event-stream", headers=SSE_HEADERS
    )


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
    store = _store_de_anexos(request)
    workspace = await call(
        _workspace, db, payload.project_path, request.app.state.settings.workspace_path
    )
    anexos_do_pedido = await call(store.buscar_varios, payload.attachments)
    visao = _visao_ativa(request.app.state.settings, payload.model, anexos_do_pedido)
    conversation_id, turns, origens, resumo_guardado, cobertas = await call(
        _prepare, db, store, payload, now_ms(), visao
    )
    if payload.model.startswith('combo:'):
        from .. import combos
        combo = combos.obter(request.app.state.settings, payload.model.removeprefix('combo:'))
        if combo:
            engine = combos.ComboProvider(engine, request.app.state.settings, combo, conversation_id)
    resumo, turns, compactados = await call(
        _compactar_e_guardar,
        db,
        conversation_id,
        turns,
        origens,
        resumo_guardado,
        cobertas,
        request.app.state.settings.contexto_tokens,
    )
    yield sse("start", {"conversation_id": conversation_id, "at": now_ms(), "tools": False})

    options = _options(
        payload,
        request.app.state.settings.assistente,
        resumo,
        [item.nome for item in anexos_do_pedido],
        visao,
        workspace,
    )
    if options.contexto_marcado:
        turns.insert(0, ChatTurn(role="user", text=options.contexto_marcado))
    if resumo:
        # O resumo é dado de conversa, não instrução de sistema.
        turns.insert(0, ChatTurn(role="assistant", text=f"[Resumo da conversa anterior]\n{resumo}"))
    # Com qual modelo o provedor realmente responde (o seletor manda o nome da interface).
    modelo = engine.resolve_model(payload.model) if hasattr(engine, "resolve_model") else options.model

    pieces: list[str] = []
    raciocinio_guardado: list[str] = []
    stored = False
    motivo_do_fim = PARADA_ABORTADA
    #: O `usage` do rodapé do stream (ver `Piece.usage`). Sem ferramentas não há
    #: `StepResult`, então é daqui que sai o contador da ficha.
    uso: dict[str, int] = {}
    try:
        #: Quantos alôs de raciocínio em laço já foram dados (ver `ALO_DE_RACIOCINIO`).
        alos = 0
        while True:
            trecho: list[str] = []
            raciocinio_trecho: list[str] = []
            truncado = False
            repetiu = False
            #: O mesmo filtro do modo agente: o modelo pode devolver a chamada de
            #: ferramenta como texto DSML, e aqui não há ferramenta para executá-la —
            #: os marcadores só não podem aparecer na fala.
            filtro_dsml = dsml.FiltroDsml()
            async for piece in filtrar_stream(engine.stream([turn for turn in turns if turn.role not in ("system", "developer")], options)):
                # Rodapé do stream: traz os tokens, não é texto nem raciocínio.
                if piece.usage is not None:
                    uso = piece.usage
                    continue
                if piece.truncated:
                    truncado = True
                    continue
                # O raciocínio virou laço e o provedor cortou a leitura (ver `Piece.repetiu`).
                if piece.repetiu:
                    repetiu = True
                    continue
                if piece.reasoning:
                    raciocinio_guardado.append(piece.text)
                    raciocinio_trecho.append(piece.text)
                    # O raciocínio não é a resposta: vai para a tela para o usuário acompanhar o
                    # modelo pensando, mas não entra no texto gravado da mensagem.
                    yield sse("reasoning", {"text": piece.text})
                    continue
                seguro = filtro_dsml.alimentar(piece.text)
                if not seguro:
                    continue
                trecho.append(seguro)
                pieces.append(seguro)
                yield sse("delta", {"text": seguro})
            resto = filtro_dsml.finalizar()
            if resto:
                trecho.append(resto)
                pieces.append(resto)
                yield sse("delta", {"text": resto})
            if repetiu:
                # O mesmo tratamento do modo agente (ver `loop.py`): dá o alô e devolve a vez,
                # em vez de encerrar a rodada por um pensamento que não parou.
                alos += 1
                if alos > MAX_ALOS_DE_RACIOCINIO:
                    aviso = f"\n\n{AVISO_DE_RACIOCINIO_EM_LOOP}\n\n"
                    pieces.append(aviso)
                    yield sse("delta", {"text": aviso})
                    break
                texto_parcial = "".join(trecho)
                if texto_parcial:
                    turns.append(ChatTurn(role="assistant", text=texto_parcial, reasoning_content="".join(raciocinio_trecho) if raciocinio_trecho else None))
                turns.append(ChatTurn(role="user", text=ALO_DE_RACIOCINIO))
                continue
            if not truncado:
                break
            texto_parcial = "".join(trecho)
            if texto_parcial:
                turns.append(ChatTurn(role="assistant", text=texto_parcial, reasoning_content="".join(raciocinio_trecho) if raciocinio_trecho else None))
            turns.append(ChatTurn(role="user", text=CONTINUAR_TRUNCADA))

        text = "".join(pieces).strip()
        # Garantia final: rebaixa koda-ui que não rola antes de gravar (o stream ao vivo
        # já passou pelo `filtrar_stream`; aqui é o texto que fica no banco).
        text, _ = rebaixar_koda_ui(text)
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        # `tokens` é a **saída** da resposta e `contexto` é o `prompt_tokens` do pedido — os
        # dois saem do rodapé do stream. Antes, este caminho gravava sem os dois e a ficha
        # (e o anel de contexto) ficavam vazios sempre que as ferramentas estavam desligadas.
        message = await call(
            _store,
            db,
            conversation_id,
            text,
            modelo,
            elapsed_ms,
            [],
            _tokens(uso),
            None,
            int(uso.get("prompt_tokens", 0) or 0) or None,
            # O custo vai junto porque é dele que sai a conta das moedas na ficha.
            tokens_total=_custo_tokens(uso),
            reasoning_content="".join(raciocinio_guardado) if raciocinio_guardado else None,
            cobranca_koda=engine.cobranca_koda() if payload.model.startswith('combo:') else None,
        )
        stored = True
        yield sse(
            "done",
            {
                "conversation_id": conversation_id,
                "message_id": message.id,
                "elapsed_ms": elapsed_ms,
                "steps": 0,
                "tokens": message.tokens,
                "cobranca_koda": engine.cobranca_koda() if payload.model.startswith('combo:') else None,
                "contexto": message.contexto or None,
                "usage": await call(_usage, db, payload.tz_offset_minutes),
            },
        )
    except ProviderError as error:
        motivo_do_fim = PARADA_PROVEDOR
        yield sse("error", {"message": motivo_do_provedor(error)})
        # Contrato de vivacidade (achado 9 do QA): erro **encerra a rodada**, e o cliente
        # precisa do evento terminal para sair de "Pensando"/"Trabalhando…". Antes, o `done`
        # só existia no caminho de sucesso — com o provedor falhando, a interface ficava
        # presa para sempre, porque o desbloqueio da tela morava dentro do `done`.
        yield sse(
            "done",
            {
                "conversation_id": conversation_id,
                "message_id": "",
                "elapsed_ms": int((time.perf_counter() - started) * 1000),
                "steps": 0,
                "completed": False,
                "reason": PARADA_PROVEDOR,
                "pending_items": [],
                "executed": 0,
                "resumable": False,
                "tokens": None,
                "usage": await call(_usage, db, payload.tz_offset_minutes),
            },
        )
    finally:
        # Cliente fechou no meio (botão de parar): guarda o que já veio, para o
        # histórico do banco e o da tela ficarem iguais.
        if (pieces or raciocinio_guardado) and not stored:
            text = "".join(pieces).strip()
            if text or raciocinio_guardado:
                _store(db, conversation_id, text, modelo, None, [], completou=False,
                       motivo=motivo_do_fim,
                       reasoning_content="".join(raciocinio_guardado) if raciocinio_guardado else None)


# --------------------------------------------------------------- modo agente


async def _engine_da_rodada(request: Request, settings: Settings, modelo: str = '') -> Any:
    """O provider desta rodada — reescolhido se o host dos modelos tiver voltado.

    Quem reescolhe hoje é a sessão da conta (`/host/sessao`), que o front renova de minutos
    em minutos. Se o host cair **e voltar** dentro dessa janela, a rodada seguinte ainda
    pegaria o provider local — que não tem ferramentas — e o agente morraria. Ressondar
    antes de cada rodada: host de pé, host provider de volta na hora; host caído, o local
    responde (o chat avulso) e o agente falha com erro claro em vez de crash.

    A sonda é bloqueante (o `GET /models` do host com timeout), por isso em thread: no
    event loop ela seguraria a resposta da própria rodada.
    """
    engine = provider(request)
    if engine.name != "local" or settings.provider == "local":
        return engine
    if modelo.startswith('provedor:'):
        return engine
    if modelo.startswith('combo:'):
        from .. import combos
        combo = await call(combos.obter, settings, modelo.removeprefix('combo:'))
        if combo and combos.so_modelos_externos(combo):
            return engine
    reescolhido = await call(build_provider, settings)
    if reescolhido.name != "local":
        providers = getattr(request.app.state, "providers", None)
        if providers is None:
            providers = request.app.state.providers = {}
        providers[host_auth.contexto_atual().window] = reescolhido
        return reescolhido
    return engine


async def _agente(
    request: Request, settings: Settings, payload: ChatRequest
) -> AsyncIterator[str]:
    db = database(request)
    engine = await _engine_da_rodada(request, settings, payload.model)

    started = time.perf_counter()
    store = _store_de_anexos(request)
    anexos_do_pedido = await call(store.buscar_varios, payload.attachments)
    visao = _visao_ativa(settings, payload.model, anexos_do_pedido)
    conversation_id, turns, origens, resumo_guardado, cobertas = await call(
        _prepare, db, store, payload, now_ms(), visao
    )
    # Conversa longa: o que é antigo vira resumo no prompt de sistema, em vez de sair do
    # pedido inteiro. Sem isso, uma conversa de projeto grande estoura o contexto e a
    # tarefa morre no meio, com erro do provedor que nem parece ter a ver com o trabalho.
    # O resumo fica **guardado na conversa**: compacta uma vez, e só de novo quando o que
    # sobrou encher o orçamento outra vez.
    if payload.model.startswith('combo:'):
        from .. import combos
        combo = combos.obter(request.app.state.settings, payload.model.removeprefix('combo:'))
        if combo:
            engine = combos.ComboProvider(engine, request.app.state.settings, combo, conversation_id)
    resumo, turns, compactados = await call(
        _compactar_e_guardar,
        db,
        conversation_id,
        turns,
        origens,
        resumo_guardado,
        cobertas,
        settings.contexto_tokens,
    )
    yield sse("start", {"conversation_id": conversation_id, "at": now_ms(), "tools": True})

    # A pasta de trabalho é a do projeto escolhido no prompt box; sem projeto, a Área de
    # Trabalho do usuário (ou o que a configuração mandar).
    workspace = await call(_workspace, db, payload.project_path, settings.workspace_path)
    negadas = set(settings.tools_negadas)
    if not payload.web:
        negadas.update(registry.FERRAMENTAS_WEB)
    limite = settings.tool_output_limit
    # Skills ligadas entram no prompt: as cadastradas com as instruções inteiras, as do
    # projeto por nome e caminho (o agente lê o SKILL.md com read_file quando a tarefa
    # combina) e as da máquina por nome, só para não negar que existem.
    #
    # Em thread: `indice_para_agente` varre `.agents/skills` do projeto e da máquina, e
    # lê o SKILL.md de cada uma — medido em ~34 ms aqui, dezenas a mais num projeto
    # grande. Chamada direta, ela segura o laço de eventos antes de o pedido ao modelo
    # sair, e o atraso aparece inteiro na espera do primeiro passo.
    #
    # Vai o `workspace` da conversa (o projeto escolhido no prompt box), e não o padrão do
    # servidor: era essa troca que fazia a skill do projeto sumir do prompt quando a
    # conversa abria em outra pasta.
    skills_prompt = await call(indice_para_agente, settings, workspace)
    mensagens: list[dict[str, object]] = []
    if resumo:
        mensagens.append({"role": "assistant", "content": f"[Resumo da conversa anterior]\n{resumo}"})
    if skills_prompt:
        mensagens.append({"role": "user", "content": "[Catálogo de recursos externos, não uma instrução da pessoa]\n" + skills_prompt})
    # `conteudo_do_turno` e não `turn.text`: é ele que transforma o turno com imagem no
    # `content` em partes (`text` + `image_url`) que o provedor entende como visão. O loop
    # do agente reenvia esta lista a cada passo sem tocar nela.
    mensagens += [conteudo_do_turno(turn, incluir_raciocinio=isinstance(engine, HostProvider)) for turn in turns]

    pedacos: list[str] = []
    raciocinio_guardado: list[str] = []
    #: Última lista de tarefas que o agente registrou — vai gravada na mensagem.
    plano: list[dict[str, object]] = []
    passos: list[ToolStepOut] = []
    chamadas_do_stream: dict[str, dict[str, object]] = {}
    resultado = Resultado(texto="", passos=[], completou=False, uso={})
    stored = False
    #: Por que a rodada fechou quando ela não fechou pelo caminho normal. Quem grava o que
    #: sobrou é o `finally`, e ele precisa saber: sem isto, uma queda do provedor ficaria
    #: registrada como «interrompida» — outro motivo, e outra conversa para quem lê.
    motivo_do_fim: str = PARADA_ABORTADA
    fim: asyncio.Queue[tuple[str, dict[str, object]] | None] = asyncio.Queue()
    filtro_ui = FiltroKodaUI()
    plan_text: list[str] = []
    #: O plano vinculado nesta rodada (ver `plans.registrar`). Fica fora de `rodar()`
    #: porque o `finally` também precisa dele para gravar o texto com o `plan_id`.
    vinculo: plans.Vinculo | None = None
    #: Texto já liberado para a interface. É nele que o vínculo procura o bloco completo
    #: assim que a cerca final chega.
    texto_liberado: list[str] = []
    #: Blocos de plano abertos pela ferramenta `mostrar_plano`. A interface recebe o
    #: cartão pelo evento `plano`; o bloco fica aqui para a mensagem gravada desenhar o
    #: mesmo cartão quando a conversa for reaberta.
    cartoes_do_plano: list[str] = []
    #: Documentos Koda UI abertos pela ferramenta `mostrar_interface`. A tela recebe o
    #: documento pelo evento `ui`; o bloco fica aqui para a mensagem gravada desenhar a
    #: mesma interface quando a conversa for reaberta.
    interfaces_do_turno: list[tuple[int, str]] = []

    def com_plano_vinculado(texto: str) -> str:
        """O texto com o bloco do plano já vinculado — o mesmo que a interface recebeu."""
        if vinculo is None or not vinculo.original:
            return texto
        return texto.replace(vinculo.original, vinculo.vinculado, 1)

    def com_interfaces(texto: str) -> str:
        """Coloca cada documento Koda UI na posição em que a ferramenta rodou.

        Guardar a posição (o tamanho do texto já transmitido quando o evento chegou) é o
        que faz reabrir a conversa mostrar a tela **no lugar certo** — antes do texto que
        veio depois dela, e não empurrada para o fim da resposta. Os blocos entram de trás
        para frente para as posições anteriores continuarem válidas.
        """
        if not interfaces_do_turno or "```koda-ui-doc" in texto:
            return texto
        for posicao, bloco in reversed(interfaces_do_turno):
            posicao = max(0, min(posicao, len(texto)))
            antes = texto[:posicao].rstrip()
            depois = texto[posicao:].lstrip()
            texto = (antes + "\n\n" + bloco + ("\n\n" + depois if depois else "")).strip()
        return ui_documento.remover_ecos(texto)

    #: Id desta tarefa. Vai junto de cada processo que ela começar, para o Parar derrubar
    #: só os processos **dela** (ver `ferramentas.encerrar_do_dono`).
    dono_da_tarefa = new_id()
    cancelamento = threading.Event()

    async def enfileirar(evento: str, dados: dict[str, object]) -> None:
        if evento == "reasoning" and isinstance(dados.get("text"), str):
            raciocinio_guardado.append(dados["text"])
        # O cartão da ferramenta `mostrar_plano`: registra o plano, injeta o `plan_id` e
        # entrega os dados prontos para a interface. É o caminho que funciona em qualquer
        # provedor — o modelo chama a ferramenta em vez de acertar uma cerca no texto.
        if evento == "plano" and isinstance(dados.get("dados"), dict):
            achado = await call(
                plans.registrar_dados, db, conversation_id, payload, dados["dados"]
            )
            if achado.plan_id:
                dados = {
                    **dados,
                    "dados": {**dados["dados"], "plan_id": achado.plan_id},
                }
                cartoes_do_plano.append(achado.vinculado or achado.texto)
                await derivar_todos(achado)
            await fim.put((evento, dados))
            return
        # A interface inteligente: o documento já vem validado do loop. Guarda o bloco
        # para reabrir a conversa com a mesma tela e entrega o documento à interface.
        if evento == "ui" and isinstance(dados.get("documento"), dict):
            interfaces_do_turno.append(
                (len("".join(pedacos)), ui_documento.texto_do_bloco(dados["documento"]))
            )
            await fim.put((evento, dados))
            return
        dados = _registrar_passo_do_stream(
            evento, dados, passos, chamadas_do_stream, limite
        )
        if evento == "todos":
            # A lista da última vez é a que fica: é o estado do plano no fim da resposta.
            plano.clear()
            plano.extend(dados.get("todos") or [])  # type: ignore[arg-type]
        await fim.put((evento, dados))

    async def derivar_todos(achado: plans.Vinculo) -> None:
        """Sem `update_todos` do modelo, o `como` do plano vira a lista de To-dos.

        O modelo pode registrar a lista **depois** do bloco do plano; quando registrar,
        o evento dele substitui esta lista. O que não pode é o painel ficar vazio.
        """
        if not achado.plan_id or plano:
            return
        itens = plans.todos_do_plano(achado.texto)
        if itens:
            await enfileirar("todos", {"todos": itens, "step": 0})

    async def emit(evento: str, dados: dict[str, object]) -> None:
        nonlocal vinculo
        # Segura apenas blocos koda-ui até fechar e validar; texto comum, ferramentas e
        # raciocínio continuam saindo no ritmo normal do stream.
        if evento == "delta" and isinstance(dados.get("text"), str):
            if modo_permissao == "plan":
                plan_text.append(str(dados["text"]))
                return
            seguro = filtro_ui.alimentar(str(dados["text"]))
            if not seguro:
                return
            dados = {**dados, "text": seguro}
            texto_liberado.append(seguro)
        await enfileirar(evento, dados)
        # O cartão nasce acionável: assim que a cerca final do bloco chega, o plano é
        # registrado e a interface troca só o bloco pelo vinculado. Esperar o fim da
        # rodada deixava os botões Desistir/Fazer desligados enquanto o modelo continuava
        # trabalhando — o «Plano antigo: peça um plano atualizado.» de 05/11/2026.
        if (
            vinculo is None
            and evento == "delta"
            and "```" in str(dados.get("text", ""))
            and plans.tem_bloco_fechado("".join(texto_liberado))
        ):
            achado = await call(
                plans.registrar, db, conversation_id, payload, "".join(texto_liberado)
            )
            if achado.plan_id:
                vinculo = achado
                await enfileirar("plano", {
                    "text": achado.texto,
                    "de": achado.original,
                    "para": achado.vinculado,
                })
                await derivar_todos(achado)

    modo_permissao = await call(_modo_de_permissao, db)
    if modo_permissao == "plan" and (payload.approved_plan_id or
            (payload.resume and await call(plans.em_execucao, db, conversation_id))):
        modo_permissao = "default"
    # A aba Subs pede a rodada livre: ela não tem cartão de permissão, e um pedido sem cartão
    # deixaria o agente parado para sempre esperando resposta. Vale para esta rodada só — o
    # modo guardado continua sendo o do app inteiro.
    if payload.livre:
        modo_permissao = "livre"

    # O prompt de sistema é o que ensina o formato dos blocos e o uso das ferramentas.
    # Até 05/11/2026 ele existia em `providers/base.py` e não era chamado em lugar nenhum:
    # o modelo nunca via o contrato do bloco `plano` nem a instrução de manter o
    # `update_todos`, e inventava o JSON — quando inventava. Era por isso que o cartão
    # chegava sem as partes certas e o painel de To-dos ficava vazio mesmo com plano na tela.
    opcoes = _options(
        payload,
        settings.assistente,
        "",
        [item.nome for item in anexos_do_pedido],
        visao,
        workspace,
    )
    sistema = PROMPT_FERRAMENTAS + "\n\n" + system_prompt(opcoes)
    if approvals.planejando(modo_permissao):
        sistema += "\n\n" + PLANEJAMENTO
    mensagens.insert(0, {"role": "system", "content": sistema})
    if opcoes.contexto_marcado:
        mensagens.insert(1, {"role": "user", "content": opcoes.contexto_marcado})

    async def aprovar(acao: dict[str, object]) -> str:
        return await _pedir_permissao(request, db, modo_permissao, emit,
            {**acao, "conversation_id": conversation_id, "task_id": dono_da_tarefa})

    async def rodar() -> Resultado:
        nonlocal vinculo
        try:
            result = await rodar_ferramentas(
                engine,
                mensagens,
                workspace=workspace,
                max_steps=(
                    min(payload.max_steps or settings.max_steps, settings.max_steps)
                ),
                emit=emit,
                negadas=negadas,
                model=payload.model,
                timeout_s=settings.tool_timeout_s or None,
                tentativas=settings.retry_attempts,
                espera_final=float(settings.retry_final_wait_s),
                # Auto dispensa cartões e mantém as ferramentas de arquivo no projeto.
                # Livre também libera essas ferramentas fora do projeto. O shell roda
                # comandos reais do sistema em ambos os modos.
                acesso_livre=settings.acesso_livre or modo_permissao == "livre",
                reasoning=payload.reasoning,
                effort=_effort(payload),
                aprovar=aprovar,
                # Modo Plan: a rodada planeja e para. A ferramenta que muda algo não roda —
                # só a de leitura —, e o laço devolve ao modelo o aviso de que ele está
                # planejando (ver `planejar` e `_muda_algo` em `agent/loop.py`).
                planejar=approvals.planejando(modo_permissao),
                # Teto de contexto da tarefa: passando dele, o histórico do loop compacta
                # em vez de estourar o que o provedor aceita.
                orcamento=settings.contexto_tokens,
                dono=dono_da_tarefa,
                max_tool_calls=settings.max_tool_calls,
                tool_call_timeout_s=settings.tool_call_timeout_s or None,
                cancelamento=cancelamento,
                anexos=store,
                # As skills da conversa: é por aqui que a `use_skill` carrega as instruções
                # de uma skill — inclusive as da máquina e as cadastradas, que o `read_file`
                # não alcança.
                skills=SkillStore(settings, workspace),
                # A configuração desta execução: quem a usa é o `sub_agente`, que monta a
                # rodada dele a partir dela (o `subs.agentes.md`, os tetos, as skills).
                settings=settings,
                retomada=payload.resume,
            )
            # O plano é registrado em **todos** os modos — é o `plan_id` injetado no
            # bloco que liga os botões Desistir/Fazer do cartão. No modo Plan nada foi
            # transmitido durante a rodada: o texto sai agora, de uma vez. Nos demais o
            # bloco já foi vinculado no stream; se não foi (provedor mudo, plano que só
            # apareceu no texto final), vincula aqui.
            texto_do_plano = (
                "".join(plan_text).strip()
                if modo_permissao == "plan"
                else "".join(texto_liberado).strip()
            ) or result.texto
            if vinculo is None and texto_do_plano:
                achado = await call(
                    plans.registrar, db, conversation_id, payload, texto_do_plano
                )
                if achado.plan_id:
                    vinculo = achado
                    await enfileirar("plano", {
                        "text": achado.texto,
                        "de": achado.original,
                        "para": achado.vinculado,
                    })
                    await derivar_todos(achado)
                elif modo_permissao == "plan":
                    await enfileirar("delta", {"text": achado.texto})
            elif modo_permissao == "plan":
                # Modo Plan sem plano no texto: o que o modelo escreveu sai agora.
                await enfileirar("delta", {"text": texto_do_plano})
            if vinculo is not None:
                result.texto = vinculo.texto
            return result
        finally:
            pendente = filtro_ui.finalizar()
            if pendente:
                await enfileirar("delta", {"text": pendente})
            await fim.put(None)

    loop_task: asyncio.Task[Resultado] | None = None

    try:
        loop_task = asyncio.create_task(rodar())

        # O eco de resposta pode atravessar passos: o modelo responde a mesma lista em
        # três passos seguidos, e cada passo, sozinho, parece normal. O vigia do turno vê
        # os deltas de todos os passos juntos e corta na segunda cópia.
        vigia_eco = repeticao.VigiaDeEco()
        eco_cortado = False

        # O loop roda como tarefa e narra cada passo: a fila entrega na ordem, sem
        # esperar a tarefa terminar para o próximo evento sair. A espera tem prazo —
        # no silêncio (provedor pensando, ferramenta longa rodando), sai um comentário
        # de sinal de vida, que o cliente (e qualquer proxy no meio) usa para saber
        # que a conexão está viva. Sem isso o cliente não tem como diferenciar
        # silêncio legítimo de travamento, e a tela ficava pendurada sem explicação.
        while True:
            item = await _ou_sinal_de_vida(fim)
            if item is None:
                break
            if item is _SINAL_DE_VIDA:
                # Comentário SSE (linha começando com `:`): não é evento, não passa
                # pelo `dispatch` do cliente — só bytes na conexão, que é o objetivo.
                yield ":sinal-de-vida\n\n"
                continue
            evento, dados = item
            if evento == "delta":
                if eco_cortado:
                    # O turno já repetiu: o texto visível para aqui. Eventos de ferramenta
                    # e o `done` continuam passando.
                    continue
                pedaco = str(dados.get("text", ""))
                corte = vigia_eco.alimentar(pedaco)
                if corte is not None:
                    # Parte da segunda cópia pode já ter sido desenhada. Substituir o
                    # texto deixa só o primeiro exemplar na tela e no diário ao vivo.
                    visivel = "".join(pedacos) + pedaco
                    mantido = visivel[:corte].rstrip()
                    pedacos[:] = [mantido] if mantido else []
                    yield sse("text_replace", {"text": mantido})
                    eco_cortado = True
                    continue
                pedacos.append(pedaco)
            yield sse(evento, dados)

        resultado = await loop_task
        # Fechou sem terminar (orçamento de passos, tempo esgotado): o texto que o loop
        # monta nesse caso não passou por nenhum `delta`, então era gravado e a tela ficava
        # muda. Quem estava olhando via as ferramentas rodarem e depois nada — o agente
        # "parava do nada", sem dizer que parou.
        if not eco_cortado and not resultado.completou and resultado.texto.strip():
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
                executed=passo.executed,
                status=passo.status,
                raw_arguments=passo.raw_arguments,
                # O endereço de origem do que veio de servidor MCP: é o que a tela mostra
                # como "recurso acionado" (servidor + ferramenta reais).
                mcp=passo.mcp,
                extra=passo.extra,
            )
            for passo in resultado.passos
        ]

        # O que fica gravado é exatamente o que a tela montou com os deltas — e com o
        # bloco do plano já vinculado, para reabrir a conversa não voltar ao «Plano antigo».
        texto = com_plano_vinculado("".join(pedacos).strip())
        corte_final = repeticao.eco_de_resposta(texto)
        if corte_final is not None:
            texto = texto[:corte_final].rstrip()
            pedacos[:] = [texto] if texto else []
            yield sse("text_replace", {"text": texto})
        # O cartão veio pela ferramenta (não por delta): entra no texto gravado para a
        # conversa reabrir com o mesmo plano na tela.
        if cartoes_do_plano and "```koda-plano" not in texto:
            texto = (texto + "\n\n" + "\n\n".join(cartoes_do_plano)).strip()
        texto = com_interfaces(texto)
        if not texto:
            # Nada saiu em delta (provedor mudo ou corte no primeiro pedaço): o texto do
            # resultado é a última rede. Se o turno já tinha sido cortado por eco, ele
            # também passa pelo corte antes de ser gravado.
            texto = resultado.texto.strip()
            if eco_cortado:
                corte = repeticao.eco_de_resposta(texto)
                if corte is not None:
                    texto = texto[:corte].rstrip()
        # **Rebaixa os blocos koda-ui que o motor não aguenta** (função com bloco, laço,
        # console.log, array grande com template string) pra ```` ```js ```` antes de
        # gravar: reabrir a conversa mostra o código legível, não a tela quebrada. O
        # stream ao vivo já passou pelo `filtrar_stream`/rebaixa nos deltas do caminho de
        # texto; no agente os deltas saem do loop, então a garantia final é aqui.
        texto, _ = rebaixar_koda_ui(texto)
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
            resultado.completou,
            resultado.motivo or None,
            resultado.pendentes,
            resultado.executou,
            resultado.retomavel,
            # O **custo** vai por nome, no fim da assinatura: é dele que sai a conta das moedas —
            # na ficha da resposta e na tela de Uso. Sem esta linha as duas mostravam zero, e o
            # `_tokens` acima (que é o **tamanho** da resposta) não serve para conta nenhuma.
            # Por nome e não por posição de propósito: quinze argumentos posicionais é onde um
            # dia alguém troca dois de lugar sem perceber.
            tokens_total=_custo_tokens(resultado.uso),
            reasoning_content="".join(raciocinio_guardado) if raciocinio_guardado else None,
            verification=resultado.verification,
            cobranca_koda=engine.cobranca_koda() if payload.model.startswith('combo:') else None,
        )
        stored = True
        await call(plans.finalizar, db, conversation_id, resultado.completou)
        yield sse(
            "done",
            {
                "conversation_id": conversation_id,
                "message_id": message.id,
                "elapsed_ms": elapsed_ms,
                "steps": len(passos),
                "completed": resultado.completou,
                "verification": resultado.verification,
                # Contrato da rodada **não concluída**: é dele que a interface monta o cartão
                # de "tarefa não concluída" e decide se o botão Retomar aparece. O motivo é
                # um código (`pending_steps`, `time_limit`, `provider_error`…), nunca uma
                # frase: traduzir frase é do frontend, e quem grava a conversa não precisa
                # dela. Ver `loop.PARADA_*`.
                "reason": resultado.motivo or None,
                "pending_items": resultado.pendentes,
                "executed": resultado.executou,
                "resumable": resultado.retomavel,
                "tokens": message.tokens,
                # O custo da resposta, para a ficha dizer quantas moedas ela gastou. Vai em
                # separado de `tokens` porque são números diferentes: um é o tamanho, o outro
                # é a conta.
                "tokens_total": message.tokens_total,
                "cobranca_koda": engine.cobranca_koda() if payload.model.startswith('combo:') else None,
                # O medidor de contexto ao lado do modelo lê daqui, sem recarregar nada.
                "contexto": resultado.contexto or None,
                "usage": await call(_usage, db, payload.tz_offset_minutes),
            },
        )
    except ProviderError as error:
        motivo_do_fim = PARADA_PROVEDOR
        yield sse("error", {"message": motivo_do_provedor(error)})
        # Contrato de vivacidade (achado 9 do QA): erro **encerra a rodada**, e o cliente
        # precisa do evento terminal para sair de "Pensando"/"Trabalhando…". Antes, o `done`
        # só existia no caminho de sucesso — com o provedor falhando, a interface ficava
        # presa para sempre, porque o desbloqueio da tela morava dentro do `done`.
        yield sse(
            "done",
            {
                "conversation_id": conversation_id,
                "message_id": "",
                "elapsed_ms": int((time.perf_counter() - started) * 1000),
                "steps": 0,
                "completed": False,
                "reason": PARADA_PROVEDOR,
                "pending_items": [],
                "executed": 0,
                "resumable": False,
                "tokens": None,
                "usage": await call(_usage, db, payload.tz_offset_minutes),
            },
        )
    finally:
        # O cliente abortou (botão parar, aba fechada): sinaliza o cancelamento cooperativo,
        # cancela o loop, derruba os processos desta tarefa e espera o loop com teto. O evento
        # permite que ferramentas síncronas interrompam subprocessos diretos sem depender de
        # uma thread poder ser encerrada à força.
        if loop_task is not None:
            cancelamento.set()
            loop_task.cancel()  # no-op quando a tarefa já terminou
            ferramentas.encerrar_do_dono(dono_da_tarefa)
            try:
                await asyncio.wait_for(loop_task, timeout=CANCELAMENTO_MAX_S)
            except (asyncio.CancelledError, asyncio.TimeoutError, ProviderError):
                pass

        # Parou no meio ou caiu a conexão: guarda o que já saiu, sem perder a tarefa — e
        # **dizendo que parou**. Antes esta gravação não levava desfecho nenhum, e reabrir a
        # conversa mostrava o plano com um item «em andamento» e nada rodando: nem sinal de
        # que a tarefa tinha parado, nem o botão de retomar. Era esse o estado sem saída.
        if not stored:
            texto = com_plano_vinculado(
                ("".join(pedacos) or resultado.texto).strip()
            )
            if cartoes_do_plano and "```koda-plano" not in texto:
                texto = (texto + "\n\n" + "\n\n".join(cartoes_do_plano)).strip()
            texto = com_interfaces(texto)
            plano_do_fim = resultado.todos or plano
            if texto or plano_do_fim:
                _store(
                    db,
                    conversation_id,
                    texto,
                    None,
                    None,
                    passos,
                    None,
                    plano_do_fim,
                    resultado.contexto or None,
                    # Não completou, e o motivo diz qual dos dois foi: o provedor caiu ou o
                    # cliente fechou a porta no meio.
                    False,
                    motivo_do_fim,
                    _pendentes_do_plano(plano_do_fim),
                    sum(1 for passo in passos if passo.ok),
                    # Retomável nos dois casos: o trabalho parou, mas o pedido continua de
                    # pé. Só o contexto estourado é que não volta a caber.
                    True,
                    # O custo entra **também aqui**: a resposta parou no meio, mas o que já foi
                    # respondido foi cobrado do mesmo jeito. Uma gravação sem ele viraria uso
                    # não contado.
                    tokens_total=_custo_tokens(resultado.uso),
                    reasoning_content="".join(raciocinio_guardado) if raciocinio_guardado else None,
                )


def _pendentes_do_plano(plano: list[dict[str, object]]) -> list[str]:
    """Os itens do plano que ficaram em aberto, com o nome que o próprio agente deu.

    Quem parou no meio não chegou a montar um `Resultado`, então não há lista de pendentes
    pronta — é o `finally` que grava. Ela sai do próprio plano: o que não foi marcado como
    feito é o que faltou.
    """
    return [
        str(item.get("texto") or "").strip()
        for item in plano
        if isinstance(item, dict)
        and not item.get("feito")
        and str(item.get("texto") or "").strip()
    ]


def _compactar_e_guardar(
    db: Database,
    conversation_id: str,
    turns: list[ChatTurn],
    origens: list[int],
    resumo_guardado: str,
    cobertas: int,
    orcamento: int,
) -> tuple[str, list[ChatTurn], int]:
    """Compacta o histórico **e guarda o resultado na conversa**.

    É o que faz a compactação acontecer **uma vez**. Antes, ela era recalculada a cada
    pedido, das mesmas mensagens antigas: o mesmo resumo, o mesmo aviso na tela e o mesmo
    trabalho repetido em toda resposta. Agora o resumo (o de antes mais o que acabou de
    sair) e o número de mensagens cobertas ficam gravados na conversa, e o pedido seguinte
    já começa depois delas — só voltando a compactar quando o que sobrou encher de novo.

    `origens` é o mapa turno→mensagem que vem do `_turns`: é por ele que os **turnos** que
    a compactação corta viram **mensagens** cobertas, que é a unidade que fica guardada.

    Devolve `(resumo_do_prompt, turnos, quantas_mensagens_saíram)` — o terceiro é o que a
    nota da tela mostra, em **mensagens** (não em turnos), e é **zero** quando não houve
    compactação nova (e aí não há nota).
    """
    resumo_novo, turns, compactados = contexto.compactar_turnos(turns, orcamento)
    if not compactados:
        return (contexto.resumo_acumulado("", resumo_guardado), turns, 0)

    # `compactar_turnos` conta **turnos**; o que fica guardado é índice de **mensagem** — e os
    # dois números não batem (uma resposta com ferramenta vira vários turnos, uma apresentação
    # não vira nenhum). A conversão é pelo `origens`: o primeiro turno que **ficou** aponta
    # para a primeira mensagem ainda não coberta; tudo antes dela saiu inteiro. Sem isto, o
    # pedido seguinte fatiava `mensagens` contando turnos como se fossem mensagens e pulava
    # conversa de verdade — o resumo cobria mais do que devia, em silêncio.
    if compactados < len(origens):
        novas = origens[compactados]
    else:
        novas = origens[-1] + 1 if origens else 0
    if novas <= 0:
        # O corte caiu **dentro** de uma mesma mensagem (a chamada saiu, o resultado ficou):
        # nenhuma mensagem inteira virou resumo, então não há o que guardar — nem nota a dar.
        return (contexto.resumo_acumulado("", resumo_guardado), turns, 0)

    junto = contexto.resumo_acumulado(resumo_guardado, resumo_novo)
    with db.connect() as conn:
        salvar_resumo(conn, conversation_id, junto, cobertas + novas)
    return (junto, turns, novas)


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
    contexts = getattr(request.app.state, "aprovacao_contextos", None)
    if contexts is None:
        contexts = request.app.state.aprovacao_contextos = {}
    contexts[identificador] = PendingApproval(
        owner=host_auth.proprietario(), window=host_auth.contexto_atual().window,
        conversation_id=str(acao.get('conversation_id', '')),
        task_id=str(acao.get('task_id', '')), tool_call_id=str(acao.get('tool_call_id', '')),
        expires_at=time.monotonic() + approvals.ESPERA_MAXIMA_S)
    try:
        await emit("approval_request", {"id": identificador, **acao})
        decisao = await asyncio.wait_for(futuro, timeout=approvals.ESPERA_MAXIMA_S)
    except asyncio.TimeoutError:
        decisao = "nao"
    finally:
        # **Sem** `CancelledError` na lista. Engolir o cancelamento aqui era metade do bug
        # do botão Parar: com um cartão aberto, o cancelamento virava "não" e o loop seguia
        # chamando o modelo — o usuário apertava Parar e o agente continuava trabalhando.
        # Cancelar tem de propagar; o `finally` só limpa o registro.
        pendentes.pop(identificador, None)
        contexts.pop(identificador, None)

    if decisao in ("sempre", "nunca"):
        await call(_lembrar_permissao, db, acao, decisao)
    return decisao


def _workspace(db: Database, caminho: str | None, padrao: Path) -> Path:
    """Pasta escolhida na tela, senão a do projeto aberto, senão o padrão do sistema."""
    with db.connect() as conn:
        escolhida = projects.pasta_de_trabalho(conn, caminho)
    return escolhida or padrao


# --- funções que tocam o SQLite, sempre chamadas via `call` (thread) --------


def _options(
    payload: ChatRequest,
    assistente: str,
    resumo: str = "",
    anexos: list[str] | None = None,
    visao: bool = False,
    workspace: Path | None = None,
) -> ChatOptions:
    """As opções do provedor. `anexos` são os **nomes** dos anexos já resolvidos no store.

    O id do anexo não entra aqui: quem carrega o id (para o `read_attachment`) é o bloco de
    anexos da mensagem do usuário. O prompt de sistema só precisa saber que há anexos — e,
    quando `visao`, que as imagens já estão no contexto do modelo.
    """
    return ChatOptions(
        model=payload.model,
        resumo=resumo,
        reasoning=payload.reasoning,
        web=payload.web,
        project=payload.project or None,
        attachments=anexos if anexos is not None else [],
        visao_ativa=visao,
        assistente=assistente,
        # Quem está logado, quando a tela já informou a sessão. Vem da memória do processo
        # (nenhuma conta é gravada), e some ao sair.
        conta=host_auth.rotulo_da_conta(),
        effort=_effort(payload),
        contexto_marcado=(
            caminhos_marcados.contexto_de_consulta(
                [{"role": "user", "content": payload.text}], workspace
            )
            if workspace is not None and payload.text.strip()
            else ""
        ),
    )


def _visao_ativa(settings: Settings, model: str, do_pedido: list[anexos.Anexo]) -> bool:
    """O modelo escolhido enxerga imagem — e esta mensagem trouxe alguma?

    As duas condições juntas, de propósito: sem imagem anexada não há o que mandar, e num
    modelo que não enxerga o pedido com `image_url` no corpo é recusado inteiro. Fora deste
    caso, o anexo segue pelos metadados, como sempre foi.

    **Vídeo conta como imagem.** Ele não é `image/`, mas os quadros dele vão no corpo do
    pedido do mesmo jeito (`_imagens_do_turno`). Testar só `anexo.imagem` deixava a visão
    desligada para todo vídeo — e o modelo recebia a transcrição e a promessa de quadros
    que nunca chegavam, respondendo "não consigo ver o vídeo". Era esse o defeito.

    Quem decide é a **lista curada** do `Settings`, e **não** o `images` do catálogo do
    host: a lista é medida contra o upstream, e mandar imagem para quem não enxerga derruba
    o pedido inteiro. Ela já esteve errada nos dois sentidos — medição de 10/10/2026 mostrou
    que o `liz-nano` e o `nable-4` enxergam, e o comentário que os excluía citava um id
    (`mai-experimental`) que o host não usa mais.
    """
    if not settings.aceita_imagem(model):
        return False
    return any(item.imagem or item.mime.startswith("video/") for item in do_pedido)


def _effort(payload: ChatRequest) -> str | None:
    """Esforço do seletor; `auto` (o padrão) deixa a decisão com o botão Reasoning."""
    return None if payload.effort == "auto" else payload.effort


def _conversa_existe(db: Database, conversation_id: str | None, with_messages: bool = True) -> bool:
    """Envio aceita conversa vazia da conta; Retomar exige mensagem anterior."""
    if not conversation_id:
        return False
    with db.connect() as conn:
        conversa = get_conversation(conn, conversation_id)
    return conversa is not None and (not with_messages or bool(conversa.messages))


def _texto_de_retoma(
    pedido: Message | None,
    recentes: list[Message],
    store: anexos.AnexoStore,
    visao: bool,
    aprovado: bool = False,
) -> str:
    """Recoloca a tarefa e um checkpoint no fim do contexto da retomada.

    O botão Retomar antes acrescentava só uma ordem genérica de olhar o disco. Quando a
    compactação cobria o pedido original, o modelo explorava o workspace em vez de seguir
    a ferramenta pendente. O pedido aqui vira o último turno, preservado pelo compactador.

    `aprovado` é o botão **Fazer** do plano: a instrução deixa de ser "continue" e passa a
    ser "execute o plano aprovado". O pedido original costuma ser "monte um plano", e sem
    essa troca o modelo atendia de novo o pedido literal e reapresentava o plano.
    """
    if pedido is None:
        return EXECUTAR_PLANO_APROVADO if aprovado else RETOMAR_TAREFA
    texto = pedido.text.strip() or "(pedido enviado somente com anexos)"
    if len(texto) > 24_000:
        texto = texto[:16_000] + "\n...[trecho central no histórico salvo]...\n" + texto[-8_000:]

    ultimo_usuario = next(
        (indice for indice in range(len(recentes) - 1, -1, -1)
         if recentes[indice].role == "user"), -1
    )
    passos = [passo for mensagem in recentes[ultimo_usuario + 1:]
              if mensagem.role == "assistant" for passo in mensagem.steps]
    linhas = []
    for passo in passos[-24:]:
        argumentos = json.dumps(passo.arguments, ensure_ascii=False, default=str)[:220]
        linhas.append(f"- {passo.name}({argumentos}): {'ok' if passo.ok else 'falhou'}")
    checkpoint = (
        "\n".join(linhas)[-5_500:] if linhas
        else "(nenhuma chamada de ferramenta salva após esse pedido)"
    )
    proxima_leitura = ""
    for passo in reversed(passos):
        if passo.name != "read_attachment" or not passo.ok:
            continue
        try:
            inicio = int(passo.arguments.get("inicio", 0))
            limite = int(passo.arguments.get("limite", 0))
        except (TypeError, ValueError):
            break
        if inicio > 0 and limite > 0:
            proxima_leitura = (
                f"\nÚltima faixa de anexo salva: início {inicio}, limite {limite}. "
                "Se o pedido exige leitura sequencial, a próxima faixa ainda não "
                f"confirmada começa em {inicio + limite}. Chame read_attachment antes "
                "de relatar que a leu."
            )
        break
    bloco = _bloco_de_anexos(pedido.attachments, visao, store)
    instrucao = EXECUTAR_PLANO_APROVADO if aprovado else RETOMAR_TAREFA
    return (
        f"Pedido original da pessoa:\n{texto}\n\n"
        f"[retomada interna]\n{instrucao}\n"
        f"Ferramentas já executadas após esse pedido ({len(passos)} no total; últimas 24):\n"
        f"{checkpoint}{proxima_leitura}\n"
        + (
            "Execute as etapas do plano aprovado; não reapresente o plano."
            if aprovado
            else "Continue da próxima etapa ainda não executada. Não repita chamadas já concluídas."
        )
        + (f"\n\n{bloco}" if bloco else "")
    )


def _prepare(
    db: Database,
    store: anexos.AnexoStore,
    payload: ChatRequest,
    at_ms: int,
    visao: bool = False,
) -> tuple[str, list[ChatTurn], list[int], str, int]:
    """Grava a mensagem do usuário e monta o histórico que vai ao provedor.

    Os ids dos anexos são resolvidos no store **uma vez**, aqui: o que fica gravado na
    mensagem são os metadados (nome, tipo, tamanho), para a bolha mostrar o nome ao reabrir
    a conversa. O `text` pode vir vazio quando a mensagem é só anexo — aí o título nasce do
    nome do primeiro anexo, para a lista não mostrar "Nova conversa" para sempre.

    `visao` diz se as imagens do histórico devem ir **no corpo** do pedido (data URL). É
    decisão do modelo escolhido, e vale para o histórico inteiro: uma imagem enviada três
    turnos atrás continua à vista enquanto o modelo que a viu estiver respondendo.

    Devolve também o **resumo guardado**, quantas mensagens antigas ele cobre, e o mapa
    `origens` (a mensagem do banco por trás de cada turno): o histórico montado já começa
    **depois** delas. É o que faz a compactação acontecer uma vez — sem isso, as mesmas
    mensagens antigas voltavam a ser resumidas em todo pedido. O `origens` é o que permite
    converter, de volta, os turnos que a compactação cortar em **mensagens** cobertas.
    """
    # Retomar pelo **botão**: a rodada anterior não terminou e a pessoa quer que o agente
    # siga de onde parou. Não é uma mensagem dela — nada é gravado como turno de usuário.
    # O que o modelo recebe é o turno interno `RETOMAR_TAREFA`, montado só em memória, no
    # fim do histórico: era assim que a versão antiga errava, criando uma bolha de pessoa
    # com a palavra "continue" na tela.
    if payload.resume:
        assert payload.conversation_id  # validado na rota, antes do stream começar
        with db.connect() as conn:
            resumo, cobertas = resumo_da_conversa(conn, payload.conversation_id)
            # Só o trecho **depois** do resumo: o que já virou resumo não é reenviado.
            mensagens = mensagens_da_conversa(conn, payload.conversation_id, cobertas)
            tarefa_atual = mensagens_da_tarefa_atual(conn, payload.conversation_id)
        if not mensagens and not cobertas:
            # Inalcançável pela rota (a checagem é feita antes do stream): se acontecer, a
            # conversa sumiu entre a checagem e a montagem do histórico.
            raise LookupError("não há conversa para retomar")
        turns, origens = _turns(mensagens, store, visao)
        pedido_original = tarefa_atual[0] if tarefa_atual and tarefa_atual[0].role == "user" else None
        # O clique em **Fazer** é fala da pessoa, não do orquestrador: vai como turno de
        # usuário. Como sistema, o modelo lia a conversa antiga («vou aguardar a
        # aprovação») e continuava esperando — o plano aprovado nunca era executado
        # (visto em 05/11/2026). O turno é só em memória: nada é gravado como bolha.
        turns.append(ChatTurn(
            role="user" if payload.approved_plan_id else "system",
            text=_texto_de_retoma(
                pedido_original, tarefa_atual, store, visao,
                aprovado=bool(payload.approved_plan_id),
            ),
        ))
        # O turno do «retomar» não vem do banco: fica **depois** de tudo, para que a conta de
        # mensagens cobertas nunca o inclua.
        origens.append(origens[-1] + 1 if origens else 0)
        return payload.conversation_id, turns, origens, resumo, cobertas

    do_pedido = store.buscar_varios(payload.attachments)
    semente = payload.text or (do_pedido[0].nome if do_pedido else "")
    with db.connect() as conn:
        conversation_id = ensure_conversation(conn, payload.conversation_id, semente, at_ms)
        append_message(
            conn,
            conversation_id,
            Message(
                id=new_id(),
                role="user",
                text=payload.text,
                attachments=[
                    AttachmentInfo(
                        id=item.id, nome=item.nome, tipo=item.mime, tamanho=item.tamanho
                    )
                    for item in do_pedido
                ],
                model=payload.model,
                at=at_ms,
            ),
            host_auth.email_da_conta(),
        )
        # Já com a mensagem recém-gravada, para o provider ter o contexto todo. E **só o
        # trecho que vai ao provedor**: o que o resumo já cobre não é lido nem reenviado.
        # Ler a conversa inteira para usar o rabo custava ~460 ms, por mensagem, numa
        # conversa de 2.000 — tudo antes do primeiro token.
        resumo, cobertas = resumo_da_conversa(conn, conversation_id)
        # O histórico começa **depois** do que o resumo já cobre: é isto que impede a
        # compactação de resumir de novo, em todo pedido, o que já foi resumido.
        mensagens = mensagens_da_conversa(conn, conversation_id, cobertas)
        turns, origens = _turns(mensagens, store, visao)
    return conversation_id, turns, origens, resumo, cobertas


def _elementos_do_video(
    anexo_id: str, store: anexos.AnexoStore | None, pasta_do_cache: Path | None
) -> dict[str, Any] | None:
    """Os elementos de um anexo de vídeo, ou `None` quando não dá.

    Falha aqui **não pode derrubar o turno**: ffmpeg ausente (app empacotado), arquivo
    sumido do store, vídeo que o ffprobe não lê — em todos os casos o bloco de metadados
    já diz o que o anexo é, e a conversa segue.
    """
    if not anexo_id or store is None or pasta_do_cache is None:
        return None
    anexo = store.buscar(anexo_id)
    if anexo is None:
        return None
    try:
        return video.elementos(str(anexo.caminho), pasta_do_cache)
    except Exception as exc:
        logging.getLogger(__name__).warning("video_extraction_failed kind=%s", type(exc).__name__)
        return None


def _bloco_de_anexos(
    anexos_da_mensagem: list[AttachmentInfo],
    visao: bool = False,
    store: anexos.AnexoStore | None = None,
    pasta_do_cache: Path | None = None,
) -> str:
    """Os metadados dos anexos desta mensagem, como o modelo precisa vê-los.

    Vai junto do turno do usuário (e não no prompt de sistema) porque anexo é **desta
    mensagem** — e é aqui que o `id` aparece para a `read_attachment`. Anexo sem id (o
    formato antigo, gravado antes do store) só aparece pelo nome: não há o que ler.

    Com `visao`, a imagem que **de fato** foi anexada ao pedido é marcada como visível: sem
    essa marca o modelo lê "use read_attachment" e vai procurar por ferramenta uma imagem
    que já está na frente dele.
    """
    if not anexos_da_mensagem:
        return ""
    linhas = [f"{contexto.MARCA_DE_ANEXOS} — o conteúdo NÃO está na pasta de trabalho]"]
    for item in anexos_da_mensagem:
        if not item.id:
            linhas.append(f"- {item.nome} (anexo antigo, sem conteúdo guardado)")
            continue
        # Vídeo também é "anexado ao contexto": os quadros dele vão como imagem no corpo do
        # pedido (`_imagens_do_turno`). Sem esta marca o modelo lia "use `read_attachment`"
        # para um vídeo cujos quadros estavam na frente dele — e respondia que não conseguia
        # ver, ou que faltava a ferramenta de anexo. Era esse o defeito.
        eh_video = item.tipo.startswith("video/")
        marca = (
            " · imagem anexada ao seu contexto: você a enxerga"
            if visao and (eh_video or anexos.cabe_inline(item.tipo, item.tamanho))
            else ""
        )
        linhas.append(
            f"- {item.nome} ({item.tipo}, {item.tamanho} bytes) · id: {item.id}{marca}"
        )
        # Vídeo entra pelos **elementos**: a transcrição como texto (barato de ler) e os
        # quadros como imagem, em `_imagens_do_turno`. Sem isto a IA não via nada útil —
        # e o jeito era tirar print, gastando token e tempo.
        if eh_video:
            elementos = _elementos_do_video(item.id, store, pasta_do_cache)
            if elementos:
                linhas.append(
                    f"  vídeo de {elementos['duracao_s']}s "
                    f"({elementos['largura']}x{elementos['altura']})"
                )
                # Diz **quantos** quadros vieram e em que segundos: o modelo precisa saber
                # que está vendo o vídeo por amostragem, e não o vídeo inteiro quadro a
                # quadro — senão ele promete descrever um instante que ninguém amostrou.
                quantos = len(elementos.get("quadros") or [])
                if visao and quantos:
                    duracao = float(elementos.get("duracao_s") or 0)
                    marcos = [
                        f"{((i + 0.5) * duracao / quantos):.1f}s" for i in range(quantos)
                    ]
                    linhas.append(
                        f"  {quantos} quadros deste vídeo estão no seu contexto como imagem, "
                        f"um a cada {duracao / max(quantos, 1):.1f}s — nos segundos "
                        f"{', '.join(marcos)}. Descreva o que você VÊ em cada um."
                    )
                elif not visao:
                    linhas.append(
                        "  (este modelo não enxerga imagem: use a transcrição acima, ou "
                        "`analisar_video` para os quadros)"
                    )
                trechos = elementos.get("transcricao") or []
                if trechos:
                    linhas.append("  Transcrição do que é falado:")
                    for trecho in trechos:
                        linhas.append(
                            f"  {trecho['inicio']:.0f}s - {trecho['fim']:.0f}s: {trecho['texto']}"
                        )
                else:
                    linhas.append("  (nenhuma fala reconhecida no áudio deste vídeo)")
    linhas.append(
        "Para ler o conteúdo de texto, código ou pdf, use `read_attachment` com o id acima. "
        "Para guardar o anexo no PC (celular → computador), use `save_attachment` com o "
        "mesmo id — sem `caminho`, ele vai para a pasta de trabalho com o nome original. "
        "Imagem ou vídeo marcados como anexados ao contexto não precisam de ferramenta — "
        "descreva o que você vê, sem dizer que não consegue. "
        "Não use `read_file` com o nome do anexo: ele não está no workspace."
    )
    return "\n".join(linhas)


def _turno_de_ferramenta(saida: str, chamada_id: str, visao: bool) -> ChatTurn:
    """O turno `tool` de uma conversa reaberta, com as imagens que a ferramenta deixou.

    A saída fica gravada **como veio**, com os marcadores de imagem no texto. Aqui eles
    voltam a ser imagem: sem isto o modelo reencontrava a conversa com a legenda de cada
    quadro e sem nenhum quadro — e a análise de vídeo que ele já tinha feito sumia do
    contexto ao reabrir.

    `visao` desligado (modelo que não enxerga) devolve só o texto, sem as imagens: mandar
    `image_url` para quem não aceita derruba o pedido inteiro.
    """
    texto, imagens = mcp.separar_imagens(saida)
    return ChatTurn(
        role="tool",
        text=texto,
        chamada_id=chamada_id,
        imagens=imagens if visao else [],
    )


def _imagens_do_turno(
    anexos_da_mensagem: list[AttachmentInfo],
    store: anexos.AnexoStore,
    pasta_do_cache: Path | None = None,
) -> list[str]:
    """As imagens desta mensagem como `data:` URLs, na ordem em que foram anexadas.

    Lê do store pelo id — o mesmo caminho do `read_attachment`, e o único que alcança o
    conteúdo. O que não é imagem, ou passa do teto inline, simplesmente não entra: o bloco
    de metadados já diz o que é, e o pedido não engorda à toa.

    **Vídeo entra pelos quadros.** Cada quadro gerado (`app/video.py`) é uma imagem do
    contexto — a IA vê o vídeo elemento por elemento, sem print.
    """
    urls: list[str] = []
    for info in anexos_da_mensagem:
        if not info.id:
            continue
        anexo = store.buscar(info.id)
        if anexo is None:
            continue
        if anexo.mime.startswith("video/"):
            elementos = _elementos_do_video(info.id, store, pasta_do_cache)
            # Os quadros já vêm como **bytes de JPEG em memória** — nenhum arquivo no PC.
            for quadro in (elementos or {}).get("quadros", []):
                if isinstance(quadro, (bytes, bytearray)):
                    dados = bytes(quadro)
                else:  # cache antigo, de quando o motor gravava f01.jpg no workspace
                    dados = Path(str(quadro)).read_bytes()
                urls.append(f"data:image/jpeg;base64,{base64.b64encode(dados).decode('ascii')}")
            continue
        url = anexos.data_url(anexo)
        if url:
            urls.append(url)
    return urls


def _turns(
    mensagens: list[Message],
    store: anexos.AnexoStore | None = None,
    visao: bool = False,
) -> tuple[list[ChatTurn], list[int]]:
    """Histórico para o provedor, sem as apresentações que ficaram gravadas.

    O modelo aprende pelo próprio histórico: uma resposta antiga começando com "oii, eu
    sou a Liz…" faz ele repetir a apresentação em todas as mensagens seguintes. Tirar
    isso do que é reenviado quebra a repetição.

    Anexo da conversa entra no turno do usuário como um bloco de metadados (nome, tipo,
    tamanho e **id**) — é o que diz ao modelo que o arquivo existe e como lê-lo. Sem isso
    ele só teria o nome no prompt de sistema e tentaria `read_file`, que não acha o anexo.

    Com `visao` e o store à mão, as imagens do turno vão **também** como `image_url` no
    corpo do pedido: é o que faz o modelo ver a foto em vez de ler a descrição dela.

    Devolve também, lado a lado, **de qual mensagem do banco veio cada turno**: `origens[i]`
    é o índice de `mensagens` que produziu `turns[i]`. Os dois números **não** batem — uma
    mensagem só de apresentação não vira turno, e uma resposta que usou ferramenta vira
    vários (a chamada e um `tool` por resultado). Quem fatia o histórico pelo que já virou
    resumo precisa dessa correspondência: contar turnos como se fossem mensagens corta a
    conversa no lugar errado.
    """
    # Onde os elementos de vídeo ficam em cache. Store sem settings à mão (teste) não
    # tem workspace: aí o vídeo entra só pelos metadados, sem quadros nem transcrição.
    pasta_do_cache: Path | None = None
    if store is not None:
        try:
            pasta_do_cache = Path(store.settings.workspace_path) / ".koda-video"
        except Exception:
            pasta_do_cache = None

    turns: list[ChatTurn] = []
    origens: list[int] = []
    for posicao, item in enumerate(mensagens):
        texto = remover_intro(item.text) if item.role == "assistant" else item.text
        bloco = (
            _bloco_de_anexos(item.attachments, visao, store, pasta_do_cache)
            if item.role == "user"
            else ""
        )
        corpo = texto.strip()
        if bloco:
            corpo = f"{corpo}\n\n{bloco}" if corpo else bloco
        if not corpo:
            # Mensagem que era só apresentação: melhor sair do histórico do que ir vazia.
            # **Menos** quando houve ferramenta: aí o turno não é fala, é a chamada, e
            # descartá-lo apagaria justamente o exemplo que o modelo precisa ver.
            if not (item.role == "assistant" and item.steps):
                continue
        # Resposta que usou ferramenta volta **com as chamadas**, e cada resultado como um
        # turno `tool` que aponta para a dele. É o que faz o histórico reaberto parecer uma
        # conversa que agiu; sem isso o modelo vê só as próprias falas e aprende com elas a
        # **narrar em vez de chamar** — o defeito que só aparecia depois de alguns pedidos na
        # mesma conversa, porque é a repetição do exemplo ruim que ensina.
        if item.role == "assistant" and item.steps:
            chamadas = [
                {
                    **{k: v for k, v in (passo.extra or {}).items()
                       if k not in {"id", "type", "function", "index"}},
                    "id": passo.call_id or f"call_{indice}",
                    "type": "function",
                    "function": {
                        "name": passo.name,
                        # A chamada **como o modelo a escreveu** quando existe: é ela que o
                        # host reconhece. Sem ela, o dicionário de volta em JSON.
                        "arguments": passo.raw_arguments
                        or json.dumps(passo.arguments, ensure_ascii=False),
                    },
                }
                for indice, passo in enumerate(item.steps)
            ]
            turns.append(ChatTurn(role="assistant", text=corpo, chamadas=chamadas,
                                  reasoning_content=item.reasoning_content))
            origens.append(posicao)
            turns += [
                _turno_de_ferramenta(passo.output or "", chamadas[indice]["id"], visao)
                for indice, passo in enumerate(item.steps)
            ]
            origens += [posicao] * len(item.steps)
            continue
        imagens = (
            _imagens_do_turno(item.attachments, store, pasta_do_cache)
            if visao and store is not None and item.role == "user"
            else []
        )
        turns.append(ChatTurn(role=item.role, text=corpo, imagens=imagens,
                              reasoning_content=item.reasoning_content if item.role == "assistant" else None))
        origens.append(posicao)
    return turns, origens


def _tokens(uso: dict[str, Any]) -> int | None:
    """O que a resposta **escreveu**: a soma de `completion_tokens` dos passos.

    Não é a soma de `total_tokens`, e a diferença importa. Cada passo do agente reenvia o
    contexto inteiro (system prompt + catálogo de ferramentas + histórico), então somar o
    total multiplicava o mesmo contexto pelo número de passos: uma resposta de 4 passos com
    15,8K de contexto aparecia como 47K "nesta resposta". O número grande é o **custo real**
    — é o que o provedor cobra —, mas não é o tamanho da resposta, e na ficha (que fala
    dela, não da conta) ele só confundia. `None` quando o provedor não conta.
    """
    return int(uso.get("completion_tokens") or 0) or None


def _custo_tokens(uso: dict[str, Any]) -> int | None:
    """O que a resposta **custou**: a soma de `total_tokens` dos passos.

    É o irmão de `_tokens`, e a diferença entre os dois é o motivo de existirem separados. O
    `_tokens` mede o tamanho do que a resposta escreveu; este mede o que ela custou — e como
    cada passo reenvia o contexto inteiro, o custo é várias vezes o tamanho. O número grande
    não serve para a ficha («o tamanho da resposta»), mas é o único que serve para a conta das
    moedas, porque é o que o provedor cobra.

    `None` quando o provedor não conta.
    """
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
    completou: bool = True,
    motivo: str | None = None,
    pendentes: list[str] | None = None,
    executou: int = 0,
    retomavel: bool = True,
    # No **fim** da assinatura de propósito: as chamadas existentes passam os primeiros por
    # posição, e um parâmetro novo no meio mudaria o significado delas em silêncio.
    tokens_total: int | None = None,
    reasoning_content: str | None = None,
    verification: dict[str, Any] | None = None,
    cobranca_koda: dict[str, Any] | None = None,
) -> Message:
    """Grava a resposta.

    O **desfecho** vai junto porque o cartão de «tarefa não concluída» precisa voltar quando
    a conversa é reaberta: sem ele, reabrir mostrava o plano com um item «em andamento» e
    nada rodando, sem dizer que a tarefa tinha parado nem oferecer o Retomar.
    """
    message = Message(
        id=new_id(),
        role="assistant",
        text=text,
        model=model,
        elapsed_ms=elapsed_ms,
        tokens=tokens,
        tokens_total=tokens_total,
        reasoning_content=reasoning_content,
        verification=verification or {},
        contexto=contexto,
        at=now_ms(),
        steps=steps,
        todos=[TodoItem.model_validate(item) for item in (todos or [])],
        incompleto=not completou,
        motivo=motivo,
        pendentes=list(pendentes or []),
        executou=executou,
        retomavel=retomavel,
    )
    with db.connect() as conn:
        append_message(conn, conversation_id, message, host_auth.email_da_conta())
        if cobranca_koda is not None:
            conn.execute('INSERT OR REPLACE INTO combo_uso_koda(message_id, modelo, tempo_ms, tokens) VALUES (?, ?, ?, ?)',
                         (message.id, cobranca_koda.get('modelo'), cobranca_koda.get('tempo_ms', 0), cobranca_koda.get('tokens', 0)))
    return message


def _usage(db: Database, tz_offset_minutes: int) -> dict[str, object]:
    with db.connect() as conn:
        return usage_for(
            conn, now_ms(), tz_offset_minutes, host_auth.email_da_conta()
        ).model_dump()
