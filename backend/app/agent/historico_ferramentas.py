"""Recupera respostas faltantes de ferramentas sem apagar mensagens existentes."""
from __future__ import annotations

from typing import Any
from ..nucleo_turno.historico import normalizar_chat


def recuperar(historico: list[dict[str, Any]]) -> bool:
    try:
        # Evita acionar append sobrescrito de ControlHistory durante deepcopy.
        ajustado = normalizar_chat(list(historico))
    except (TypeError, ValueError, KeyError, AttributeError):
        return False
    if len(ajustado) <= len(historico):
        return False
    # Não normalizar se o procedimento remover ou alterar mensagens existentes.
    indice = 0
    for mensagem in ajustado:
        if indice < len(historico) and mensagem == historico[indice]:
            indice += 1
    if indice != len(historico):
        return False
    historico[:] = ajustado
    return True
