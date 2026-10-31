"""Transporte de conversa do Koda para os serviços Qoder internacional e chinês."""

from __future__ import annotations

import asyncio
import hashlib
import json
import threading
import time
import uuid
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any
from urllib.parse import urlparse

import httpx

from . import qoder_api, qoder_cosy
from .providers.base import ProviderError, TransientProviderError


REGIOES = {
    "qoder": ("https://api3.qoder.sh", "https://openapi.qoder.sh"),
    "qoder-cn": ("https://gateway.qoder.com.cn", "https://openapi.qoder.com.cn"),
}
CAMINHO_CHAT = "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1"
CAMINHO_MODELOS = "/algo/api/v2/model/list"
_CACHE_PAT: dict[tuple[str, str], tuple[str, float]] = {}
_TRAVA_PAT = threading.Lock()


def _assinar(url: str, credenciais: dict[str, str], corpo: str, *, chat: bool = False,
             modelo: dict[str, str] | None = None) -> dict[str, str]:
    cabecalhos = qoder_cosy.cabecalhos(url, credenciais, corpo, chat=chat, modelo=modelo)
    caminho = urlparse(url).path
    cabecalhos.update({"Cosy-Bodyhash": hashlib.md5(corpo.encode("ascii")).hexdigest(),
                       "Cosy-Bodylength": str(len(corpo.encode("ascii"))),
                       "Cosy-Sigpath": caminho[5:] if caminho.startswith("/algo") else caminho})
    return cabecalhos


async def _credenciais(cliente: httpx.AsyncClient, conta: dict[str, Any], openapi: str) -> dict[str, str]:
    especificos = conta.get("specific") or {}
    acesso = str(especificos.get("apiKey") or conta.get("access") or "")
    uid = str(especificos.get("userId") or "")
    nome = str(conta.get("conta") or "")
    email = nome if "@" in nome else ""
    if acesso.startswith("pt-"):
        chave = (openapi, hashlib.sha256(acesso.encode("utf-8")).hexdigest())
        with _TRAVA_PAT:
            cached = _CACHE_PAT.get(chave)
        if cached and cached[1] > time.time() + 300:
            acesso = cached[0]
        else:
            try:
                resposta = await cliente.post(f"{openapi}/api/v1/jobToken/exchange", json={"personal_token": acesso},
                                              headers={"accept": "application/json", "user-agent": "qodercli/1.0.0"})
                resposta.raise_for_status()
                troca = resposta.json()
            except (httpx.HTTPError, ValueError) as erro:
                raise ProviderError("não consegui validar a chave pessoal do Qoder") from erro
            if not isinstance(troca, dict) or not troca.get("token"):
                raise ProviderError("o Qoder não devolveu um token para a chave pessoal")
            acesso = str(troca["token"])
            try:
                expira = (datetime.fromisoformat(str(troca["expires_at"]).replace("Z", "+00:00")).timestamp()
                          if troca.get("expires_at") else time.time() + float(troca.get("expires_in") or 86400))
            except (TypeError, ValueError, OverflowError):
                expira = time.time() + 3600
            with _TRAVA_PAT:
                _CACHE_PAT[chave] = (acesso, expira)
        uid = ""
    if not uid:
        try:
            resposta = await cliente.get(f"{openapi}/api/v1/userinfo", headers={"authorization": f"Bearer {acesso}"})
            resposta.raise_for_status()
            info = resposta.json()
            if isinstance(info, dict):
                uid = str(info.get("id") or info.get("userId") or info.get("user_id") or "")
                nome = str(info.get("name") or nome)
                email = str(info.get("email") or email)
        except (httpx.HTTPError, ValueError):
            pass
    if not acesso or not uid:
        raise ProviderError("a conta Qoder não tem a identidade necessária; conecte-a novamente")
    maquina = str(especificos.get("machineId") or conta.get("escopo") or "")
    if not maquina:
        maquina = str(uuid.uuid5(uuid.NAMESPACE_URL, "koda-qoder:" + uid))
    return {"uid": uid, "name": nome, "email": email, "access": acesso, "machineId": maquina}


async def _modelo(cliente: httpx.AsyncClient, base: str, credenciais: dict[str, str], chave: str) -> dict[str, Any]:
    url = base + CAMINHO_MODELOS
    try:
        resposta = await cliente.get(url, headers=_assinar(url, credenciais, ""))
        resposta.raise_for_status()
        catalogo = resposta.json()
    except (httpx.HTTPError, ValueError) as erro:
        raise ProviderError("não consegui consultar os modelos da conta Qoder") from erro
    itens = catalogo.get("chat") if isinstance(catalogo, dict) else None
    if isinstance(itens, list):
        for item in itens:
            if isinstance(item, dict) and item.get("key") == chave:
                return item
    raise ProviderError(f"o modelo {chave} não está no catálogo desta conta Qoder")


def _texto(conteudo: Any) -> str:
    if isinstance(conteudo, str):
        return conteudo
    if isinstance(conteudo, list):
        return "\n".join(str(item.get("text") or "") for item in conteudo if isinstance(item, dict) and item.get("text"))
    return "" if conteudo is None else str(conteudo)


