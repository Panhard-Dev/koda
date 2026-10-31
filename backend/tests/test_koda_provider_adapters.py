"""Contratos dos adaptadores de conta do Koda, sem rede nem credenciais reais."""

import asyncio
import base64
import json
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import httpx
import pytest


def test_iflow_troca_token_e_busca_chave_sem_motor_antigo(monkeypatch):
    from app import oauth_login
    from types import SimpleNamespace
    pedidos = []
    class Resposta:
        status_code = 200
        def __init__(self, dados): self.dados = dados
        def json(self): return self.dados
    class Cliente:
        def __init__(self, **_kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *_args): return None
        def post(self, url, **kwargs):
            pedidos.append((url, kwargs))
            return Resposta({"access_token": "token", "refresh_token": "renovar"})
        def get(self, url, **kwargs):
            pedidos.append((url, kwargs))
            return Resposta({"success": True, "data": {"apiKey": "chave", "email": "conta"}})
    monkeypatch.setattr(oauth_login.httpx, "Client", Cliente)
    fluxo = SimpleNamespace(config={"client_id": "id", "client_secret": "segredo", "token": "https://iflow.cn/token", "userinfo": "https://iflow.cn/user"}, redirect="http://localhost/callback")
    resultado = oauth_login._trocar_codigo_iflow(fluxo, "codigo")
    assert resultado["specific"]["apiKey"] == "chave" and resultado["refresh_token"] == "renovar"
    assert pedidos[0][1]["headers"]["authorization"].startswith("Basic ")
    assert pedidos[1][1]["params"] == {"accessToken": "token"}


@pytest.mark.parametrize("identificador", ["gemini-cli", "antigravity"])
def test_google_usa_fluxo_proprio_quando_cliente_configurado(monkeypatch, identificador):
    from app import oauth_login
    from types import SimpleNamespace
    config = {"tipo": "pkce", "client_id": "cliente", "authorize": "https://accounts.google.com", "token": "https://oauth2.googleapis.com"}
    monkeypatch.setitem(oauth_login.FLUXOS, identificador, config)
    monkeypatch.setattr(oauth_login, "_vivos", {})
    monkeypatch.setattr(oauth_login, "_iniciar_pkce", lambda fluxo: {"tipo": "pkce", "id": fluxo.id})
    assert oauth_login.iniciar(SimpleNamespace(), identificador)["id"] == identificador


@pytest.mark.parametrize("existente", [True, False])
def test_glm_recupera_chave_do_plano(existente):
    from app import glm_login_koda
    pedidos = []
    class Resposta:
        status_code = 200
        def __init__(self, dado): self.dado = dado
        def json(self): return {"code": 200, "data": self.dado}
    class Cliente:
        def post(self, url, **kw):
            pedidos.append(("POST", url))
            return Resposta({"access_token": "biz"} if url.endswith("/login") else {"apiKey": "chave"})
        def get(self, url, **kw):
            pedidos.append(("GET", url))
            if url.endswith("getCustomerInfo"):
                return Resposta({"organizations": [{"organizationId": "org", "projects": [{"projectId": "projeto"}]}]})
            if "/copy/" in url:
                return Resposta({"secretKey": "segredo"})
            return Resposta([{"name": "zcode-api-key", "apiKey": "chave"}] if existente else [])
    config = {"business_login": "https://api.z.ai/login", "api": "https://api.z.ai", "key_name": "zcode-api-key"}
    assert glm_login_koda.chave_do_plano(Cliente(), config, "token") == ("chave.segredo", "biz")
    assert sum(metodo == "POST" and url.endswith("/api_keys") for metodo, url in pedidos) == (0 if existente else 1)


