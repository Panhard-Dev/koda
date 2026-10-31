"""Contratos dos provedores migrados, sem rede ou credenciais reais."""

import asyncio
import hashlib
import json
import struct
import zlib
from contextlib import nullcontext
from types import SimpleNamespace

import httpx
import pytest

from app import provedores
from app import cursor_koda, gitlab_koda, google_conta_koda, kiro_koda, koda_tool_protocol, mimo_conta_koda, qoder_cosy, qoder_koda, trae_koda, windsurf_koda, zed_koda
from app.providers.base import ChatOptions, ChatTurn, ProviderError, TransientProviderError
from app.providers.conta import ContaProvider


@pytest.mark.parametrize("identificador", ["chatgpt-web", "deepseek-web", "gemini-web", "grok-web", "muse-web", "perplexity-web", "uc-web"])
def test_provedor_web_removido_do_catalogo_e_bloqueado(identificador):
    assert identificador not in provedores.POR_ID
    with pytest.raises(ProviderError, match="removido"):
        ContaProvider(SimpleNamespace(), identificador)._conta()


@pytest.mark.parametrize("identificador,dominio", [
    ("codebuddy-cn", "copilot.tencent.com"),
    ("codebuddy-intl", "www.codebuddy.ai"),
])
def test_codebuddy_stream_e_ferramentas_sem_motor_antigo(monkeypatch, identificador, dominio):
    chamadas = []
    provedor = ContaProvider(SimpleNamespace(), identificador)
    monkeypatch.setattr(provedor, "_conta", lambda: {"access": "token"})

    async def sse(url, headers, corpo, conta):
        chamadas.append((url, headers, corpo, conta))
        yield "data: " + json.dumps({"choices": [{"delta": {"content": "olá", "tool_calls": [
            {"index": 0, "id": "t1", "function": {"name": "ler", "arguments": '{"id":'},
             "extra_content": {"signature": "opaca"}}]}}]})
        yield "data: " + json.dumps({"choices": [{"delta": {"tool_calls": [
            {"index": 0, "function": {"arguments": "2}"}}]}, "finish_reason": "tool_calls"}],
            "usage": {"prompt_tokens": 4, "completion_tokens": 5}})
        yield "data: [DONE]"

    monkeypatch.setattr(provedor, "_sse", sse)
    mensagens = [{"role": "system", "content": "Você é Koda"}, {"role": "user", "content": "oi"}]
    original = json.loads(json.dumps(mensagens))
    ferramentas = [{"type": "function", "function": {"name": "ler"}}]
    resultado = asyncio.run(provedor.step(mensagens, ferramentas, "modelo"))

    assert resultado.text == "olá"
    assert resultado.calls[0].arguments == {"id": 2}
    assert resultado.calls[0].extra == {"extra_content": {"signature": "opaca"}}
    assert resultado.usage == {"prompt_tokens": 4, "completion_tokens": 5}
    assert dominio in chamadas[0][0]
    assert chamadas[0][1]["x-request-id"] == chamadas[0][1]["x-conversation-request-id"]
    assert chamadas[0][2]["messages"][0]["content"] == "Você é Koda"
    assert chamadas[0][2]["stream"] is True
    assert chamadas[0][2]["tools"] == ferramentas
    assert mensagens == original

    async def consumir():
        return [p async for p in provedor.stream([ChatTurn("user", "oi")], ChatOptions(model="modelo"))]

    pedacos = asyncio.run(consumir())
    assert pedacos[0].text == "olá"
    assert chamadas[1][2]["messages"][0]["role"] == "system"


@pytest.mark.parametrize("identificador", ["codebuddy-cn", "codebuddy-intl"])
def test_codebuddy_modelo_testado_por_stream(monkeypatch, identificador):
    pedidos = []

    class Cliente:
        def __init__(self, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def stream(self, metodo, url, **kwargs):
            pedidos.append((metodo, url, kwargs))
            return nullcontext(httpx.Response(200, text='data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'))

    monkeypatch.setattr(provedores.httpx, "Client", Cliente)
    resultado = provedores._chamar_modelo(identificador, {"access": "token"}, "modelo")
    assert resultado == {"ok": True, "detalhe": "ok"}
    assert pedidos[0][2]["json"]["stream"] is True
    assert pedidos[0][2]["json"]["messages"][0]["role"] == "system"


def test_codebuddy_marca_conta_sem_cota(monkeypatch):
    marcadas = []
    resposta = httpx.Response(400, json={"code": 6004, "msg": "limite"})

    class Contexto:
        async def __aenter__(self):
            return resposta

        async def __aexit__(self, *_args):
            return None

    class Cliente:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        def stream(self, *_args, **_kwargs):
            return Contexto()

    provedor = ContaProvider(SimpleNamespace(), "codebuddy-cn")
    monkeypatch.setattr(httpx, "AsyncClient", Cliente)
    monkeypatch.setattr(provedor, "_marcar_esgotada", lambda *args: marcadas.append(args))

    async def consumir():
        return [linha async for linha in provedor._sse("https://example.test", {}, {}, {"id": "conta"})]

    with pytest.raises(TransientProviderError, match="sem cota"):
        asyncio.run(consumir())
    assert marcadas[0][0]["id"] == "conta"


def test_mimo_chave_de_api_vai_direto_e_preserva_ferramentas(monkeypatch):
    pedidos = []

    class Cliente:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, **kwargs):
            pedidos.append((url, kwargs))
            return httpx.Response(200, json={"choices": [{"message": {"content": "ok", "tool_calls": [
                {"id": "t1", "function": {"name": "ler", "arguments": '{"x":1}'}}]}}]})

    provedor = ContaProvider(SimpleNamespace(), "xiaomi-mimo")
    monkeypatch.setattr(provedor, "_conta", lambda: {"access": "sk-teste"})
    monkeypatch.setattr(httpx, "AsyncClient", Cliente)
    resultado = asyncio.run(provedor.step([{"role": "user", "content": "oi"}], [], "mimo-v2.5"))
    assert resultado.calls[0].arguments == {"x": 1}
    assert pedidos[0][0] == "https://api.xiaomimimo.com/v1/chat/completions"
    assert pedidos[0][1]["headers"]["api-key"] == "sk-teste"


