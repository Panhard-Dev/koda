"""OAuth de verdade, dentro do Koda — autorização, troca de código e refresh.

O motor é um só; o que muda por provedor está em `provedores_oauth.json` (client id,
endpoints, escopos, corpo do pedido de token). As constantes vêm do **9router** instalado
nesta máquina — um proxy que já faz esses logins — e as do Google batem com o magpie.

**Dois fluxos, porque são os dois que os fornecedores publicam:**

- `pkce`   — authorization code + PKCE S256, com servidor local de callback.
- `device` — o usuário digita um código numa página; o app consulta o endpoint de token até
             sair (GitHub, xAI, Kimi, MiniMax).

Quem não tem fluxo público fica em `CLIS` (o login é o do CLI do fornecedor) ou em
`SEM_FLUXO` (não há o que rodar) — e a tela diz qual é o caso, em vez de oferecer um botão
que não faz nada.

O refresh é automático: token vencido com refresh token é renovado antes de qualquer leitura.
O token fica em `data/provedores/<id>.json` com permissão 0600.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import sqlite3
import shutil
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

import httpx

from .config import Settings

#: Quanto tempo um fluxo espera o navegador antes de desistir.
ESPERA_S = 600

#: O que não tem fluxo público: a tela explica em vez de oferecer botão morto.
SEM_FLUXO = {
    "chatgpt": "Sign in with ChatGPT é um fluxo do próprio magpie; o ChatGPT não publica "
               "OAuth para apps de terceiros.",
    "workbuddy": "o login do WorkBuddy vem de um plugin npm (auth OAuth do OpenCode), "
                 "não de um OAuth público.",
}

#: Quem entra pelo login do próprio CLI — o caminho que o magpie também usa nestes.
CLIS: dict[str, tuple[str, str]] = {
    "cursor": ("cursor-agent", "cursor-agent login"),
    "devin": ("devin", "devin auth login"),
    "kiro": ("kiro-cli", "kiro-cli login"),
    "qoder": ("qoder", "qoder"),
    "qoder-cn": ("qoder-cn", "qoder-cn"),
    "zcode": ("zcode", "zcode"),
    "factory": ("droid", "droid"),
    "xiaomi": ("mimo", "mimo"),
}


def _carregar_fluxos() -> dict[str, dict[str, Any]]:
    caminho_do_json = Path(__file__).with_name("provedores_oauth.json")
    try:
        dado = json.loads(caminho_do_json.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    for provedor, variavel in (
        ("google", "KODA_GOOGLE_CLIENT_ID"),
        ("antigravity", "KODA_ANTIGRAVITY_CLIENT_ID"),
    ):
        if isinstance(dado.get(provedor), dict):
            dado[provedor]["client_id"] = os.environ.get(variavel, "")
    return {
        chave: valor
        for chave, valor in dado.items()
        if isinstance(valor, dict) and not chave.startswith("_")
    }


FLUXOS: dict[str, dict[str, Any]] = _carregar_fluxos()
_MANIFESTO = json.loads(Path(__file__).with_name("provedores_9router.json").read_text(encoding="utf-8"))
_LOGIN_9ROUTER = {item["id"]: item for item in _MANIFESTO["provedores"]}


def _escopos(config: dict[str, Any]) -> str:
    bruto = config.get("scopes")
    if isinstance(bruto, list):
        return " ".join(str(item) for item in bruto)
    return str(bruto or "")


#: As contas dos provedores, **várias por provedor** — empilhadas como no 9router.
#:
#: Fica no mesmo banco do app (`koda.db`): a conta é dado do app como a conversa, e um JSON
#: paralelo só criava um segundo lugar para o backup esquecer.
#:
#: `id` é um identificador próprio (e não o e-mail): a mesma pessoa pode ter duas contas do
#: mesmo provedor com o mesmo e-mail (dois assentos de um time), e o provedor troca o
#: refresh token a cada uso — o id tem de sobreviver a isso.
TABELA = """
CREATE TABLE IF NOT EXISTS provedor_contas (
    id          TEXT PRIMARY KEY,
    provedor    TEXT NOT NULL,
    conta       TEXT,
    acesso      TEXT NOT NULL,
    refresh     TEXT,
    expira_em   TEXT,
    id_token    TEXT,
    escopo      TEXT,
    specific    TEXT,
    ordem       INTEGER NOT NULL DEFAULT 0,
    esgotada_ate TEXT,
    motivo      TEXT,
    criado_em   TEXT NOT NULL,
    atualizado  TEXT NOT NULL
)
"""

INDICE = "CREATE INDEX IF NOT EXISTS provedor_contas_provedor ON provedor_contas (provedor, ordem)"


def _conexao(settings: Settings) -> sqlite3.Connection:
    caminho = settings.database_path
    caminho.parent.mkdir(parents=True, exist_ok=True)
    banco = sqlite3.connect(caminho)
    banco.row_factory = sqlite3.Row
    _migrar_tabela(banco)
    banco.execute(TABELA)
    colunas = {linha["name"] for linha in banco.execute("PRAGMA table_info(provedor_contas)")}
    if "specific" not in colunas:
        banco.execute("ALTER TABLE provedor_contas ADD COLUMN specific TEXT")
    banco.execute(INDICE)
    banco.commit()
    return banco


def _migrar_tabela(banco: sqlite3.Connection) -> None:
    """Traz a tabela de uma conta por provedor para a de várias contas.

    A primeira versão usava `provedor` como chave primária — uma conta por provedor. Empilhar
    contas exige id próprio, então a tabela antiga é copiada e aposentada. Sem isto, o
    `CREATE TABLE IF NOT EXISTS` não faria nada (a tabela já existe) e o INSERT novo falharia.
    """
    colunas = [linha["name"] for linha in banco.execute("PRAGMA table_info(provedor_contas)")]
    if not colunas or "id" in colunas:
        return
    banco.execute("ALTER TABLE provedor_contas RENAME TO provedor_contas_velho")
    banco.execute(TABELA)
    agora = datetime.now(tz=timezone.utc).isoformat()
    for linha in banco.execute("SELECT * FROM provedor_contas_velho").fetchall():
        banco.execute(
            """INSERT OR REPLACE INTO provedor_contas
               (id, provedor, conta, acesso, refresh, expira_em, id_token, escopo,
                ordem, esgotada_ate, motivo, criado_em, atualizado)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)""",
            (
                secrets.token_hex(8),
                linha["provedor"],
                linha["conta"],
                linha["acesso"],
                linha["refresh"],
                linha["expira_em"],
                linha["id_token"],
                linha["escopo"],
                agora,
                agora,
            ),
        )
    banco.execute("DROP TABLE provedor_contas_velho")
    banco.commit()


def _linha(linha: sqlite3.Row | None) -> dict[str, Any] | None:
    if linha is None:
        return None
    return {
        "id": linha["id"],
        "provedor": linha["provedor"],
        "conta": linha["conta"],
        "access": linha["acesso"],
        "refresh": linha["refresh"],
        "expiraEm": linha["expira_em"],
        "id_token": linha["id_token"],
        "escopo": linha["escopo"],
        "specific": json.loads(linha["specific"]) if linha["specific"] else {},
        "esgotadaAte": linha["esgotada_ate"],
        "motivo": linha["motivo"],
    }


def caminho(settings: Settings, identificador: str) -> str:
    """Onde as contas moram — a tela mostra isso como origem."""
    return f"{settings.database_path} · provedor_contas/{identificador}"


def contas(settings: Settings, identificador: str) -> list[dict[str, Any]]:
    """Todas as contas do provedor, na ordem em que o rodízio as usa."""
    with _conexao(settings) as banco:
        linhas = banco.execute(
            "SELECT * FROM provedor_contas WHERE provedor = ? ORDER BY ordem, criado_em",
            (identificador,),
        ).fetchall()
    return [item for item in (_linha(linha) for linha in linhas) if item]


def guardado(settings: Settings, identificador: str) -> dict[str, Any] | None:
    """A conta **em uso** agora: a primeira da fila que ainda tem cota.

    Se todas estouraram, devolve a primeira mesmo assim — é melhor mostrar o estado real
    («esgotada até tal dia») do que fingir que não há conta.
    """
    lista = contas(settings, identificador)
    if not lista:
        return _migrar_do_json(settings, identificador)
    agora = datetime.now(tz=timezone.utc)
    for item in lista:
        ate = item.get("esgotadaAte")
        if not ate:
            return item
        try:
            if datetime.fromisoformat(ate) <= agora:
                # A janela renovou: a conta volta para a fila.
                _marcar(settings, item["id"], esgotada_ate=None, motivo=None)
                return item
        except ValueError:
            return item
    return lista[0]


def _migrar_do_json(settings: Settings, identificador: str) -> dict[str, Any] | None:
    """Traz para o banco a conta que ficou nos arquivos da versão anterior."""
    arquivo = settings.database_path.parent / "provedores" / f"{identificador}.json"
    try:
        dado = json.loads(arquivo.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(dado, dict) or not dado.get("access"):
        return None
    _gravar(settings, identificador, dado)
    try:
        arquivo.unlink()
    except OSError:
        pass
    return guardado(settings, identificador)


def _gravar(settings: Settings, identificador: str, dado: dict[str, Any]) -> str:
    """Grava (ou atualiza) a conta e devolve o id dela.

    A atualização é por **conta** (provedor + e-mail), e não por provedor: entrar de novo com
    a mesma conta substitui os tokens dela; entrar com outra conta **acrescenta** uma linha.
    """
    agora = datetime.now(tz=timezone.utc).isoformat()
    with _conexao(settings) as banco:
        existente = None
        if dado.get("conta"):
            existente = banco.execute(
                "SELECT id FROM provedor_contas WHERE provedor = ? AND conta = ?",
                (identificador, dado["conta"]),
            ).fetchone()
        if existente is not None:
            banco.execute(
                """UPDATE provedor_contas
                      SET acesso = ?, refresh = ?, expira_em = ?, id_token = ?, escopo = ?, specific = ?,
                          esgotada_ate = NULL, motivo = NULL, atualizado = ?
                    WHERE id = ?""",
                (
                    dado.get("access") or "",
                    dado.get("refresh"),
                    dado.get("expiraEm"),
                    dado.get("id_token"),
                    dado.get("escopo"),
                    json.dumps(dado.get("specific") or {}),
                    agora,
                    existente["id"],
                ),
            )
            banco.commit()
            return str(existente["id"])

        ordem = banco.execute(
            "SELECT COALESCE(MAX(ordem), -1) + 1 FROM provedor_contas WHERE provedor = ?",
            (identificador,),
        ).fetchone()[0]
        novo_id = secrets.token_hex(8)
        banco.execute(
            """INSERT INTO provedor_contas
               (id, provedor, conta, acesso, refresh, expira_em, id_token, escopo, specific,
                ordem, esgotada_ate, motivo, criado_em, atualizado)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)""",
            (
                novo_id,
                identificador,
                dado.get("conta"),
                dado.get("access") or "",
                dado.get("refresh"),
                dado.get("expiraEm"),
                dado.get("id_token"),
                dado.get("escopo"),
                json.dumps(dado.get("specific") or {}),
                ordem,
                agora,
                agora,
            ),
        )
        banco.commit()
        return novo_id


def _marcar(settings: Settings, conta_id: str, *, esgotada_ate: str | None, motivo: str | None) -> None:
    """Marca (ou limpa) o fim de cota de uma conta — é o que faz o rodízio andar."""
    with _conexao(settings) as banco:
        banco.execute(
            "UPDATE provedor_contas SET esgotada_ate = ?, motivo = ?, atualizado = ? WHERE id = ?",
            (esgotada_ate, motivo, datetime.now(tz=timezone.utc).isoformat(), conta_id),
        )
        banco.commit()


def esquecer(settings: Settings, identificador: str, conta_id: str | None = None) -> None:
    """Sai da conta: uma conta específica, ou todas as do provedor."""
    with _conexao(settings) as banco:
        if conta_id:
            banco.execute("DELETE FROM provedor_contas WHERE id = ?", (conta_id,))
        else:
            banco.execute("DELETE FROM provedor_contas WHERE provedor = ?", (identificador,))
        banco.commit()


def _claims(token: str | None) -> dict[str, Any]:
    if not isinstance(token, str) or token.count(".") < 2:
        return {}
    corpo = token.split(".")[1]
    corpo += "=" * (-len(corpo) % 4)
    try:
        dado = json.loads(base64.urlsafe_b64decode(corpo))
    except (ValueError, TypeError):
        return {}
    return dado if isinstance(dado, dict) else {}


def _iso(segundos: float | None) -> str | None:
    if not segundos:
        return None
    try:
        return datetime.fromtimestamp(segundos, tz=timezone.utc).isoformat()
    except (OverflowError, OSError, ValueError):
        return None


def _expira_em(dado: dict[str, Any]) -> str | None:
    segundos = dado.get("expires_in")
    try:
        return _iso(time.time() + float(segundos)) if segundos else None
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------- fluxos vivos


class _Fluxo:
    def __init__(self, identificador: str, config: dict[str, Any], settings: Settings) -> None:
        self.id = identificador
        self.config = config
        # O `Settings` viaja com o fluxo porque quem conclui é a thread do servidor HTTP, e
        # ela não recebe request nenhum de onde tirar a pasta de dados.
        self.settings = settings
        self.estado = "aguardando"
        self.url: str | None = None
        self.codigo: str | None = None
        self.detalhe = ""
        self.conta: str | None = None
        self.criado = time.time()
        self.verifier = secrets.token_urlsafe(64)[:96]
        self.state = secrets.token_hex(16)
        self.servidor: ThreadingHTTPServer | None = None
        self.redirect = ""
        self.extra: dict[str, Any] = {}
        self.auth_meta: dict[str, Any] = {}


_trava = threading.Lock()
_vivos: dict[str, _Fluxo] = {}


def _challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def _pagina(titulo: str, texto: str) -> bytes:
    return (
        "<!doctype html><meta charset='utf-8'><title>{t}</title>"
        "<body style=\"font:15px/1.6 system-ui;background:#0b0b0c;color:#e8e8ea;"
        "display:grid;place-items:center;height:100vh;margin:0\">"
        "<div style='text-align:center'><h1 style='font-size:18px'>{t}</h1>"
        "<p style='color:#9a9aa2'>{x}</p></div></body>"
    ).format(t=titulo, x=texto).encode("utf-8")


def iniciar(settings: Settings, identificador: str) -> dict[str, Any]:
    """Começa um login. Devolve o que a tela precisa mostrar: URL, código ou o motivo."""
    if identificador in _LOGIN_9ROUTER and identificador not in {"anthropic", "openai"}:
        return _iniciar_9router(settings, identificador)
    config = FLUXOS.get(identificador)
    if config is None:
        if identificador in SEM_FLUXO:
            return {"tipo": "nada", "mensagem": SEM_FLUXO[identificador]}
        cli = CLIS.get(identificador)
        if cli is None:
            return {"tipo": "nada", "mensagem": "este provedor não tem login disponível aqui"}
        binario, comando = cli
        if shutil.which(binario) is None:
            return {
                "tipo": "cli",
                "mensagem": f"o CLI `{binario}` não está instalado — instale-o e rode `{comando}`.",
            }
        return {
            "tipo": "cli",
            "mensagem": f"o login é o do CLI: rode `{comando}` num terminal. O Koda lê o "
                        "resultado sozinho depois.",
        }

    fluxo = _Fluxo(identificador, config, settings)
    with _trava:
        _vivos[identificador] = fluxo

    if config.get("tipo") == "device":
        return _iniciar_device(fluxo)
    if config.get("tipo") == "aws_sso":
        return _iniciar_aws_sso(fluxo)
    if config.get("tipo") == "qoder":
        return _iniciar_qoder(fluxo)
    return _iniciar_pkce(fluxo)


def _iniciar_9router(settings: Settings, identificador: str) -> dict[str, Any]:
    """Usa os mesmos construtores de autorização e troca de token do 9router."""
    item = _LOGIN_9ROUTER[identificador]
    fonte = item["fonteId"]
    if item["tipo"] == "web_cookie":
        fluxo = _Fluxo(identificador, {"motor": "cookie"}, settings)
        fluxo.url = item.get("website") or ""
        with _trava:
            _vivos[identificador] = fluxo
        return {"tipo": "cookie", "estado": "aguardando", "url": fluxo.url,
                "mensagem": item.get("authHint") or "Cole a credencial da sessão do navegador."}
    if fonte == "cursor":
        fluxo = _Fluxo(identificador, {"motor": "cookie"}, settings)
        fluxo.url = item.get("website") or ""
        with _trava:
            _vivos[identificador] = fluxo
        return {"tipo": "cookie", "estado": "aguardando", "url": fluxo.url,
                "mensagem": "Cole o token de acesso da sua conta Cursor. O Koda não lê arquivos da IDE."}
    if fonte == "xiaomi-mimo":
        return {"tipo": "nada", "mensagem": "o login do MiMo usa retorno criptografado; o adaptador de retorno ainda não está ligado ao Koda"}
    if fonte == "gitlab":
        return {"tipo": "nada", "mensagem": "o GitLab exige o Client ID de um aplicativo OAuth próprio; o Koda ainda não tem esse campo"}

    from . import auth_9router

    preparo = auth_9router.chamar(settings, fonte, "prepare")
    if not preparo.get("ok"):
        return {"tipo": "nada", "mensagem": preparo.get("error") or "não consegui preparar o login"}
    info = preparo["result"]
    tipo_fluxo = info.get("flowType")
    config = {
        "motor": "9router", "fonte": fonte,
        "caminho": info.get("callbackPath") or "/callback",
        "porta": info.get("fixedPort") or 0,
        "verificar_state": tipo_fluxo == "authorization_code_pkce" or fonte in {"gemini-cli", "antigravity", "iflow", "kimchi"},
    }
    fluxo = _Fluxo(identificador, config, settings)
    with _trava:
        anterior = _vivos.pop(identificador, None)
        _vivos[identificador] = fluxo
    if anterior and anterior.servidor is not None:
        threading.Thread(target=anterior.servidor.shutdown, daemon=True).start()

    if tipo_fluxo == "device_code":
        pedido = auth_9router.chamar(settings, fonte, "device-code")
        if not pedido.get("ok"):
            fluxo.estado = "erro"
            fluxo.detalhe = pedido.get("error") or "o provedor não deu código de dispositivo"
            return {"tipo": "device", "estado": "erro", "mensagem": fluxo.detalhe}
        dado = pedido["result"]
        fluxo.extra = dado
        fluxo.codigo = dado.get("user_code") or dado.get("code")
        fluxo.state = dado.get("device_code") or dado.get("code") or ""
        fluxo.url = dado.get("verification_uri_complete") or dado.get("verification_uri") or dado.get("verificationUrl")
        if not fluxo.url or not fluxo.state:
            fluxo.estado = "erro"
            fluxo.detalhe = "o provedor não devolveu página ou código de login"
            return {"tipo": "device", "estado": "erro", "mensagem": fluxo.detalhe}
        threading.Thread(target=_esperar_9router, args=(fluxo,), daemon=True).start()
        return {"tipo": "device", "estado": "aguardando", "url": fluxo.url, "codigo": fluxo.codigo}

    if tipo_fluxo not in {"authorization_code", "authorization_code_pkce", "browser_token"}:
        fluxo.estado = "erro"
        fluxo.detalhe = f"o fluxo {tipo_fluxo or 'especial'} do 9router ainda não tem retorno no Koda"
        return {"tipo": "nada", "mensagem": fluxo.detalhe}
    try:
        servidor = ThreadingHTTPServer(("127.0.0.1", int(config["porta"])), _Handler)
    except OSError as erro:
        fluxo.estado = "erro"
        fluxo.detalhe = f"não consegui abrir a porta do retorno: {erro}"
        return {"tipo": "pkce", "estado": "erro", "mensagem": fluxo.detalhe}
    servidor.daemon_threads = True
    servidor.koda_fluxo = fluxo  # type: ignore[attr-defined]
    fluxo.servidor = servidor
    callback_host = "127.0.0.1" if fonte in {"xai", "zed"} else "localhost"
    fluxo.redirect = f"http://{callback_host}:{servidor.server_address[1]}{config['caminho']}"
    meta = {"nativeAppPort": servidor.server_address[1]} if fonte == "zed" else {}
    autorizado = auth_9router.chamar(settings, fonte, "authorize", redirectUri=fluxo.redirect, meta=meta)
    if not autorizado.get("ok"):
        servidor.server_close()
        fluxo.estado = "erro"
        fluxo.detalhe = autorizado.get("error") or "o provedor não montou o login"
        return {"tipo": "pkce", "estado": "erro", "mensagem": fluxo.detalhe}
    dados = autorizado["result"]
    fluxo.state = dados.get("state") or fluxo.state
    fluxo.verifier = dados.get("codeVerifier") or fluxo.verifier
    fluxo.auth_meta = {"systemId": dados.get("systemId")} if dados.get("systemId") else {}
    fluxo.url = dados.get("authUrl")
    if not fluxo.url:
        servidor.server_close()
        fluxo.estado = "erro"
        fluxo.detalhe = "o provedor não devolveu endereço de login"
        return {"tipo": "pkce", "estado": "erro", "mensagem": fluxo.detalhe}
    threading.Thread(target=servidor.serve_forever, daemon=True).start()
    return {"tipo": "pkce", "estado": "aguardando", "url": fluxo.url}


def _esperar_9router(fluxo: _Fluxo) -> None:
    from . import auth_9router

    limite = time.time() + min(int(fluxo.extra.get("expires_in") or ESPERA_S), ESPERA_S)
    intervalo = max(int(fluxo.extra.get("interval") or 5), 3)
    while time.time() < limite and fluxo.estado == "aguardando":
        time.sleep(intervalo)
        pedido = auth_9router.chamar(
            fluxo.settings, fluxo.config["fonte"], "poll",
            deviceCode=fluxo.state, codeVerifier=fluxo.extra.get("codeVerifier"),
            extraData=fluxo.extra,
        )
        if not pedido.get("ok"):
            fluxo.estado = "erro"
            fluxo.detalhe = pedido.get("error") or "falha ao verificar o login"
            return
        resultado = pedido["result"]
        if resultado.get("success") and resultado.get("tokens", {}).get("accessToken"):
            _concluir(fluxo, resultado["tokens"])
            return
        if resultado.get("pending") or resultado.get("error") in {"authorization_pending", "slow_down"}:
            if resultado.get("error") == "slow_down":
                intervalo += 5
            continue
        fluxo.estado = "erro"
        fluxo.detalhe = resultado.get("errorDescription") or resultado.get("error") or "login recusado"
        return
    if fluxo.estado == "aguardando":
        fluxo.estado = "erro"
        fluxo.detalhe = "o tempo do login acabou"


def _iniciar_pkce(fluxo: _Fluxo) -> dict[str, Any]:
    config = fluxo.config
    porta = int(config.get("porta") or 0)
    try:
        servidor = ThreadingHTTPServer(("127.0.0.1", porta), _Handler)
    except OSError as erro:
        fluxo.estado = "erro"
        fluxo.detalhe = (
            f"não consegui abrir a porta {porta or 'local'} para receber o retorno ({erro}). "
            "Feche o outro programa que a usa e tente de novo."
        )
        return {"tipo": "pkce", "mensagem": fluxo.detalhe, "estado": "erro"}

    servidor.daemon_threads = True
    servidor.koda_fluxo = fluxo  # type: ignore[attr-defined]
    fluxo.servidor = servidor
    fluxo.redirect = (
        f"http://localhost:{servidor.server_address[1]}{config.get('caminho') or '/callback'}"
    )

    parametros = {
        "response_type": "code",
        "client_id": config["client_id"],
        "redirect_uri": fluxo.redirect,
        "scope": _escopos(config),
        "state": fluxo.state,
        "code_challenge": _challenge(fluxo.verifier),
        "code_challenge_method": "S256",
        **{chave: str(valor) for chave, valor in (config.get("extra") or {}).items()},
    }
    fluxo.url = f"{config['authorize']}?{urlencode(parametros)}"

    threading.Thread(target=servidor.serve_forever, daemon=True).start()
    return {"tipo": "pkce", "url": fluxo.url, "estado": "aguardando"}


def _iniciar_device(fluxo: _Fluxo) -> dict[str, Any]:
    config = fluxo.config
    try:
        with httpx.Client(timeout=20) as cliente:
            resposta = cliente.post(
                config["device"],
                data={"client_id": config["client_id"], "scope": _escopos(config)},
                headers={"accept": "application/json"},
            )
            resposta.raise_for_status()
            dado = resposta.json()
    except (httpx.HTTPError, ValueError) as erro:
        fluxo.estado = "erro"
        fluxo.detalhe = f"o fornecedor não deu o código do dispositivo: {erro}"
        return {"tipo": "device", "mensagem": fluxo.detalhe, "estado": "erro"}

    fluxo.codigo = dado.get("user_code")
    fluxo.url = dado.get("verification_uri") or dado.get("verification_url")
    fluxo.state = dado.get("device_code", "")
    intervalo = max(int(dado.get("interval") or 5), 5)
    expira = int(dado.get("expires_in") or 900)

    def esperar() -> None:
        limite = time.time() + min(expira, ESPERA_S)
        while time.time() < limite and fluxo.estado == "aguardando":
            time.sleep(intervalo)
            try:
                with httpx.Client(timeout=20) as cliente:
                    resposta = cliente.post(
                        config["token"],
                        data={
                            "client_id": config["client_id"],
                            "device_code": fluxo.state,
                            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                        },
                        headers={"accept": "application/json"},
                    )
                    dado = resposta.json()
            except (httpx.HTTPError, ValueError):
                continue
            if dado.get("access_token"):
                _concluir(fluxo, dado)
                return
            if dado.get("error") not in (None, "authorization_pending", "slow_down"):
                fluxo.estado = "erro"
                fluxo.detalhe = str(dado.get("error_description") or dado.get("error"))
                return
        if fluxo.estado == "aguardando":
            fluxo.estado = "erro"
            fluxo.detalhe = "o código venceu sem confirmação"

    threading.Thread(target=esperar, daemon=True).start()
    return {"tipo": "device", "url": fluxo.url, "codigo": fluxo.codigo, "estado": "aguardando"}


def _iniciar_qoder(fluxo: _Fluxo) -> dict[str, Any]:
    """O login do Qoder: página de dispositivos + consulta até a conta ser escolhida.

    O Qoder não usa device code padrão nem OAuth de redirecionamento: ele abre
    `qoder.com/device/selectAccounts` com um **challenge PKCE**, um `nonce` e uma
    `machine_id`, e a pessoa escolhe a conta lá. O app então consulta
    `/api/v1/deviceToken/poll` com o `nonce` e o `verifier` até o token aparecer.

    O `machine_id` é uma identidade desta máquina (uuid) — é o que o Qoder usa para amarrar o
    dispositivo; ele fica guardado junto com o login para as renovações.
    """
    import uuid as _uuid

    config = fluxo.config
    openapi = str(config["openapi"]).rstrip("/")
    machine = str(_uuid.uuid4())
    parametros = {
        "challenge": _challenge(fluxo.verifier),
        "challenge_method": "S256",
        "nonce": fluxo.state,
        "machine_id": machine,
        "client_id": config["client_id"],
    }
    fluxo.url = f"{config['login']}?{urlencode(parametros)}"

    def esperar() -> None:
        limite = time.time() + ESPERA_S
        while time.time() < limite and fluxo.estado == "aguardando":
            time.sleep(3)
            try:
                with httpx.Client(timeout=20) as cliente:
                    resposta = cliente.get(
                        f"{openapi}/api/v1/deviceToken/poll",
                        params={"nonce": fluxo.state, "verifier": fluxo.verifier},
                        headers={"accept": "application/json"},
                    )
            except httpx.HTTPError:
                continue
            if resposta.status_code in (404, 400):
                # 404 = a página ainda não registrou este nonce (ninguém escolheu a conta);
                # 400 sem verifier seria erro nosso, e o laço desiste abaixo pelo tempo.
                continue
            if resposta.status_code >= 400:
                fluxo.estado = "erro"
                fluxo.detalhe = f"o Qoder recusou: HTTP {resposta.status_code} {resposta.text[:160]}"
                return
            try:
                dado = resposta.json()
            except ValueError:
                continue
            if _concluir_qoder(fluxo, config, dado, machine):
                return
        if fluxo.estado == "aguardando":
            fluxo.estado = "erro"
            fluxo.detalhe = "o tempo do login acabou — a conta não foi escolhida na página"

    threading.Thread(target=esperar, daemon=True).start()
    return {"tipo": "device", "url": fluxo.url, "estado": "aguardando"}


def _concluir_qoder(
    fluxo: _Fluxo, config: dict[str, Any], dado: dict[str, Any], machine: str
) -> bool:
    """Troca o device token pelo par de tokens da conta. `True` quando concluiu."""
    corpo = dado.get("data") if isinstance(dado.get("data"), dict) else dado
    device = corpo.get("deviceToken") or corpo.get("token") or corpo.get("accessToken")
    if not device:
        return False
    openapi = str(config["openapi"]).rstrip("/")
    trocado: dict[str, Any] = {}
    for tentativa in (
        {"json": {"deviceToken": device, "machineId": machine}},
        {"headers": {"authorization": f"Bearer {device}"}},
    ):
        try:
            with httpx.Client(timeout=30) as cliente:
                resposta = cliente.post(
                    f"{openapi}/api/v1/jobToken/exchange",
                    headers={"accept": "application/json", **tentativa.get("headers", {})},
                    **({"json": tentativa["json"]} if "json" in tentativa else {}),
                )
        except httpx.HTTPError:
            continue
        if resposta.status_code < 400:
            try:
                trocado = resposta.json()
            except ValueError:
                trocado = {}
            break
    dados = trocado.get("data") if isinstance(trocado.get("data"), dict) else trocado
    acesso = dados.get("accessToken") or dados.get("access_token") or device
    fluxo.estado = "concluido"
    # O `dt-…` **é** a credencial (o `/userinfo` aceita ele direto como Bearer), então a conta
    # sai de lá — antes ficava sem nome e a tela mostrava «conta sem nome».
    fluxo.conta = dados.get("email") or dados.get("name") or _conta_qoder(config, acesso)
    _gravar(fluxo.settings, fluxo.id, {
        "id": fluxo.id,
        "conta": fluxo.conta,
        "access": acesso,
        "refresh": dados.get("refreshToken") or dados.get("refresh_token"),
        "expiraEm": _expira_em({"expires_in": dados.get("expiresIn") or dados.get("expires_in")}),
        "id_token": None,
        "escopo": machine,
    })
    return True


def _conta_qoder(config: dict[str, Any], token: str) -> str | None:
    """Quem é a conta, pelo `/userinfo` do Qoder (aceita o device token como Bearer)."""
    url = config.get("userinfo")
    if not url:
        return None
    try:
        with httpx.Client(timeout=15) as cliente:
            resposta = cliente.get(url, headers={"authorization": f"Bearer {token}"})
            if resposta.status_code >= 400:
                return None
            dados = resposta.json()
    except (httpx.HTTPError, ValueError):
        return None
    return dados.get("email") or dados.get("name") or dados.get("username")


def _iniciar_aws_sso(fluxo: _Fluxo) -> dict[str, Any]:
    """O device flow do AWS SSO (Kiro): registra o cliente, pede o código e fica consultando.

    São três passos porque é assim que a AWS publica — o cliente OAuth é **registrado em tempo
    de execução** (`/client/register`), não existe um `client_id` fixo como nos outros. O que
    fica guardado é o par cliente+código, e o token sai do `/token` quando a pessoa aprova.
    """
    config = fluxo.config
    base = str(config["oidc"]).rstrip("/")
    try:
        with httpx.Client(timeout=30) as cliente:
            registro = cliente.post(
                f"{base}/client/register",
                json={
                    "clientName": config.get("client_name") or "koda",
                    "clientType": "public",
                    "scopes": config.get("scopes") or [],
                    "grantTypes": config.get("grant_types") or [],
                },
            )
            registro.raise_for_status()
            criado = registro.json()
            fluxo.state = json.dumps(
                {
                    "clientId": criado.get("clientId"),
                    "clientSecret": criado.get("clientSecret"),
                }
            )
            autorizacao = cliente.post(
                f"{base}/device_authorization",
                json={
                    "clientId": criado.get("clientId"),
                    "clientSecret": criado.get("clientSecret"),
                    "startUrl": config.get("start_url"),
                },
            )
            autorizacao.raise_for_status()
            dado = autorizacao.json()
    except (httpx.HTTPError, ValueError) as erro:
        fluxo.estado = "erro"
        fluxo.detalhe = f"a AWS não abriu o login: {erro}"
        return {"tipo": "device", "mensagem": fluxo.detalhe, "estado": "erro"}

    fluxo.codigo = dado.get("userCode")
    fluxo.url = dado.get("verificationUriComplete") or dado.get("verificationUri")
    device_code = str(dado.get("deviceCode") or "")
    intervalo = max(int(dado.get("interval") or 5), 5)
    expira = int(dado.get("expiresIn") or 600)

    def esperar() -> None:
        limite = time.time() + min(expira, ESPERA_S)
        credenciais = json.loads(fluxo.state)
        while time.time() < limite and fluxo.estado == "aguardando":
            time.sleep(intervalo)
            try:
                with httpx.Client(timeout=20) as cliente:
                    resposta = cliente.post(
                        f"{base}/token",
                        json={
                            "clientId": credenciais.get("clientId"),
                            "clientSecret": credenciais.get("clientSecret"),
                            "deviceCode": device_code,
                            "grantType": "urn:ietf:params:oauth:grant-type:device_code",
                        },
                    )
                    dado = resposta.json()
            except (httpx.HTTPError, ValueError):
                continue
            if dado.get("accessToken"):
                _concluir(
                    fluxo,
                    {
                        "access_token": dado.get("accessToken"),
                        "refresh_token": dado.get("refreshToken"),
                        "expires_in": dado.get("expiresIn"),
                    },
                )
                return
            if dado.get("error") not in (None, "authorization_pending", "slow_down"):
                fluxo.estado = "erro"
                fluxo.detalhe = str(dado.get("error_description") or dado.get("error"))
                return
        if fluxo.estado == "aguardando":
            fluxo.estado = "erro"
            fluxo.detalhe = "o código venceu sem confirmação"

    threading.Thread(target=esperar, daemon=True).start()
    return {"tipo": "device", "url": fluxo.url, "codigo": fluxo.codigo, "estado": "aguardando"}


class _Handler(BaseHTTPRequestHandler):
    """O retorno do navegador: `?code=…&state=…` no caminho combinado."""

    def do_GET(self) -> None:  # noqa: N802 (nome do BaseHTTPRequestHandler)
        partes = urlparse(self.path)
        fluxo = getattr(self.server, "koda_fluxo", None)
        if fluxo is None or partes.path != (fluxo.config.get("caminho") or "/callback"):
            self.send_response(404)
            self.end_headers()
            return
        consulta = parse_qs(partes.query)
        if fluxo.config.get("verificar_state", True) and consulta.get("state", [""])[0] != fluxo.state:
            self._responder("Não deu", "O retorno não é deste login. Comece de novo no Koda.")
            return
        if fluxo.config.get("fonte") in {"zed", "windsurf", "trae"}:
            codigo = self.path if any(consulta.get(chave) for chave in
                                      ("access_token", "refreshToken", "refresh_token", "token")) else ""
        else:
            codigo = next((consulta[chave][0] for chave in
                           ("code", "refreshToken", "access_token", "token") if consulta.get(chave)), "")
        if not codigo:
            erro = consulta.get("error_description", consulta.get("error", ["sem código"]))[0]
            fluxo.estado = "erro"
            fluxo.detalhe = erro
            self._responder("Não deu", erro)
            return
        try:
            dado = _trocar_codigo(fluxo, codigo)
        except Exception as erro:  # noqa: BLE001 — a página precisa dizer o que houve
            fluxo.estado = "erro"
            fluxo.detalhe = str(erro)
            self._responder("Não deu", str(erro))
            return
        _concluir(fluxo, dado)
        if fluxo.estado == "concluido":
            self._responder("Pronto", "Login concluído. Pode fechar esta aba e voltar ao Koda.")
        else:
            self._responder("Não deu", fluxo.detalhe or "O provedor não concluiu o login.")

    def _responder(self, titulo: str, texto: str) -> None:
        corpo = _pagina(titulo, texto)
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(corpo)))
        self.end_headers()
        self.wfile.write(corpo)

    def log_message(self, *_args: Any) -> None:
        """Sem log: a linha do `http.server` no stderr não serve a ninguém aqui."""


def _fluxo_do_caminho(caminho_pedido: str) -> _Fluxo | None:
    with _trava:
        for fluxo in _vivos.values():
            if (fluxo.config.get("caminho") or "/callback") == caminho_pedido:
                return fluxo
    return None


def _trocar_codigo(fluxo: _Fluxo, codigo: str) -> dict[str, Any]:
    config = fluxo.config
    if config.get("motor") == "9router":
        from . import auth_9router

        pedido = auth_9router.chamar(
            fluxo.settings, config["fonte"], "exchange",
            code=codigo, redirectUri=fluxo.redirect, codeVerifier=fluxo.verifier,
            state=fluxo.state, meta=fluxo.auth_meta,
        )
        if not pedido.get("ok"):
            raise RuntimeError(pedido.get("error") or "o provedor recusou a troca do login")
        return pedido["result"]
    corpo: dict[str, Any] = {
        "grant_type": "authorization_code",
        "code": codigo,
        "redirect_uri": fluxo.redirect,
        "client_id": config["client_id"],
        "code_verifier": fluxo.verifier,
    }
    if config.get("client_secret"):
        corpo["client_secret"] = config["client_secret"]

    # O corpo do pedido de token não é igual em todo fornecedor (a Anthropic quer JSON, o
    # GitHub e o Google querem form). O JSON do provedor diz qual é, e o outro formato fica
    # de reserva — errar isso devolveria «invalid_request» e ninguém saberia por quê.
    formato = config.get("token_body", "form")
    with httpx.Client(timeout=30) as cliente:
        if formato == "json":
            resposta = cliente.post(config["token"], json=corpo,
                                    headers={"accept": "application/json"})
        else:
            resposta = cliente.post(config["token"], data=corpo,
                                    headers={"accept": "application/json"})
        if resposta.status_code >= 400 and formato == "json":
            resposta = cliente.post(config["token"], data=corpo,
                                    headers={"accept": "application/json"})
        if resposta.status_code >= 400:
            raise RuntimeError(f"o fornecedor recusou a troca: {resposta.text[:300]}")
        return resposta.json()


def _concluir(fluxo: _Fluxo, dado: dict[str, Any]) -> None:
    if fluxo.config.get("motor") == "9router":
        dado = {
            "access_token": dado.get("accessToken") or dado.get("apiKey"),
            "refresh_token": dado.get("refreshToken"),
            "expires_in": dado.get("expiresIn"),
            "expires_at": dado.get("expiresAt"),
            "id_token": dado.get("idToken"),
            "scope": dado.get("scope"),
            "email": dado.get("email") or dado.get("displayName"),
            "specific": {**(dado.get("providerSpecificData") or {}),
                         **({"apiKey": dado["apiKey"]} if dado.get("apiKey") else {})},
        }
    if not dado.get("access_token"):
        fluxo.estado = "erro"
        fluxo.detalhe = "o provedor não devolveu token de acesso"
        return
    fluxo.estado = "concluido"
    fluxo.conta = dado.get("email") or _conta_do_token(fluxo, dado)
    _gravar(fluxo.settings, fluxo.id, {
        "id": fluxo.id,
        "conta": fluxo.conta,
        "access": dado.get("access_token"),
        "refresh": dado.get("refresh_token"),
        "expiraEm": dado.get("expires_at") or _expira_em(dado),
        "id_token": dado.get("id_token"),
        "escopo": dado.get("scope"),
        "specific": dado.get("specific") or {},
    })
    if fluxo.servidor is not None:
        threading.Thread(target=fluxo.servidor.shutdown, daemon=True).start()


def _conta_do_token(fluxo: _Fluxo, dado: dict[str, Any]) -> str | None:
    if fluxo.id == "github":
        try:
            with httpx.Client(timeout=20) as cliente:
                resposta = cliente.get(
                    fluxo.config.get("userinfo", "https://api.github.com/user"),
                    headers={"authorization": f"Bearer {dado.get('access_token')}",
                             "accept": "application/vnd.github+json"},
                )
                return resposta.json().get("login")
        except (httpx.HTTPError, ValueError):
            return None
    claims = _claims(dado.get("id_token"))
    if claims.get("email"):
        return claims["email"]
    if fluxo.id in {"google", "antigravity"}:
        try:
            with httpx.Client(timeout=20) as cliente:
                resposta = cliente.get(
                    "https://www.googleapis.com/oauth2/v2/userinfo?alt=json",
                    headers={"authorization": f"Bearer {dado.get('access_token')}"},
                )
                return resposta.json().get("email")
        except (httpx.HTTPError, ValueError):
            return None
    return claims.get("preferred_username") or claims.get("sub")


def _extrair_codigo(texto: str) -> tuple[str, str]:
    """Aceita o que a pessoa tiver: a URL inteira, `code#state` ou só o código.

    O Claude mostra o código na página em vez de voltar sozinho (`code=true`), e o Codex cai
    nisso quando a porta 1455 está ocupada. Sem esta porta de entrada, esses dois casos
    ficariam sem saída.
    """
    limpo = (texto or "").strip()
    if not limpo:
        return "", ""
    if "code=" in limpo:
        consulta = parse_qs(urlparse(limpo).query)
        return consulta.get("code", [""])[0], consulta.get("state", [""])[0]
    if "#" in limpo:
        codigo, _, state = limpo.partition("#")
        return codigo.strip(), state.strip()
    return limpo, ""


def concluir_com_texto(settings: Settings, identificador: str, texto: str) -> dict[str, Any]:
    """Termina um login pelo código colado — o caminho de quem não volta sozinho."""
    with _trava:
        fluxo = _vivos.get(identificador)
    if fluxo is None:
        return {"ok": False, "mensagem": "não há login em andamento para este provedor"}
    if fluxo.config.get("motor") == "cookie":
        segredo = texto.strip()
        if not segredo:
            return {"ok": False, "mensagem": "cole a credencial da sessão"}
        _concluir(fluxo, {"access_token": segredo, "email": "Conta web",
                          "specific": {"apiKey": segredo}})
        return {"ok": fluxo.estado == "concluido", "conta": fluxo.conta,
                "mensagem": fluxo.detalhe if fluxo.estado != "concluido" else None}
    codigo, state = _extrair_codigo(texto)
    if not codigo:
        return {"ok": False, "mensagem": "não achei um código nesse texto"}
    if state and state != fluxo.state:
        return {"ok": False, "mensagem": "esse código é de outro login — comece de novo"}
    try:
        dado = _trocar_codigo(fluxo, codigo)
    except Exception as erro:  # noqa: BLE001 — a mensagem do fornecedor é a explicação
        fluxo.estado = "erro"
        fluxo.detalhe = str(erro)
        return {"ok": False, "mensagem": str(erro)}
    _concluir(fluxo, dado)
    return {"ok": fluxo.estado == "concluido", "conta": fluxo.conta,
            "mensagem": fluxo.detalhe if fluxo.estado != "concluido" else None}


def estado(identificador: str) -> dict[str, Any]:
    with _trava:
        fluxo = _vivos.get(identificador)
    if fluxo is None:
        return {"estado": "parado"}
    if fluxo.estado == "aguardando" and time.time() - fluxo.criado > ESPERA_S:
        fluxo.estado = "erro"
        fluxo.detalhe = "o tempo do login acabou"
    return {
        "estado": fluxo.estado,
        "detalhe": fluxo.detalhe,
        "conta": fluxo.conta,
        "url": fluxo.url,
        "codigo": fluxo.codigo,
    }


def cancelar(identificador: str) -> None:
    with _trava:
        fluxo = _vivos.pop(identificador, None)
    if fluxo and fluxo.servidor is not None:
        threading.Thread(target=fluxo.servidor.shutdown, daemon=True).start()


# ------------------------------------------------------------------- refresh


def garantir(settings: Settings, identificador: str) -> dict[str, Any] | None:
    """Devolve o login guardado com token válido, renovando se preciso."""
    dado = guardado(settings, identificador)
    if dado is None:
        return None
    expira = dado.get("expiraEm")
    if expira:
        try:
            quando = datetime.fromisoformat(expira)
        except ValueError:
            quando = None
        if quando is not None and quando > datetime.now(tz=timezone.utc):
            return dado
    if not dado.get("refresh"):
        return dado
    try:
        novo = _renovar(identificador, dado)
    except Exception:  # noqa: BLE001 — renovar é otimização, não pode derrubar a leitura
        novo = None
    if novo:
        dado.update(novo)
        _gravar(settings, identificador, dado)
    return dado


def _renovar(identificador: str, dado: dict[str, Any]) -> dict[str, Any] | None:
    config = FLUXOS.get(identificador)
    if config is None or not dado.get("refresh"):
        return None
    # Nem todo fluxo tem `client_id` fixo (o AWS SSO registra o cliente na hora, o Qoder usa o
    # par device/machine). Sem ele não há renovação por aqui — e isso não pode derrubar a
    # listagem inteira, que era o que acontecia (KeyError → 500 em `/api/provedores`).
    if not config.get("client_id"):
        return None
    corpo: dict[str, Any] = {
        "client_id": config["client_id"],
        "grant_type": "refresh_token",
        "refresh_token": dado["refresh"],
    }
    if config.get("client_secret"):
        corpo["client_secret"] = config["client_secret"]
    if config.get("refresh_scope"):
        corpo["scope"] = config["refresh_scope"]
    try:
        with httpx.Client(timeout=30) as cliente:
            if config.get("refresh_body", "form") == "json":
                resposta = cliente.post(config["token"], json=corpo,
                                        headers={"accept": "application/json"})
            else:
                resposta = cliente.post(config["token"], data=corpo,
                                        headers={"accept": "application/json"})
            if resposta.status_code >= 400:
                return None
            novo = resposta.json()
    except (httpx.HTTPError, ValueError):
        return None
    if not novo.get("access_token"):
        return None
    return {
        "access": novo.get("access_token"),
        "refresh": novo.get("refresh_token") or dado.get("refresh"),
        "expiraEm": _expira_em(novo),
        "id_token": novo.get("id_token") or dado.get("id_token"),
    }


def tipo(identificador: str) -> str:
    if identificador in FLUXOS:
        return FLUXOS[identificador].get("tipo", "pkce")
    if identificador in CLIS:
        return "cli"
    return "nada"
