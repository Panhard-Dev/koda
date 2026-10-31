"""Cliente de conversa Trae SOLO do Koda."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import quote

import httpx

from .providers.base import ProviderError, TransientProviderError


BASE = "https://core-normal.trae.ai/api/remote/v1"


def _texto(valor: Any) -> str:
    if isinstance(valor, str):
        return valor
    if isinstance(valor, list):
        return "\n".join(str(item.get("text") or "") for item in valor if isinstance(item, dict) and item.get("text"))
    return "" if valor is None else str(valor)


def _query(mensagens: list[dict[str, Any]]) -> str:
    partes = []
    for mensagem in mensagens:
        role = str(mensagem.get("role") or "user")
        texto = _texto(mensagem.get("content"))
        if role == "assistant" and mensagem.get("tool_calls"):
            texto += "\n" + json.dumps(mensagem["tool_calls"], ensure_ascii=False)
        if role == "tool":
            texto = f"[Resultado da ferramenta {mensagem.get('tool_call_id') or ''}]\n{texto}"
        elif role in {"system", "developer", "assistant"}:
            texto = f"[{role}]\n{texto}"
        if texto:
            partes.append(texto)
    return json.dumps([{"type": "text", "data": {"content": "\n\n".join(partes)}}], ensure_ascii=False)


def _corpo(modelo: str, mensagens: list[dict[str, Any]], conta: dict[str, Any]) -> dict[str, Any]:
    especificos = conta.get("specific") or {}
    modo = "work" if modelo.lower() in {"work", "auto-work", "solo-work"} else "code"
    automatico = not modelo or modelo.lower() == "auto" or modo == "work"
    comum = {"language": "en-us", "app_language": especificos.get("appLanguage") or "en", "quality": "stable",
             "app_version": especificos.get("appVersion") or "1.0.0.1229", "web_id": especificos.get("webId") or "",
             "user_identity": especificos.get("userIdentity") or "Free", "is_freshman": "0",
             "biz_user_id": especificos.get("bizUserId") or "", "user_unique_id": especificos.get("userUniqueId") or "",
             "scope": especificos.get("scope") or "marscode-us", "tenant": especificos.get("tenant") or "marscode",
             "region": especificos.get("region") or "US-East", "aiRegion": especificos.get("aiRegion") or especificos.get("region") or "US-East",
             "is_privacy_mode": 0, "privacy_mode": "off", "solo_chat_mode": modo}
    return {"mode": modo, "environment_id": "default", "initial_message": {
        "chat_session_id": "", "content": [], "query": _query(mensagens), "model_name": "" if automatico else modelo,
        "agent_type": "solo_agent_remote", "model_selection_strategy": "auto" if automatico else "manual",
        "common_params": json.dumps(comum, ensure_ascii=False),
    }, "env": "remote", "auto_create_project": False, "origin": "web"}


def _sse(delta: dict[str, Any] | None = None, *, motivo: str | None = None, uso: dict[str, int] | None = None) -> str:
    evento: dict[str, Any] = {"choices": [{"index": 0, "delta": delta or {}, "finish_reason": motivo}]}
    if uso:
        evento["usage"] = uso
    return "data: " + json.dumps(evento, ensure_ascii=False)


async def linhas(conta: dict[str, Any], modelo: str, mensagens: list[dict[str, Any]]) -> AsyncIterator[str]:
    token = str(conta.get("access") or "")
    if not token:
        raise ProviderError("a conta Trae não tem token de acesso")
    especificos = conta.get("specific") or {}
    headers = {"authorization": f"Cloud-IDE-JWT {token}", "content-type": "application/json",
               "x-trae-client-type": "web", "x-preferenced-language": str(especificos.get("appLanguage") or "en"),
               "x-user-region": str(especificos.get("userRegion") or "US"), "referer": "https://solo.trae.ai/",
               "user-agent": "Mozilla/5.0 Koda/0.8.0", "accept": "text/event-stream"}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=20.0)) as cliente:
            resposta = await cliente.post(f"{BASE}/chat_sessions", headers=headers, json=_corpo(modelo, mensagens, conta))
            if resposta.status_code == 429:
                raise TransientProviderError("a conta Trae está sem cota agora")
            if resposta.status_code >= 400:
                raise ProviderError(f"Trae recusou a sessão (HTTP {resposta.status_code})")
            dados = resposta.json()
            sessao = dados.get("data") if isinstance(dados, dict) else None
            if not isinstance(dados, dict) or dados.get("code") != 0 or not isinstance(sessao, dict):
                raise ProviderError("Trae não conseguiu iniciar a conversa")
            sessao_id = str(sessao.get("chat_session_id") or "")
            mensagem_id = str(sessao.get("message_id") or "")
            if not sessao_id or not mensagem_id:
                raise ProviderError("Trae não devolveu os identificadores da conversa")
            url = f"{BASE}/chat_sessions/{quote(sessao_id, safe='')}/events"
            async with cliente.stream("GET", url, headers=headers, params={"reply_to_message_id": mensagem_id}) as eventos:
                if eventos.status_code >= 400:
                    raise ProviderError(f"Trae não abriu os eventos (HTTP {eventos.status_code})")
                ordem: list[str] = []
                pensamentos: dict[str, str] = {}
                texto_enviado = ""
                uso: dict[str, int] = {}
                tipo = ""
                concluiu = False
                async for linha in eventos.aiter_lines():
                    if linha.startswith("event:"):
                        tipo = linha[6:].strip()
                        continue
                    if not linha:
                        tipo = ""
                        continue
                    if not linha.startswith("data:"):
                        continue
                    try:
                        dado = json.loads(linha[5:].strip())
                    except ValueError:
                        continue
                    if not isinstance(dado, dict):
                        continue
                    if tipo == "error":
                        raise ProviderError(f"Trae interrompeu a resposta: {str(dado.get('message') or dado.get('code') or 'erro')[:300]}")
                    if tipo == "token_usage":
                        uso = {"prompt_tokens": int(dado.get("prompt_tokens") or 0),
                               "completion_tokens": int(dado.get("completion_tokens") or 0)}
                    elif tipo == "plan_item" and dado.get("id"):
                        chave = str(dado["id"])
                        if chave not in pensamentos:
                            ordem.append(chave)
                        anterior = pensamentos.get(chave) or ""
                        novo = str(dado.get("thought") or "")
                        if len(novo) >= len(anterior):
                            pensamentos[chave] = novo
                        completo = "".join(pensamentos.get(chave, "") for chave in ordem)
                        if not completo.startswith(texto_enviado):
                            raise ProviderError("Trae alterou uma parte da resposta já recebida")
                        trecho = completo[len(texto_enviado):]
                        texto_enviado = completo
                        if trecho:
                            yield _sse({"content": trecho})
                    elif tipo == "done":
                        concluiu = True
                        break
                if not texto_enviado:
                    raise ProviderError("Trae encerrou a resposta sem conteúdo")
                yield _sse(motivo="stop" if concluiu else "length", uso=uso)
                yield "data: [DONE]"
    except (httpx.HTTPError, ValueError) as erro:
        raise TransientProviderError(f"não consegui falar com o Trae: {erro}") from erro