def test_mimo_token_de_conta_usa_sessao_fornecida(monkeypatch):
    chamadas = []

    class RespostaStream:
        def __init__(self, status):
            self.status_code = status

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def aread(self):
            return b""

        async def aiter_lines(self):
            yield 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}'
            yield "data: [DONE]"

    class Cliente:
        def __init__(self, **_kwargs):
            self.chat = 0

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, url, **kwargs):
            chamadas.append(("GET", url, kwargs))
            request = httpx.Request("GET", url)
            if "/pass/serviceLogin" in url:
                return httpx.Response(200, text='&&&START&&&{"code":0,"location":"https://account.xiaomi.com/sso","nonce":123,"ssecurity":"security"}', request=request)
            return httpx.Response(200, headers={"set-cookie": "mimoams_serviceToken=servico; Path=/"}, request=request)

        def stream(self, metodo, url, **kwargs):
            chamadas.append((metodo, url, kwargs))
            self.chat += 1
            return RespostaStream(401 if self.chat == 1 else 200)

    monkeypatch.setattr(mimo_conta_koda, "_COOKIES", {})
    monkeypatch.setattr(mimo_conta_koda.httpx, "AsyncClient", Cliente)
    provedor = ContaProvider(SimpleNamespace(), "xiaomi-mimo")
    monkeypatch.setattr(provedor, "_conta", lambda: {"access": "sessao", "specific": {
        "mimoPassToken": "conta", "mimoUserId": "u1", "region": "ams"}})
    resultado = asyncio.run(provedor.step([{"role": "user", "content": "oi"}], [], "mimo-v2.6-pro"))
    assert resultado.text == "ok"
    chats = [item for item in chamadas if item[0] == "POST"]
    assert len(chats) == 2
    assert chats[0][1] == "https://mimo-server-ams.xiaomimimo.com/api/route/chat/completions"
    assert "serviceToken=servico" in chats[0][2]["headers"]["cookie"]
    assert "passToken" not in chats[0][2]["headers"]["cookie"]
    assert len([item for item in chamadas if "/pass/serviceLogin" in item[1]]) == 2


def test_mimo_nao_envia_credencial_para_redirecionamento_estranho():
    class Cliente:
        async def get(self, url, **_kwargs):
            return httpx.Response(200, json={"code": 0, "location": "https://evil.test/sso", "nonce": 123,
                                           "ssecurity": "security"}, request=httpx.Request("GET", url))

    async def entrar():
        return await mimo_conta_koda._sessao(Cliente(), {"specific": {"mimoPassToken": "nova-chave"}})

    with pytest.raises(ProviderError, match="inválido"):
        asyncio.run(entrar())