def test_zed_descriptografa_retorno_da_sessao():
    import base64
    from types import SimpleNamespace
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding, rsa
    from app import oauth_login
    chave = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    cifrado = chave.public_key().encrypt(b"token-zed", padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
    credencial = base64.urlsafe_b64encode(cifrado).decode().rstrip("=")
    fluxo = SimpleNamespace(extra={"zed_private_key": chave, "zed_system_id": "sistema"})
    resultado = oauth_login._trocar_codigo_zed(fluxo, f"/?user_id=42&access_token={credencial}")
    assert resultado["access_token"] == "token-zed"
    assert resultado["specific"]["userId"] == "42"
    assert "zed_private_key" not in fluxo.extra


@pytest.mark.parametrize("identificador", ["gemini-cli", "antigravity"])
def test_google_sem_cliente_explicita_configuracao_sem_motor_antigo(monkeypatch, identificador):
    from app import oauth_login
    from types import SimpleNamespace
    monkeypatch.setitem(oauth_login.FLUXOS, identificador, {"client_id": ""})
    resposta = oauth_login.iniciar(SimpleNamespace(), identificador)
    assert resposta["tipo"] == "nada" and "CLIENT_ID" in resposta["mensagem"]


def test_mimo_aceita_chave_api_sem_motor_antigo(monkeypatch):
    from app import oauth_login
    from types import SimpleNamespace
    monkeypatch.setattr(oauth_login, "_vivos", {})
    resultado = oauth_login.iniciar(SimpleNamespace(), "xiaomi-mimo")
    assert resultado["tipo"] == "cookie" and "API" in resultado["mensagem"]


def test_trae_troca_retorno_em_endpoint_configurado(monkeypatch):
    from app import oauth_login
    from types import SimpleNamespace
    pedidos = []
    class Resposta:
        status_code = 200
        def json(self): return {"Result": {"AccessToken": "access", "RefreshToken": "novo"}}
    class Cliente:
        def __init__(self, **_kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *_args): return None
        def post(self, url, **kwargs):
            pedidos.append((url, kwargs))
            return Resposta()
    monkeypatch.setattr(oauth_login.httpx, "Client", Cliente)
    fluxo = SimpleNamespace(config={"exchange_path": "/cloudide/exchange"})
    resultado = oauth_login._trocar_codigo_trae(fluxo, "/callback?refreshToken=renovar&token=cloud")
    assert resultado["access_token"] == "access" and resultado["refresh_token"] == "novo"
    assert pedidos[0][0] == "https://api.marscode.com/cloudide/exchange"
    assert pedidos[0][1]["headers"]["x-cloudide-token"] == "cloud"


def test_trae_aceita_token_quando_o_endpoint_nao_esta_configurado(monkeypatch):
    from app import oauth_login
    from types import SimpleNamespace
    monkeypatch.delitem(oauth_login.FLUXOS, "trae", raising=False)
    monkeypatch.setattr(oauth_login, "_vivos", {})
    resposta = oauth_login.iniciar(SimpleNamespace(), "trae")
    assert resposta["tipo"] == "cookie" and "token" in resposta["mensagem"]


def test_trae_usa_fluxo_nativo_quando_endpoint_configurado(monkeypatch):
    from app import oauth_login
    from types import SimpleNamespace
    monkeypatch.setitem(oauth_login.FLUXOS, "trae", {"tipo": "trae", "exchange_path": "/exchange"})
    monkeypatch.setattr(oauth_login, "_vivos", {})
    monkeypatch.setattr(oauth_login, "_iniciar_trae", lambda fluxo: {"tipo": "pkce", "id": fluxo.id})
    assert oauth_login.iniciar(SimpleNamespace(), "trae")["id"] == "trae"

from app import koda_headers, oauth_login, provedores
from app.providers.base import ChatOptions, ChatTurn, ProviderError
from app.providers.conta import ContaProvider


class ClienteSimulado:
    def __init__(self, respostas):
        self.respostas = iter(respostas)
        self.pedidos = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def _responder(self, metodo, url, **kwargs):
        self.pedidos.append((metodo, url, kwargs))
        status, corpo = next(self.respostas)
        return httpx.Response(status, json=corpo, request=httpx.Request(metodo, url))

    def post(self, url, **kwargs):
        return self._responder("POST", url, **kwargs)

    def get(self, url, **kwargs):
        return self._responder("GET", url, **kwargs)


class ThreadImediata:
    def __init__(self, target, **_kwargs):
        self.target = target

    def start(self):
        self.target()


@pytest.mark.parametrize("identificador,metodo", [
    ("github", "_iniciar_device"), ("kiro", "_iniciar_aws_sso"),
    ("minimax-code", "_iniciar_device"), ("minimax-code-global", "_iniciar_device"),
    ("kimi", "_iniciar_device"),
    ("qoder", "_iniciar_qoder"), ("qoder-cn", "_iniciar_qoder"),
    ("grok-cli", "_iniciar_device"),
    ("nous", "_iniciar_device"),
    ("xai", "_iniciar_pkce"),
    ("cline", "_iniciar_cline"), ("clinepass", "_iniciar_cline"),
    ("muse", "_iniciar_device"),
    ("kilocode", "_iniciar_kilo"),
    ("kimchi", "_iniciar_kimchi"),
    ("codebuddy-cn", "_iniciar_codebuddy"), ("codebuddy-intl", "_iniciar_codebuddy"),
    ("windsurf", "_iniciar_windsurf"),
])
def test_login_escolhe_implementacao_nativa(monkeypatch, identificador, metodo):
    monkeypatch.setattr(oauth_login, "_vivos", {})
    monkeypatch.setattr(subprocess, "run", lambda *_args, **_kwargs: pytest.fail("processo externo chamado"))
    monkeypatch.setattr(oauth_login, metodo, lambda fluxo: {"id": fluxo.id, "tipo": fluxo.config["tipo"]})

    resultado = oauth_login.iniciar(SimpleNamespace(), identificador)

    assert resultado["id"] == identificador
    esperado = ("aws_sso" if identificador == "kiro" else "qoder" if identificador.startswith("qoder")
                else "pkce" if identificador == "xai" else "cline" if identificador.startswith("cline")
                else "kilo" if identificador == "kilocode" else "kimchi" if identificador == "kimchi"
                else "codebuddy" if identificador.startswith("codebuddy-")
                else "windsurf" if identificador == "windsurf" else "device")
    assert resultado["tipo"] == esperado


@pytest.mark.parametrize("identificador,dominio", [("codebuddy-cn", "copilot.tencent.com"), ("codebuddy-intl", "www.codebuddy.ai")])
def test_codebuddy_login_e_renovacao(monkeypatch, identificador, dominio):
    cliente = ClienteSimulado([
        (200, {"code": 0, "data": {"state": "estado /+", "authUrl": "https://example.test/login"}}),
        (200, {"code": 11217}),
        (200, {"code": 0, "data": {"accessToken": "acesso", "refreshToken": "renovar", "expiresIn": 3600}}),
        (200, {"code": 0, "data": {"accessToken": "novo", "refreshToken": "novo-refresh", "expiresIn": 7200}}),
    ])
    concluidos = []
    monkeypatch.setattr(oauth_login.httpx, "Client", lambda **_kwargs: cliente)
    monkeypatch.setattr(oauth_login.threading, "Thread", ThreadImediata)
    monkeypatch.setattr(oauth_login.time, "sleep", lambda _s: None)
    monkeypatch.setattr(oauth_login, "_concluir", lambda _fluxo, dados: concluidos.append(dados))
    fluxo = oauth_login._Fluxo(identificador, oauth_login.FLUXOS[identificador], SimpleNamespace())

    inicio = oauth_login._iniciar_codebuddy(fluxo)
    renovado = oauth_login._renovar(identificador, {"refresh": "renovar"})

    assert inicio["url"] == "https://example.test/login"
    assert concluidos == [{"access_token": "acesso", "refresh_token": "renovar", "expires_in": 3600}]
    assert cliente.pedidos[0][2]["headers"]["x-domain"] == dominio
    assert cliente.pedidos[1][2]["params"]["state"] == "estado /+"
    assert cliente.pedidos[-1][2]["headers"]["x-refresh-token"] == "renovar"
    assert renovado["access"] == "novo" and renovado["refresh"] == "novo-refresh"


def test_codebuddy_recusa_resposta_invalida(monkeypatch):
    cliente = ClienteSimulado([(200, [])])
    monkeypatch.setattr(oauth_login.httpx, "Client", lambda **_kwargs: cliente)
    fluxo = oauth_login._Fluxo("codebuddy-cn", oauth_login.FLUXOS["codebuddy-cn"], SimpleNamespace())

    assert oauth_login._iniciar_codebuddy(fluxo)["estado"] == "erro"


def test_windsurf_callback_e_registro_da_conta(monkeypatch):
    class ServidorSimulado:
        def __init__(self, _endereco, _handler):
            self.server_address = ("127.0.0.1", 31337)

        def serve_forever(self):
            return None

    cliente = ClienteSimulado([(200, {"apiKey": "sk-ws-teste", "apiServerUrl": "https://eu.windsurf.com/_route/api_server"})])
    monkeypatch.setattr(oauth_login, "ThreadingHTTPServer", ServidorSimulado)
    monkeypatch.setattr(oauth_login.threading, "Thread", ThreadImediata)
    monkeypatch.setattr(oauth_login.httpx, "Client", lambda **_kwargs: cliente)
    fluxo = oauth_login._Fluxo("windsurf", oauth_login.FLUXOS["windsurf"], SimpleNamespace())

    inicio = oauth_login._iniciar_windsurf(fluxo)
    dado = oauth_login._trocar_codigo(fluxo, "token-de-sessao")

    parametros = parse_qs(urlparse(inicio["url"]).query)
    assert parametros["state"] == [fluxo.state]
    assert parametros["redirect_uri"] == [fluxo.redirect]
    assert dado["access_token"] == "sk-ws-teste"
    assert dado["specific"]["apiServerUrl"] == "https://eu.windsurf.com/_route/api_server"
    assert cliente.pedidos[0][2]["json"] == {"firebase_id_token": "token-de-sessao"}


def test_windsurf_recusa_servidor_estranho(monkeypatch):
    cliente = ClienteSimulado([(200, {"apiKey": "sk-ws-teste", "apiServerUrl": "https://evil.test"})])
    monkeypatch.setattr(oauth_login.httpx, "Client", lambda **_kwargs: cliente)
    fluxo = oauth_login._Fluxo("windsurf", oauth_login.FLUXOS["windsurf"], SimpleNamespace())
    with pytest.raises(RuntimeError, match="endereço"):
        oauth_login._trocar_codigo(fluxo, "token-de-sessao")
    assert oauth_login._trocar_codigo(fluxo, "sk-ws-existente")["access_token"] == "sk-ws-existente"


@pytest.mark.parametrize("identificador", [
    "cursor",
])
def test_sessao_web_recebe_credencial_sem_motor_externo(monkeypatch, identificador):
    gravados = []
    monkeypatch.setattr(oauth_login, "_vivos", {})
    monkeypatch.setattr(subprocess, "run", lambda *_args, **_kwargs: pytest.fail("processo externo chamado"))
    monkeypatch.setattr(oauth_login, "_gravar", lambda _settings, _id, dado: gravados.append(dado))
    settings = SimpleNamespace()

    inicio = oauth_login.iniciar(settings, identificador)
    resultado = oauth_login.concluir_com_texto(settings, identificador, "token-teste")

    assert inicio["tipo"] == "cookie"
    assert resultado["ok"]
    assert gravados[0]["access"] == "token-teste"
    assert gravados[0]["specific"]["apiKey"] == "token-teste"


def test_device_flow_respeita_slow_down(monkeypatch):
    cliente = ClienteSimulado([
        (200, {"device_code": "device", "user_code": "A-B", "verification_uri": "https://example.test/device", "interval": 5}),
        (400, {"error": "slow_down"}),
        (400, {"error": "authorization_pending"}),
        (200, {"access_token": "token-de-teste"}),
    ])
    pausas = []
    concluidos = []
    monkeypatch.setattr(oauth_login.httpx, "Client", lambda **_kwargs: cliente)
    monkeypatch.setattr(oauth_login.threading, "Thread", ThreadImediata)
    monkeypatch.setattr(oauth_login.time, "sleep", pausas.append)
    monkeypatch.setattr(oauth_login, "_concluir", lambda fluxo, dado: concluidos.append(dado))
    fluxo = oauth_login._Fluxo("github", oauth_login.FLUXOS["github"], SimpleNamespace())

    resultado = oauth_login._iniciar_device(fluxo)

    assert resultado["url"] == "https://example.test/device"
    assert pausas == [5, 10, 10]
    assert concluidos == [{"access_token": "token-de-teste"}]
    assert all(pedido[2]["data"].get("device_code") == "device" for pedido in cliente.pedidos[1:])


def test_xai_pkce_usa_callback_e_identidade_do_koda(monkeypatch):
    class ServidorSimulado:
        def __init__(self, endereco, _handler):
            self.server_address = endereco

        def serve_forever(self):
            return None

    monkeypatch.setattr(oauth_login, "ThreadingHTTPServer", ServidorSimulado)
    monkeypatch.setattr(oauth_login.threading, "Thread", ThreadImediata)
    fluxo = oauth_login._Fluxo("xai", oauth_login.FLUXOS["xai"], SimpleNamespace())

    resultado = oauth_login._iniciar_pkce(fluxo)

    params = parse_qs(urlparse(resultado["url"]).query)
    assert resultado["tipo"] == "pkce"
    assert params["redirect_uri"] == ["http://127.0.0.1:56121/callback"]
    assert params["code_challenge"] == [oauth_login._challenge(fluxo.verifier)]
    assert params["state"] == [fluxo.state]
    assert params["referrer"] == ["koda"]
    assert params["nonce"]


def test_xai_troca_codigo_com_verificador_original(monkeypatch):
    cliente = ClienteSimulado([(200, {"access_token": "acesso"})])
    monkeypatch.setattr(oauth_login.httpx, "Client", lambda **_kwargs: cliente)
    fluxo = oauth_login._Fluxo("xai", oauth_login.FLUXOS["xai"], SimpleNamespace())
    fluxo.redirect = "http://127.0.0.1:56121/callback"

    resultado = oauth_login._trocar_codigo(fluxo, "codigo")

    assert resultado["access_token"] == "acesso"
    assert cliente.pedidos[0][2]["data"]["code"] == "codigo"
    assert cliente.pedidos[0][2]["data"]["code_verifier"] == fluxo.verifier
    assert cliente.pedidos[0][2]["data"]["redirect_uri"] == fluxo.redirect


@pytest.mark.parametrize("identificador", ["cline", "clinepass"])
def test_cline_abre_callback_exclusivo_e_le_credencial_codificada(monkeypatch, identificador):
    class ServidorSimulado:
        def __init__(self, _endereco, _handler):
            self.server_address = ("127.0.0.1", 31337)

        def serve_forever(self):
            return None

    monkeypatch.setattr(oauth_login, "ThreadingHTTPServer", ServidorSimulado)
    monkeypatch.setattr(oauth_login.threading, "Thread", ThreadImediata)
    fluxo = oauth_login._Fluxo(identificador, oauth_login.FLUXOS[identificador], SimpleNamespace())
    inicio = oauth_login._iniciar_cline(fluxo)
    dados = {"accessToken": "acesso", "refreshToken": "renovacao", "email": "teste@example.test"}
    codigo = base64.urlsafe_b64encode(json.dumps(dados).encode()).decode().rstrip("=")

    resultado = oauth_login._trocar_codigo(fluxo, codigo)

    parametros = parse_qs(urlparse(inicio["url"]).query)
    assert fluxo.config["caminho"].startswith("/callback/")
    assert parametros["callback_url"] == [fluxo.redirect]
    assert parametros["redirect_uri"] == [fluxo.redirect]
    assert resultado["access_token"] == "acesso"
    assert resultado["refresh_token"] == "renovacao"
    assert resultado["email"] == "teste@example.test"


def test_cline_troca_codigo_quando_nao_e_credencial_codificada(monkeypatch):
    cliente = ClienteSimulado([(200, {"data": {"accessToken": "acesso", "userInfo": {"email": "teste@example.test"}}})])
    monkeypatch.setattr(oauth_login.httpx, "Client", lambda **_kwargs: cliente)
    fluxo = oauth_login._Fluxo("cline", oauth_login.FLUXOS["cline"], SimpleNamespace())
    fluxo.redirect = "http://localhost:31337/callback/segredo"

    resultado = oauth_login._trocar_codigo(fluxo, "codigo-opaco")

    assert resultado["access_token"] == "acesso"
    assert resultado["email"] == "teste@example.test"
    assert cliente.pedidos[0][2]["json"]["code"] == "codigo-opaco"
    assert cliente.pedidos[0][2]["json"]["redirect_uri"] == fluxo.redirect


@pytest.mark.parametrize("identificador", ["cline", "clinepass"])
def test_cline_renova_token_de_conta(monkeypatch, identificador):
    cliente = ClienteSimulado([(200, {"data": {
        "accessToken": "novo", "refreshToken": "renovado", "expiresAt": "2099-01-01T00:00:00Z",
    }})])
    monkeypatch.setattr(oauth_login.httpx, "Client", lambda **_kwargs: cliente)

    resultado = oauth_login._renovar(identificador, {"refresh": "antigo"})

    assert resultado["access"] == "novo"
    assert resultado["refresh"] == "renovado"
    assert resultado["expiraEm"].startswith("2099-01-01")
    assert cliente.pedidos[0][2]["json"]["refreshToken"] == "antigo"
    assert cliente.pedidos[0][2]["json"]["grantType"] == "refresh_token"


@pytest.mark.parametrize("identificador", ["cline", "clinepass"])
def test_cline_resposta_em_envelope_e_chamada_de_ferramenta(monkeypatch, identificador):
    conta = {"access": "sessao"}
    pedidos = []

    class ClienteAsync:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, **kwargs):
            pedidos.append((url, kwargs))
            return httpx.Response(200, json={"data": {"choices": [{"message": {
                "content": "ok", "tool_calls": [{"id": "t1", "function": {"name": "ler", "arguments": '{}'}}],
            }}]}})

    provedor = ContaProvider(SimpleNamespace(), identificador)
    monkeypatch.setattr(provedor, "_conta", lambda: conta)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **_kwargs: ClienteAsync())
    resultado = asyncio.run(provedor.step([{"role": "user", "content": "oi"}], [], "cline-pass/modelo"))

    assert resultado.text == "ok"
    assert resultado.calls[0].name == "ler"
    assert pedidos[0][1]["headers"]["authorization"] == "Bearer workos:sessao"
    assert pedidos[0][1]["headers"]["X-Title"] == "Koda"
    assert koda_headers.cline({"access": "ignorar", "specific": {"apiKey": "chave"}})["authorization"] == "Bearer chave"


