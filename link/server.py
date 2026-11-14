"""
koda-link — o "hbbs + hbbr" do Koda, mas tudo seu.

A ideia é a mesma do RustDesk:

  * o PC abre uma sala e mostra um QR com o endereço dela;
  * o celular entra na sala e fala com o Koda do PC;
  * quem estiver fora da mesma Wi-Fi usa este mesmo servidor rodando num
    lugar alcançável (VPS, Raspberry Pi, port forward ou Tailscale).

Não existe Koda Cloud aqui. O servidor só conhece salas e repassa quadros;
o token da API do Koda nunca sai do PC.

Dois modos, no mesmo processo:

  * **direto** — o servidor roda no próprio PC (`KODA_API_URL` definido) e
    repassa os pedidos para o backend local. É o modo "mesma Wi-Fi".
  * **relay** — o servidor roda fora do PC; o PC conecta nele como `host` e
    recebe os pedidos por WebSocket. É o modo "de qualquer lugar".

Rodar:

    KODA_API_URL=http://127.0.0.1:8787 \\
    KODA_API_TOKEN=... \\
    uvicorn server:app --host 0.0.0.0 --port 8798

Para o modo relay, basta subir sem `KODA_API_URL` num servidor alcançável.
"""

from __future__ import annotations

import asyncio
import base64
import codecs
import contextlib
import ipaddress
import json
import math
import os
import re
import secrets
import socket
import time
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

import httpx
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

RAIZ = Path(__file__).resolve().parent.parent
MOBILE_DIR = Path(os.environ.get("KODA_LINK_MOBILE_DIR") or RAIZ / "mobile")

API_URL = os.environ.get("KODA_API_URL", "").rstrip("/")
API_TOKEN = os.environ.get("KODA_API_TOKEN", "")
LINK_TOKEN = os.environ.get("KODA_LINK_TOKEN", "")
PUBLIC_URL = os.environ.get("KODA_LINK_PUBLIC_URL", "").rstrip("/")

#: A porta em que **este** processo está atendendo. O backend a preenche ao
#: subir o servidor (`_subir_servidor`), porque ela pode não ser a 8798: se a
#: 8798 estiver ocupada, o link sobe numa vizinha livre. O celular lê este
#: número no `/api/rede` e passa a falar com a porta certa.
PORTA: int | None = None

TTL = int(os.environ.get("KODA_LINK_TTL", "900"))
MAX_SALAS = int(os.environ.get("KODA_LINK_MAX_SALAS", "64"))
MAX_QUADRO = int(os.environ.get("KODA_LINK_MAX_QUADRO", str(24 * 1024 * 1024)))

#: Modo túnel: a porta só escuta em 127.0.0.1 e o Cloudflare é a única entrada.
#: Nesse modo até o loopback precisa do token para criar sala — senão o túnel
#: deixaria qualquer pessoa na internet abrir salas.
SO_PUBLICO = os.environ.get("KODA_LINK_SO_PUBLICO") == "1"

#: Modo rede local: o celular acha este PC na mesma Wi-Fi e entra sem QR, URL ou
#: chave. Ligado pelo interruptor do PC, nunca pelo túnel público. Enquanto está
#: ligado, qualquer aparelho da rede entra no Koda — é o preço de não pedir chave.
REDE_LOCAL = os.environ.get("KODA_LINK_REDE_LOCAL") == "1"

#: Freio do pareamento sem chave: quantas entradas por IP numa janela.
REDE_ENTRADAS = int(os.environ.get("KODA_LINK_REDE_ENTRADAS", "6"))
REDE_JANELA = float(os.environ.get("KODA_LINK_REDE_JANELA", "60"))

#: Freio de mão do celular: pedidos por janela, janela em segundos e quantos
#: pedidos podem estar vivos ao mesmo tempo (o chat é um; o resto é consulta).
RATE_LIMITE = int(os.environ.get("KODA_LINK_RATE", "90"))
RATE_JANELA = float(os.environ.get("KODA_LINK_RATE_JANELA", "60"))
MAX_CONCORRENTES = int(os.environ.get("KODA_LINK_CONCORRENTES", "4"))

ALFABETO = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
METODOS = frozenset({"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"})

