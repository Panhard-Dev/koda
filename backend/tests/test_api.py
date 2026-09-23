"""Testes das rotas: chat em streaming, histórico, uso e conta."""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.routers import chat
from app.schemas import ChatRequest
from app.tools.loop import Resultado


@pytest.fixture()
def client(tmp_path: Path) -> TestClient:
    settings = Settings(
        provider="local",
        database_path=tmp_path / "koda.db",
        local_stream_delay_ms=0,
        openai_api_key=None,
    )
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def read_events(response_text: str) -> list[tuple[str, dict]]:
    """Transforma o corpo SSE em pares (evento, dados)."""
    events: list[tuple[str, dict]] = []
    event = None
    for line in response_text.splitlines():
        if line.startswith("event:"):
            event = line.split(":", 1)[1].strip()
        elif line.startswith("data:"):
            events.append((event or "message", json.loads(line.split(":", 1)[1].strip())))
    return events


def send(client: TestClient, text: str, **extra) -> list[tuple[str, dict]]:
    payload = {"text": text, "model": "liz-nano", "tz_offset_minutes": 0, **extra}
    response = client.post("/api/chat", json=payload)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    return read_events(response.text)


def test_health_reports_local_provider(client: TestClient) -> None:
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["provider"] == "local"
    assert body["provider_ready"] is True


def test_chat_streams_and_persists_the_conversation(client: TestClient) -> None:
    events = send(client, "primeira mensagem")
    kinds = [name for name, _ in events]
    assert kinds[0] == "start"
    assert kinds[-1] == "done"
    assert "delta" in kinds

    streamed = "".join(data["text"] for name, data in events if name == "delta")
    assert "primeira mensagem" in streamed

    done = next(data for name, data in events if name == "done")
    assert done["elapsed_ms"] >= 0
    assert done["usage"]["daily"]["used"] == 2  # a pergunta e a resposta

    conversation_id = events[0][1]["conversation_id"]
    conversation = client.get(f"/api/conversations/{conversation_id}").json()
    assert conversation["title"] == "primeira mensagem"
    assert [item["role"] for item in conversation["messages"]] == ["user", "assistant"]
    assert conversation["messages"][1]["text"] == streamed


def test_second_message_continues_the_same_conversation(client: TestClient) -> None:
    first = send(client, "oi")
    conversation_id = first[0][1]["conversation_id"]
    send(client, "e agora?", conversation_id=conversation_id)

    listed = client.get("/api/conversations").json()
    assert len(listed) == 1
    assert listed[0]["id"] == conversation_id
    assert listed[0]["message_count"] == 4
    assert listed[0]["preview"]


def test_each_request_without_conversation_id_starts_a_new_one(client: TestClient) -> None:
    first = send(client, "mensagem solta")[0][1]["conversation_id"]
    second = send(client, "outra solta")[0][1]["conversation_id"]
    assert first != second
    assert len(client.get("/api/conversations").json()) == 2


def test_usage_counts_daily_weekly_and_monthly(client: TestClient) -> None:
    conversation_id = None
    for index in range(3):
        events = send(client, f"mensagem {index}", conversation_id=conversation_id)
        conversation_id = events[0][1]["conversation_id"]

    usage = client.get("/api/usage", params={"tz_offset_minutes": 180}).json()
    assert usage["messages"] == 6
    assert usage["conversations"] == 1
    for window in ("daily", "weekly", "monthly"):
        assert usage[window]["used"] == 6
    assert usage["daily"]["limit"] == 20
    assert usage["weekly"]["limit"] == 100
    assert usage["monthly"]["limit"] == 300