def test_cline_teste_de_modelo_entende_envelope(monkeypatch):
    cliente = ClienteSimulado([(200, {"data": {"choices": [{"message": {"content": "ok"}}]}})])
    monkeypatch.setattr(provedores.httpx, "Client", lambda **_kwargs: cliente)

    resultado = provedores._chamar_modelo("clinepass", {"access": "sessao"}, "cline-pass/modelo")

    assert resultado == {"ok": True, "detalhe": "ok"}
    assert cliente.pedidos[0][2]["headers"]["authorization"] == "Bearer workos:sessao"


def test_kimchi_callback_usa_estado_e_valida_token(monkeypatch):
    class ServidorSimulado:
        def __init__(self, _endereco, _handler):
            self.server_address = ("127.0.0.1", 31337)

        def serve_forever(self):
            return None

    cliente = ClienteSimulado([
        (200, {}), (200, {"id": "42", "email": "teste@example.test", "username": "pessoa"}),
    ])
    monkeypatch.setattr(oauth_login, "ThreadingHTTPServer", ServidorSimulado)
    monkeypatch.setattr(oauth_login.threading, "Thread", ThreadImediata)
    monkeypatch.setattr(oauth_login.httpx, "Client", lambda **_kwargs: cliente)
    fluxo = oauth_login._Fluxo("kimchi", oauth_login.FLUXOS["kimchi"], SimpleNamespace())
    inicio = oauth_login._iniciar_kimchi(fluxo)

    resultado = oauth_login._trocar_codigo(fluxo, "token-teste")

    parametros = parse_qs(urlparse(inicio["url"]).query)
    assert parametros["state"] == [fluxo.state]
    assert parametros["callback"] == [fluxo.redirect]
    assert fluxo.config["verificar_state"] is True
    assert resultado["access_token"] == "token-teste"
    assert resultado["email"] == "teste@example.test"
    assert cliente.pedidos[0][2]["headers"]["authorization"] == "Bearer token-teste"
    assert oauth_login._extrair_codigo(f"{fluxo.redirect}?token=token-teste&state={fluxo.state}") == ("token-teste", fluxo.state)


