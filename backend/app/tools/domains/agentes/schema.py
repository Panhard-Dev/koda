"""O schema da ferramenta que lança um sub-agente.

A descrição é o que decide se o modelo usa isto ou faz o trabalho ele mesmo, e por isso ela
diz as três coisas que ele não tem como adivinhar: que o sub-agente **não apaga nada**, que
ele **não sai da pasta** sem ordem, e que existe **teto** por rodada. Sem isso o modelo
manda apagar, ou lança cinco de uma vez e recebe erro.
"""

from __future__ import annotations

from ....contracts.tools import _def

#: O nome que o modelo vê. É ele que `agent/subagente.py` reconhece no despacho.
NOME = "sub_agente"

DEFINICOES = [
    _def(
        NOME,
        (
            "Lança um sub-agente para tocar um pedaço do trabalho, com o prompt e as "
            "ferramentas próprias dele. Use quando o pedaço for grande e independente o "
            "bastante para valer uma cabeça só nele — levantar o que quebrou, revisar um "
            "arquivo inteiro, rodar e conferir os testes. "
            "O que ele relatar volta para você: leia antes de repetir o trabalho dele. "
            "Ele NÃO apaga nada (apagar é seu) e NÃO sai da pasta do projeto, a menos que "
            "você mande no argumento. No máximo 3 por rodada."
        ),
        {
            "agente": {
                "type": "string",
                "description": (
                    "Nome do sub-agente, como está escrito no `subs.agentes.md`. "
                    "Um nome que não existe devolve a lista dos que existem."
                ),
            },
            "tarefa": {
                "type": "string",
                "description": (
                    "O que ele deve fazer, com o contexto que ele não tem: ele não vê esta "
                    "conversa, e começa do zero."
                ),
            },
            "esforco": {
                "type": "string",
                "enum": ["auto", "minimal", "low", "medium", "high"],
                "description": "Quanto ele deve pensar antes de agir. Sem isto, o padrão dele.",
            },
            "modelo": {
                "type": "string",
                "description": "Modelo para ele, quando valer um diferente do seu.",
            },
            "fora_da_pasta": {
                "type": "boolean",
                "description": (
                    "Permitir que ele mexa fora da pasta do projeto. Só mande quando for "
                    "preciso de verdade — o padrão é ele ficar dentro."
                ),
            },
        },
        ["agente", "tarefa"],
    )
]