def test_usage_ignores_messages_outside_the_window(client: TestClient, tmp_path: Path) -> None:
    """Mensagem de dois meses atrás conta no total, mas não na janela mensal."""
    settings = Settings(provider="local", database_path=tmp_path / "koda.db", local_stream_delay_ms=0)
    app = create_app(settings)
    with TestClient(app) as test_client:
        database = app.state.db
        from app.repository import append_message, ensure_conversation
        from app.schemas import Message

        old = int(time.time() * 1000) - 70 * 24 * 60 * 60 * 1000
        with database.connect() as conn:
            conversation_id = ensure_conversation(conn, None, "conversa antiga", old)
            append_message(
                conn,
                conversation_id,
                Message(id="antiga", role="user", text="conversa antiga", at=old),
            )

        usage = test_client.get("/api/usage", params={"tz_offset_minutes": 0}).json()
        assert usage["messages"] == 1
        assert usage["daily"]["used"] == 0
        assert usage["weekly"]["used"] == 0
        assert usage["monthly"]["used"] == 0


def test_conversation_lifecycle_and_404s(client: TestClient) -> None:
    created = client.post("/api/conversations", params={"title": "Conversa nova"}).json()
    assert client.get(f"/api/conversations/{created['id']}").json()["title"] == "Conversa nova"
    assert client.delete(f"/api/conversations/{created['id']}").status_code == 204
    assert client.get(f"/api/conversations/{created['id']}").status_code == 404
    assert client.delete("/api/conversations/nao-existe").status_code == 404


def test_account_link_unlink_and_sign_out(client: TestClient) -> None:
    initial = client.get("/api/account").json()
    assert initial["phone"] is None and initial["google"] is False

    linked = client.patch("/api/account", json={"phone": "(11) 91234-5678"}).json()
    assert linked["phone"] == "11912345678"  # só dígitos

    google = client.patch("/api/account", json={"google": True}).json()
    assert google["google"] is True
    assert google["email"] == "koda@gmail.com"
    assert google["phone"] == "11912345678"  # mandar só `google` não mexe no telefone

    unlinked = client.patch("/api/account", json={"phone": None}).json()
    assert unlinked["phone"] is None
    assert unlinked["google"] is True

    send(client, "oi")
    assert client.get("/api/conversations").json()

    signed_out = client.post("/api/account/sign-out").json()
    assert signed_out["phone"] is None and signed_out["google"] is False
    assert client.get("/api/conversations").json() == []


def test_invalid_phone_is_rejected(client: TestClient) -> None:
    response = client.patch("/api/account", json={"phone": "123"})
    assert response.status_code == 422


def test_empty_message_is_rejected(client: TestClient) -> None:
    assert client.post("/api/chat", json={"text": "   "}).status_code == 422


def test_missing_key_uses_openai_provider_but_says_it_is_not_ready(tmp_path: Path) -> None:
    settings = Settings(provider="openai", database_path=tmp_path / "koda.db", openai_api_key=None)
    with TestClient(create_app(settings)) as test_client:
        assert test_client.get("/api/health").json()["provider_ready"] is False
        events = send(test_client, "oi")
        assert [name for name, _ in events][-1] == "error"
        assert "OPENAI_API_KEY" in events[-1][1]["message"]


# --------------------------------------------------------------- modo agente


class ModeloComFerramentas:
    """Dublê do modelo: pede uma ferramenta de verdade e depois conclui.

    Também responde em texto puro, para dar para testar os dois caminhos da rota.
    """

    name = "dublê"
    ready = True
    model = "modelo-de-teste"

    def __init__(self, workspace: Path) -> None:
        self.workspace = workspace
        self.passos = 0
        self.historico: list[list[dict]] = []

    async def stream(self, turns, options):
        from app.providers.base import Piece

        yield Piece("pesando no problema", reasoning=True)
        for pedaco in ("resposta ", "em texto"):
            yield Piece(pedaco)

    def resolve_model(self, model: str) -> str:
        return self.model

    async def step(self, messages, tools, model: str = ""):
        from app.tools.loop import StepResult, ToolCall

        self.historico.append(list(messages))
        self.passos += 1
        if self.passos == 1:
            return StepResult(
                calls=[
                    ToolCall(
                        id="call_1",
                        name="write_file",
                        arguments={"caminho": "saida.txt", "conteudo": "feito pelo agente"},
                        raw_arguments=json.dumps(
                            {"caminho": "saida.txt", "conteudo": "feito pelo agente"}
                        ),
                    )
                ]
            )
        return StepResult(text="Criei saida.txt com o conteúdo pedido.")

    async def step_streaming(
        self,
        messages,
        tools,
        model: str = "",
        reasoning: bool = True,
        effort: str | None = None,
    ):
        """O mesmo passo, mas narrando o texto — como o provider do host faz.

        Existe aqui para os testes exercitarem o caminho que a interface usa de verdade:
        sem ele, o loop cai no `step()` e o texto volta num delta só.
        """
        from app.providers.base import Piece

        self.reasoning_recebido = reasoning
        resultado = await self.step(messages, tools, model)
        if resultado.text:
            meio = len(resultado.text) // 2
            yield Piece(resultado.text[:meio])
            yield Piece(resultado.text[meio:])
        yield resultado