def test_kimchi_recusa_credencial_invalida(monkeypatch):
    cliente = ClienteSimulado([(401, {})])
    monkeypatch.setattr(oauth_login.httpx, "Client", lambda **_kwargs: cliente)
    fluxo = oauth_login._Fluxo("kimchi", oauth_login.FLUXOS["kimchi"], SimpleNamespace())

    with pytest.raises(RuntimeError, match="validar"):
        oauth_login._trocar_codigo(fluxo, "invalido")


def test_device_flow_recusa_resposta_incompleta(monkeypatch):
    cliente = ClienteSimulado([(200, {"verification_uri": "https://example.test/device"})])
    monkeypatch.setattr(oauth_login.httpx, "Client", lambda **_kwargs: cliente)
    monkeypatch.setattr(oauth_login.threading, "Thread", lambda **_kwargs: pytest.fail("não deve iniciar polling"))
    fluxo = oauth_login._Fluxo("github", oauth_login.FLUXOS["github"], SimpleNamespace())

    resultado = oauth_login._iniciar_device(fluxo)

    assert resultado["estado"] == "erro"
    assert fluxo.estado == "erro"


def test_minimax_device_pkce_aceita_poll_por_codigo(monkeypatch):
    cliente = ClienteSimulado([
        (200, {"user_code": "ABCD", "verification_url": "https://example.test/login", "interval": 5000}),
        (200, {"status": "pending"}),
        (200, {"access_token": "acesso", "refresh_token": "renovacao"}),
    ])
    pausas = []
    concluidos = []
    monkeypatch.setattr(oauth_login.httpx, "Client", lambda **_kwargs: cliente)
    monkeypatch.setattr(oauth_login.threading, "Thread", ThreadImediata)
    monkeypatch.setattr(oauth_login.time, "sleep", pausas.append)
    monkeypatch.setattr(oauth_login, "_concluir", lambda fluxo, dado: concluidos.append(dado))
    fluxo = oauth_login._Fluxo("minimax-code-global", oauth_login.FLUXOS["minimax-code-global"], SimpleNamespace())

    resultado = oauth_login._iniciar_device(fluxo)

    primeiro = cliente.pedidos[0][2]["data"]
    consulta = cliente.pedidos[1][2]["data"]
    assert resultado["codigo"] == "ABCD"
    assert primeiro["code_challenge"] == oauth_login._challenge(fluxo.verifier)
    assert primeiro["code_challenge_method"] == "S256"
    assert consulta["user_code"] == "ABCD"
    assert "device_code" not in consulta
    assert consulta["code_verifier"] == fluxo.verifier
    assert pausas == [5, 5]
    assert concluidos[0]["access_token"] == "acesso"


def test_cancelamento_impede_nova_consulta(monkeypatch):
    cliente = ClienteSimulado([(200, {"device_code": "device", "user_code": "A-B", "verification_uri": "https://example.test/"})])
    fluxo = oauth_login._Fluxo("github", oauth_login.FLUXOS["github"], SimpleNamespace())
    monkeypatch.setattr(oauth_login, "_vivos", {"github": fluxo})
    monkeypatch.setattr(oauth_login.httpx, "Client", lambda **_kwargs: cliente)
    monkeypatch.setattr(oauth_login.threading, "Thread", ThreadImediata)
    monkeypatch.setattr(oauth_login.time, "sleep", lambda _segundos: oauth_login.cancelar("github"))

    oauth_login._iniciar_device(fluxo)

    assert fluxo.estado == "cancelado"
    assert len(cliente.pedidos) == 1


def test_kimi_login_usa_a_mesma_identidade_em_todos_os_pedidos(monkeypatch):
    cliente = ClienteSimulado([
        (200, {"device_code": "device", "user_code": "ABCD", "interval": 5}),
        (200, {"access_token": "acesso", "refresh_token": "renovacao"}),
    ])
    concluidos = []
    monkeypatch.setattr(oauth_login.httpx, "Client", lambda **_kwargs: cliente)
    monkeypatch.setattr(oauth_login.threading, "Thread", ThreadImediata)
    monkeypatch.setattr(oauth_login.time, "sleep", lambda _segundos: None)
    monkeypatch.setattr(oauth_login, "_concluir", lambda fluxo, dado: concluidos.append(dado))
    fluxo = oauth_login._Fluxo("kimi", oauth_login.FLUXOS["kimi"], SimpleNamespace())

    resultado = oauth_login._iniciar_device(fluxo)

    dispositivo = concluidos[0]["specific"]["deviceId"]
    assert resultado["url"].endswith("?user_code=ABCD")
    assert all(pedido[2]["headers"]["X-Msh-Device-Id"] == dispositivo for pedido in cliente.pedidos)
    assert all(pedido[2]["headers"]["X-Msh-Platform"] == "koda" for pedido in cliente.pedidos)


def test_muse_troca_autorizacao_por_credencial_de_uso(monkeypatch):
    cliente = ClienteSimulado([
        (200, {"device_code": "device", "user_code": "ABCD", "verification_uri": "https://example.test/"}),
        (200, {"access_token": "identidade"}),
        (200, {"api_key": "chave-modelo", "user_email": "teste@example.test", "is_subs_active": True}),
    ])
    gravados = []
    monkeypatch.setattr(oauth_login.httpx, "Client", lambda **_kwargs: cliente)
    monkeypatch.setattr(oauth_login.threading, "Thread", ThreadImediata)
    monkeypatch.setattr(oauth_login.time, "sleep", lambda _segundos: None)
    monkeypatch.setattr(oauth_login, "_gravar", lambda _settings, _id, dado: gravados.append(dado))
    fluxo = oauth_login._Fluxo("muse", oauth_login.FLUXOS["muse"], SimpleNamespace())

    oauth_login._iniciar_device(fluxo)

    assert fluxo.estado == "concluido"
    assert gravados[0]["access"] == "chave-modelo"
    assert gravados[0]["specific"]["oauthAccessToken"] == "identidade"
    assert cliente.pedidos[2][1] == "https://api.meta.ai/muse-code/key"
    assert cliente.pedidos[2][2]["headers"]["authorization"] == "Bearer identidade"
    assert all(pedido[2]["headers"]["x-api-version"] == "1.0.0" for pedido in cliente.pedidos)


def test_muse_nao_salva_conta_sem_credencial_de_uso(monkeypatch):
    cliente = ClienteSimulado([(200, {"is_subs_active": False})])
    monkeypatch.setattr(oauth_login.httpx, "Client", lambda **_kwargs: cliente)
    monkeypatch.setattr(oauth_login, "_gravar", lambda *_args: pytest.fail("conta não deveria ser salva"))
    fluxo = oauth_login._Fluxo("muse", oauth_login.FLUXOS["muse"], SimpleNamespace())

    oauth_login._concluir_muse(fluxo, "identidade")

    assert fluxo.estado == "erro"


