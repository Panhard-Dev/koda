"""Conversão de chamadas de ferramentas e eventos de conversa do Koda."""

from __future__ import annotations

import json
import re
import uuid
from typing import Any

from .providers.base import ProviderError

_TAG = re.compile(r"<koda_tool>\s*(.*?)\s*</koda_tool>", re.DOTALL)


def _chamadas(texto: str, ferramentas: list[dict[str, Any]], nonce: str) -> list[dict[str, Any]] | None:
    if not ferramentas or "<koda_tool>" not in texto:
        return None
    trechos = list(_TAG.finditer(texto))
    if not trechos or _TAG.sub("", texto).strip() or len(trechos) > 32:
        raise ProviderError("o provedor web devolveu uma chamada de ferramenta inválida")
    permitidas = {str((item.get("function") or item).get("name") or "") for item in ferramentas}
    chamadas = []
    for item in trechos:
        try:
            dado = json.loads(item.group(1))
        except ValueError as erro:
            raise ProviderError("o provedor web devolveu argumentos inválidos") from erro
        if (not isinstance(dado, dict) or not nonce or dado.get("nonce") != nonce or dado.get("name") not in permitidas
                or not isinstance(dado.get("arguments"), dict)):
            raise ProviderError("o provedor web pediu uma ferramenta não disponível ou argumentos inválidos")
        chamadas.append({"id": f"call_{uuid.uuid4().hex}", "type": "function", "function": {
            "name": dado["name"], "arguments": json.dumps(dado["arguments"], ensure_ascii=False)}})
    return chamadas


def _sse(delta: dict[str, Any] | None = None, *, motivo: str | None = None) -> str:
    return "data: " + json.dumps({"choices": [{"index": 0, "delta": delta or {}, "finish_reason": motivo}]}, ensure_ascii=False)
