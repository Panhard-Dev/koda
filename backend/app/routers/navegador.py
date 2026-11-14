"""Rotas do Navegador do celular.

Duas famílias, de propósito:

- `/api/navegador/...` — listas e arquivos. Passam pelo token normal do backend, que o
  link já apresenta; o celular pede por elas pelo mesmo caminho de sempre.
- `/navegador/proxy/...` — a página do host local e **todos** os recursos dela. Fica fora
  de `/api` porque um `iframe` não manda `Authorization`: o token vai no caminho, e é
  conferido aqui, uma vez por pedido.

O proxy só fala com `127.0.0.1`, nunca com a internet: quem navega para fora é o próprio
WebView do celular. É o que permite abrir o backend, o front e o servidor de modelos sem
expor a rede da casa.
"""

from __future__ import annotations

import asyncio
import hmac
import mimetypes
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse

from .. import navegador, seguranca
from ..config import Settings

router = APIRouter(tags=["navegador"])

#: Cabeçalhos que não devem ser repassados nem para o host nem de volta.
_NAO_REPASSAR = frozenset(
    {
        "authorization",
        "connection",
        "content-encoding",
        "content-length",
        "cookie",
        "host",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "set-cookie",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    }
)

#: Cabeçalhos que atrapalham o preview dentro de um iframe.
_NAO_VOLTAR = frozenset(
    {
        "content-security-policy",
        "content-security-policy-report-only",
        # O uvicorn já carimba `date` e `server` na resposta; repassar os do host criava
        # cabeçalho duplicado — inválido em HTTP, e o túnel/WebView pode recusar.
        "date",
        "server",
        "x-frame-options",
        "cross-origin-embedder-policy",
        "cross-origin-opener-policy",
        "cross-origin-resource-policy",
    }
)


#: Cliente HTTP compartilhado com o host local. Um cliente por pedido abria uma conexão
#: TCP nova para **cada** módulo do Vite — e uma página de dev são centenas. Reaproveitar
#: a conexão é o que faz a diferença entre uma página que abre e uma que fica branca.
_CLIENTE: httpx.AsyncClient | None = None


def _cliente_do_proxy() -> httpx.AsyncClient:
    global _CLIENTE
    if _CLIENTE is None or _CLIENTE.is_closed:
        _CLIENTE = httpx.AsyncClient(
            timeout=httpx.Timeout(navegador.ESPERA_S, read=60.0),
            follow_redirects=False,
            limits=httpx.Limits(
                max_connections=64,
                max_keepalive_connections=32,
                keepalive_expiry=60.0,
            ),
        )
    return _CLIENTE


#: Cache curto dos recursos reescritos (html/css/js). O celular pede o mesmo módulo
#: várias vezes enquanto a página monta; guardar por alguns segundos evita refazer a
#: viagem túnel → backend → host → reescrita em Python para cada um.
_CACHE: "OrderedDict[tuple[str, int, str, str, str], tuple[float, int, str, dict[str, str], bytes]]" = OrderedDict()
_CACHE_BYTES = 0
_CACHE_MAX_BYTES = 48 * 1024 * 1024
_CACHE_LOCK = asyncio.Lock()


def _ttl_do_tipo(tipo: str) -> float:
    """Segundos que um recurso reescrito pode ser reaproveitado.

    HTML muda com um restart do host e é barato de reescrever: 5s. Módulo de JS/CSS é o
    que vem em maior número: 25s — o suficiente para uma recarga inteira, curto o
    bastante para o HMR do Vite não ficar preso numa versão velha.
    """
    if _e_texto(tipo):
        return 5.0
    if _e_css(tipo) or _e_js(tipo):
        return 25.0
    return 0.0


def _max_age_do_tipo(tipo: str, porta: int) -> int:
    """`cache-control` para o WebView — o cache do celular, entre uma abertura e outra."""
    if porta == 8787:
        # O backend do Koda responde estado vivo (conversa, modelos, sessões).
        return 0
    if _e_texto(tipo):
        return 5
    if _e_css(tipo) or _e_js(tipo):
        return 25
    if tipo.startswith(("image/", "font/", "audio/", "video/")):
        return 300
    return 0


def _pode_guardar(porta: int, request: Request, tipo: str, status: int) -> bool:
    if request.method != "GET" or status != 200 or porta == 8787:
        return False
    if tipo in {"application/json", "text/event-stream"} or tipo.endswith("+json"):
        return False
    return _ttl_do_tipo(tipo) > 0


def _chave_do_cache(prefixo: str, porta: int, caminho: str, request: Request) -> tuple[str, int, str, str, str]:
    # O prefixo entra na chave: a reescrita embute o endereço do túnel, que é por sessão.
    return (prefixo, porta, caminho, request.url.query, request.headers.get("accept", ""))