def test_kilo_login_guarda_organizacao_e_escapa_codigo(monkeypatch):
    cliente = ClienteSimulado([
        (200, {"code": "A/B", "verificationUrl": "https://example.test/device"}),
        (202, {}),
        (200, {"status": "approved", "token": "acesso", "userEmail": "teste@example.test"}),
        (200, {"organizations": [{"id": "org-1"}]}),
    ])
    gravados = []
    monkeypatch.setattr(oauth_login.httpx, "Client", lambda **_kwargs: cliente)
    monkeypatch.setattr(oauth_login.threading, "Thread", ThreadImediata)
    monkeypatch.setattr(oauth_login.time, "sleep", lambda _segundos: None)
    monkeypatch.setattr(oauth_login, "_gravar", lambda _settings, _id, dado: gravados.append(dado))
    fluxo = oauth_login._Fluxo("kilocode", oauth_login.FLUXOS["kilocode"], SimpleNamespace())

    resultado = oauth_login._iniciar_kilo(fluxo)

    assert resultado["codigo"] == "A/B"
    assert fluxo.estado == "concluido"
    assert "%2F" in cliente.pedidos[1][1]
    assert gravados[0]["access"] == "acesso"
    assert gravados[0]["specific"]["orgId"] == "org-1"


def test_kilo_lista_modelos_e_preserva_organizacao(monkeypatch):
    conta = {"access": "teste", "specific": {"orgId": "org-1"}}
    cliente = ClienteSimulado([(200, {"data": [{"id": "modelo", "name": "Modelo"}]})])
    monkeypatch.setattr(oauth_login, "garantir", lambda *_args: conta)
    monkeypatch.setattr(provedores.httpx, "Client", lambda **_kwargs: cliente)

    resultado = provedores._ao_vivo("kilocode", SimpleNamespace())

    assert resultado["modelos"] == ["modelo"]
    assert resultado["nomes"] == {"modelo": "Modelo"}
    assert cliente.pedidos[0][2]["headers"]["X-KiloCode-OrganizationId"] == "org-1"


def test_kilo_step_usa_gateway_direto(monkeypatch):
    conta = {"access": "teste", "specific": {"orgId": "org-1"}}
    pedidos = []

    class ClienteAsync:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, **kwargs):
            pedidos.append((url, kwargs))
            return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    provedor = ContaProvider(SimpleNamespace(), "kilocode")
    monkeypatch.setattr(provedor, "_conta", lambda: conta)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **_kwargs: ClienteAsync())

    resultado = asyncio.run(provedor.step([{"role": "user", "content": "oi"}], [], "modelo"))

    assert resultado.text == "ok"
    assert pedidos[0][0] == "https://api.kilo.ai/api/gateway/chat/completions"
    assert pedidos[0][1]["headers"]["authorization"] == "Bearer teste"
    assert pedidos[0][1]["headers"]["X-KiloCode-OrganizationId"] == "org-1"


def test_kimchi_step_usa_endpoint_oficial(monkeypatch):
    pedidos = []

    class ClienteAsync:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, **kwargs):
            pedidos.append((url, kwargs))
            return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    provedor = ContaProvider(SimpleNamespace(), "kimchi")
    monkeypatch.setattr(provedor, "_conta", lambda: {"access": "teste"})
    monkeypatch.setattr(httpx, "AsyncClient", lambda **_kwargs: ClienteAsync())

    resultado = asyncio.run(provedor.step([{"role": "user", "content": "oi"}], [], "modelo"))

    assert resultado.text == "ok"
    assert pedidos[0][0] == "https://llm.kimchi.dev/openai/v1/chat/completions"
    assert pedidos[0][1]["headers"]["authorization"] == "Bearer teste"
    assert pedidos[0][1]["headers"]["user-agent"] == "Koda/0.8.0"


def test_glm_modelo_e_step_usam_plano_coding(monkeypatch):
    conta = {"access": "chave-de-plano"}
    cliente = ClienteSimulado([(200, {"choices": [{"message": {"content": "ok"}}]})])
    monkeypatch.setattr(provedores.httpx, "Client", lambda **_kwargs: cliente)
    assert provedores._chamar_modelo("glm", conta, "glm-5.3") == {"ok": True, "detalhe": "ok"}
    assert cliente.pedidos[0][1] == "https://api.z.ai/api/coding/paas/v4/chat/completions"

    pedidos = []

    class ClienteAsync:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, **kwargs):
            pedidos.append((url, kwargs))
            return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    provedor = ContaProvider(SimpleNamespace(), "glm")
    monkeypatch.setattr(provedor, "_conta", lambda: conta)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **_kwargs: ClienteAsync())
    resultado = asyncio.run(provedor.step([{"role": "user", "content": "oi"}], [], "glm-5.3"))
    assert resultado.text == "ok"
    assert pedidos[0][0] == cliente.pedidos[0][1]
    assert pedidos[0][1]["headers"]["authorization"] == "Bearer chave-de-plano"


def test_iflow_usa_chave_de_api_da_conta(monkeypatch):
    conta = {"access": "sessao", "specific": {"apiKey": "chave-iflow"}}
    cliente = ClienteSimulado([(200, {"choices": [{"message": {"content": "ok"}}]})])
    monkeypatch.setattr(provedores.httpx, "Client", lambda **_kwargs: cliente)
    assert provedores._chamar_modelo("iflow", conta, "modelo") == {"ok": True, "detalhe": "ok"}
    assert cliente.pedidos[0][1] == "https://apis.iflow.cn/v1/chat/completions"
    assert cliente.pedidos[0][2]["headers"]["authorization"] == "Bearer chave-iflow"

    pedidos = []

    class ClienteAsync:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, **kwargs):
            pedidos.append((url, kwargs))
            return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    provedor = ContaProvider(SimpleNamespace(), "iflow")
    monkeypatch.setattr(provedor, "_conta", lambda: conta)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **_kwargs: ClienteAsync())
    assert asyncio.run(provedor.step([{"role": "user", "content": "oi"}], [], "modelo")).text == "ok"
    assert pedidos[0][0] == cliente.pedidos[0][1]
    assert pedidos[0][1]["headers"]["authorization"] == "Bearer chave-iflow"


def test_muse_repassa_razao_criptografada_e_chamada_de_ferramenta(monkeypatch):
    eventos = [
        {"type": "reasoning", "id": "rs_1", "encrypted_content": "opaco"},
        {"type": "message", "role": "assistant", "phase": "commentary", "content": [
            {"type": "output_text", "text": "Vou olhar."}]},
        {"type": "function_call", "id": "fc_1", "call_id": "c1", "name": "ler", "arguments": '{"id":1}'},
    ]
    pedidos = []

    class ClienteAsync:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, **kwargs):
            pedidos.append((url, kwargs))
            if len(pedidos) == 1:
                return httpx.Response(200, json={"status": "completed", "output": eventos,
                                                  "usage": {"input_tokens": 4, "output_tokens": 5}})
            return httpx.Response(200, json={"status": "completed", "output": [{"type": "message", "content": [
                {"type": "output_text", "text": "pronto"}]}]})

    provedor = ContaProvider(SimpleNamespace(), "muse")
    monkeypatch.setattr(provedor, "_conta", lambda: {"access": "chave"})
    monkeypatch.setattr(httpx, "AsyncClient", lambda **_kwargs: ClienteAsync())
    mensagens = [{"role": "system", "content": "Seja Koda"}, {"role": "user", "content": "olhe"}]
    ferramentas = [{"type": "function", "function": {"name": "ler", "parameters": {"type": "object"}}}]

    primeira = asyncio.run(provedor.step(mensagens, ferramentas, "muse-spark-1.3"))
    assert primeira.text == "Vou olhar."
    assert primeira.calls[0].arguments == {"id": 1}
    assert primeira.usage == {"prompt_tokens": 4, "completion_tokens": 5}
    mensagens += [{"role": "assistant", "content": primeira.text,
                   "tool_calls": [primeira.calls[0].para_mensagem()]},
                  {"role": "tool", "tool_call_id": "c1", "content": "resultado"}]
    segunda = asyncio.run(provedor.step(mensagens, ferramentas, "muse-spark-1.3"))

    assert segunda.text == "pronto"
    assert pedidos[0][0] == "https://api.meta.ai/v1/responses"
    assert pedidos[0][1]["json"]["include"] == ["reasoning.encrypted_content"]
    assert pedidos[0][1]["json"]["instructions"] == "Seja Koda"
    assert pedidos[1][1]["json"]["input"][1:4] == eventos
    assert pedidos[1][1]["json"]["input"][4]["call_id"] == "c1"