@pytest.fixture()
def agente(tmp_path: Path):
    """Cliente com um provider de ferramentas no lugar do local."""
    workspaces = tmp_path / "projeto"
    workspaces.mkdir()
    settings = Settings(
        provider="local",
        database_path=tmp_path / "koda.db",
        local_stream_delay_ms=0,
        openai_api_key=None,
        workspace=workspaces,
        max_steps=4,
    )
    with TestClient(create_app(settings)) as test_client:
        test_client.app.state.provider = ModeloComFerramentas(workspaces)
        yield test_client, workspaces


def test_agente_roda_ferramenta_e_grava_os_passos(agente) -> None:
    client, workspace = agente
    events = send(client, "crie saida.txt", tools=True)
    kinds = [name for name, _ in events]

    assert kinds[0] == "start" and events[0][1]["tools"] is True
    assert kinds[-1] == "done"
    assert "tool_call" in kinds and "tool_result" in kinds

    chamada = next(data for name, data in events if name == "tool_call")
    assert chamada["name"] == "write_file"
    assert chamada["arguments"]["conteudo"] == "feito pelo agente"

    resultado = next(data for name, data in events if name == "tool_result")
    assert resultado["ok"] is True and "gravados em" in resultado["output"]

    # A ferramenta rodou de verdade, na pasta de trabalho configurada.
    assert (workspace / "saida.txt").read_text(encoding="utf-8") == "feito pelo agente"

    done = next(data for name, data in events if name == "done")
    assert done["steps"] == 1 and done["completed"] is True

    # O texto da resposta é o que a tela montou, e os passos ficam no histórico.
    conversation_id = events[0][1]["conversation_id"]
    conversa = client.get(f"/api/conversations/{conversation_id}").json()
    resposta = conversa["messages"][-1]
    assert resposta["text"] == "Criei saida.txt com o conteúdo pedido."
    assert resposta["steps"][0]["name"] == "write_file"
    assert resposta["steps"][0]["arguments"]["caminho"] == "saida.txt"
    assert resposta["model"] == "modelo-de-teste"


def test_ferramentas_sao_o_comportamento_normal_da_conversa(agente) -> None:
    """Sem `tools` no corpo, o agente roda sozinho quando o provedor sabe chamar."""
    client, workspace = agente
    events = send(client, "crie saida.txt")
    assert events[0][1]["tools"] is True
    assert "tool_call" in [name for name, _ in events]
    assert (workspace / "saida.txt").read_text(encoding="utf-8") == "feito pelo agente"


def test_tools_false_na_mensagem_responde_em_texto(agente) -> None:
    client, workspace = agente
    events = send(client, "oi", tools=False)
    assert [name for name, _ in events] == ["start", "reasoning", "delta", "delta", "done"]
    assert events[0][1]["tools"] is False
    # O raciocínio vai para a tela — é ele que evita a tela parada — mas não é a resposta.
    assert "".join(data["text"] for name, data in events if name == "reasoning") == (
        "pesando no problema"
    )
    assert "".join(data["text"] for name, data in events if name == "delta") == (
        "resposta em texto"
    )
    assert not (workspace / "saida.txt").exists()


