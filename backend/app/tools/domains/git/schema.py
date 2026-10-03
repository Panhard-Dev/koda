"""Schema das ferramentas de git.

Cada ferramenta declara **aqui** o próprio nome, a descrição e os argumentos (`_def`). O
registro (`tools/registry.py`) junta os schemas dos domínios — ele não guarda lista própria.
É o que faz a ferramenta nova entrar no domínio dela em vez de engordar um arquivo central.
"""

from __future__ import annotations

from ....contracts.tools import _def

DEFINICOES = [
    _def("git_status", "Mostra o status git do projeto. Use isto em vez do shell para git.", {}, []),
    _def("git_diff", "Mostra o diff não-commitado (staged + unstaged). Use isto em vez de `git diff` no shell.", {}, []),
    _def("git_log", "Mostra os últimos commits (padrão 10). Use isto em vez de `git log` no shell.", {"quantidade": {"type": "integer"}}, []),
    _def("git_commit", "Faz git add -A e commit com a mensagem dada. Use isto em vez de `git commit` no shell.", {"mensagem": {"type": "string"}}, ["mensagem"]),
    _def(
        "git_push",
        "Envia os commits locais para o repositório remoto (git push).",
        {
            "remoto": {"type": "string", "description": "nome do remoto (padrão do git: origin)"},
            "ramo": {"type": "string", "description": "ramo a enviar"},
        },
        [],
    ),
    _def(
        "git_pull",
        "Baixa e integra as mudanças do repositório remoto (git pull --ff-only).",
        {
            "remoto": {"type": "string", "description": "nome do remoto (padrão do git: origin)"},
            "ramo": {"type": "string", "description": "ramo a baixar"},
        },
        [],
    ),
]