#: O que o celular pode pedir. É uma lista fechada de propósito: o túnel é
#: público, e a API local tem rotas que não são para o celular (host, dev,
#: store, nuvem, contas, MCPs, remoto). Rota nova no mobile = linha nova aqui.
REGRAS_DE_API: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("GET", re.compile(r"/api/provedores")),
    ("GET", re.compile(r"/api/provedores/[^/]+/modelos")),
    # O catálogo do próprio Koda (GLM, Qwen), que no PC fica no topo do seletor.
    ("GET", re.compile(r"/api/models")),
    # O detalhe do provedor no celular mostra o login e testa se ele vale.
    ("POST", re.compile(r"/api/provedores/[^/]+/testar")),
    ("GET", re.compile(r"/api/permissions")),
    ("PUT", re.compile(r"/api/permissions")),
    ("GET", re.compile(r"/api/projects")),
    # Escolher pasta no celular é escolher a pasta do PC — e ela fica salva lá.
    ("POST", re.compile(r"/api/projects")),
    ("POST", re.compile(r"/api/projects/[^/]+/ativo")),
    ("POST", re.compile(r"/api/projects/soltar")),
    ("GET", re.compile(r"/api/fs/pastas")),
    # Histórico: listar, abrir e apagar as conversas do PC.
    ("GET", re.compile(r"/api/conversations")),
    ("GET", re.compile(r"/api/conversations/[^/]+")),
    ("DELETE", re.compile(r"/api/conversations/[^/]+")),
    ("GET", re.compile(r"/api/usage")),
    ("POST", re.compile(r"/api/chat")),
    ("POST", re.compile(r"/api/chat/approval")),
    # O cartão do plano (modo Plan) tem Fazer/Desistir no celular, como no PC.
    ("POST", re.compile(r"/api/chat/plan/decision")),
    # Modo ao vivo: o celular acompanha a rodada do PC (e a dele mesmo depois de
    # voltar ao app) e para o trabalho de verdade, sem depender de fechar a conexão.
    ("GET", re.compile(r"/api/live")),
    ("GET", re.compile(r"/api/live/[^/]+")),
    ("GET", re.compile(r"/api/live/[^/]+/eventos")),
    ("POST", re.compile(r"/api/live/parar")),
    ("POST", re.compile(r"/api/attachments")),
    # Navegador do celular: a lista de arquivos do projeto e os hosts do PC.
    ("GET", re.compile(r"/api/navegador/arquivos")),
    ("GET", re.compile(r"/api/navegador/hosts")),
    ("GET", re.compile(r"/api/navegador/pdf/info")),
    ("GET", re.compile(r"/api/health")),
)


def _permitido(metodo: str, caminho: str) -> bool:
    alvo = caminho.split("?", 1)[0]
    return any(metodo == regra_metodo and padrao.fullmatch(alvo) for regra_metodo, padrao in REGRAS_DE_API)


def _freio(sala: "Sala") -> str | None:
    """Janela deslizante + teto de pedidos vivos. Devolve o motivo ou `None`."""
    agora = time.monotonic()
    while sala.pedidos and agora - sala.pedidos[0] > RATE_JANELA:
        sala.pedidos.popleft()
    if len(sala.pedidos) >= RATE_LIMITE:
        return "limite de pedidos do link; espere um pouco"
    if len(sala.ativos) >= MAX_CONCORRENTES:
        return "há pedidos demais em andamento"
    return None


def _codigo(tamanho: int = 8) -> str:
    return "".join(secrets.choice(ALFABETO) for _ in range(tamanho))


def _agora() -> float:
    return time.time()


@dataclass
class Sala:
    id: str
    codigo: str
    segredo: str
    criada: float
    expira: float
    sessao: str | None = None
    host: WebSocket | None = None
    convidado: WebSocket | None = None
    tarefas: dict[str, asyncio.Task[None]] = field(default_factory=dict)
    trava_convidado: asyncio.Lock = field(default_factory=asyncio.Lock)
    #: Janela deslizante de pedidos e os ids que ainda estão vivos.
    pedidos: deque[float] = field(default_factory=deque)
    ativos: set[str] = field(default_factory=set)

    @property
    def pareada(self) -> bool:
        return bool(self.sessao)


SALAS: dict[str, Sala] = {}


def _bearer(request: Request) -> str:
    valor = request.headers.get("authorization", "")
    if valor.lower().startswith("bearer "):
        return valor[7:].strip()
    return ""


def _autorizado(request: Request) -> bool:
    """Criar sala é coisa do PC.

    Com `KODA_LINK_TOKEN`, só quem tem o token. Sem ele (o caso da Wi-Fi de
    casa), só quem está no próprio PC — um celular na mesma rede não pode
    abrir salas sozinho.
    """
    if LINK_TOKEN:
        return secrets.compare_digest(_bearer(request), LINK_TOKEN)
    if SO_PUBLICO:
        # Atrás do túnel todo pedido chega de 127.0.0.1; sem esta guarda o
        # loopback deixaria a internet inteira criar salas.
        return False
    host = request.client.host if request.client else ""
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _base_publica(request: Request) -> str:
    if PUBLIC_URL:
        return PUBLIC_URL
    return str(request.base_url).rstrip("/")


def _limpar_salas() -> None:
    agora = _agora()
    for sala_id, sala in list(SALAS.items()):
        if math.isinf(sala.expira):
            continue
        if sala.expira <= agora:
            for tarefa in sala.tarefas.values():
                tarefa.cancel()
            SALAS.pop(sala_id, None)


async def _varredor() -> None:
    while True:
        await asyncio.sleep(30)
        _limpar_salas()


