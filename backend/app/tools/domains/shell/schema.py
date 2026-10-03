"""Schema das ferramentas de execução.

Cada ferramenta declara **aqui** o próprio nome, a descrição e os argumentos (`_def`). O
registro (`tools/registry.py`) junta os schemas dos domínios — ele não guarda lista própria.
É o que faz a ferramenta nova entrar no domínio dela em vez de engordar um arquivo central.
"""

from __future__ import annotations

from ....contracts.tools import _def

DEFINICOES = [
    _def(
        "code_interpreter",
        "Executa um trecho de código e devolve a saída (print etc). Use para calcular e "
        "analisar; para rodar teste/build/programa use `shell`. Python por padrão; "
        "com `linguagem: node` roda JavaScript — o certo num projeto JS. Para ler ou "
        "procurar arquivo do projeto, use read_file/search_codebase.",
        {
            "codigo": {"type": "string", "description": "Código completo a executar"},
            "linguagem": {
                "type": "string",
                "description": "python (padrão) ou node",
            },
        },
        ["codigo"],
    ),
    _def(
        "shell",
        "Executa um comando no terminal (cmd) e devolve stdout+stderr. Use só para "
        "programa de verdade (build, teste, git, install); NÃO use para ler, criar, editar, "
        "listar, mover ou apagar arquivo — há ferramenta própria para cada um. Comando que demora "
        "NÃO é interrompido: a cada 4 minutos ele devolve a saída até agora com um id, e "
        'você decide — continue acompanhando com {"continuar": "<id>"} ou pare com '
        '{"parar": "<id>"}. Comando que não termina sozinho (servidor, programa com janela, '
        "prévia de algo) é caso de olhar a saída e parar.",
        {
            "comando": {"type": "string", "description": "o comando a rodar"},
            "continuar": {
                "type": "string",
                "description": "id de um comando que ficou rodando: espera mais 4 minutos por ele",
            },
            "parar": {
                "type": "string",
                "description": "id de um comando que ficou rodando: interrompe agora",
            },
            "tempo_limite": {
                "type": "integer",
                "description": (
                    "segundos de espera antes de voltar com a saída (padrão 240 = 4 min; "
                    "acima disso continua valendo a olhada de 4 min). Não interrompe nada"
                ),
            },
        },
        [],
    ),
    _def("terminal", "Alias de shell: executa um comando no terminal.", {"comando": {"type": "string"}}, ["comando"]),
    _def(
        "install_package",
        "Instala uma dependência no projeto (npm/pnpm/yarn, uv/pip ou cargo, pelo que o projeto usa). Use isto em vez de rodar `npm install`/`pip install` no shell. Chame direto: a ferramenta descobre o gerenciador sozinha — não investigue o projeto antes.",
        {
            "pacote": {"type": "string"},
            "gerenciador": {
                "type": "string",
                "description": "npm, pnpm, yarn, uv, pip, cargo — opcional; o padrão é o do projeto",
            },
        },
        ["pacote"],
    ),
    _def(
        "uninstall_package",
        "Remove uma dependência do projeto (npm/pnpm/yarn, uv/pip ou cargo).",
        {"pacote": {"type": "string"}, "gerenciador": {"type": "string"}},
        ["pacote"],
    ),
]
