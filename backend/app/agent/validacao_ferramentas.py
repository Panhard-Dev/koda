"""Valida argumentos das ferramentas nativas pelo catálogo efetivamente oferecido."""
from __future__ import annotations

from typing import Any

from ..nucleo_turno.validacao import EsquemaInvalido, validar
from ..tools import registry


def erro(nome: str, argumentos: dict[str, Any], catalogo: list[dict[str, Any]]) -> str | None:
    canonico = registry.canonico(nome)
    # A lista de tarefas aceita intencionalmente texto, aliases e estados legados.
    if canonico == 'update_todos':
        return None
    nativas = {registry.canonico(str((item.get('function') or {}).get('name') or ''))
               for item in registry.DEFINICOES}
    if not canonico or canonico not in nativas:
        return None
    for item in catalogo:
        funcao = item.get('function') or {}
        if registry.canonico(str(funcao.get('name') or '')) != canonico:
            continue
        try:
            validar(registry._sinonimos(argumentos), funcao.get('parameters', {}))
        except EsquemaInvalido as problema:
            return f'ERRO: argumentos inválidos para {nome}: {problema}'
        return None
    return None