def test_muse_stream_e_teste_de_modelo(monkeypatch):
    cliente = ClienteSimulado([(200, {"status": "completed", "output": [{"type": "message", "content": [
        {"type": "output_text", "text": "ok"}]}]})])
    monkeypatch.setattr(provedores.httpx, "Client", lambda **_kwargs: cliente)
    assert provedores._chamar_modelo("muse", {"access": "chave"}, "muse-spark-1.3") == {"ok": True, "detalhe": "ok"}
    assert cliente.pedidos[0][2]["headers"]["x-api-version"] == "1.0.0"

    provedor = ContaProvider(SimpleNamespace(), "muse")
    monkeypatch.setattr(provedor, "_conta", lambda: {"access": "chave"})

    async def sse(_url, _headers, _corpo, _conta):
        yield 'data: {"type":"response.output_text.delta","delta":"olá"}'
        yield 'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":2,"output_tokens":3}}}'
        yield 'data: [DONE]'

    monkeypatch.setattr(provedor, "_sse", sse)

    async def consumir():
        return [p async for p in provedor.stream([ChatTurn(role="user", text="oi")], ChatOptions(model="muse-spark-1.3"))]

    pedacos = asyncio.run(consumir())
    assert pedacos[0].text == "olá"
    assert pedacos[1].usage == {"prompt_tokens": 2, "completion_tokens": 3}
    assert not any(p.truncated for p in pedacos)


@pytest.mark.parametrize("identificador", ["xai", "github"])
def test_adaptador_usa_uma_unica_leitura_da_conta(monkeypatch, identificador):
    leituras = []

    class ClienteAsync:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, _url, **_kwargs):
            return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    async def token_copilot(conta):
        assert conta["access"] == "token"
        return "token-sessao", {"authorization": "Bearer token-sessao"}

    provedor = ContaProvider(SimpleNamespace(), identificador)
    monkeypatch.setattr(provedor, "_conta", lambda: leituras.append(1) or {"access": "token"})
    monkeypatch.setattr(provedor, "_copilot_token", token_copilot)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **_kwargs: ClienteAsync())
    assert asyncio.run(provedor.step([{"role": "user", "content": "oi"}], [], "modelo")).text == "ok"
    assert leituras == [1]


def test_kimi_step_preserva_ferramentas_e_raciocinio(monkeypatch):
    pedidos = []
    conta = {"access": "token-teste", "specific": {"deviceId": "dispositivo"}}

    class ClienteAsync:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, **kwargs):
            pedidos.append((url, kwargs))
            return httpx.Response(200, json={"choices": [{"finish_reason": "length", "message": {
                "content": "resposta", "reasoning_content": "raciocínio",
                "tool_calls": [{"id": "chamada", "function": {"name": "ler", "arguments": '{"id":1}'},
                                "extra_content": {"signature": "opaca"}}],
            }}], "usage": {"prompt_tokens": 3, "completion_tokens": 4}})

    provedor = ContaProvider(SimpleNamespace(), "kimi")
    monkeypatch.setattr(provedor, "_conta", lambda: conta)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **_kwargs: ClienteAsync())
    ferramentas = [{"type": "function", "function": {"name": "ler"}}]

    resultado = asyncio.run(provedor.step([{"role": "user", "content": "oi"}], ferramentas, "k3"))

    assert resultado.text == "resposta"
    assert resultado.reasoning_content == "raciocínio"
    assert resultado.truncado
    assert resultado.calls[0].arguments == {"id": 1}
    assert resultado.calls[0].extra == {"extra_content": {"signature": "opaca"}}
    assert pedidos[0][1]["json"]["tools"] == ferramentas
    assert pedidos[0][1]["headers"]["X-Msh-Platform"] == "koda"
    assert pedidos[0][1]["headers"]["X-Msh-Device-Id"] == "dispositivo"


def test_grok_step_remonta_ferramentas_do_stream(monkeypatch):
    conta = {"access": "token-teste"}
    pedidos = []
    provedor = ContaProvider(SimpleNamespace(), "grok-cli")
    monkeypatch.setattr(provedor, "_conta", lambda: conta)

    async def sse(url, cabecalhos, corpo, _conta):
        pedidos.append((url, cabecalhos, corpo))
        eventos = [
            {"choices": [{"delta": {"reasoning_content": "pensando", "tool_calls": [
                {"index": 0, "id": "t1", "function": {"name": "ler", "arguments": '{"id":'}}]}}]},
            {"choices": [{"delta": {"content": "pronto", "tool_calls": [
                {"index": 0, "function": {"arguments": '3}'}}]}, "finish_reason": "tool_calls"}],
             "usage": {"prompt_tokens": 5, "completion_tokens": 7}},
        ]
        for evento in eventos:
            yield "data: " + json.dumps(evento)
        yield "data: [DONE]"

    monkeypatch.setattr(provedor, "_sse", sse)
    ferramentas = [{"type": "function", "function": {"name": "ler"}}]
    resultado = asyncio.run(provedor.step([{"role": "user", "content": "oi"}], ferramentas, "grok-build"))

    assert resultado.text == "pronto"
    assert resultado.reasoning_content == "pensando"
    assert resultado.calls[0].id == "t1"
    assert resultado.calls[0].arguments == {"id": 3}
    assert not resultado.truncado
    assert pedidos[0][1]["x-grok-model-override"] == "grok-build"
    assert pedidos[0][1]["x-xai-token-auth"] == "xai-grok-cli"
    assert pedidos[0][2]["stream"] is True
    assert pedidos[0][2]["tools"] == ferramentas


def test_grok_modelo_testa_stream_com_identidade_da_conta(monkeypatch):
    pedidos = []

    class ClienteStreaming:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def stream(self, metodo, url, **kwargs):
            pedidos.append((metodo, url, kwargs))
            conteudo = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
            return nullcontext(httpx.Response(200, text=conteudo))

    monkeypatch.setattr(provedores.httpx, "Client", lambda **_kwargs: ClienteStreaming())
    resultado = provedores._chamar_modelo("grok-cli", {"access": "teste"}, "grok-build")

    assert resultado == {"ok": True, "detalhe": "ok"}
    assert pedidos[0][2]["json"]["stream"] is True
    assert pedidos[0][2]["headers"]["x-grok-model-override"] == "grok-build"


def test_nous_preserva_compatibilidade_com_contas_existentes():
    assert koda_headers.token_nous({"access": "novo", "escopo": "inference:invoke", "specific": {"apiKey": "antiga"}}) == "novo"
    assert koda_headers.token_nous({"access": "antigo", "specific": {"apiKey": "chave-legada"}}) == "chave-legada"
    assert koda_headers.token_nous({"access": "novo", "specific": {"apiKey": "vencida", "agentKeyExpiresAt": "2000-01-01T00:00:00Z"}}) == "novo"
    assert oauth_login.FLUXOS["nous"]["scopes"] == "inference:invoke"


def test_minimax_inclui_cabecalho_do_protocolo():
    cabecalhos = koda_headers.minimax("sessao-de-teste")
    assert cabecalhos["x-api-key"] == "sk-xxx"
    assert cabecalhos["X-Mavis-Session-Id"] == "sessao-de-teste"


