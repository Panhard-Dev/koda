"""Sessão de conta MiMo informada ao Koda, sem ler cookies de outros programas."""

from __future__ import annotations

import base64
import hashlib
import json
import threading
import time
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse

import httpx

from .providers.base import ProviderError, TransientProviderError


SIDS = {"cn": "mimopc", "sgp": "mimosgp", "ams": "mimoams", "ru": "mimoru", "in": "mimoin"}
MODELOS_CONTA = {"mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.6-pro-ultraspeed"}
_COOKIES: dict[str, tuple[str, float]] = {}
_TRAVA = threading.Lock()


def usa_conta(conta: dict[str, Any], modelo: str) -> bool:
    return bool((conta.get("specific") or {}).get("mimoPassToken")) and modelo.split("/", 1)[-1] in MODELOS_CONTA


def _regiao(conta: dict[str, Any]) -> str:
    regiao = str((conta.get("specific") or {}).get("region") or "sgp").lower()
    return regiao if regiao in SIDS else "sgp"


def _chave(conta: dict[str, Any]) -> str:
    dados = conta.get("specific") or {}
    texto = "\0".join(str(x or "") for x in (_regiao(conta), dados.get("mimoUserId"), dados.get("mimoPassToken")))
    return hashlib.sha256(texto.encode("utf-8")).hexdigest()


def _verificar_url(url: str) -> None:
    partes = urlparse(url)
    host = (partes.hostname or "").lower()
    try:
        porta = partes.port
    except ValueError as erro:
        raise ProviderError("a Xiaomi devolveu um endereço de autenticação inválido") from erro
    if (partes.scheme != "https" or partes.username or partes.password or porta not in (None, 443)
            or not any(host == base or host.endswith("." + base) for base in ("xiaomi.com", "xiaomimimo.com"))):
        raise ProviderError("a Xiaomi devolveu um endereço de autenticação inválido")


async def _sessao(cliente: httpx.AsyncClient, conta: dict[str, Any], *, renovar: bool = False) -> str:
    dados = conta.get("specific") or {}
    segredo = str(dados.get("mimoPassToken") or "")
    if not segredo or any(c in segredo for c in "\r\n;"):
        raise ProviderError("a conta MiMo precisa da sessão autorizada pelo usuário")
    chave = _chave(conta)
    with _TRAVA:
        anterior = _COOKIES.get(chave)
    if not renovar and anterior and anterior[1] > time.monotonic():
        return anterior[0]
    regiao = _regiao(conta)
    sid = SIDS[regiao]
    jar = {"passToken": segredo}
    for campo, nome in (("mimoUserId", "userId"), ("mimoCUserId", "cUserId")):
        valor = str(dados.get(campo) or "")
        if any(c in valor for c in "\r\n;"):
            raise ProviderError("identidade da conta MiMo inválida")
        if valor:
            jar[nome] = valor
    cookie = "; ".join(f"{k}={v}" for k, v in jar.items())
    resposta = await cliente.get("https://account.xiaomi.com/pass/serviceLogin",
        params={"_locale": "zh_CN", "_snsNone": "true", "sid": sid, "_json": "true"},
        headers={"cookie": cookie, "user-agent": "MiClaw/1.0", "accept": "application/json"})
    if resposta.status_code >= 400:
        raise ProviderError(f"Xiaomi recusou a sessão (HTTP {resposta.status_code})")
    try:
        login = json.loads(resposta.text.removeprefix("&&&START&&&"))
    except ValueError as erro:
        raise ProviderError("Xiaomi devolveu uma autenticação inválida") from erro
    if (not isinstance(login, dict) or login.get("code") != 0 or not login.get("location")
            or not login.get("nonce") or not login.get("ssecurity")):
        raise ProviderError("a conta Xiaomi precisa ser autenticada novamente")
    for nome, valor in resposta.cookies.items():
        if nome and valor:
            jar[nome] = valor
    digest = hashlib.sha1(f"nonce={login['nonce']}&{login['ssecurity']}".encode("utf-8")).digest()
    endereco = str(login["location"])
    _verificar_url(endereco)
    partes = urlparse(endereco)
    parametros = parse_qsl(partes.query, keep_blank_values=True)
    parametros.append(("clientSign", base64.b64encode(digest).decode("ascii")))
    endereco = urlunparse(partes._replace(query=urlencode(parametros)))
    for _ in range(8):
        _verificar_url(endereco)
        retorno = await cliente.get(endereco, headers={"user-agent": "MiClaw/1.0"}, follow_redirects=False)
        for nome, valor in retorno.cookies.items():
            if nome and valor:
                jar[nome] = valor
        if 300 <= retorno.status_code < 400 and retorno.headers.get("location"):
            endereco = urljoin(endereco, retorno.headers["location"])
            continue
        if retorno.status_code >= 400:
            raise ProviderError(f"Xiaomi não concluiu a autenticação (HTTP {retorno.status_code})")
        break
    else:
        raise ProviderError("a autenticação Xiaomi excedeu o limite de redirecionamentos")
    if not jar.get("serviceToken") and jar.get(f"{sid}_serviceToken"):
        jar["serviceToken"] = jar[f"{sid}_serviceToken"]
    if not jar.get("serviceToken"):
        raise ProviderError("Xiaomi não devolveu o token de serviço")
    permitidos = {nome: valor for nome, valor in jar.items()
                  if nome in {"serviceToken", "userId"} or nome.endswith(("_ph", "_slh"))}
    if any(any(c in str(valor) for c in "\r\n;") for valor in permitidos.values()):
        raise ProviderError("Xiaomi devolveu uma sessão inválida")
    resultado = "; ".join(f"{nome}={valor}" for nome, valor in permitidos.items())
    with _TRAVA:
        _COOKIES[chave] = (resultado, time.monotonic() + 1800)
    return resultado


async def linhas(conta: dict[str, Any], modelo: str, mensagens: list[dict[str, Any]],
                 tools: list[dict[str, Any]]) -> AsyncIterator[str]:
    regiao = _regiao(conta)
    url = f"https://mimo-server-{regiao}.xiaomimimo.com/api/route/chat/completions"
    corpo: dict[str, Any] = {"model": modelo.split("/", 1)[-1], "messages": mensagens, "stream": True,
                             "temperature": 1, "top_p": 0.95}
    if tools:
        corpo["tools"] = tools
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=20.0), follow_redirects=False) as cliente:
            for tentativa in range(2):
                cookie = await _sessao(cliente, conta, renovar=tentativa > 0)
                headers = {"cookie": cookie, "content-type": "application/json", "accept": "text/event-stream",
                           "user-agent": "miNative PC/Normal Windows_NT/10.0.19045 SDKV/1.0.0 DEVT/PC DEVS/Windows APP/miaccount_desktop APPV/0.1.0"}
                async with cliente.stream("POST", url, headers=headers, json=corpo) as resposta:
                    if resposta.status_code == 401 and tentativa == 0:
                        await resposta.aread()
                        continue
                    if resposta.status_code == 429:
                        raise TransientProviderError("a conta MiMo está sem cota agora")
                    if resposta.status_code >= 400:
                        raise ProviderError(f"MiMo recusou a conversa (HTTP {resposta.status_code})")
                    async for linha in resposta.aiter_lines():
                        if linha.startswith("data:"):
                            yield linha
                    return
            raise ProviderError("MiMo recusou a autenticação")
    except httpx.HTTPError as erro:
        raise TransientProviderError(f"não consegui falar com o MiMo: {erro}") from erro