def test_agente_streama_o_texto_em_vez_de_mandar_tudo_de_uma_vez(agente) -> None:
    """O texto do passo sai pedaço a pedaço, e não repetido no fim.

    Antes o loop usava só o `step()` (`stream: false`) e emitia o texto do passo inteiro
    num único delta. Como o modo agente é o padrão, **toda** resposta aparecia de uma vez
    na tela, por mais longo que fosse o texto.
    """
    client, _ = agente
    events = send(client, "crie saida.txt", tools=True)
    texto = "".join(data["text"] for name, data in events if name == "delta")

    assert "Criei saida.txt com o conteúdo pedido." in texto
    # O texto do passo final veio fatiado: nenhum delta sozinho carrega ele inteiro.
    finais = [data["text"] for name, data in events if name == "delta"]
    assert not any(pedaco == "Criei saida.txt com o conteúdo pedido." for pedaco in finais)
    assert sum(1 for pedaco in finais if "Criei" in pedaco or "conteúdo" in pedaco) >= 2
    # E não aparece duas vezes (o texto já saiu no stream, o loop não repete).
    assert texto.count("Criei saida.txt com o conteúdo pedido.") == 1


def test_botao_reasoning_chega_ao_provider_no_modo_agente(agente) -> None:
    """O botão Reasoning vale também no caminho com ferramentas — que é o padrão."""
    client, _ = agente
    provider = client.app.state.provider

    send(client, "crie saida.txt", tools=True)
    assert provider.reasoning_recebido is True

    send(client, "crie saida.txt", tools=True, reasoning=False)
    assert provider.reasoning_recebido is False


def test_agente_recebe_o_prompt_e_a_pasta_de_trabalho(agente) -> None:
    client, workspace = agente
    send(client, "qual a pasta?", tools=True)

    mensagens = client.app.state.provider.historico[0]
    assert mensagens[0]["role"] == "system"
    assert "ferramentas disponíveis" in mensagens[0]["content"]
    assert str(workspace) in mensagens[0]["content"]


def test_models_do_host_viram_opcoes_do_seletor() -> None:
    from app.routers.models import catalogo

    dados = {
        "data": [
            {"id": "liz-nano", "name": "Liz Nano"},
            {"id": "koda-1", "name": "Koda 1"},
            {"id": "layze-2", "name": "Layze 2"},
            {"id": "liz-mini-1-3", "name": "Liz Mini 1.3"},
            {"id": "modelo-sem-nome"},
            {"id": "liz-imagem-image"},
            {"id": "liz-voz-tts"},
            {"id": ""},
        ]
    }
    itens = catalogo(dados)

    # Do maior para o menor: layze-2 (4, 2) > koda-1 (4, 1) > modelo-sem-nome (4, 0)
    # > liz-mini-1-3 (2, 1) > liz-nano (1, 0).
    assert [item.value for item in itens] == [
        "layze-2",
        "koda-1",
        "modelo-sem-nome",
        "liz-mini-1-3",
        "liz-nano",
    ]
    # O host já manda o nome de exibição; o nosso só entra quando falta.
    assert itens[1].label == "Koda 1"
    assert itens[2].label == "Modelo Sem Nome"
    assert itens[3].label == "Liz Mini 1.3"
    # Sem "host local" embaixo de cada linha: o seletor mostra só o nome do modelo.
    assert all(item.hint is None for item in itens)