@asynccontextmanager
async def lifespan(app: FastAPI):
    tarefa = asyncio.create_task(_varredor())
    try:
        yield
    finally:
        tarefa.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await tarefa
        for sala in list(SALAS.values()):
            for tarefa_sala in sala.tarefas.values():
                tarefa_sala.cancel()
        SALAS.clear()


app = FastAPI(
    title="koda-link",
    version="0.1.0",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


@app.middleware("http")
async def cabecalhos_de_seguranca(request: Request, call_next: Any) -> Any:
    # O pareamento na rede local é chamado de fora da página (o celular ainda não
    # está pareado), então essas duas rotas precisam de CORS. Só elas.
    da_rede = request.url.path.startswith("/api/rede")
    if da_rede and request.method == "OPTIONS":
        resposta = Response(status_code=204)
    else:
        resposta = await call_next(request)
    if da_rede:
        resposta.headers["access-control-allow-origin"] = "*"
        resposta.headers["access-control-allow-methods"] = "GET, POST, OPTIONS"
        resposta.headers["access-control-allow-headers"] = "content-type, x-koda-rede"
        resposta.headers["access-control-max-age"] = "600"
    resposta.headers.setdefault("x-content-type-options", "nosniff")
    # O Navegador do celular mostra hosts locais dentro de um iframe da própria
    # página do link; para essas rotas o quadro é o nosso. Fora delas, ninguém
    # emoldura o link.
    if request.url.path.startswith("/navegador/"):
        resposta.headers.setdefault("x-frame-options", "SAMEORIGIN")
    else:
        resposta.headers.setdefault("x-frame-options", "DENY")
    resposta.headers.setdefault("referrer-policy", "no-referrer")
    # O microfone fica de fora: o mobile usa voz para ditar. A câmera é do
    # próprio app: o celular precisa dela para ler o QR do computador.
    resposta.headers.setdefault("permissions-policy", "camera=(self), geolocation=()")
    if request.url.path.startswith("/api/"):
        resposta.headers.setdefault("cache-control", "no-store")
    elif request.url.path.startswith("/mobile"):
        # O Chrome recusa registrar um service worker servido com `no-store`.
        # `no-cache` mantém o app sempre novo e ainda permite a instalação.
        resposta.headers.setdefault("cache-control", "no-cache")
    return resposta


@app.get("/api/health")
async def health() -> dict[str, Any]:
    if SO_PUBLICO:
        return {"ok": True, "nome": "koda-link", "versao": "0.1.0"}
    return {
        "ok": True,
        "nome": "koda-link",
        "versao": "0.1.0",
        "salas": len(SALAS),
        "modo": "direto" if API_URL else "relay",
    }


@app.get("/api/transfer/{item_id}")
async def transferencia(item_id: str) -> Response:
    """Arquivo que o Koda do PC preparou para o celular.

    No modo direto (túnel ou mesma Wi-Fi) o link repassa para o backend local com o
    token que só o PC conhece. No modo relay o link está fora do PC e não alcança o
    disco dele; a transferência fica para uma versão futura.
    """
    if not re.fullmatch(r"[a-f0-9]{32}", item_id):
        raise HTTPException(status_code=404, detail="transferência desconhecida")
    if not API_URL:
        raise HTTPException(
            status_code=503,
            detail="transferência de arquivos só no modo túnel ou na mesma Wi-Fi",
        )
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, read=None)) as cliente:
            resposta = await cliente.get(
                f"{API_URL}/api/transfer/{item_id}",
                headers={"authorization": f"Bearer {API_TOKEN}"},
            )
    except httpx.HTTPError as erro:
        raise HTTPException(status_code=502, detail=f"o PC não respondeu: {erro}") from erro
    if resposta.status_code != 200:
        raise HTTPException(status_code=404, detail="essa transferência não existe mais")
    cabecalhos = {"cache-control": "no-store"}
    disposicao = resposta.headers.get("content-disposition")
    if disposicao:
        cabecalhos["content-disposition"] = disposicao
    return Response(
        content=resposta.content,
        media_type=resposta.headers.get("content-type", "application/octet-stream"),
        headers=cabecalhos,
    )


# ---------------------------------------------------------------------------
# Navegador do celular: arquivos, PDF e hosts locais
# ---------------------------------------------------------------------------


def _sala_da_sessao(sessao: str) -> "Sala | None":
    """A sala dona deste token de sessão. É a credencial do navegador no link."""
    if not sessao:
        return None
    for sala in list(SALAS.values()):
        if sala.sessao and secrets.compare_digest(sala.sessao, sessao):
            return sala
    return None


def _exigir_navegador(sessao: str) -> None:
    if _sala_da_sessao(sessao) is None:
        raise HTTPException(status_code=404, detail="sala desconhecida ou expirada")
    if not API_URL:
        raise HTTPException(
            status_code=503,
            detail="o navegador só funciona no modo túnel ou na mesma Wi-Fi",
        )


