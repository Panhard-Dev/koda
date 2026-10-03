"""Schema da ferramenta de skill.

Uma skill é um **pacote de instruções**, não um comando: `use_skill` devolve o texto dela
para o modelo seguir. É a diferença que separa skill de MCP — a skill ensina, a ferramenta
MCP executa.
"""

from __future__ import annotations

from ....contracts.tools import _def

DEFINICOES = [
    _def(
        "use_skill",
        "Carrega as instruções de uma skill pelo nome e devolve o texto delas. Chame quando o "
        "pedido combinar com uma das skills disponíveis (elas aparecem no prompt de sistema), "
        "ANTES de executar a tarefa — e siga o que as instruções mandarem. As skills do "
        "projeto e da máquina moram fora do alcance do read_file; esta é a forma de lê-las.",
        {
            "nome": {
                "type": "string",
                "description": "o nome exato da skill, como aparece no prompt de sistema",
            }
        },
        ["nome"],
    ),
]