def test_catalogo_sai_do_maior_para_o_menor() -> None:
    """A ordem vem do nome, porque o host não publica tamanho em lugar nenhum.

    Nem `/v1/models` nem o `catalog.go` dele têm campo de tamanho — a lista de lá é só a
    ordem do upstream, filtrada pela allowlist. Então o peso sai do tier (`nano` < `mini`
    < sem tier) e, dentro do tier, da geração.
    """
    from app.routers.models import catalogo, peso

    dados = {
        "data": [
            {"id": "liz-nano", "name": "Liz Nano"},
            {"id": "liz-mini-1-3", "name": "Liz Mini 1.3"},
            {"id": "liz-mini-2", "name": "Liz Mini 2"},
            {"id": "liz-3-flash", "name": "Liz 3 Flash"},
            {"id": "liz-4", "name": "Liz 4"},
        ]
    }
    assert [item.value for item in catalogo(dados)] == [
        "liz-4",
        "liz-3-flash",
        "liz-mini-2",
        "liz-mini-1-3",
        "liz-nano",
    ]
    assert (
        peso("liz-4")
        > peso("liz-3-flash")
        > peso("liz-mini-2")
        > peso("liz-mini-1-3")
        > peso("liz-nano")
    )
    # Tier vence geração: um "mini" de geração alta continua abaixo de um "flash".
    assert peso("liz-mini-2") < peso("liz-3-flash")


def test_models_vazio_no_provider_local(client: TestClient) -> None:
    assert client.get("/api/models").json() == []


def test_resolve_model_deixa_o_id_do_host_passar(tmp_path: Path) -> None:
    """O catálogo é do host: id desconhecido vai como veio, não cai no modelo padrão.

    Antes o provider devolvia o padrão para qualquer coisa que não começasse com
    `gemini`, então escolher "koda-1" na interface pedia outro modelo ao host — todo
    mundo acabava no mesmo modelo, sem erro nenhum para denunciar.
    """
    from app.providers import GeminiProxyProvider

    engine = GeminiProxyProvider(
        Settings(
            provider="gemini",
            database_path=tmp_path / "koda.db",
            gemini_proxy_url="http://127.0.0.1:21128/v1",
            gemini_model="liz-nano",
        )
    )

    for identificador in ("liz-nano", "koda-1", "layze-2", "liz-mini-1-3", "liz-mini-2"):
        assert engine.resolve_model(identificador) == identificador

    # Nome decorativo antigo (conversa gravada antes do host) cai no padrão.
    assert engine.resolve_model("koda-flash") == "liz-nano"
    assert engine.resolve_model("") == "liz-nano"

    # O model_map continua ganhando de tudo.
    com_mapa = GeminiProxyProvider(
        Settings(
            provider="gemini",
            database_path=tmp_path / "koda.db",
            model_map='{"liz-nano": "outro-modelo"}',
        )
    )
    assert com_mapa.resolve_model("liz-nano") == "outro-modelo"