async def _buscar_no_backend(caminho: str, parametros: dict[str, str]) -> httpx.Response:
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, read=None)) as cliente:
            resposta = await cliente.get(
                f"{API_URL}{caminho}",
                params=parametros,
                headers={"authorization": f"Bearer {API_TOKEN}"},
            )
    except httpx.HTTPError as erro:
        raise HTTPException(status_code=502, detail=f"o PC não respondeu: {erro}") from erro
    if resposta.status_code >= 400:
        raise HTTPException(
            status_code=resposta.status_code,
            detail="o PC não conseguiu abrir esse arquivo",
        )
    return resposta


@app.get("/navegador/arquivo/{sessao}")
async def navegador_arquivo(sessao: str, base: str = "", caminho: str = "") -> Response:
    _exigir_navegador(sessao)
    resposta = await _buscar_no_backend(
        "/api/navegador/arquivo", {"base": base, "caminho": caminho}
    )
    cabecalhos = {"cache-control": "no-store"}
    disposicao = resposta.headers.get("content-disposition")
    if disposicao:
        cabecalhos["content-disposition"] = disposicao
    return Response(
        content=resposta.content,
        media_type=resposta.headers.get("content-type", "application/octet-stream"),
        headers=cabecalhos,
    )


@app.get("/navegador/pdf/{sessao}")
async def navegador_pdf(
    sessao: str, base: str = "", caminho: str = "", pagina: int = 1
) -> Response:
    _exigir_navegador(sessao)
    resposta = await _buscar_no_backend(
        "/api/navegador/pdf",
        {"base": base, "caminho": caminho, "pagina": str(pagina)},
    )
    return Response(
        content=resposta.content,
        media_type=resposta.headers.get("content-type", "image/png"),
        headers={"cache-control": "no-store"},
    )


#: Um cliente só para o Navegador: a página do Vite pede centenas de módulos, e abrir
#: uma conexão TCP por módulo era o que deixava a tela branca por dezenas de segundos.
_CLIENTE_NAVEGADOR: httpx.AsyncClient | None = None


def _cliente_do_navegador() -> httpx.AsyncClient:
    global _CLIENTE_NAVEGADOR
    if _CLIENTE_NAVEGADOR is None or _CLIENTE_NAVEGADOR.is_closed:
        _CLIENTE_NAVEGADOR = httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, read=60.0),
            follow_redirects=False,
            limits=httpx.Limits(
                max_connections=64,
                max_keepalive_connections=32,
                keepalive_expiry=60.0,
            ),
        )
    return _CLIENTE_NAVEGADOR


@app.api_route(
    "/navegador/{sessao}/{porta}/{caminho:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
)
async def navegador_proxy(
    sessao: str, porta: int, caminho: str, request: Request
) -> Response:
    """A página do host local e todos os recursos dela, dentro do link.

    O backend faz a reescrita e recebe de volta o prefixo público (`x-koda-prefixo`)
    para que os recursos continuem apontando para o túnel, não para o `127.0.0.1`.
    """
    _exigir_navegador(sessao)
    if not 1 <= porta <= 65535:
        raise HTTPException(status_code=400, detail="porta inválida")
    cabecalhos = {
        nome: valor
        for nome, valor in request.headers.items()
        if nome.lower() in {"accept", "accept-language", "content-type", "user-agent"}
    }
    corpo = await request.body()
    cliente = _cliente_do_navegador()
    try:
        pedido = cliente.build_request(
            request.method,
            f"{API_URL}/navegador/proxy/{quote(API_TOKEN, safe='')}/{porta}/{caminho}",
            params=request.query_params,
            headers={
                **cabecalhos,
                "authorization": f"Bearer {API_TOKEN}",
                "x-koda-prefixo": f"/navegador/{sessao}",
            },
            content=corpo or None,
        )
        resposta = await cliente.send(pedido, stream=True)
    except httpx.HTTPError as erro:
        raise HTTPException(
            status_code=502, detail=f"o PC não respondeu: {erro}"
        ) from erro

    async def fluxo() -> Any:
        try:
            async for pedaco in resposta.aiter_raw():
                yield pedaco
        finally:
            await resposta.aclose()

    proibidos = {
        "connection",
        "date",
        "keep-alive",
        "server",
        "set-cookie",
        "transfer-encoding",
    }
    return StreamingResponse(
        fluxo(),
        status_code=resposta.status_code,
        headers={
            nome: valor
            for nome, valor in resposta.headers.items()
            if nome.lower() not in proibidos
        },
    )


#: Entradas sem chave por IP: {ip: [instantes]}.
ENTRADAS_REDE: dict[str, deque[float]] = {}


def _da_rede_local(request: Request) -> bool:
    """Só IP privado, loopback ou link-local. A internet nunca entra por aqui."""
    host = request.client.host if request.client else ""
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback or ip.is_link_local