def _corpo(modelo: dict[str, Any], mensagens: list[dict[str, Any]], ferramentas: list[dict[str, Any]]) -> dict[str, Any]:
    chave = str(modelo["key"])
    instrucoes = "\n\n".join(_texto(item.get("content")) for item in mensagens if item.get("role") in {"system", "developer"}).strip()
    conversa = [dict(item) for item in mensagens if item.get("role") not in {"system", "developer"}]
    ultima = next((_texto(item.get("content")) for item in reversed(conversa) if item.get("role") == "user"), "")
    pedido, tarefa, sessao = (str(uuid.uuid4()) for _ in range(3))
    limite = modelo.get("max_output_tokens") or 8192
    try:
        limite = max(1, int(limite))
    except (TypeError, ValueError):
        limite = 8192
    return {
        "request_id": pedido, "request_set_id": tarefa, "chat_record_id": tarefa, "session_id": sessao,
        "stream": True, "chat_task": "FREE_INPUT", "is_reply": True, "is_retry": False, "source": 1,
        "version": "3", "session_type": "qodercli", "agent_id": "agent_common", "task_id": "common",
        "code_language": "", "chat_prompt": "", "image_urls": None, "aliyun_user_type": "",
        "system": instrucoes, "messages": conversa, "tools": ferramentas,
        "parameters": {"max_tokens": limite},
        "chat_context": {"chatPrompt": "", "imageUrls": None, "extra": {"context": [],
                         "modelConfig": {"key": chave, "is_reasoning": bool(modelo.get("is_reasoning"))},
                         "originalContent": ultima}, "features": [], "text": ultima},
        "model_config": modelo,
        "business": {"product": "cli", "version": "1.0.0", "type": "agent", "stage": "start",
                     "id": str(uuid.uuid4()), "name": ultima[:30], "begin_at": int(time.time() * 1000)},
    }


async def _aguardar_fila(cliente: httpx.AsyncClient, base: str, credenciais: dict[str, str],
                         corpo: dict[str, Any], info: dict[str, Any]) -> None:
    url = base + qoder_api.FILA
    parametros = {"requestSetId": corpo["request_set_id"], "modelKey": corpo["model_config"]["key"]}
    if info.get("queueType"):
        parametros["queueType"] = str(info["queueType"])
    headers = _assinar(url, credenciais, "")
    headers.update({"X-Request-ID": corpo["request_id"], "X-Session-ID": corpo["session_id"]})
    for _ in range(5):
        await asyncio.sleep(3)
        try:
            resposta = await cliente.get(url, params=parametros, headers=headers)
            resposta.raise_for_status()
            situacao = resposta.json()
            if isinstance(situacao, dict) and situacao.get("isQueued") is False:
                return
        except (httpx.HTTPError, ValueError):
            break


async def linhas(
    identificador: str, conta: dict[str, Any], modelo: str,
    mensagens: list[dict[str, Any]], ferramentas: list[dict[str, Any]],
) -> AsyncIterator[str]:
    """Entrega eventos OpenAI vindos do envelope Qoder, sem processo externo."""
    base, openapi = REGIOES[identificador]
    async with httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=20.0)) as cliente:
        credenciais = await _credenciais(cliente, conta, openapi)
        config = await _modelo(cliente, base, credenciais, modelo)
        url = base + CAMINHO_CHAT
        for tentativa in range(2):
            corpo = _corpo(config, mensagens, ferramentas)
            fio = qoder_cosy.codificar_corpo(json.dumps(corpo, separators=(",", ":"), ensure_ascii=False))
            headers = _assinar(url, credenciais, fio, chat=True,
                               modelo={"key": modelo, "source": str(config.get("source") or "system")})
            fila: dict[str, Any] | None = None
            enviou = False
            try:
                async with cliente.stream("POST", url, headers=headers, content=fio.encode("ascii")) as resposta:
                    if resposta.status_code >= 400:
                        texto = (await resposta.aread()).decode("utf-8", "replace")
                        if qoder_api._na_fila(texto):
                            fila = {}
                        else:
                            raise ProviderError(f"Qoder respondeu HTTP {resposta.status_code}: {texto[:300]}")
                    else:
                        async for linha in resposta.aiter_lines():
                            if not linha.startswith("data:"):
                                continue
                            carga = linha[5:].strip()
                            if carga == "[DONE]":
                                yield "data: [DONE]"
                                return
                            try:
                                envelope = json.loads(carga)
                            except ValueError:
                                continue
                            if not isinstance(envelope, dict):
                                continue
                            if qoder_api._evento_na_fila(envelope):
                                fila = qoder_api._info_da_fila(envelope)
                                break
                            try:
                                status = int(envelope.get("statusCodeValue") or 200)
                            except (TypeError, ValueError):
                                status = 200
                            interno = envelope.get("body", envelope)
                            if status != 200:
                                if isinstance(interno, str) and qoder_api._na_fila(interno):
                                    fila = qoder_api._info_da_fila({"message": interno})
                                    break
                                raise ProviderError(f"Qoder interrompeu a resposta ({status}): {str(interno)[:300]}")
                            if interno == "[DONE]":
                                yield "data: [DONE]"
                                return
                            if isinstance(interno, str):
                                try:
                                    interno = json.loads(interno)
                                except ValueError:
                                    continue
                            if isinstance(interno, dict):
                                enviou = True
                                yield "data: " + json.dumps(interno, ensure_ascii=False)
            except httpx.HTTPError as erro:
                raise TransientProviderError(f"não consegui falar com o Qoder: {erro}") from erro
            if fila is None:
                return
            if enviou:
                raise TransientProviderError("o Qoder entrou em fila após iniciar a resposta")
            if tentativa == 0:
                await _aguardar_fila(cliente, base, credenciais, corpo, fila)
        raise TransientProviderError("o modelo Qoder está na fila; tente novamente em alguns segundos")