@pytest.mark.parametrize("identificador,dominio", [
    ("qoder", "api3.qoder.sh"), ("qoder-cn", "gateway.qoder.com.cn"),
])
def test_qoder_assina_conversa_e_remonta_ferramentas(monkeypatch, identificador, dominio):
    pedidos = []

    class RespostaStream:
        status_code = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def aiter_lines(self):
            eventos = [
                {"choices": [{"delta": {"content": "Olá", "tool_calls": [
                    {"index": 0, "id": "c1", "function": {"name": "ler", "arguments": '{"id":'}}]}}]},
                {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": '2}'}}]},
                               "finish_reason": "tool_calls"}], "usage": {"prompt_tokens": 4, "completion_tokens": 5}},
            ]
            for evento in eventos:
                yield "data: " + json.dumps({"statusCodeValue": 200, "body": json.dumps(evento)})
            yield 'data: {"statusCodeValue":200,"body":"[DONE]"}'

    class Cliente:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, url, **kwargs):
            pedidos.append(("GET", url, kwargs))
            return httpx.Response(200, json={"chat": [{"key": "modelo", "source": "system", "max_output_tokens": 1000}]},
                                  request=httpx.Request("GET", url))

        def stream(self, metodo, url, **kwargs):
            pedidos.append((metodo, url, kwargs))
            return RespostaStream()

    monkeypatch.setattr(qoder_koda.httpx, "AsyncClient", Cliente)
    conta = {"access": "dt-teste", "specific": {"userId": "usuario", "machineId": "maquina"}}
    provedor = ContaProvider(SimpleNamespace(), identificador)
    monkeypatch.setattr(provedor, "_conta", lambda: conta)
    mensagens = [{"role": "system", "content": "Você é Koda"}, {"role": "user", "content": "oi"}]
    ferramentas = [{"type": "function", "function": {"name": "ler"}}]

    resultado = asyncio.run(provedor.step(mensagens, ferramentas, "modelo"))

    assert resultado.text == "Olá"
    assert resultado.calls[0].arguments == {"id": 2}
    assert resultado.usage == {"prompt_tokens": 4, "completion_tokens": 5}
    assert all(dominio in pedido[1] for pedido in pedidos)
    corpo_cifrado = pedidos[-1][2]["content"]
    corpo = json.loads(qoder_cosy.decodificar_corpo(corpo_cifrado.decode("ascii")))
    assert corpo["system"] == "Você é Koda"
    assert corpo["messages"] == mensagens[1:]
    assert corpo["tools"] == ferramentas
    assert pedidos[-1][2]["headers"]["Cosy-Bodyhash"] == hashlib.md5(corpo_cifrado).hexdigest()


def test_qoder_teste_de_modelo_sem_processo_externo(monkeypatch):
    chamadas = []

    async def linhas(identificador, conta, modelo, mensagens, ferramentas):
        chamadas.append((identificador, conta, modelo, mensagens, ferramentas))
        yield 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}'
        yield 'data: [DONE]'

    monkeypatch.setattr(qoder_koda, "linhas", linhas)
    resultado = provedores._chamar_modelo("qoder-cn", {"access": "dt-teste"}, "modelo")
    assert resultado == {"ok": True, "detalhe": "ok"}
    assert chamadas[0][0] == "qoder-cn"


def test_qoder_aguarda_fila_e_reenvia_com_novo_pedido(monkeypatch):
    pedidos = []
    respostas = iter([
        ["data: " + json.dumps({"statusCodeValue": 403, "body": json.dumps({"code": 10605, "isQueued": True})})],
        ["data: " + json.dumps({"statusCodeValue": 200, "body": json.dumps({"choices": [{
            "delta": {"content": "pronto"}, "finish_reason": "stop"}]})}), "data: [DONE]"],
    ])

    class RespostaStream:
        status_code = 200

        def __init__(self, linhas):
            self.linhas = linhas

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def aiter_lines(self):
            for linha in self.linhas:
                yield linha

    class Cliente:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, url, **kwargs):
            corpo = {"isQueued": False} if "/queue/status" in url else {"chat": [{"key": "modelo"}]}
            pedidos.append(("GET", url, kwargs))
            return httpx.Response(200, json=corpo, request=httpx.Request("GET", url))

        def stream(self, metodo, url, **kwargs):
            pedidos.append((metodo, url, kwargs))
            return RespostaStream(next(respostas))

    async def sem_espera(_segundos):
        return None

    monkeypatch.setattr(qoder_koda.httpx, "AsyncClient", Cliente)
    monkeypatch.setattr(qoder_koda.asyncio, "sleep", sem_espera)
    conta = {"access": "dt-teste", "specific": {"userId": "u", "machineId": "m"}}
    provedor = ContaProvider(SimpleNamespace(), "qoder")
    monkeypatch.setattr(provedor, "_conta", lambda: conta)
    resultado = asyncio.run(provedor.step([{"role": "user", "content": "oi"}], [], "modelo"))
    assert resultado.text == "pronto"
    chats = [item for item in pedidos if item[0] == "POST"]
    assert len(chats) == 2
    primeiro = json.loads(qoder_cosy.decodificar_corpo(chats[0][2]["content"].decode("ascii")))
    segundo = json.loads(qoder_cosy.decodificar_corpo(chats[1][2]["content"].decode("ascii")))
    assert primeiro["request_id"] != segundo["request_id"]
    assert any("/queue/status" in item[1] for item in pedidos)


def test_qoder_chave_pessoal_e_trocada_uma_vez(monkeypatch):
    trocas = []

    class Cliente:
        async def post(self, url, **kwargs):
            trocas.append((url, kwargs))
            return httpx.Response(200, json={"token": "job-teste", "expires_in": 3600},
                                  request=httpx.Request("POST", url))

        async def get(self, url, **_kwargs):
            return httpx.Response(200, json={"userId": "usuario"}, request=httpx.Request("GET", url))

    monkeypatch.setattr(qoder_koda, "_CACHE_PAT", {})

    async def executar():
        cliente = Cliente()
        conta = {"access": "pt-chave-teste"}
        a = await qoder_koda._credenciais(cliente, conta, "https://openapi.qoder.sh")
        b = await qoder_koda._credenciais(cliente, conta, "https://openapi.qoder.sh")
        return a, b

    primeira, segunda = asyncio.run(executar())
    assert primeira == segunda
    assert primeira["access"] == "job-teste" and primeira["uid"] == "usuario"
    assert len(trocas) == 1