async def _ler_do_cache(chave: tuple[str, int, str, str, str]) -> tuple[int, str, dict[str, str], bytes] | None:
    global _CACHE_BYTES
    async with _CACHE_LOCK:
        item = _CACHE.get(chave)
        if item is None:
            return None
        if item[0] <= time.monotonic():
            _CACHE.pop(chave, None)
            _CACHE_BYTES -= len(item[4])
            return None
        _CACHE.move_to_end(chave)
        return item[1], item[2], item[3], item[4]


async def _guardar_no_cache(
    chave: tuple[str, int, str, str, str],
    status: int,
    tipo: str,
    cabecalhos: dict[str, str],
    corpo: bytes,
) -> None:
    global _CACHE_BYTES
    if len(corpo) > 4 * 1024 * 1024:
        return
    async with _CACHE_LOCK:
        antigo = _CACHE.pop(chave, None)
        if antigo is not None:
            _CACHE_BYTES -= len(antigo[4])
        _CACHE[chave] = (time.monotonic() + _ttl_do_tipo(tipo), status, tipo, cabecalhos, corpo)
        _CACHE_BYTES += len(corpo)
        while _CACHE and _CACHE_BYTES > _CACHE_MAX_BYTES:
            _, velho = _CACHE.popitem(last=False)
            _CACHE_BYTES -= len(velho[4])


def _settings(request: Request) -> Settings:
    return request.app.state.settings


def _raiz(base: str, request: Request) -> Path:
    """A pasta do projeto escolhido no celular, ou a pasta de trabalho padrão."""
    if base.strip():
        caminho = Path(base).expanduser()
    else:
        caminho = _settings(request).workspace_path
    if not caminho.is_dir():
        raise HTTPException(status_code=404, detail="essa pasta não existe no PC")
    return caminho.resolve()


def _alvo(base: str, caminho: str, request: Request) -> Path:
    raiz = _raiz(base, request)
    try:
        alvo = navegador.resolver(raiz, caminho)
    except ValueError as erro:
        raise HTTPException(status_code=400, detail=str(erro)) from erro
    if not alvo.is_file():
        raise HTTPException(status_code=404, detail="esse arquivo não existe")
    return alvo


@router.get("/api/navegador/arquivos")
async def arquivos(base: str = "", caminho: str = "", request: Request = None) -> dict:
    raiz = _raiz(base, request)
    try:
        return await asyncio.to_thread(navegador.listar, raiz, caminho)
    except ValueError as erro:
        raise HTTPException(status_code=404, detail=str(erro)) from erro


@router.get("/api/navegador/hosts")
async def hosts() -> dict:
    return {"hosts": await navegador.portas_locais()}


@router.get("/api/navegador/arquivo")
async def arquivo(base: str = "", caminho: str = "", request: Request = None) -> FileResponse:
    alvo = _alvo(base, caminho, request)
    tipo = mimetypes.guess_type(alvo.name)[0] or "application/octet-stream"
    return FileResponse(
        alvo,
        media_type=tipo,
        filename=alvo.name,
        headers={"cache-control": "no-store"},
    )


@router.get("/api/navegador/pdf/info")
async def pdf_info(base: str = "", caminho: str = "", request: Request = None) -> dict:
    alvo = _alvo(base, caminho, request)
    return await asyncio.to_thread(navegador.info_pdf, alvo)


@router.get("/api/navegador/pdf")
async def pdf_pagina(
    base: str = "", caminho: str = "", pagina: int = 1, request: Request = None
) -> Response:
    alvo = _alvo(base, caminho, request)
    try:
        dados = await asyncio.to_thread(navegador.pagina_pdf, alvo, pagina)
    except (ValueError, RuntimeError) as erro:
        raise HTTPException(status_code=400, detail=str(erro)) from erro
    return Response(
        dados,
        media_type="image/png",
        headers={"cache-control": "no-store"},
    )


# ---------------------------------------------------------------------------
# Proxy dos hosts locais
# ---------------------------------------------------------------------------


def _token_do_pedido(token: str) -> bool:
    atual = seguranca.token()
    if atual is None:
        # Dev sem token: a API inteira já está aberta, e o proxy não é a porta mais larga.
        return True
    return hmac.compare_digest(token, atual)


def _cabecalhos_para_o_host(request: Request, porta: int) -> dict[str, str]:
    cabecalhos = {
        nome: valor
        for nome, valor in request.headers.items()
        if nome.lower() not in _NAO_REPASSAR
    }
    # O front do Koda fala com o backend em 8787; o proxy apresenta o token que o
    # iframe não tem. Para qualquer outro host, o token não sai daqui.
    if porta == 8787 and seguranca.token():
        cabecalhos["authorization"] = f"Bearer {seguranca.token()}"
    # Sem compressão: o corpo de recursos binários é repassado cru, e um gzip sem o
    # cabeçalho `content-encoding` chegaria ao celular como lixo.
    cabecalhos["accept-encoding"] = "identity"
    return cabecalhos