#: A página do APK é servida pelo WebViewAssetLoader, que usa este domínio fixo.
ORIGENS_DO_APK = {
    "https://appassets.androidplatform.net",
    "http://appassets.androidplatform.net",
}


def _origem_do_pareamento(request: Request) -> bool:
    """Aceita a página do próprio link, o APK e chamadas sem Origin.

    O APK antigo abria a página em `file://` e mandava `Origin: null`; o atual usa
    o WebViewAssetLoader e manda `https://appassets.androidplatform.net`. Um site
    qualquer tem origem `https://...` e continua recusado: o pareamento sem chave
    não pode ser disparado por uma aba aberta no celular.
    """
    origem = request.headers.get("origin")
    if not origem or origem == "null" or origem in ORIGENS_DO_APK:
        return True
    return urlsplit(origem).netloc == request.headers.get("host", "")


@app.get("/api/rede")
async def rede_info(request: Request) -> JSONResponse:
    """O celular bate nesta porta em cada IP da Wi-Fi até achar o Koda."""
    if not _da_rede_local(request):
        raise HTTPException(status_code=403, detail="só na rede local")
    return JSONResponse(
        {
            "koda": True,
            "nome": socket.gethostname(),
            "rede_local": REDE_LOCAL,
            "direto": bool(API_URL),
            # A porta real, que pode não ser a 8798 quando ela estava ocupada.
            "porta": PORTA,
        }
    )


@app.post("/api/rede/entrar")
async def rede_entrar(request: Request) -> JSONResponse:
    """Entra sem QR, URL ou chave — só quando o PC ligou o modo rede local."""
    if not _da_rede_local(request):
        raise HTTPException(status_code=403, detail="só na rede local")
    if not API_URL:
        raise HTTPException(
            status_code=503, detail="o pareamento na rede local só funciona no PC"
        )
    if not REDE_LOCAL:
        raise HTTPException(
            status_code=403, detail="o modo rede local está desligado no PC"
        )
    if not _origem_do_pareamento(request):
        raise HTTPException(status_code=403, detail="origem não permitida")

    host = request.client.host if request.client else "?"
    agora = time.monotonic()
    fila = ENTRADAS_REDE.setdefault(host, deque())
    while fila and agora - fila[0] > REDE_JANELA:
        fila.popleft()
    if len(fila) >= REDE_ENTRADAS:
        raise HTTPException(status_code=429, detail="tentativas demais; espere um pouco")
    fila.append(agora)

    _limpar_salas()
    if len(SALAS) >= MAX_SALAS:
        raise HTTPException(status_code=429, detail="há salas demais abertas; feche alguma")
    sala_id = secrets.token_hex(6)
    codigo = _codigo()
    segredo = secrets.token_urlsafe(24)
    criada = _agora()
    expira = float("inf") if TTL <= 0 else criada + TTL
    SALAS[sala_id] = Sala(
        id=sala_id,
        codigo=codigo,
        segredo=segredo,
        criada=criada,
        expira=expira,
    )
    base = _base_publica(request)
    return JSONResponse(
        {
            "koda": True,
            "sala": sala_id,
            "codigo": codigo,
            "url": f"{base}/mobile/#sala={sala_id}&codigo={codigo}",
            "modo": "direto" if API_URL else "relay",
            "expira_em": 0 if math.isinf(expira) else int(expira),
        }
    )


@app.post("/api/salas")
async def criar_sala(request: Request) -> JSONResponse:
    if not _autorizado(request):
        raise HTTPException(status_code=401, detail="sem autorização para abrir uma sala")
    _limpar_salas()
    if len(SALAS) >= MAX_SALAS:
        raise HTTPException(status_code=429, detail="há salas demais abertas; feche alguma")
    sala_id = secrets.token_hex(6)
    codigo = _codigo()
    segredo = secrets.token_urlsafe(24)
    agora = _agora()
    # TTL 0 = a sala vive até o dono fechar o link (o modo túnel usa isso).
    expira = float("inf") if TTL <= 0 else agora + TTL
    SALAS[sala_id] = Sala(
        id=sala_id,
        codigo=codigo,
        segredo=segredo,
        criada=agora,
        expira=expira,
    )
    base = _base_publica(request)
    return JSONResponse(
        {
            "sala": sala_id,
            "codigo": codigo,
            "segredo": segredo,
            "url": f"{base}/mobile/#sala={sala_id}&codigo={codigo}",
            "expira_em": 0 if math.isinf(expira) else int(expira),
            "modo": "direto" if API_URL else "relay",
        }
    )