def _quadro_aws(tipo, conteudo, *, message_type="event"):
    def campo(nome, valor):
        chave = nome.encode("utf-8")
        dados = valor.encode("utf-8")
        return bytes([len(chave)]) + chave + b"\x07" + len(dados).to_bytes(2, "big") + dados

    headers = campo(":message-type", message_type) + campo(":event-type", tipo)
    carga = json.dumps(conteudo, ensure_ascii=False).encode("utf-8")
    preambulo = struct.pack(">II", 16 + len(headers) + len(carga), len(headers))
    mensagem = preambulo + struct.pack(">I", zlib.crc32(preambulo) & 0xFFFFFFFF) + headers + carga
    return mensagem + struct.pack(">I", zlib.crc32(mensagem) & 0xFFFFFFFF)


def test_kiro_eventstream_fragmentado_verifica_crc_e_limite():
    quadro = _quadro_aws("assistantResponseEvent", {"content": "Olá"})
    leitor = kiro_koda.LeitorEventStream()
    eventos = []
    for inicio in range(0, len(quadro), 3):
        eventos.extend(leitor.receber(quadro[inicio:inicio + 3]))
    leitor.terminar()
    assert eventos[0][0][":event-type"] == "assistantResponseEvent"
    assert eventos[0][1]["content"] == "Olá"

    adulterado = bytearray(quadro)
    adulterado[-5] ^= 1
    with pytest.raises(ProviderError, match="corrompida"):
        kiro_koda.LeitorEventStream().receber(adulterado)
    with pytest.raises(ProviderError, match="tamanho"):
        kiro_koda.LeitorEventStream().receber(struct.pack(">III", kiro_koda.MAX_EVENTO + 1, 0, 0))


def test_kiro_conversa_binaria_e_ferramentas_sem_motor_antigo(monkeypatch):
    pedidos = []
    quadros = b"".join([
        _quadro_aws("assistantResponseEvent", {"content": "<think"}),
        _quadro_aws("assistantResponseEvent", {"content": "ing>pensei</think"}),
        _quadro_aws("assistantResponseEvent", {"content": "ing>resposta"}),
        _quadro_aws("toolUseEvent", {"name": "ler_arquivo", "toolUseId": "c1", "input": '{"arquivo":'}),
        _quadro_aws("toolUseEvent", {"name": "ler_arquivo", "toolUseId": "c1", "input": '"x"}'}),
        _quadro_aws("metricsEvent", {"inputTokens": 10, "outputTokens": 3}),
        _quadro_aws("messageStopEvent", {"stopReason": "tool_use"}),
    ])

    class Resposta:
        status_code = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def aiter_bytes(self):
            for inicio in range(0, len(quadros), 13):
                yield quadros[inicio:inicio + 13]

    class Cliente:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        def stream(self, metodo, url, **kwargs):
            pedidos.append((metodo, url, kwargs))
            return Resposta()

    monkeypatch.setattr(kiro_koda.httpx, "AsyncClient", Cliente)
    conta = {"access": "token", "specific": {"region": "us-east-1", "profileArn": "arn:teste"}}
    provedor = ContaProvider(SimpleNamespace(), "kiro")
    monkeypatch.setattr(provedor, "_conta", lambda: conta)
    mensagens = [{"role": "system", "content": "Você é Koda"}, {"role": "user", "content": "oi"}]
    ferramentas = [{"type": "function", "function": {"name": "ler.arquivo", "parameters": {
        "type": "object", "properties": {"arquivo": {"type": "string"}}, "required": ["arquivo"]}}}]
    resultado = asyncio.run(provedor.step(mensagens, ferramentas, "claude-sonnet-5-thinking"))

    assert resultado.text == "resposta"
    assert resultado.reasoning_content == "pensei"
    assert resultado.calls[0].name == "ler.arquivo"
    assert resultado.calls[0].arguments == {"arquivo": "x"}
    assert resultado.usage == {"prompt_tokens": 10, "completion_tokens": 3}
    corpo = pedidos[0][2]["json"]
    atual = corpo["conversationState"]["currentMessage"]["userInputMessage"]
    assert "Você é Koda" in atual["content"]
    assert atual["modelId"] == "claude-sonnet-5"
    assert atual["userInputMessageContext"]["tools"][0]["toolSpecification"]["name"] == "ler_arquivo"
    assert corpo["profileArn"] == "arn:teste"
    assert pedidos[0][2]["headers"]["x-amz-sso-bearer"] == "token"


