"""POST /api/chat — responde em streaming e grava a conversa.

Dois caminhos, escolhidos por `tools` no corpo:
- **texto**: uma resposta só, em streaming (como antes);
- **agente**: o modelo pode chamar as ferramentas locais entre passos, e cada chamada e
  cada resultado sai como evento (`tool_call` / `tool_result`) para a interface mostrar.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pathlib import Path

from .. import anexos, host_auth, projects
from ..agent import contexto
from ..policy import approvals
from ..config import Settings
from ..db import Database
from ..deps import call, database, provider
from ..identidade import regras as regras_identidade
from ..identidade import remover_intro
from ..providers import ChatOptions, ChatTurn, ProviderError, conteudo_do_turno, system_prompt
from ..repository import (
    append_message,
    ensure_conversation,
    get_conversation,
    mensagens_da_conversa,
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
from ..agent.loop import (
    ALO_DE_RACIOCINIO,
    AVISO_DE_RACIOCINIO_EM_LOOP,
    CONTINUAR_TRUNCADA,
    MAX_ALOS_DE_RACIOCINIO,
    PARADA_ABORTADA,
    PARADA_PROVEDOR,
    RETOMAR_TAREFA,
    Emit,
    Resultado,
)

router = APIRouter(tags=["chat"])

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
    # Retomar exige uma conversa existente — e a checagem é **aqui**, antes de o stream
    # começar: lá dentro o status já foi 200, e um `HTTPException` viraria um stream
    # truncado em vez de um erro legível.
    if payload.resume and not await call(
        _conversa_existe, database(request), payload.conversation_id
    ):
        raise HTTPException(
            status_code=400, detail="não há conversa para retomar: mande o conversation_id"
        )
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
    store = _store_de_anexos(request)
    anexos_do_pedido = await call(store.buscar_varios, payload.attachments)
    visao = _visao_ativa(request.app.state.settings, payload.model, anexos_do_pedido)
    conversation_id, turns, origens, resumo_guardado, cobertas = await call(
        _prepare, db, store, payload, now_ms(), visao
    )
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
    )
    # Com qual modelo o provedor realmente responde (o seletor manda o nome da interface).
    modelo = engine.resolve_model(payload.model) if hasattr(engine, "resolve_model") else options.model

    pieces: list[str] = []
    stored = False
    #: O `usage` do rodapé do stream (ver `Piece.usage`). Sem ferramentas não há
    #: `StepResult`, então é daqui que sai o contador da ficha.
    uso: dict[str, int] = {}
    try:
        #: Quantos alôs de raciocínio em laço já foram dados (ver `ALO_DE_RACIOCINIO`).
        alos = 0
        while True:
            trecho: list[str] = []
            truncado = False
            repetiu = False
            async for piece in engine.stream(turns, options):
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
                    # O raciocínio não é a resposta: vai para a tela para o usuário acompanhar o
                    # modelo pensando, mas não entra no texto gravado da mensagem.
                    yield sse("reasoning", {"text": piece.text})
                    continue
                trecho.append(piece.text)
                pieces.append(piece.text)
                yield sse("delta", {"text": piece.text})
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
                    turns.append(ChatTurn(role="assistant", text=texto_parcial))
                turns.append(ChatTurn(role="user", text=ALO_DE_RACIOCINIO))
                continue
            if not truncado:
                break
            texto_parcial = "".join(trecho)
            if texto_parcial:
                turns.append(ChatTurn(role="assistant", text=texto_parcial))
            turns.append(ChatTurn(role="user", text=CONTINUAR_TRUNCADA))

        text = "".join(pieces).strip()
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
                "contexto": message.contexto or None,
                "usage": await call(_usage, db, payload.tz_offset_minutes),
            },
        )
    except ProviderError as error:
        yield sse("error", {"message": str(error)})
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
    instrucoes_base = _options(
        payload, settings.assistente, resumo, [item.nome for item in anexos_do_pedido], visao
    )
    mensagens: list[dict[str, object]] = [
        {
            "role": "system",
            "content": (
                f"{PROMPT_FERRAMENTAS}\n{system_prompt(instrucoes_base)}\n"
                f"{regras_identidade(settings.assistente)}\n"
                f"Pasta de trabalho atual: {workspace}"
                + (f"\n\n{skills_prompt}" if skills_prompt else "")
            ),
        }
    ]
    # `conteudo_do_turno` e não `turn.text`: é ele que transforma o turno com imagem no
    # `content` em partes (`text` + `image_url`) que o provedor entende como visão. O loop
    # do agente reenvia esta lista a cada passo sem tocar nela.
    mensagens += [conteudo_do_turno(turn) for turn in turns]

    pedacos: list[str] = []
    #: Última lista de tarefas que o agente registrou — vai gravada na mensagem.
    plano: list[dict[str, object]] = []
    passos: list[ToolStepOut] = []
    resultado = Resultado(texto="", passos=[], completou=False, uso={})
    stored = False
    #: Por que a rodada fechou quando ela não fechou pelo caminho normal. Quem grava o que
    #: sobrou é o `finally`, e ele precisa saber: sem isto, uma queda do provedor ficaria
    #: registrada como «interrompida» — outro motivo, e outra conversa para quem lê.
    motivo_do_fim: str = PARADA_ABORTADA
    fim: asyncio.Queue[tuple[str, dict[str, object]] | None] = asyncio.Queue()
    #: Id desta tarefa. Vai junto de cada processo que ela começar, para o Parar derrubar
    #: só os processos **dela** (ver `ferramentas.encerrar_do_dono`).
    dono_da_tarefa = new_id()
    cancelamento = threading.Event()

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
    # A aba Subs pede a rodada livre: ela não tem cartão de permissão, e um pedido sem cartão
    # deixaria o agente parado para sempre esperando resposta. Vale para esta rodada só — o
    # modo guardado continua sendo o do app inteiro.
    if payload.livre:
        modo_permissao = "livre"

    async def aprovar(acao: dict[str, object]) -> str:
        return await _pedir_permissao(request, db, modo_permissao, emit, acao)

    async def rodar() -> Resultado:
        try:
            return await rodar_ferramentas(
                engine,
                mensagens,
                workspace=workspace,
                max_steps=(
                    settings.max_steps if payload.max_steps is None else payload.max_steps
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
                aprovar=None if modo_permissao in ("auto", "livre") else aprovar,
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
                raw_arguments=passo.raw_arguments,
                # O endereço de origem do que veio de servidor MCP: é o que a tela mostra
                # como "recurso acionado" (servidor + ferramenta reais).
                mcp=passo.mcp,
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
                # O medidor de contexto ao lado do modelo lê daqui, sem recarregar nada.
                "contexto": resultado.contexto or None,
                "usage": await call(_usage, db, payload.tz_offset_minutes),
            },
        )
    except ProviderError as error:
        motivo_do_fim = PARADA_PROVEDOR
        yield sse("error", {"message": str(error)})
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
            texto = ("".join(pedacos) or resultado.texto).strip()
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
        return (resumo_guardado, turns, 0)

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
        return (resumo_guardado, turns, 0)

    junto = "\n\n".join(
        parte.strip() for parte in (resumo_guardado, resumo_novo) if parte and parte.strip()
    )
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
    await emit("approval_request", {"id": identificador, **acao})
    try:
        decisao = await asyncio.wait_for(futuro, timeout=approvals.ESPERA_MAXIMA_S)
    except asyncio.TimeoutError:
        decisao = "nao"
    finally:
        # **Sem** `CancelledError` na lista. Engolir o cancelamento aqui era metade do bug
        # do botão Parar: com um cartão aberto, o cancelamento virava "não" e o loop seguia
        # chamando o modelo — o usuário apertava Parar e o agente continuava trabalhando.
        # Cancelar tem de propagar; o `finally` só limpa o registro.
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


def _options(
    payload: ChatRequest,
    assistente: str,
    resumo: str = "",
    anexos: list[str] | None = None,
    visao: bool = False,
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
    )


def _visao_ativa(settings: Settings, model: str, do_pedido: list[anexos.Anexo]) -> bool:
    """O modelo escolhido enxerga imagem — e esta mensagem trouxe alguma?

    As duas condições juntas, de propósito: sem imagem anexada não há o que mandar, e num
    modelo que não enxerga o pedido com `image_url` no corpo é recusado inteiro. Fora deste
    caso, o anexo segue pelos metadados, como sempre foi.

    Quem decide é a **lista curada** do `Settings`, e **não** o `images` do catálogo do
    host: a lista é medida contra o upstream, e mandar imagem para quem não enxerga derruba
    o pedido inteiro. Ela já esteve errada nos dois sentidos — medição de 10/10/2026 mostrou
    que o `liz-nano` e o `nable-4` enxergam, e o comentário que os excluía citava um id
    (`mai-experimental`) que o host não usa mais.
    """
    return settings.aceita_imagem(model) and any(item.imagem for item in do_pedido)


def _effort(payload: ChatRequest) -> str | None:
    """Esforço do seletor; `auto` (o padrão) deixa a decisão com o botão Reasoning."""
    return None if payload.effort == "auto" else payload.effort


def _conversa_existe(db: Database, conversation_id: str | None) -> bool:
    """A conversa existe e tem pelo menos uma mensagem? É o pré-requisito de Retomar."""
    if not conversation_id:
        return False
    with db.connect() as conn:
        conversa = get_conversation(conn, conversation_id)
    return conversa is not None and bool(conversa.messages)


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
        if not mensagens and not cobertas:
            # Inalcançável pela rota (a checagem é feita antes do stream): se acontecer, a
            # conversa sumiu entre a checagem e a montagem do histórico.
            raise LookupError("não há conversa para retomar")
        turns, origens = _turns(mensagens, store, visao)
        turns.append(ChatTurn(role="user", text=RETOMAR_TAREFA))
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


def _bloco_de_anexos(anexos_da_mensagem: list[AttachmentInfo], visao: bool = False) -> str:
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
        marca = (
            " · imagem anexada ao seu contexto: você a enxerga"
            if visao and anexos.cabe_inline(item.tipo, item.tamanho)
            else ""
        )
        linhas.append(
            f"- {item.nome} ({item.tipo}, {item.tamanho} bytes) · id: {item.id}{marca}"
        )
    linhas.append(
        "Para ler o conteúdo de texto, código ou pdf, use `read_attachment` com o id acima. "
        "Imagem marcada como anexada não precisa de ferramenta — descreva o que você vê. "
        "Não use `read_file` com o nome do anexo: ele não está no workspace."
    )
    return "\n".join(linhas)


def _imagens_do_turno(
    anexos_da_mensagem: list[AttachmentInfo], store: anexos.AnexoStore
) -> list[str]:
    """As imagens desta mensagem como `data:` URLs, na ordem em que foram anexadas.

    Lê do store pelo id — o mesmo caminho do `read_attachment`, e o único que alcança o
    conteúdo. O que não é imagem, ou passa do teto inline, simplesmente não entra: o bloco
    de metadados já diz o que é, e o pedido não engorda à toa.
    """
    urls: list[str] = []
    for info in anexos_da_mensagem:
        if not info.id:
            continue
        anexo = store.buscar(info.id)
        if anexo is None:
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
    turns: list[ChatTurn] = []
    origens: list[int] = []
    for posicao, item in enumerate(mensagens):
        texto = remover_intro(item.text) if item.role == "assistant" else item.text
        bloco = _bloco_de_anexos(item.attachments, visao) if item.role == "user" else ""
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
            turns.append(ChatTurn(role="assistant", text=corpo, chamadas=chamadas))
            origens.append(posicao)
            turns += [
                ChatTurn(role="tool", text=passo.output or "", chamada_id=chamadas[indice]["id"])
                for indice, passo in enumerate(item.steps)
            ]
            origens += [posicao] * len(item.steps)
            continue
        imagens = (
            _imagens_do_turno(item.attachments, store)
            if visao and store is not None and item.role == "user"
            else []
        )
        turns.append(ChatTurn(role=item.role, text=corpo, imagens=imagens))
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
    return message


def _usage(db: Database, tz_offset_minutes: int) -> dict[str, object]:
    with db.connect() as conn:
        return usage_for(
            conn, now_ms(), tz_offset_minutes, host_auth.email_da_conta()
        ).model_dump()