@app.get("/api/salas/{sala_id}")
async def estado_sala(sala_id: str, request: Request) -> dict[str, Any]:
    if not _autorizado(request):
        raise HTTPException(status_code=401, detail="sem autorização")
    sala = SALAS.get(sala_id)
    if not sala or (not math.isinf(sala.expira) and sala.expira <= _agora()):
        raise HTTPException(status_code=404, detail="sala inexistente ou expirada")
    return {
        "sala": sala.id,
        "host": sala.host is not None,
        "convidado": sala.convidado is not None,
        "pareada": sala.pareada,
        "expira_em": 0 if math.isinf(sala.expira) else int(sala.expira),
        "modo": "direto" if API_URL else "relay",
    }


@app.delete("/api/salas/{sala_id}")
async def fechar_sala(sala_id: str, request: Request) -> dict[str, bool]:
    if not _autorizado(request):
        raise HTTPException(status_code=401, detail="sem autorização")
    sala = SALAS.pop(sala_id, None)
    if not sala:
        raise HTTPException(status_code=404, detail="sala inexistente")
    for tarefa in sala.tarefas.values():
        tarefa.cancel()
    for socket in (sala.host, sala.convidado):
        if socket is not None:
            with contextlib.suppress(Exception):
                await socket.close(code=4001, reason="sala fechada")
    return {"ok": True}


async def _recusar(websocket: WebSocket, code: int, reason: str) -> None:
    """Aceita e fecha com o código da aplicação.

    Fechar **antes** do `accept` vira um 403 no handshake, e o celular nunca
    recebe o motivo — ele fica tentando reconectar em vez de dizer que o código
    já foi usado. O aceite é imediato e nenhum quadro é trocado.
    """
    with contextlib.suppress(Exception):
        await websocket.accept()
        await websocket.close(code=code, reason=reason)


@app.websocket("/ws/{sala_id}")
async def relay(sala_id: str, websocket: WebSocket) -> None:
    papel = websocket.query_params.get("papel", "")
    sala = SALAS.get(sala_id)
    if not sala or (not math.isinf(sala.expira) and sala.expira <= _agora()):
        await _recusar(websocket, 4404, "sala inexistente ou expirada")
        return

    # No túnel, só a página servida pelo próprio link pode abrir o WebSocket.
    # Sem isso, um site qualquer que descubra a sala tenta se passar pelo celular.
    if SO_PUBLICO:
        origem = websocket.headers.get("origin")
        if origem and urlsplit(origem).netloc != websocket.headers.get("host", ""):
            await _recusar(websocket, 4403, "origem inválida")
            return

    if papel == "host":
        if not secrets.compare_digest(websocket.query_params.get("segredo", ""), sala.segredo):
            await _recusar(websocket, 4403, "segredo inválido")
            return
    elif papel == "convidado":
        codigo = websocket.query_params.get("codigo", "").upper()
        sessao = websocket.query_params.get("sessao", "")
        if sessao and sala.sessao and secrets.compare_digest(sessao, sala.sessao):
            pass
        elif sala.codigo and secrets.compare_digest(codigo, sala.codigo):
            sala.codigo = ""
            sala.sessao = secrets.token_urlsafe(24)
        else:
            await _recusar(websocket, 4403, "código inválido ou já usado")
            return
    else:
        await _recusar(websocket, 4400, "papel inválido")
        return

    await websocket.accept()

    if papel == "host":
        if sala.host is not None:
            with contextlib.suppress(Exception):
                await sala.host.close(code=4409, reason="outro PC entrou nesta sala")
        sala.host = websocket
    else:
        if sala.convidado is not None:
            with contextlib.suppress(Exception):
                await sala.convidado.close(code=4409, reason="outro celular entrou nesta sala")
        sala.convidado = websocket

    outro = sala.convidado if papel == "host" else sala.host
    if outro is not None:
        with contextlib.suppress(Exception):
            await outro.send_json(
                {"tipo": "presenca", "host": sala.host is not None, "convidado": sala.convidado is not None}
            )

    await websocket.send_json(
        {
            "tipo": "pareado",
            "sala": sala.id,
            "papel": papel,
            "sessao": sala.sessao if papel == "convidado" else None,
            "direto": bool(API_URL),
            "host": sala.host is not None,
            "convidado": sala.convidado is not None,
            "expira_em": 0 if math.isinf(sala.expira) else int(sala.expira),
        }
    )

    try:
        while True:
            texto = await websocket.receive_text()
            if len(texto) > MAX_QUADRO:
                await websocket.close(code=1009, reason="quadro grande demais")
                return
            try:
                dados = json.loads(texto)
            except ValueError:
                continue
            if not isinstance(dados, dict):
                continue

            tipo = dados.get("tipo")

            if tipo == "ping":
                await websocket.send_json({"tipo": "pong", "agora": _agora()})
                continue

            if papel == "convidado":
                if tipo == "pedido":
                    pedido_id = dados.get("id")
                    if not isinstance(pedido_id, str) or not pedido_id:
                        await _erro(websocket, pedido_id, "pedido sem id")
                        continue
                    if not _permitido(str(dados.get("metodo", "")).upper(), str(dados.get("caminho", ""))):
                        await _erro(websocket, pedido_id, "rota não permitida no link")
                        continue
                    motivo = _freio(sala)
                    if motivo:
                        await _erro(websocket, pedido_id, motivo)
                        continue
                    sala.pedidos.append(time.monotonic())
                    sala.ativos.add(pedido_id)
                    if sala.host is not None:
                        with contextlib.suppress(Exception):
                            await sala.host.send_text(texto)
                    elif API_URL:
                        await _iniciar_direto(sala, websocket, dados)
                    else:
                        sala.ativos.discard(pedido_id)
                        await _erro(websocket, pedido_id, "o PC ainda não está conectado")
                elif tipo == "cancelar":
                    pedido_id = dados.get("id")
                    if isinstance(pedido_id, str):
                        sala.ativos.discard(pedido_id)
                    if sala.host is not None:
                        with contextlib.suppress(Exception):
                            await sala.host.send_text(texto)
                continue

            # papel == "host": o PC devolve os quadros para o celular.
            if tipo in {"inicio", "pedaco", "fim", "erro", "evento"} and sala.convidado is not None:
                if tipo in {"fim", "erro"}:
                    pedido_id = dados.get("id")
                    if isinstance(pedido_id, str):
                        sala.ativos.discard(pedido_id)
                with contextlib.suppress(Exception):
                    await sala.convidado.send_text(texto)

    except WebSocketDisconnect:
        pass
    finally:
        if papel == "host" and sala.host is websocket:
            sala.host = None
            # Sem host não há quem responda: os pedidos vivos morreram junto.
            sala.ativos.clear()
        if papel == "convidado" and sala.convidado is websocket:
            sala.convidado = None
            for tarefa in sala.tarefas.values():
                tarefa.cancel()
            sala.tarefas.clear()
            sala.ativos.clear()
            sala.pedidos.clear()
        outro = sala.convidado if papel == "host" else sala.host
        if outro is not None:
            with contextlib.suppress(Exception):
                await outro.send_json(
                    {"tipo": "presenca", "host": sala.host is not None, "convidado": sala.convidado is not None}
                )