def test_kiro_historico_pareia_ferramenta_e_resultado():
    mensagens = [
        {"role": "user", "content": "ler"},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "chamada", "function": {"name": "ler.arquivo", "arguments": '{"id":1}'}}]},
        {"role": "tool", "tool_call_id": "chamada", "content": "resultado"},
    ]
    ferramentas = [{"function": {"name": "ler.arquivo", "parameters": {"type": "object", "properties": {}}}}]
    corpo, nomes = kiro_koda._corpo("modelo", mensagens, ferramentas, {})
    historico = corpo["conversationState"]["history"]
    atual = corpo["conversationState"]["currentMessage"]["userInputMessage"]
    assert historico[1]["assistantResponseMessage"]["toolUses"][0]["name"] == "ler_arquivo"
    assert atual["userInputMessageContext"]["toolResults"][0]["toolUseId"] == "chamada"
    assert nomes["ler_arquivo"] == "ler.arquivo"


def test_kiro_teste_de_modelo_direto(monkeypatch):
    async def linhas(conta, modelo, mensagens, ferramentas):
        yield 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}'
        yield 'data: [DONE]'

    monkeypatch.setattr(kiro_koda, "linhas", linhas)
    assert provedores._chamar_modelo("kiro", {"access": "token"}, "modelo") == {"ok": True, "detalhe": "ok"}




def _quadro_grpc(flag, conteudo):
    return bytes([flag]) + len(conteudo).to_bytes(4, "big") + conteudo


def test_windsurf_grpc_web_e_modelo_sem_motor_antigo(monkeypatch):
    pedidos = []
    uso = b"\x08\x07\x10\x03"
    quadros = b"".join([
        _quadro_grpc(0, windsurf_koda._campo(1, windsurf_koda._campo(1, "Olá"))),
        _quadro_grpc(0, windsurf_koda._campo(3, windsurf_koda._campo(1, uso))),
        _quadro_grpc(128, b"grpc-status: 0\r\n"),
    ])

    class Resposta:
        status_code = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def aiter_bytes(self):
            for inicio in range(0, len(quadros), 2):
                yield quadros[inicio:inicio + 2]

    class Cliente:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        def stream(self, metodo, url, **kwargs):
            pedidos.append((metodo, url, kwargs))
            return Resposta()

    monkeypatch.setattr(windsurf_koda.httpx, "AsyncClient", Cliente)
    conta = {"access": "sk-ws-teste", "specific": {"apiServerUrl": "https://eu.windsurf.com/_route/api_server"}}
    provedor = ContaProvider(SimpleNamespace(), "windsurf")
    monkeypatch.setattr(provedor, "_conta", lambda: conta)
    resultado = asyncio.run(provedor.step([{"role": "user", "content": "oi"}], [], "swe-1.6"))

    assert resultado.text == "Olá"
    assert resultado.usage == {"prompt_tokens": 7, "completion_tokens": 3}
    assert pedidos[0][1] == "https://eu.windsurf.com/_route/api_server" + windsurf_koda.CAMINHO
    assert pedidos[0][2]["headers"]["authorization"] == "Bearer sk-ws-teste"
    enquadrado = pedidos[0][2]["content"]
    assert enquadrado[0] == 0 and int.from_bytes(enquadrado[1:5], "big") == len(enquadrado) - 5
    campos = list(windsurf_koda._campos(enquadrado[5:]))
    modelo = next(valor for numero, tipo, valor in campos if numero == 3 and tipo == 2)
    assert list(windsurf_koda._campos(modelo))[0][2] == b"swe-1-6"


def test_windsurf_recusa_quadro_incompleto_e_host_estranho():
    leitor = windsurf_koda.LeitorGrpcWeb()
    leitor.receber(b"\x00\x00\x00\x00\x04a")
    with pytest.raises(ProviderError, match="no meio"):
        leitor.terminar()
    with pytest.raises(ProviderError, match="inválido"):
        windsurf_koda._url({"specific": {"apiServerUrl": "https://windsurf.com.atacante.test"}})


def test_windsurf_erro_grpc_nao_e_sucesso(monkeypatch):
    class Resposta:
        status_code = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def aiter_bytes(self):
            yield _quadro_grpc(128, b"grpc-status: 7\r\ngrpc-message: acesso%20negado\r\n")

    class Cliente:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        def stream(self, *_args, **_kwargs):
            return Resposta()

    monkeypatch.setattr(windsurf_koda.httpx, "AsyncClient", Cliente)

    async def consumir():
        return [linha async for linha in windsurf_koda.linhas({"access": "token"}, "modelo", [{"role": "user", "content": "oi"}])]

    with pytest.raises(ProviderError, match="acesso negado"):
        asyncio.run(consumir())