def test_nous_modelo_e_step_usam_token_da_sessao(monkeypatch):
    conta = {"access": "sessao", "escopo": "inference:invoke", "specific": {"apiKey": "antiga"}}
    cliente = ClienteSimulado([(200, {"choices": [{"message": {"content": "ok"}}]})])
    monkeypatch.setattr(provedores.httpx, "Client", lambda **_kwargs: cliente)
    assert provedores._chamar_modelo("nous", conta, "modelo") == {"ok": True, "detalhe": "ok"}
    assert cliente.pedidos[0][2]["headers"]["authorization"] == "Bearer sessao"

    pedidos = []

    class ClienteAsync:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, **kwargs):
            pedidos.append((url, kwargs))
            return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    provedor = ContaProvider(SimpleNamespace(), "nous")
    monkeypatch.setattr(provedor, "_conta", lambda: conta)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **_kwargs: ClienteAsync())
    resultado = asyncio.run(provedor.step([{"role": "user", "content": "oi"}], [], "modelo"))
    assert resultado.text == "ok"
    assert pedidos[0][0] == "https://inference-api.nousresearch.com/v1/chat/completions"
    assert pedidos[0][1]["headers"]["authorization"] == "Bearer sessao"


def test_kimi_stream_entrega_raciocinio_e_texto(monkeypatch):
    conta = {"access": "token-teste", "specific": {"deviceId": "dispositivo"}}
    pedidos = []
    provedor = ContaProvider(SimpleNamespace(), "kimi")
    monkeypatch.setattr(provedor, "_conta", lambda: conta)

    async def sse(url, cabecalhos, corpo, _conta):
        pedidos.append((url, cabecalhos, corpo))
        yield "data: " + json.dumps({"choices": [{"delta": {"reasoning_content": "pensando"}}]})
        yield "data: " + json.dumps({"choices": [{"delta": {"content": "pronto"}}]})
        yield "data: [DONE]"

    monkeypatch.setattr(provedor, "_sse", sse)

    async def coletar():
        return [parte async for parte in provedor.stream(
            [ChatTurn(role="system", text="regras"), ChatTurn(role="user", text="oi")],
            ChatOptions(model="k3"),
        )]

    partes = asyncio.run(coletar())
    assert [(parte.text, parte.reasoning) for parte in partes] == [("pensando", True), ("pronto", False)]
    assert pedidos[0][2]["messages"][0] == {"role": "system", "content": "regras"}
    assert pedidos[0][1]["X-Msh-Platform"] == "koda"


@pytest.mark.parametrize("identificador,dominio", [
    ("minimax-code", "agent.minimax.cn"),
    ("minimax-code-global", "agent.minimax.io"),
])
def test_minimax_step_converte_ferramentas_e_resposta(monkeypatch, identificador, dominio):
    conta = {"access": "token-teste"}
    pedidos = []

    class ClienteAsync:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, **kwargs):
            pedidos.append((url, kwargs))
            return httpx.Response(200, json={"content": [
                {"type": "thinking", "thinking": "analisando", "signature": "assinatura"},
                {"type": "text", "text": "pronto"},
                {"type": "tool_use", "id": "t1", "name": "ler", "input": {"id": 3}},
            ], "stop_reason": "tool_use", "usage": {"input_tokens": 5, "output_tokens": 7}})

    provedor = ContaProvider(SimpleNamespace(), identificador)
    monkeypatch.setattr(provedor, "_conta", lambda: conta)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **_kwargs: ClienteAsync())
    ferramentas = [{"type": "function", "function": {"name": "ler", "parameters": {"type": "object"}}}]
    mensagens = [{"role": "system", "content": "regras"}, {"role": "user", "content": "oi"}]

    resultado = asyncio.run(provedor.step(mensagens, ferramentas, "MiniMax-M3"))

    assert resultado.text == "pronto"
    assert resultado.reasoning_content == "analisando"
    assert resultado.calls[0].arguments == {"id": 3}
    assert resultado.usage == {"prompt_tokens": 5, "completion_tokens": 7}
    assert dominio in pedidos[0][0]
    assert pedidos[0][1]["json"]["system"] == "regras"
    assert pedidos[0][1]["json"]["tools"][0]["name"] == "ler"
    assert pedidos[0][1]["headers"]["authorization"] == "Bearer token-teste"
    historico = [
        {"role": "assistant", "content": resultado.text,
         "tool_calls": [resultado.calls[0].para_mensagem()]},
        {"role": "tool", "tool_call_id": "t1", "content": "resultado"},
    ]
    asyncio.run(provedor.step(historico, ferramentas, "MiniMax-M3"))
    assert pedidos[1][1]["json"]["messages"][0]["content"][0] == {
        "type": "thinking", "thinking": "analisando", "signature": "assinatura",
    }


def test_minimax_stream_entrega_texto_e_pensamento(monkeypatch):
    conta = {"access": "token-teste"}
    provedor = ContaProvider(SimpleNamespace(), "minimax-code-global")
    monkeypatch.setattr(provedor, "_conta", lambda: conta)

    async def sse(_url, _cabecalhos, _corpo, _conta):
        yield 'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"pensando"}}'
        yield 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"pronto"}}'
        yield 'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}'
        yield 'data: {"type":"message_stop"}'

    monkeypatch.setattr(provedor, "_sse", sse)

    async def coletar():
        return [parte async for parte in provedor.stream(
            [ChatTurn(role="user", text="oi")], ChatOptions(model="MiniMax-M3"),
        )]

    partes = asyncio.run(coletar())
    assert [(p.text, p.reasoning, p.truncated) for p in partes] == [
        ("pensando", True, False), ("pronto", False, False), ("", False, True),
    ]


@pytest.mark.parametrize("identificador", ["minimax-code-global", "kilocode"])
def test_stream_mostra_erro_do_provedor(monkeypatch, identificador):
    provedor = ContaProvider(SimpleNamespace(), identificador)
    monkeypatch.setattr(provedor, "_conta", lambda: {"access": "teste"})

    async def sse(_url, _headers, _body, _conta):
        yield 'data: {"type":"error","error":{"message":"erro simulado"}}'

    monkeypatch.setattr(provedor, "_sse", sse)

    async def coletar():
        return [parte async for parte in provedor.stream([ChatTurn(role="user", text="oi")], ChatOptions(model="m"))]

    with pytest.raises(ProviderError, match="erro simulado"):
        asyncio.run(coletar())


def test_teste_de_modelo_nao_confunde_resposta_vazia_com_sucesso(monkeypatch):
    cliente = ClienteSimulado([(200, {"data": {}})])
    monkeypatch.setattr(provedores.httpx, "Client", lambda **_kwargs: cliente)

    resultado = provedores._chamar_modelo("kilocode", {"access": "teste"}, "modelo")

    assert not resultado["ok"]
    assert "sem escolhas" in resultado["detalhe"]


def test_minimax_testa_modelo_sem_motor_externo(monkeypatch):
    cliente = ClienteSimulado([(200, {"content": [{"type": "text", "text": "ok"}]})])
    monkeypatch.setattr(provedores.httpx, "Client", lambda **_kwargs: cliente)

    resultado = provedores._chamar_modelo("minimax-code-global", {"access": "teste"}, "MiniMax-M3")

    assert resultado == {"ok": True, "detalhe": "ok"}
    assert cliente.pedidos[0][1].startswith("https://agent.minimax.io/")
    assert cliente.pedidos[0][2]["headers"]["authorization"] == "Bearer teste"