def test_esforco_none_so_vai_para_quem_aceita(tmp_path: Path, monkeypatch) -> None:
    """`reasoning_effort: none` faz o host recusar (`liz-4`, `layze-2`) com 400.

    O alvo de cada modelo vem do `/v1/models` do host: os de `openai-responses` recusam o
    campo, com ou sem ferramentas no corpo — a resposta era um erro na tela em vez de uma
    resposta.
    """
    import httpx

    from app.providers import openai_compat

    catalogo = {
        "data": [
            {"id": "liz-nano"},
            {"id": "koda-1", "targetFormat": "openai-chat"},
            {"id": "liz-4", "targetFormat": "openai-responses"},
            {"id": "layze-2", "targetFormat": "openai-responses"},
        ]
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=catalogo)

    class ClienteFalso(httpx.AsyncClient):
        def __init__(self, **kwargs: object) -> None:
            kwargs["transport"] = httpx.MockTransport(handler)
            super().__init__(**kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(openai_compat.httpx, "AsyncClient", ClienteFalso)
    engine = openai_compat.GeminiProxyProvider(
        Settings(
            provider="gemini",
            database_path=tmp_path / "koda.db",
            gemini_proxy_url="http://host-falso/v1",
        )
    )

    async def cenario() -> dict[str, str]:
        return {
            modelo: await engine.esforco(reasoning, modelo)
            for modelo in ("liz-nano", "koda-1", "liz-4", "layze-2")
            for reasoning in (False,)
        }

    esforcos = asyncio.run(cenario())
    assert esforcos == {
        "liz-nano": "none",
        "koda-1": "none",
        "liz-4": "minimal",
        "layze-2": "minimal",
    }
    # Com o raciocínio ligado o valor é o mesmo para todos.
    assert asyncio.run(engine.esforco(True, "liz-4")) == "minimal"


def test_escolha_de_esforco_da_interface_manda_no_provider(tmp_path: Path, monkeypatch) -> None:
    """O seletor ao lado do modelo ganha do botão Reasoning — e `none` continua guardado."""
    import httpx

    from app.providers import openai_compat

    catalogo = {
        "data": [
            {"id": "liz-nano"},
            {"id": "koda-1"},
            {"id": "layze-2", "targetFormat": "openai-responses"},
        ]
    }

    class ClienteFalso(httpx.AsyncClient):
        def __init__(self, **kwargs: object) -> None:
            kwargs["transport"] = httpx.MockTransport(
                lambda request: httpx.Response(200, json=catalogo)
            )
            super().__init__(**kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(openai_compat.httpx, "AsyncClient", ClienteFalso)
    engine = openai_compat.GeminiProxyProvider(
        Settings(provider="gemini", database_path=tmp_path / "koda.db")
    )

    async def cenario() -> dict[str, str]:
        return {
            "alto": await engine.esforco(True, "liz-nano", "high"),
            "medio_sem_reasoning": await engine.esforco(False, "liz-nano", "medium"),
            "auto_ligado": await engine.esforco(True, "liz-nano", None),
            "auto_desligado": await engine.esforco(False, "liz-nano", None),
            "none_num_recusado": await engine.esforco(False, "layze-2", "none"),
            "none_num_aceito": await engine.esforco(False, "koda-1", "none"),
        }

    assert asyncio.run(cenario()) == {
        "alto": "high",
        "medio_sem_reasoning": "medium",
        "auto_ligado": "minimal",
        "auto_desligado": "none",
        "none_num_recusado": "minimal",
        "none_num_aceito": "none",
    }


def test_effort_auto_nao_vai_para_o_provider() -> None:
    from app.routers.chat import _effort

    assert _effort(ChatRequest(text="oi", effort="auto")) is None
    assert _effort(ChatRequest(text="oi", effort="high")) == "high"


def test_effort_invalido_e_recusado(client: TestClient) -> None:
    resposta = client.post("/api/chat", json={"text": "oi", "effort": "turbo"})
    assert resposta.status_code == 422


def test_esforco_escolhido_vai_no_corpo_do_pedido(tmp_path: Path, monkeypatch) -> None:
    """O seletor da interface tem que chegar no host como `reasoning_effort`."""
    import httpx

    from app.providers import openai_compat
    from app.providers.base import ChatOptions, ChatTurn

    catalogo = {"data": [{"id": "liz-nano"}]}
    corpos: list[dict] = []
    sse = (
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
        "data: [DONE]\n\n"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json=catalogo)
        corpos.append(json.loads(request.content.decode("utf-8")))
        return httpx.Response(200, content=sse.encode())

    class ClienteFalso(httpx.AsyncClient):
        def __init__(self, **kwargs: object) -> None:
            kwargs["transport"] = httpx.MockTransport(handler)
            super().__init__(**kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(openai_compat.httpx, "AsyncClient", ClienteFalso)
    engine = openai_compat.GeminiProxyProvider(
        Settings(provider="gemini", database_path=tmp_path / "koda.db")
    )

    async def cenario() -> None:
        async for _ in engine.stream(
            [ChatTurn(role="user", text="oi")],
            ChatOptions(model="liz-nano", reasoning=True, effort="high"),
        ):
            pass
        async for _ in engine.step_streaming(
            [{"role": "user", "content": "oi"}], tools=[], model="liz-nano", effort="medium"
        ):
            pass

    asyncio.run(cenario())
    assert [corpo.get("reasoning_effort") for corpo in corpos] == ["high", "medium"]
    assert [corpo.get("model") for corpo in corpos] == ["liz-nano", "liz-nano"]


def test_esforco_sem_catalogo_vai_de_minimal(tmp_path: Path, monkeypatch) -> None:
    """Catálogo fora do ar: `minimal` passa em todos, então é ele que vai."""
    import httpx

    from app.providers import openai_compat

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "sem catálogo"})

    class ClienteFalso(httpx.AsyncClient):
        def __init__(self, **kwargs: object) -> None:
            kwargs["transport"] = httpx.MockTransport(handler)
            super().__init__(**kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(openai_compat.httpx, "AsyncClient", ClienteFalso)
    engine = openai_compat.GeminiProxyProvider(
        Settings(provider="gemini", database_path=tmp_path / "koda.db")
    )
    assert asyncio.run(engine.esforco(False, "liz-nano")) == "minimal"


def test_models_do_openai_e_o_modelo_configurado(tmp_path: Path) -> None:
    settings = Settings(
        provider="openai",
        database_path=tmp_path / "koda.db",
        openai_api_key="chave-de-teste",
        openai_model="gpt-4o-mini",
    )
    with TestClient(create_app(settings)) as test_client:
        assert test_client.get("/api/models").json() == [
            {"value": "gpt-4o-mini", "label": "gpt-4o-mini", "hint": "provedor atual"}
        ]


def test_pedir_ferramentas_a_um_provider_que_nao_tem_avisa(client: TestClient) -> None:
    """Provider local não sabe chamar ferramenta: pedir explicitamente dá erro."""
    events = send(client, "rode algo", tools=True)
    assert [name for name, _ in events] == ["error"]
    assert "não sabe chamar ferramentas" in events[-1][1]["message"]


def test_health_mostra_pasta_e_ferramentas_disponiveis(tmp_path: Path) -> None:
    settings = Settings(
        provider="local",
        database_path=tmp_path / "koda.db",
        workspace=tmp_path,
        tools_deny="shell, git_commit",
    )
    with TestClient(create_app(settings)) as test_client:
        body = test_client.get("/api/health").json()
    assert body["workspace"] == str(tmp_path)
    assert "shell" not in body["tools"] and "git_commit" not in body["tools"]
    assert "read_file" in body["tools"]
    assert len(body["tools"]) == 20


# ------------------------------------------------------- parar no meio


def test_parar_no_meio_cancela_a_tarefa_do_loop(agente, monkeypatch) -> None:
    """Fechar o gerador (botão parar) tem que cancelar o loop, não deixá-lo rodando.

    Sem o cancelamento a tarefa continua executando os passos restantes e enfileirando
    eventos que ninguém mais lê — a ferramenta segue rodando na máquina depois do stop.
    """
    client, _workspace = agente
    cancelada = asyncio.Event()

    async def loop_que_nunca_termina(*_args, **kwargs):
        emit = kwargs["emit"]
        try:
            await emit("delta", {"text": "comecando..."})
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            cancelada.set()
            raise
        return Resultado(texto="nunca chega", passos=[], completou=False, uso={})

    monkeypatch.setattr(chat, "rodar_ferramentas", loop_que_nunca_termina)

    async def cenario() -> bool:
        pedido = SimpleNamespace(
            app=SimpleNamespace(
                state=SimpleNamespace(
                    db=client.app.state.db, provider=client.app.state.provider
                )
            )
        )
        payload = ChatRequest(text="faca algo demorado", model="liz-nano", tools=True)
        gerador = chat._agente(pedido, client.app.state.settings, payload)

        assert "event: start" in await anext(gerador)
        # O segundo evento é o delta do dublê: só aí a tarefa do loop já existe e o
        # gerador está suspenso dentro do `while`, que é onde o abort acontece.
        assert "comecando" in await anext(gerador)

        # É o que o cliente faz ao abortar: fecha o gerador no meio.
        await gerador.aclose()
        return cancelada.is_set()

    assert asyncio.run(cenario()) is True