@pytest.mark.parametrize("familia", ["anthropic", "open_ai", "google", "x_ai"])
def test_zed_modelos_conversa_e_ferramentas_por_familia(monkeypatch, familia):
    pedidos = []
    if familia == "anthropic":
        eventos = [
            {"type": "message_start", "message": {"usage": {"input_tokens": 5}}},
            {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "pensando"}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "sig"}},
            {"type": "content_block_stop", "index": 0},
            {"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "c1", "name": "ler", "input": {}}},
            {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": '{"id":1}'}},
            {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 3}},
        ]
    elif familia == "open_ai":
        eventos = [
            {"type": "response.output_item.added", "item": {"type": "function_call", "id": "fc1", "call_id": "c1", "name": "ler"}},
            {"type": "response.function_call_arguments.delta", "item_id": "fc1", "delta": '{"id":1}'},
            {"type": "response.completed", "response": {"usage": {"input_tokens": 5, "output_tokens": 3}}},
        ]
    elif familia == "google":
        eventos = [{"candidates": [{"content": {"parts": [{"functionCall": {"id": "c1", "name": "ler", "args": {"id": 1}},
                        "thoughtSignature": "sig"}]}, "finishReason": "STOP"}],
                    "usageMetadata": {"promptTokenCount": 5, "candidatesTokenCount": 3}}]
    else:
        eventos = [{"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1", "type": "function",
                    "function": {"name": "ler", "arguments": '{"id":1}'}}]}, "finish_reason": "tool_calls"}],
                    "usage": {"prompt_tokens": 5, "completion_tokens": 3}}]

    class RespostaStream:
        status_code = 200
        headers = {}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def aiter_lines(self):
            for evento in eventos:
                yield json.dumps({"event": evento})
            yield json.dumps({"status": "stream_ended"})

    class Cliente:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, url, **kwargs):
            pedidos.append(("GET", url, kwargs))
            dados = {"models": [{"id": "modelo", "provider": familia, "display_name": "Modelo"}]}
            return httpx.Response(200, json=dados, request=httpx.Request("GET", url))

        async def post(self, url, **kwargs):
            pedidos.append(("POST", url, kwargs))
            return httpx.Response(200, json={"token": "llm-temporario"}, request=httpx.Request("POST", url))

        def stream(self, metodo, url, **kwargs):
            pedidos.append((metodo, url, kwargs))
            return RespostaStream()

    monkeypatch.setattr(zed_koda, "_TOKEN_CACHE", {})
    monkeypatch.setattr(zed_koda, "_MODEL_CACHE", {})
    monkeypatch.setattr(zed_koda.httpx, "AsyncClient", Cliente)
    conta = {"access": "token-longo", "specific": {"userId": "usuario", "organizationId": "org"}}
    provedor = ContaProvider(SimpleNamespace(), "zed")
    monkeypatch.setattr(provedor, "_conta", lambda: conta)
    mensagens = [{"role": "system", "content": "Você é Koda"}, {"role": "user", "content": "oi"}]
    ferramentas = [{"type": "function", "function": {"name": "ler", "parameters": {"type": "object", "properties": {}}}}]
    resultado = asyncio.run(provedor.step(mensagens, ferramentas, "modelo"))

    assert resultado.calls[0].id == "c1"
    assert resultado.calls[0].arguments == {"id": 1}
    assert resultado.usage == {"prompt_tokens": 5, "completion_tokens": 3}
    requisicao = pedidos[-1][2]["json"]
    assert requisicao["provider"] == familia
    assert pedidos[-1][2]["headers"]["authorization"] == "Bearer llm-temporario"
    if familia == "anthropic":
        assert resultado.calls[0].extra["_koda_zed_thinking"][0]["signature"] == "sig"
        historico = mensagens + [{"role": "assistant", "content": "", "tool_calls": [resultado.calls[0].para_mensagem()]},
                                 {"role": "tool", "tool_call_id": "c1", "content": "resultado"}]
        corpo = zed_koda._anthropic("modelo", historico, ferramentas)
        assert corpo["messages"][-1]["content"][0]["is_error"] is False
        assert corpo["messages"][-2]["content"][0]["signature"] == "sig"
    if familia == "google":
        assert resultado.calls[0].extra["extra_content"]["google"]["thought_signature"] == "sig"
        historico = mensagens + [{"role": "assistant", "content": "", "tool_calls": [resultado.calls[0].para_mensagem()]},
                                 {"role": "tool", "tool_call_id": "c1", "content": "resultado"}]
        corpo = zed_koda._google(historico, ferramentas)
        assert corpo["contents"][-2]["parts"][0]["thoughtSignature"] == "sig"
        assert corpo["contents"][-1]["parts"][0]["functionResponse"]["id"] == "c1"


def test_zed_erro_do_servico_nao_vira_resposta_de_sucesso():
    conversor = zed_koda.Conversor("anthropic")
    with pytest.raises(ProviderError, match="recusado"):
        conversor.receber({"error": {"message": "recusado"}})