def test_kiro_guardar_credenciais_para_renovacao(monkeypatch):
    cliente = ClienteSimulado([
        (200, {"clientId": "cliente", "clientSecret": "segredo"}),
        (200, {"deviceCode": "dispositivo", "userCode": "ABC", "verificationUri": "https://example.test/", "interval": 5}),
        (200, {"accessToken": "acesso", "refreshToken": "renovacao", "expiresIn": 3600,
               "profileArn": "arn:profile:teste"}),
    ])
    gravados = []
    monkeypatch.setattr(oauth_login.httpx, "Client", lambda **_kwargs: cliente)
    monkeypatch.setattr(oauth_login.threading, "Thread", ThreadImediata)
    monkeypatch.setattr(oauth_login.time, "sleep", lambda _segundos: None)
    monkeypatch.setattr(oauth_login, "_conta_do_token", lambda *_args: "conta")
    monkeypatch.setattr(oauth_login, "_gravar", lambda _settings, _id, dado: gravados.append(dado))
    fluxo = oauth_login._Fluxo("kiro", oauth_login.FLUXOS["kiro"], SimpleNamespace())

    resultado = oauth_login._iniciar_aws_sso(fluxo)

    assert resultado["tipo"] == "device"
    assert fluxo.estado == "concluido"
    assert gravados[0]["specific"] == {
        "clientId": "cliente", "clientSecret": "segredo", "region": "us-east-1",
        "authMethod": "builder-id", "startUrl": oauth_login.FLUXOS["kiro"]["start_url"],
        "profileArn": "arn:profile:teste",
    }
    assert gravados[0]["refresh"] == "renovacao"


@pytest.mark.parametrize("identificador,dominio", [("qoder", "openapi.qoder.sh"), ("qoder-cn", "openapi.qoder.com.cn")])
def test_qoder_guarda_token_e_identidade_do_dispositivo(monkeypatch, identificador, dominio):
    cliente = ClienteSimulado([
        (202, {}),
        (200, {"token": "device-token", "refresh_token": "refresh", "user_id": "42",
               "expires_at": "2099-01-01T00:00:00+00:00"}),
        (200, {"email": "conta@example.test", "organization_id": "org"}),
    ])
    gravados = []
    monkeypatch.setattr(oauth_login.httpx, "Client", lambda **_kwargs: cliente)
    monkeypatch.setattr(oauth_login.threading, "Thread", ThreadImediata)
    monkeypatch.setattr(oauth_login.time, "sleep", lambda _segundos: None)
    monkeypatch.setattr(oauth_login, "_gravar", lambda _settings, _id, dado: gravados.append(dado))
    fluxo = oauth_login._Fluxo(identificador, oauth_login.FLUXOS[identificador], SimpleNamespace())

    resultado = oauth_login._iniciar_qoder(fluxo)

    assert resultado["tipo"] == "device"
    assert fluxo.estado == "concluido"
    assert dominio in cliente.pedidos[0][1]
    assert cliente.pedidos[0][2]["params"]["challenge_method"] == "S256"
    assert gravados[0]["access"] == "device-token"
    assert gravados[0]["refresh"] == "refresh"
    assert gravados[0]["specific"]["machineId"] == gravados[0]["escopo"]
    assert gravados[0]["specific"]["userId"] == "42"
    assert gravados[0]["specific"]["organizationId"] == "org"
    assert gravados[0]["conta"] == "conta@example.test"


def test_kiro_renova_com_cliente_registrado(monkeypatch):
    cliente = ClienteSimulado([(200, {"accessToken": "novo-acesso", "expiresIn": 3600})])
    monkeypatch.setattr(oauth_login.httpx, "Client", lambda **_kwargs: cliente)

    resultado = oauth_login._renovar("kiro", {
        "refresh": "renovacao",
        "specific": {"clientId": "cliente", "clientSecret": "segredo"},
    })

    assert resultado["access"] == "novo-acesso"
    assert resultado["refresh"] == "renovacao"
    assert cliente.pedidos[0][2]["json"] == {
        "clientId": "cliente", "clientSecret": "segredo",
        "grantType": "refresh_token", "refreshToken": "renovacao",
    }


def test_renovacao_atualiza_a_mesma_conta_sem_email(tmp_path, monkeypatch):
    settings = SimpleNamespace(database_path=tmp_path / "koda.db")
    conta_id = oauth_login._gravar(settings, "kimi", {
        "access": "acesso-antigo", "refresh": "refresh-antigo", "conta": None,
        "expiraEm": "2000-01-01T00:00:00+00:00", "specific": {"deviceId": "id"},
    })
    chamadas = []

    def renovar(_id, dado):
        chamadas.append(dado["refresh"])
        time.sleep(0.05)
        return {"access": "acesso-novo", "refresh": "refresh-novo", "expiraEm": "2099-01-01T00:00:00+00:00"}

    monkeypatch.setattr(oauth_login, "_renovar", renovar)
    with ThreadPoolExecutor(max_workers=2) as executor:
        resultados = list(executor.map(lambda _n: oauth_login.garantir(settings, "kimi"), range(2)))

    contas = oauth_login.contas(settings, "kimi")
    assert len(contas) == 1
    assert contas[0]["id"] == conta_id
    assert contas[0]["access"] == "acesso-novo"
    assert [resultado["access"] for resultado in resultados] == ["acesso-novo", "acesso-novo"]
    assert chamadas == ["refresh-antigo"]


def test_teste_de_modelo_renova_a_conta_selecionada(tmp_path, monkeypatch):
    settings = SimpleNamespace(database_path=tmp_path / "koda.db")
    primeira = oauth_login._gravar(settings, "kimi", {
        "conta": "primeira", "access": "acesso-1", "refresh": "refresh-1",
        "expiraEm": "2000-01-01T00:00:00+00:00",
    })
    segunda = oauth_login._gravar(settings, "kimi", {
        "conta": "segunda", "access": "acesso-2", "refresh": "refresh-2",
        "expiraEm": "2000-01-01T00:00:00+00:00",
    })
    oauth_login._marcar(settings, primeira, esgotada_ate="2099-01-01T00:00:00+00:00", motivo="cota")
    chamadas = []
    monkeypatch.setattr(oauth_login, "_renovar", lambda _id, dado: {
        "access": dado["access"] + "-novo", "refresh": dado["refresh"], "expiraEm": "2099-01-01T00:00:00+00:00",
    })
    monkeypatch.setattr(provedores, "_chamar_modelo", lambda _id, conta, _modelo, _settings: (
        chamadas.append(conta) or {"ok": True, "detalhe": "ok"}
    ))

    resultado = provedores.testar_modelo("kimi", "k3", settings)

    assert resultado["ok"]
    assert chamadas[0]["id"] == segunda
    assert chamadas[0]["access"] == "acesso-2-novo"
    assert len(resultado["tentativas"]) == 1


def test_copilot_troca_token_e_testa_modelo_diretamente(monkeypatch):
    cliente = ClienteSimulado([
        (200, {"token": "sessao-copilot"}),
        (200, {"choices": [{"message": {"content": "ok"}}]}),
    ])
    monkeypatch.setattr(provedores.httpx, "Client", lambda **_kwargs: cliente)

    resultado = provedores._chamar_modelo("github", {"access": "token-github"}, "modelo")

    assert resultado == {"ok": True, "detalhe": "ok"}
    assert cliente.pedidos[0][1] == "https://api.github.com/copilot_internal/v2/token"
    assert cliente.pedidos[0][2]["headers"]["authorization"] == "token token-github"
    assert cliente.pedidos[1][1] == "https://api.githubcopilot.com/chat/completions"
    assert cliente.pedidos[1][2]["headers"]["authorization"] == "Bearer sessao-copilot"


def test_xai_preserva_limite_de_uso(monkeypatch):
    cliente = ClienteSimulado([(429, {"error": {"resets_in_seconds": 120}})])
    monkeypatch.setattr(provedores.httpx, "Client", lambda **_kwargs: cliente)

    resultado = provedores._chamar_modelo("xai", {"access": "token-teste"}, "grok")

    assert not resultado["ok"]
    assert resultado["esgotadaAte"]
    assert cliente.pedidos[0][1] == "https://api.x.ai/v1/chat/completions"
    assert cliente.pedidos[0][2]["headers"]["authorization"] == "Bearer token-teste"
