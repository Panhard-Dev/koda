"""Schema das ferramentas de plano.

Cada ferramenta declara **aqui** o próprio nome, a descrição e os argumentos (`_def`). O
registro (`tools/registry.py`) junta os schemas dos domínios — ele não guarda lista própria.
É o que faz a ferramenta nova entrar no domínio dela em vez de engordar um arquivo central.
"""

from __future__ import annotations

from ....contracts.tools import _def

DEFINICOES = [
    _def(
        "mostrar_plano",
        "Abre o cartão de plano na conversa — a tela bonita que a pessoa lê e aprova antes "
        "de qualquer execução. Use SEMPRE que for propor um plano, em qualquer provedor. "
        "Preencha as seis partes; a interface desenha, não escreva o plano em prosa nem em "
        "bloco de código.",
        {
            "titulo": {
                "type": "string",
                "description": "título curto do plano",
            },
            "o_que_e": {
                "type": "string",
                "description": "o que é esta entrega, em uma frase",
            },
            "pra_que": {
                "type": "string",
                "description": "para que serve / o objetivo",
            },
            "por_que": {
                "type": "string",
                "description": "por que este caminho e não outro",
            },
            "como": {
                "type": "array",
                "description": "o passo a passo, na ordem",
                "items": {
                    "type": "object",
                    "properties": {
                        "titulo": {"type": "string", "description": "o passo, curto"},
                        "texto": {"type": "string", "description": "o detalhe do passo"},
                    },
                    "required": ["titulo"],
                },
            },
            "mudancas": {
                "type": "array",
                "description": "os arquivos ou partes que serão mexidos",
                "items": {
                    "type": "object",
                    "properties": {
                        "arquivo": {"type": "string", "description": "caminho do arquivo"},
                        "texto": {"type": "string", "description": "o que muda nele"},
                    },
                    "required": ["texto"],
                },
            },
            "resultado": {
                "type": "string",
                "description": "o resultado final esperado, em uma frase",
            },
        },
        ["titulo", "como"],
    ),
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