@pytest.mark.parametrize("identificador,dominio", [
    ("gemini-cli", "cloudcode-pa.googleapis.com"), ("antigravity", "daily-cloudcode-pa.googleapis.com"),
])
def test_google_conta_encontra_projeto_e_preserva_assinatura(monkeypatch, identificador, dominio):
    pedidos = []

    class Resposta:
        status_code = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def aiter_lines(self):
            evento = {"response": {"candidates": [{"content": {"parts": [
                {"text": "pensando", "thought": True},
                {"functionCall": {"id": "c1", "name": "ler", "args": {"id": 3}}, "thoughtSignature": "assinatura"},
            ]}, "finishReason": "STOP"}], "usageMetadata": {"promptTokenCount": 8, "candidatesTokenCount": 2}}}
            yield "data: " + json.dumps(evento)
            yield "data: [DONE]"

    class Cliente:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, **kwargs):
            pedidos.append(("POST", url, kwargs))
            return httpx.Response(200, json={"cloudaicompanionProject": {"id": "projeto-real"}},
                                  request=httpx.Request("POST", url))

        def stream(self, metodo, url, **kwargs):
            pedidos.append((metodo, url, kwargs))
            return Resposta()

    monkeypatch.setattr(google_conta_koda.httpx, "AsyncClient", Cliente)
    monkeypatch.setattr(google_conta_koda, "_PROJETOS", {})
    provedor = ContaProvider(SimpleNamespace(), identificador)
    monkeypatch.setattr(provedor, "_conta", lambda: {"access": "token"})
    mensagens = [{"role": "system", "content": "Você é Koda"}, {"role": "user", "content": "oi"}]
    ferramentas = [{"type": "function", "function": {"name": "ler", "parameters": {"type": "object", "properties": {}}}}]
    resultado = asyncio.run(provedor.step(mensagens, ferramentas, "modelo"))

    assert resultado.reasoning_content == "pensando"
    assert resultado.calls[0].arguments == {"id": 3}
    assert resultado.calls[0].extra["extra_content"]["google"]["thought_signature"] == "assinatura"
    assert dominio in pedidos[-1][1]
    corpo = pedidos[-1][2]["json"]
    assert corpo["project"] == "projeto-real"
    assert corpo["request"]["systemInstruction"]["parts"][0]["text"] == "Você é Koda"
    assert corpo["request"]["toolConfig"]["functionCallingConfig"]["mode"] == "VALIDATED"
    mensagens += [{"role": "assistant", "content": "", "tool_calls": [resultado.calls[0].para_mensagem()]},
                  {"role": "tool", "tool_call_id": "c1", "content": "resultado"}]
    proximo = google_conta_koda._corpo(identificador, "projeto-real", "modelo", mensagens, ferramentas)
    assert proximo["request"]["contents"][-2]["parts"][0]["thoughtSignature"] == "assinatura"


def test_google_nao_fabrica_projeto_da_conta():
    class Cliente:
        async def post(self, url, **_kwargs):
            return httpx.Response(200, json={}, request=httpx.Request("POST", url))

    async def consultar():
        return await google_conta_koda._projeto(Cliente(), "gemini-cli", {"access": "token-sem-projeto"})

    with pytest.raises(ProviderError, match="não devolveu um projeto"):
        asyncio.run(consultar())


def test_trae_sessao_e_resposta_incremental(monkeypatch):
    pedidos = []

    class Resposta:
        status_code = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def aiter_lines(self):
            yield "event: plan_item"
            yield 'data: {"id":"a","thought":"Oi"}'
            yield ""
            yield "event: plan_item"
            yield 'data: {"id":"a","thought":"Oi pessoa"}'
            yield ""
            yield "event: token_usage"
            yield 'data: {"prompt_tokens":5,"completion_tokens":3}'
            yield ""
            yield "event: done"
            yield "data: {}"

    class Cliente:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, **kwargs):
            pedidos.append(("POST", url, kwargs))
            return httpx.Response(200, json={"code": 0, "data": {"chat_session_id": "s/1", "message_id": "m 1"}})

        def stream(self, metodo, url, **kwargs):
            pedidos.append((metodo, url, kwargs))
            return Resposta()

    monkeypatch.setattr(trae_koda.httpx, "AsyncClient", Cliente)
    provedor = ContaProvider(SimpleNamespace(), "trae")
    monkeypatch.setattr(provedor, "_conta", lambda: {"access": "token"})
    mensagens = [{"role": "system", "content": "Você é Koda"}, {"role": "user", "content": "oi"}]
    resultado = asyncio.run(provedor.step(mensagens, [], "modelo"))

    assert resultado.text == "Oi pessoa"
    assert resultado.usage == {"prompt_tokens": 5, "completion_tokens": 3}
    assert pedidos[0][2]["headers"]["authorization"] == "Cloud-IDE-JWT token"
    assert "Você é Koda" in pedidos[0][2]["json"]["initial_message"]["query"]
    assert pedidos[0][2]["json"]["initial_message"]["model_selection_strategy"] == "manual"
    assert "s%2F1/events" in pedidos[1][1]
    assert pedidos[1][2]["params"]["reply_to_message_id"] == "m 1"


def test_trae_modelo_work_usa_selecao_automatica():
    corpo = trae_koda._corpo("work", [{"role": "user", "content": "oi"}], {})
    assert corpo["mode"] == "work"
    assert corpo["initial_message"]["model_name"] == ""
    assert corpo["initial_message"]["model_selection_strategy"] == "auto"