def _cabecalhos_de_volta(
    resposta: httpx.Response, reescrito: bool, max_age: int = 0
) -> dict[str, str]:
    cabecalhos: dict[str, str] = {}
    for nome, valor in resposta.headers.items():
        baixo = nome.lower()
        if baixo in _NAO_REPASSAR or baixo in _NAO_VOLTAR:
            continue
        if reescrito and baixo in {"content-length", "content-encoding"}:
            continue
        if baixo == "cache-control":
            continue
        cabecalhos[nome] = valor
    cabecalhos["referrer-policy"] = "no-referrer"
    # `no-store` em tudo obrigava o WebView a baixar de novo cada módulo a cada abertura.
    cabecalhos["cache-control"] = (
        f"private, max-age={max_age}" if max_age > 0 else "no-store"
    )
    return cabecalhos


def _e_texto(tipo: str) -> bool:
    return tipo in {"text/html", "application/xhtml+xml"}


def _e_css(tipo: str) -> bool:
    return tipo == "text/css"


def _e_js(tipo: str) -> bool:
    return "javascript" in tipo or "ecmascript" in tipo


@router.api_route(
    "/navegador/proxy/{token}/{porta}/{caminho:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
)
async def proxy(
    token: str, porta: int, caminho: str, request: Request
) -> Response:
    if not _token_do_pedido(token):
        raise HTTPException(status_code=401, detail="token do navegador inválido")
    if not 1 <= porta <= 65535:
        raise HTTPException(status_code=400, detail="porta inválida")

    base = request.headers.get(navegador.PREFIXO_CABECALHO, "")
    if not navegador.prefixo_valido(base):
        base = f"/navegador/proxy/{navegador.cotar(token)}"
    prefixo = f"{base.rstrip('/')}/{porta}"
    prefixo_api = f"{base.rstrip('/')}/8787"

    alvo = navegador.url_do_alvo(porta, caminho)
    chave = _chave_do_cache(prefixo, porta, caminho, request)
    guardado = await _ler_do_cache(chave)
    if guardado is not None:
        status, tipo_guardado, cabecalhos_guardados, dados = guardado
        return Response(
            dados,
            status_code=status,
            media_type=f"{tipo_guardado}; charset=utf-8",
            headers={
                **cabecalhos_guardados,
                "cache-control": f"private, max-age={int(_ttl_do_tipo(tipo_guardado))}",
            },
        )

    corpo = await request.body()
    cabecalhos = _cabecalhos_para_o_host(request, porta)
    cliente = _cliente_do_proxy()
    try:
        pedido = cliente.build_request(
            request.method,
            alvo,
            params=request.query_params,
            headers=cabecalhos,
            content=corpo or None,
        )
        resposta = await cliente.send(pedido, stream=True)
    except httpx.HTTPError as erro:
        raise HTTPException(
            status_code=502, detail=f"o host local não respondeu: {erro}"
        ) from erro

    tipo = (resposta.headers.get("content-type") or "").split(";")[0].strip().lower()
    localizacao = resposta.headers.get("location")
    max_age = _max_age_do_tipo(tipo, porta)

    if resposta.status_code in {301, 302, 303, 307, 308} and localizacao:
        await resposta.aclose()
        destino = navegador.reescrever_location(localizacao, prefixo, porta)
        return Response(
            status_code=resposta.status_code,
            headers={"location": destino, "cache-control": "no-store"},
        )

    if _e_texto(tipo) or _e_css(tipo) or _e_js(tipo):
        try:
            dados = await resposta.aread()
        finally:
            await resposta.aclose()
        if len(dados) > navegador.MAX_REESCRITA:
            return Response(
                dados,
                status_code=resposta.status_code,
                media_type=tipo or None,
                headers=_cabecalhos_de_volta(resposta, reescrito=False, max_age=max_age),
            )
        texto = dados.decode(resposta.charset_encoding or "utf-8", errors="replace")
        if _e_texto(tipo):
            texto = navegador.reescrever_html(texto, prefixo, prefixo_api)
        elif _e_css(tipo):
            texto = navegador.reescrever_css(texto, prefixo)
        else:
            texto = navegador.reescrever_js(texto, prefixo)
        corpo_final = texto.encode("utf-8")
        cabecalhos_finais = _cabecalhos_de_volta(resposta, reescrito=True, max_age=max_age)
        if _pode_guardar(porta, request, tipo, resposta.status_code):
            await _guardar_no_cache(
                chave, resposta.status_code, tipo, cabecalhos_finais, corpo_final
            )
        return Response(
            corpo_final,
            status_code=resposta.status_code,
            media_type=f"{tipo}; charset=utf-8",
            headers=cabecalhos_finais,
        )

    async def fluxo() -> Any:
        try:
            async for pedaco in resposta.aiter_raw():
                yield pedaco
        finally:
            await resposta.aclose()

    return StreamingResponse(
        fluxo(),
        status_code=resposta.status_code,
        media_type=tipo or None,
        headers=_cabecalhos_de_volta(resposta, reescrito=False, max_age=max_age),
    )
