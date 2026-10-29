"""Ponte de inferência para o transporte/tradutores MIT do 9router.

O bundle JavaScript é gerado por ``scripts/build-9router-engine.mjs``. Tokens entram
somente pelo stdin do processo filho; nunca são argumentos nem variáveis de ambiente.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

from .config import Settings

_BUNDLE = Path(__file__).with_name("engine_9router.mjs")
_MANIFESTO = json.loads(Path(__file__).with_name("provedores_9router.json").read_text(encoding="utf-8"))
_FONTE = {item["id"]: item["fonteId"] for item in _MANIFESTO["provedores"]}
_MARCA = "KODA_RESULT:"


def chamar(
    settings: Settings,
    identificador: str,
    conta: dict[str, Any],
    modelo: str,
    mensagens: list[dict[str, Any]],
    ferramentas: list[dict[str, Any]] | None = None,
    *,
    max_tokens: int = 8192,
) -> dict[str, Any]:
    """Executa um turno no protocolo que o registry do 9router define."""
    node = str(settings.node_path) if settings.node_path and settings.node_path.is_file() else shutil.which("node")
    if not node or not _BUNDLE.is_file():
        return {"ok": False, "detalhe": "motor de modelos do 9router não está instalado"}
    fonte = _FONTE.get(identificador)
    if not fonte:
        return {"ok": False, "detalhe": "provedor não consta no 9router"}
    pedido = {
        "provider": fonte,
        "model": modelo,
        "messages": mensagens,
        "tools": ferramentas or [],
        "maxTokens": max_tokens,
        "credentials": {
            "id": conta.get("id"),
            "accessToken": conta.get("access"),
            "apiKey": (conta.get("specific") or {}).get("apiKey"),
            "refreshToken": conta.get("refresh"),
            "idToken": conta.get("id_token"),
            "expiresAt": conta.get("expiraEm"),
            "providerSpecificData": conta.get("specific") or {},
        },
    }
    try:
        processo = subprocess.run(
            [node, str(_BUNDLE)], input=json.dumps(pedido, ensure_ascii=False),
            text=True, encoding="utf-8", capture_output=True, timeout=180, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {"ok": False, "detalhe": "motor do 9router não respondeu a tempo"}
    if _MARCA not in processo.stdout:
        return {"ok": False, "detalhe": f"motor do 9router terminou sem resposta ({processo.returncode})"}
    try:
        resultado = json.loads(processo.stdout.rsplit(_MARCA, 1)[1])
    except ValueError:
        return {"ok": False, "detalhe": "motor do 9router devolveu resposta inválida"}
    if not resultado.get("ok"):
        corpo = resultado.get("body") or resultado.get("error") or "falha no fornecedor"
        return {"ok": False, "status": resultado.get("status"), "detalhe": str(corpo)[:500]}
    try:
        dado = json.loads(resultado.get("body") or "{}")
    except ValueError:
        return {"ok": False, "detalhe": "fornecedor devolveu resposta inválida"}
    return {"ok": True, "status": resultado.get("status"), "dados": dado}


def modelos_ao_vivo(settings: Settings, identificador: str, conta: dict[str, Any]) -> list[dict[str, Any]] | None:
    """Consulta a lista dinâmica do Zed pelo transporte do 9router."""
    if identificador != "zed":
        return None
    node = str(settings.node_path) if settings.node_path and settings.node_path.is_file() else shutil.which("node")
    if not node or not _BUNDLE.is_file():
        return None
    pedido = {"action": "models", "provider": "zed", "credentials": {
        "accessToken": conta.get("access"),
        "providerSpecificData": conta.get("specific") or {},
    }}
    try:
        processo = subprocess.run(
            [node, str(_BUNDLE)], input=json.dumps(pedido), text=True, encoding="utf-8",
            capture_output=True, timeout=40, check=False,
        )
        resultado = json.loads(processo.stdout.rsplit(_MARCA, 1)[1])
        if resultado.get("ok"):
            return json.loads(resultado.get("body") or "{}").get("models") or []
    except (OSError, ValueError, IndexError, subprocess.TimeoutExpired):
        pass
    return None
