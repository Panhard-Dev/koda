"""Chamadas de conversa das contas Gemini CLI e Antigravity."""

from __future__ import annotations

import hashlib
import json
import re
import threading
import time
import uuid
from collections.abc import AsyncIterator
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from . import zed_koda
from .providers.base import ProviderError, TransientProviderError


LOAD = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"
BASES = {
    "gemini-cli": "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    "antigravity": "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
}
_PROJETOS: dict[tuple[str, str], tuple[str, float]] = {}
_TRAVA = threading.Lock()


def _headers(identificador: str, conta: dict[str, Any]) -> dict[str, str]:
    token = str(conta.get("access") or "")
    if not token:
        raise ProviderError("a conta Google não tem token de acesso")
    usuario = "antigravity/hub/2.24.0 darwin/arm64" if identificador == "antigravity" else "gemini-cli/0.34.0 (win32; x64)"
    return {"authorization": f"Bearer {token}", "content-type": "application/json", "accept": "text/event-stream",
            "user-agent": usuario, "x-goog-api-client": "google-genai-sdk/1.41.0 gl-node/v22.19.0"}


async def _projeto(cliente: httpx.AsyncClient, identificador: str, conta: dict[str, Any]) -> str:
    especificos = conta.get("specific") or {}
    projeto = especificos.get("projectId") or especificos.get("project_id")
    if isinstance(projeto, dict):
        projeto = projeto.get("id")
    if isinstance(projeto, str) and projeto:
        return projeto
    chave = (identificador, hashlib.sha256(str(conta.get("access") or "").encode("utf-8")).hexdigest())
    with _TRAVA:
        anterior = _PROJETOS.get(chave)
    if anterior and anterior[1] > time.monotonic():
        return anterior[0]
    metadata = {"ideType": "ANTIGRAVITY" if identificador == "antigravity" else "IDE_UNSPECIFIED",
                "platform": "PLATFORM_UNSPECIFIED", "pluginType": "GEMINI"}
    resposta = await cliente.post(LOAD, headers=_headers(identificador, conta), json={"metadata": metadata})
    if resposta.status_code >= 400:
        raise ProviderError(f"Google não conseguiu consultar o projeto da conta (HTTP {resposta.status_code})")
    dados = resposta.json()
    projeto = dados.get("cloudaicompanionProject") if isinstance(dados, dict) else None
    if isinstance(projeto, dict):
        projeto = projeto.get("id")
    if not isinstance(projeto, str) or not projeto:
        raise ProviderError("o Google não devolveu um projeto Code Assist para esta conta")
    with _TRAVA:
        _PROJETOS[chave] = (projeto, time.monotonic() + 1800)
    return projeto


def _modelo(identificador: str, modelo: str) -> tuple[str, str | None]:
    if identificador != "antigravity":
        return modelo, None
    if modelo == "gemini-3.1-pro-high":
        return "gemini-pro-agent", None
    if modelo == "gemini-3.8-flash":
        return "gemini-3.8-flash-medium", "MEDIUM"
    if modelo in {"claude-sonnet-5-5", "claude-opus-5-5"}:
        return modelo + "-high", "HIGH"
    achado = re.fullmatch(r"(gemini-3\.[67]-flash)-(high|medium|low)", modelo)
    if achado:
        return achado.group(1) + "-tiered", achado.group(2).upper()
    achado = re.fullmatch(r"(.+)-(high|medium|low)", modelo)
    if achado:
        return modelo, achado.group(2).upper()
    return modelo, None


def _schema(valor: Any) -> Any:
    if isinstance(valor, list):
        return [_schema(item) for item in valor]
    if isinstance(valor, dict):
        return {chave: _schema(item) for chave, item in valor.items()
                if chave not in {"additionalProperties", "$schema", "$id", "examples", "default"}}
    return valor


def _corpo(identificador: str, projeto: str, modelo: str,
           mensagens: list[dict[str, Any]], ferramentas: list[dict[str, Any]]) -> dict[str, Any]:
    modelo, nivel = _modelo(identificador, modelo)
    request = zed_koda._google(mensagens, ferramentas)
    request["sessionId"] = str(uuid.uuid4().int % (10 ** 18))
    for grupo in request.get("tools") or []:
        for funcao in grupo.get("functionDeclarations") or []:
            funcao["parameters"] = _schema(funcao.get("parameters") or {})
    if ferramentas:
        request["toolConfig"] = {"functionCallingConfig": {"mode": "VALIDATED"}}
    if nivel:
        request.setdefault("generationConfig", {})["thinkingConfig"] = {"thinkingLevel": nivel, "includeThoughts": True}
    corpo: dict[str, Any] = {"project": projeto, "model": modelo, "request": request}
    if identificador == "antigravity":
        corpo["userAgent"] = "antigravity"
        corpo["requestId"] = f"agent/{uuid.uuid4()}/{int(time.time() * 1000)}/{uuid.uuid4()}/1"
    return corpo


async def linhas(identificador: str, conta: dict[str, Any], modelo: str,
                 mensagens: list[dict[str, Any]], ferramentas: list[dict[str, Any]], ao_limite: Any = None) -> AsyncIterator[str]:
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=20.0)) as cliente:
            projeto = await _projeto(cliente, identificador, conta)
            corpo = _corpo(identificador, projeto, modelo, mensagens, ferramentas)
            async with cliente.stream("POST", BASES[identificador], headers=_headers(identificador, conta), json=corpo) as resposta:
                if resposta.status_code in {409, 429}:
                    if ao_limite:
                        ate = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
                        ao_limite(conta, ate, "limite de uso atingido")
                    raise TransientProviderError("a conta Google está sem cota agora")
                if resposta.status_code >= 400:
                    detalhe = (await resposta.aread()).decode("utf-8", "replace")
                    raise ProviderError(f"Google respondeu HTTP {resposta.status_code}: {detalhe[:300]}")
                conversor = zed_koda.Conversor("google")
                async for linha in resposta.aiter_lines():
                    if not linha.startswith("data:"):
                        continue
                    carga = linha[5:].strip()
                    if not carga:
                        continue
                    if carga == "[DONE]":
                        break
                    try:
                        envelope = json.loads(carga)
                    except ValueError:
                        continue
                    if not isinstance(envelope, dict):
                        continue
                    if envelope.get("error"):
                        raise ProviderError(f"Google interrompeu a resposta: {str(envelope['error'])[:300]}")
                    evento = envelope.get("response", envelope)
                    if isinstance(evento, dict):
                        for pedaco in conversor.receber(evento):
                            yield pedaco
                for pedaco in conversor.terminar():
                    yield pedaco
    except (httpx.HTTPError, ValueError) as erro:
        raise TransientProviderError(f"não consegui falar com o Google: {erro}") from erro