async def _erro(websocket: WebSocket, pedido_id: Any, mensagem: str) -> None:
    if not isinstance(pedido_id, str) or not pedido_id:
        return
    with contextlib.suppress(Exception):
        await websocket.send_json({"tipo": "erro", "id": pedido_id, "mensagem": mensagem})


async def _iniciar_direto(sala: Sala, websocket: WebSocket, pedido: dict[str, Any]) -> None:
    pedido_id = pedido.get("id")
    if not isinstance(pedido_id, str) or not pedido_id:
        return
    anterior = sala.tarefas.pop(pedido_id, None)
    if anterior is not None:
        anterior.cancel()
    tarefa = asyncio.create_task(_atender_direto(sala, websocket, pedido))
    sala.tarefas[pedido_id] = tarefa

    def _terminou(_: asyncio.Task[None]) -> None:
        if sala.tarefas.get(pedido_id) is tarefa:
            sala.tarefas.pop(pedido_id, None)

    tarefa.add_done_callback(_terminou)


def _cabecalhos_do_pedido(pedido: dict[str, Any]) -> dict[str, str]:
    cabecalhos = {
        "authorization": f"Bearer {API_TOKEN}",
        "x-koda-window": "mobile",
    }
    recebidos = pedido.get("cabecalhos")
    if isinstance(recebidos, dict):
        for nome in ("content-type", "accept"):
            valor = recebidos.get(nome)
            if isinstance(valor, str) and len(valor) < 400:
                cabecalhos[nome] = valor
    return cabecalhos


def _corpo_do_pedido(pedido: dict[str, Any]) -> bytes | None:
    if isinstance(pedido.get("corpo_b64"), str):
        try:
            return base64.b64decode(pedido["corpo_b64"], validate=True)
        except (ValueError, TypeError):
            return None
    if isinstance(pedido.get("corpo"), str):
        return pedido["corpo"].encode("utf-8")
    return None


