"""Schema das ferramentas de plano.

Cada ferramenta declara **aqui** o próprio nome, a descrição e os argumentos (`_def`). O
registro (`tools/registry.py`) junta os schemas dos domínios — ele não guarda lista própria.
É o que faz a ferramenta nova entrar no domínio dela em vez de engordar um arquivo central.
"""

from __future__ import annotations

from ....contracts.tools import _def

DEFINICOES = [
    _def(
        "update_todos",
        "Registra/atualiza a lista de tarefas da resposta (o plano). Marque cada item como "
        "feito quando ele terminar de verdade, e o próximo como atual.",
        {
            "todos": {
                "type": "array",
                "description": "a lista completa, na ordem: faça x, faça y, faça z",
                "items": {
                    "type": "object",
                    "properties": {
                        "texto": {"type": "string", "description": "o que fazer, curto"},
                        "feito": {"type": "boolean", "description": "já terminou?"},
                        "atual": {"type": "boolean", "description": "está fazendo agora"},
                    },
                    "required": ["texto"],
                },
            }
        },
        ["todos"],
    ),
]
