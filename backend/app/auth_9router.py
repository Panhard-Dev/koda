"""Ponte para os fluxos OAuth e device code do 9router (MIT)."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

from .config import Settings

_BUNDLE = Path(__file__).with_name("auth_9router.mjs")
_MARCA = "KODA_RESULT:"


def chamar(settings: Settings, provedor: str, acao: str, **dados: Any) -> dict[str, Any]:
    credenciais_google = {
        "google": "KODA_GOOGLE_CLIENT_ID",
        "antigravity": "KODA_ANTIGRAVITY_CLIENT_ID",
    }
    variavel = credenciais_google.get(provedor)
    if variavel and not os.environ.get(variavel):
        return {"ok": False, "error": f"configure {variavel} para usar este login"}
    node = str(settings.node_path) if settings.node_path and settings.node_path.is_file() else shutil.which("node")
    if not node or not _BUNDLE.is_file():
        return {"ok": False, "error": "motor de login do 9router não está instalado"}
    pedido = {"provider": provedor, "action": acao, **dados}
    try:
        processo = subprocess.run(
            [node, str(_BUNDLE)], input=json.dumps(pedido, ensure_ascii=False),
            text=True, encoding="utf-8", capture_output=True, timeout=45, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {"ok": False, "error": "o motor de login não respondeu a tempo"}
    if _MARCA not in processo.stdout:
        return {"ok": False, "error": f"o motor de login terminou sem resposta ({processo.returncode})"}
    try:
        return json.loads(processo.stdout.rsplit(_MARCA, 1)[1])
    except ValueError:
        return {"ok": False, "error": "o motor de login devolveu resposta inválida"}