async def _atender_direto(sala: Sala, websocket: WebSocket, pedido: dict[str, Any]) -> None:
    pedido_id = pedido["id"]
    metodo = str(pedido.get("metodo", "GET")).upper()
    caminho = str(pedido.get("caminho", ""))

    if (
        metodo not in METODOS
        or not caminho.startswith("/api/")
        or caminho.startswith("/api/remoto")
        or not _permitido(metodo, caminho)
        or "://" in caminho
        or ".." in caminho
        or "\n" in caminho
    ):
        await _erro(websocket, pedido_id, "pedido inválido")
        return

    corpo = _corpo_do_pedido(pedido)
    if corpo is None and pedido.get("corpo_b64") is not None:
        await _erro(websocket, pedido_id, "corpo inválido")
        return

    try:
        limite = httpx.Timeout(30.0, read=None, write=30.0, pool=30.0)
        async with httpx.AsyncClient(timeout=limite) as cliente:
            async with cliente.stream(
                metodo,
                f"{API_URL}{caminho}",
                content=corpo,
                headers=_cabecalhos_do_pedido(pedido),
            ) as resposta:
                tipo_conteudo = resposta.headers.get("content-type", "")
                eh_texto = any(
                    marca in tipo_conteudo
                    for marca in ("text/", "json", "event-stream", "xml", "javascript")
                )
                async with sala.trava_convidado:
                    await websocket.send_json(
                        {
                            "tipo": "inicio",
                            "id": pedido_id,
                            "status": resposta.status_code,
                            "cabecalhos": {"content-type": tipo_conteudo},
                        }
                    )

                decodificador = codecs.getincrementaldecoder("utf-8")("replace") if eh_texto else None
                async for pedaco in resposta.aiter_raw():
                    if decodificador is not None:
                        texto = decodificador.decode(pedaco)
                        if not texto:
                            continue
                        quadro = {"tipo": "pedaco", "id": pedido_id, "dados": texto}
                    else:
                        quadro = {
                            "tipo": "pedaco",
                            "id": pedido_id,
                            "dados_b64": base64.b64encode(pedaco).decode("ascii"),
                        }
                    async with sala.trava_convidado:
                        await websocket.send_json(quadro)

                if decodificador is not None:
                    resto = decodificador.decode(b"", final=True)
                    if resto:
                        async with sala.trava_convidado:
                            await websocket.send_json({"tipo": "pedaco", "id": pedido_id, "dados": resto})

        async with sala.trava_convidado:
            await websocket.send_json({"tipo": "fim", "id": pedido_id})
    except asyncio.CancelledError:
        with contextlib.suppress(Exception):
            async with sala.trava_convidado:
                await websocket.send_json({"tipo": "fim", "id": pedido_id, "cancelado": True})
        raise
    except Exception as erro:  # noqa: BLE001 — o celular precisa saber o que houve
        await _erro(websocket, pedido_id, str(erro) or "falha ao falar com o backend")
    finally:
        sala.ativos.discard(pedido_id)


PAGINA_ENTRADA = """<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#0d0d0f" />
<title>Koda Link</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100dvh; display: grid; place-items: center;
    background: #0d0d0f; color: #ececf1;
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
  }
  main { width: min(420px, calc(100% - 40px)); }
  h1 { font-size: 22px; letter-spacing: .18em; margin: 0 0 6px; font-weight: 600; }
  p { color: #8b8b96; margin: 0 0 22px; font-size: 13.5px; }
  label { display: block; font-size: 12px; color: #8b8b96; margin-bottom: 7px; }
  input {
    width: 100%; padding: 13px 14px; border-radius: 12px; border: 1px solid #2a2a31;
    background: #141418; color: #ececf1; font: inherit; outline: none;
  }
  input:focus { border-color: #6d5bd0; }
  button {
    width: 100%; margin-top: 12px; padding: 13px 14px; border: 0; border-radius: 12px;
    background: #ececf1; color: #0d0d0f; font: inherit; font-weight: 600; cursor: pointer;
  }
  small { display: block; margin-top: 18px; color: #6c6c76; font-size: 12px; }
</style>
</head>
<body>
<main>
  <h1>KODA LINK</h1>
  <p>Entre com o link ou o código que aparece no seu PC.</p>
  <form id="forma">
    <label for="destino">Link ou código</label>
    <input id="destino" autocomplete="off" autocapitalize="characters" placeholder="ABCD2345" />
    <button type="submit">Conectar</button>
  </form>
  <small>Este servidor é seu. Nada passa pela nuvem do Koda.</small>
</main>
<script>
  const forma = document.getElementById('forma')
  const campo = document.getElementById('destino')
  forma.addEventListener('submit', (evento) => {
    evento.preventDefault()
    const valor = campo.value.trim()
    if (!valor) return
    if (/^https?:\\/\\//i.test(valor)) {
      location.href = valor
      return
    }
    const partes = valor.split(/[-\\s]+/).filter(Boolean)
    if (partes.length === 2) {
      location.href = `/mobile/#sala=${encodeURIComponent(partes[0])}&codigo=${encodeURIComponent(partes[1])}`
      return
    }
    campo.setCustomValidity('Cole o link inteiro ou use SALA-CODIGO.')
    campo.reportValidity()
  })
</script>
</body>
</html>
"""


@app.get("/", response_class=HTMLResponse)
async def entrada() -> str:
    return PAGINA_ENTRADA


if MOBILE_DIR.exists():
    app.mount("/mobile", StaticFiles(directory=str(MOBILE_DIR), html=True), name="mobile")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "server:app",
        host=os.environ.get("KODA_LINK_HOST", "0.0.0.0"),
        port=int(os.environ.get("KODA_LINK_PORT", "8798")),
        log_level="info",
    )