def test_gitlab_conversa_direta_e_chamada_de_ferramenta(monkeypatch):
    pedidos = []

    class Cliente:
        def __init__(self, **_kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *_args): return None
        async def post(self, url, **kwargs):
            pedidos.append((url, kwargs))
            import re
            nonce = re.search(r'"nonce":"([a-f0-9]{32})"', kwargs["json"]["content"]).group(1)
            return httpx.Response(200, json=f'<koda_tool>{{"name":"ler","arguments":{{"id":2}},"nonce":"{nonce}"}}</koda_tool>')

    monkeypatch.setattr(gitlab_koda.httpx, "AsyncClient", Cliente)
    provedor = ContaProvider(SimpleNamespace(), "gitlab")
    monkeypatch.setattr(provedor, "_conta", lambda: {"access": "token"})
    mensagens = [{"role": "system", "content": "Você é Koda"}, {"role": "user", "content": "oi"}]
    ferramentas = [{"type": "function", "function": {"name": "ler", "parameters": {"type": "object"}}}]
    resultado = asyncio.run(provedor.step(mensagens, ferramentas, "padrao"))
    assert resultado.calls[0].name == "ler" and resultado.calls[0].arguments == {"id": 2}
    assert pedidos[0][0] == "https://gitlab.com/api/v4/chat/completions"
    assert pedidos[0][1]["json"]["with_clean_history"] is True
    assert "Você é Koda" in pedidos[0][1]["json"]["content"]




def test_gitlab_tem_modelo_selecionavel():
    assert "gitlab-duo" in provedores.modelos("gitlab")["modelos"]


def test_cursor_conversa_simples_connect_fragmentado(monkeypatch):
    import gzip
    pedidos = []
    texto = windsurf_koda._campo(2, windsurf_koda._campo(1, "Olá mundo"))
    comprimido = gzip.compress(texto)
    quadro = b"\x01" + len(comprimido).to_bytes(4, "big") + comprimido
    fim = b"{}"
    quadro += b"\x02" + len(fim).to_bytes(4, "big") + fim

    class Resposta:
        status_code = 200
        async def __aenter__(self): return self
        async def __aexit__(self, *_args): return None
        async def aiter_bytes(self):
            yield quadro[:3]
            yield quadro[3:11]
            yield quadro[11:]

    class Cliente:
        def __init__(self, **_kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *_args): return None
        def stream(self, metodo, url, **kwargs):
            pedidos.append((metodo, url, kwargs))
            return Resposta()

    monkeypatch.setattr(cursor_koda.httpx, "AsyncClient", Cliente)
    provedor = ContaProvider(SimpleNamespace(), "cursor")
    monkeypatch.setattr(provedor, "_conta", lambda: {"access": "identidade::token"})
    mensagens = [{"role": "system", "content": "Você é Koda"}, {"role": "user", "content": "oi"}]
    resultado = asyncio.run(provedor.step(mensagens, [], "default"))
    assert resultado.text == "Olá mundo" and not resultado.truncado
    assert pedidos[0][1] == cursor_koda.URL
    assert pedidos[0][2]["headers"]["authorization"] == "Bearer token"
    assert b"Voc\xc3\xaa \xc3\xa9 Koda" in pedidos[0][2]["content"]
    assert b"default" in pedidos[0][2]["content"]


def test_cursor_rejeita_quadro_comprimido_invalido():
    with pytest.raises(ProviderError, match="comprimida inválida"):
        cursor_koda._descomprimir(b"nao e gzip")


def test_cursor_modo_agente_usa_canal_proprio(monkeypatch):
    from app import cursor_agent_koda
    conta = {"access": "prefixo::token", "specific": {}}
    async def linhas(*_args):
        yield 'data: {"choices":[{"index":0,"delta":{"content":"oi"},"finish_reason":null}]}'
        yield 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}'
        yield 'data: [DONE]'
    monkeypatch.setattr(cursor_agent_koda, "linhas", linhas)
    provedor = ContaProvider(SimpleNamespace(), "cursor")
    monkeypatch.setattr(provedor, "_conta", lambda: conta)
    ferramentas = [{"function": {"name": "ler"}}]
    resultado = asyncio.run(provedor.step([{"role": "user", "content": "oi"}], ferramentas, "default"))
    assert resultado.text == "oi"
    assert conta["specific"] == {}


def test_web_recusa_ferramenta_desconhecida_e_tags_com_texto():
    ferramentas = [{"function": {"name": "ler"}}]
    with pytest.raises(ProviderError, match="não disponível"):
        koda_tool_protocol._chamadas('<koda_tool>{"name":"outra","arguments":{},"nonce":"123"}</koda_tool>', ferramentas, "123")
    with pytest.raises(ProviderError, match="inválida"):
        koda_tool_protocol._chamadas('texto <koda_tool>{"name":"ler","arguments":{}}</koda_tool>', ferramentas, "123")
    with pytest.raises(ProviderError, match="não disponível"):
        koda_tool_protocol._chamadas('<koda_tool>{"name":"ler","arguments":{},"nonce":"errado"}</koda_tool>', ferramentas, "123")


