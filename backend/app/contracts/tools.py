"""O contrato de uma ferramenta: como se declara um schema.

Mora em `contracts/` porque **cada domínio declara o próprio schema** e `domains/`
não importa de `tools/` (seria import para cima). Aqui não há ciclo: o registro importa
daqui, e os domínios também.
"""

from __future__ import annotations

from typing import Any


def _def(
    nome: str, descricao: str, props: dict[str, Any], obrigatorios: list[str]
) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": nome,
            "description": descricao,
            "parameters": {"type": "object", "properties": props, "required": obrigatorios},
        },
    }
