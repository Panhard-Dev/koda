"""Identificação do Koda ao se comunicar com provedores externos."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
import uuid


def kimi(device_id: str | None) -> dict[str, str]:
    """Cabeçalhos da sessão de dispositivo do Kimi Code."""
    cabecalhos = {
        "X-Msh-Platform": "koda",
        "X-Msh-Version": "0.8.0",
        "X-Msh-Device-Name": "Koda",
        "X-Msh-Device-Model": "Koda Desktop",
    }
    if device_id:
        cabecalhos["X-Msh-Device-Id"] = device_id
    return cabecalhos


def minimax(sessao: str) -> dict[str, str]:
    """Cabeçalhos do protocolo de conversação do MiniMax Code."""
    fuso = datetime.now().astimezone().utcoffset()
    return {
        "User-Agent": "MiniMaxAgent",
        "X-Mavis-Agent-Id": "main",
        "X-Mavis-Session-Id": sessao,
        "X-Mavis-Timezone-Offset": str(int(fuso.total_seconds()) if fuso else 0),
        "anthropic-version": "2023-06-01",
        "x-api-key": "sk-xxx",
        "content-type": "application/json",
    }


def token_nous(conta: dict[str, Any]) -> str:
    """Aceita sessões novas e chaves temporárias salvas por versões anteriores."""
    especificos = conta.get("specific") or {}
    chave = str(especificos.get("apiKey") or "")
    acesso = str(conta.get("access") or "")
    validade = especificos.get("agentKeyExpiresAt")
    if chave and validade:
        try:
            expira = datetime.fromisoformat(str(validade).replace("Z", "+00:00"))
            if expira.tzinfo is not None and expira > datetime.now(tz=timezone.utc):
                return chave
        except ValueError:
            pass
    if chave and not validade and "inference:invoke" not in str(conta.get("escopo") or ""):
        return chave
    return acesso or chave


def cline(conta: dict[str, Any]) -> dict[str, str]:
    """Usa o prefixo de conta exigido pelo Cline, preservando chaves diretas."""
    chave = (conta.get("specific") or {}).get("apiKey")
    token = str(chave or conta.get("access") or "")
    if not chave and token and not token.lower().startswith("workos:"):
        token = f"workos:{token}"
    return {"authorization": f"Bearer {token}", "content-type": "application/json", "X-Title": "Koda"}


def kilo(conta: dict[str, Any]) -> dict[str, str]:
    """Inclui a organização apenas quando ela estiver vinculada à conta."""
    especificos = conta.get("specific") or {}
    token = str(especificos.get("apiKey") or conta.get("access") or "")
    cabecalhos = {"authorization": f"Bearer {token}", "content-type": "application/json"}
    if especificos.get("orgId"):
        cabecalhos["X-KiloCode-OrganizationId"] = str(especificos["orgId"])
    return cabecalhos


def kimchi(conta: dict[str, Any]) -> dict[str, str]:
    token = str((conta.get("specific") or {}).get("apiKey") or conta.get("access") or "")
    return {"authorization": f"Bearer {token}", "content-type": "application/json", "user-agent": "Koda/0.8.0"}


def glm(conta: dict[str, Any]) -> dict[str, str]:
    token = str((conta.get("specific") or {}).get("apiKey") or conta.get("access") or "")
    return {"authorization": f"Bearer {token}", "content-type": "application/json"}


def iflow(conta: dict[str, Any]) -> dict[str, str]:
    token = str((conta.get("specific") or {}).get("apiKey") or conta.get("access") or "")
    return {"authorization": f"Bearer {token}", "content-type": "application/json", "user-agent": "iFlow-Cli"}


def muse(conta: dict[str, Any]) -> dict[str, str]:
    chave = (conta.get("specific") or {}).get("apiKey")
    token = str(chave or conta.get("access") or "")
    resultado = {"authorization": f"Bearer {token}", "content-type": "application/json"}
    if not chave:
        resultado["x-api-version"] = "1.0.0"
    return resultado


def codebuddy(conta: dict[str, Any], internacional: bool = False) -> dict[str, str]:
    """Cabeçalhos pedidos pelo gateway de conversa das duas regiões."""
    token = str((conta.get("specific") or {}).get("apiKey") or conta.get("access") or "")
    request = str(uuid.uuid4())
    plataforma = "IDE" if internacional else "CLI"
    return {
        "authorization": f"Bearer {token}", "content-type": "application/json",
        "user-agent": f"{plataforma}/2.108.1 CodeBuddy/2.108.1", "x-product": "SaaS",
        "x-ide-type": plataforma, "x-ide-name": plataforma, "x-requested-with": "XMLHttpRequest",
        "x-codebuddy-request": "1", "x-request-id": request, "x-conversation-id": str(uuid.uuid4()),
        "x-conversation-request-id": request, "x-conversation-message-id": request,
    }


def mimo_api(conta: dict[str, Any]) -> dict[str, str]:
    chave = str((conta.get("specific") or {}).get("apiKey") or conta.get("access") or "")
    return {"api-key": chave, "content-type": "application/json"}
