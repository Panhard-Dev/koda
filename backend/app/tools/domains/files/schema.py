"""Schema das ferramentas de arquivos.

Cada ferramenta declara **aqui** o próprio nome, a descrição e os argumentos (`_def`). O
registro (`tools/registry.py`) junta os schemas dos domínios — ele não guarda lista própria.
É o que faz a ferramenta nova entrar no domínio dela em vez de engordar um arquivo central.
"""

from __future__ import annotations

from ....contracts.tools import _def

DEFINICOES = [
    _def(
        "read_file",
        "Lê um arquivo de texto inteiro. Use isto em vez de `cat`/`type`/`head`/`tail` no "
        "shell. Não passe `limite` por hábito: o arquivo vem "
        "completo, e é isso que evita ler o mesmo arquivo várias vezes. Use `inicio`/`limite` "
        "só em arquivo muito grande, e aí o retorno diz o que ficou de fora.",
        {
            "caminho": {"type": "string"},
            "inicio": {"type": "integer", "description": "linha inicial, 1 = primeira (padrão 1)"},
            "limite": {
                "type": "integer",
                "description": "quantas linhas ler (padrão: o arquivo inteiro)",
            },
        },
        ["caminho"],
    ),
    _def(
        "read_attachment",
        "Lê o conteúdo de um arquivo que o usuário **anexou nesta conversa**. O anexo NÃO "
        "está na pasta de trabalho: passe o `id` que vem no bloco «[anexos desta mensagem]». "
        "Não passe o nome nem um caminho — `read_file` não acha o anexo, e o nome não é "
        "caminho. Devolve o texto para texto/código e para pdf. Para imagem, devolve os "
        "metadados: a imagem já vai anexada ao seu contexto quando o modelo enxerga "
        "imagens — não precisa desta ferramenta para vê-la.",
        {
            "id": {
                "type": "string",
                "description": "o id do anexo, exatamente como veio no bloco de anexos da mensagem",
            },
            "inicio": {"type": "integer", "description": "linha inicial, 1 = primeira (padrão 1)"},
            "limite": {
                "type": "integer",
                "description": "quantas linhas ler (padrão: o anexo inteiro)",
            },
        },
        ["id"],
    ),
    _def(
        "write_file",
        "Cria ou sobrescreve um arquivo de texto INTEIRO (cria subpastas). Use isto em vez "
        "de `echo`/heredoc no shell. Substitui o conteúdo todo — para alterar um trecho use "
        "`edit_file`.",
        {"caminho": {"type": "string"}, "conteudo": {"type": "string"}},
        ["caminho", "conteudo"],
    ),
    _def(
        "edit_file",
        "Substitui um trecho exato em um arquivo (old_string deve ocorrer uma única vez). "
        "Use isto em vez de `sed`/`awk` no shell; para o arquivo inteiro use `write_file`.",
        {
            "caminho": {"type": "string"},
            "old_string": {"type": "string"},
            "new_string": {"type": "string"},
        },
        ["caminho", "old_string", "new_string"],
    ),
    _def(
        "str_replace_editor",
        "Alias de edit_file: substitui old_string por new_string em um arquivo.",
        {
            "caminho": {"type": "string"},
            "old_string": {"type": "string"},
            "new_string": {"type": "string"},
        },
        ["caminho", "old_string", "new_string"],
    ),
    _def(
        "list_dir",
        "Lista arquivos e subpastas de um diretório (padrão: pasta de trabalho). Use isto "
        "em vez de `dir`/`ls` no shell.",
        {"caminho": {"type": "string", "description": "padrão: ."}},
        [],
    ),
    _def("delete_file", "Apaga um arquivo (não apaga pastas). Use isto em vez de `del`/`rm` no shell.", {"caminho": {"type": "string"}}, ["caminho"]),
    _def(
        "create_directory",
        "Cria uma pasta (cria também as pastas acima dela que faltarem). Use isto em vez de `mkdir` no shell.",
        {"caminho": {"type": "string"}},
        ["caminho"],
    ),
    _def(
        "move_file",
        "Move um arquivo ou uma pasta para outro caminho (o destino não pode existir). Use isto em vez de `mv` no shell.",
        {"origem": {"type": "string"}, "destino": {"type": "string"}},
        ["origem", "destino"],
    ),
    _def(
        "copy_file",
        "Copia um arquivo ou uma pasta inteira para outro caminho. Use isto em vez de `cp` no shell.",
        {"origem": {"type": "string"}, "destino": {"type": "string"}},
        ["origem", "destino"],
    ),
    _def(
        "rename_file",
        "Renomeia um arquivo ou pasta dentro da mesma pasta (só o nome, sem caminho). Use isto em vez de `ren`/`mv` no shell.",
        {"caminho": {"type": "string"}, "novo_nome": {"type": "string"}},
        ["caminho", "novo_nome"],
    ),
    _def(
        "delete_directory",
        "Apaga uma pasta inteira, com tudo dentro dela. Nunca apaga a pasta de trabalho. Use isto em vez de `rmdir`/`rm -rf` no shell.",
        {"caminho": {"type": "string"}},
        ["caminho"],
    ),
    _def(
        "get_environment",
        "Informa o ambiente de trabalho: sistema, pasta do projeto, Python, git e o que há nela.",
        {},
        [],
    ),
    _def(
        "search_codebase",
        "Busca um termo (texto ou regex) em todos os arquivos do projeto e devolve "
        "arquivo:linha com a linha. Use isto em vez de `findstr`/`grep` no shell.",
        {"termo": {"type": "string"}, "regex": {"type": "boolean", "description": "tratar termo como regex (padrão false)"}},
        ["termo"],
    ),
    _def(
        "vector_search",
        "Alias de search_codebase: busca textual nos arquivos do projeto (ranking simples por ocorrências).",
        {"termo": {"type": "string"}},
        ["termo"],
    ),
    _def("grep", "Alias de regex_search: busca com expressão regular nos arquivos.", {"padrao": {"type": "string"}}, ["padrao"]),
    _def(
        "regex_search",
        "Busca com expressão regular nos arquivos do projeto (arquivo:linha:trecho). Use "
        "isto em vez de `findstr`/`grep` no shell; para buscar um texto use `search_codebase`.",
        {"padrao": {"type": "string"}},
        ["padrao"],
    ),
    _def(
        "get_problems",
        "Verifica problemas de sintaxe/erros em um arquivo (Python via py_compile; tenta pyflakes se instalado).",
        {"caminho": {"type": "string"}},
        ["caminho"],
    ),
    _def("linter", "Alias de get_problems.", {"caminho": {"type": "string"}}, ["caminho"]),
    _def(
        "search_files",
        "Procura arquivos pelo nome ou por um padrão glob (ex.: **/*.py) e devolve os "
        "caminhos. Use isto em vez de `find`/`ls` no shell; para procurar conteúdo use "
        "`search_codebase`/`regex_search`.",
        {
            "padrao": {"type": "string", "description": "padrão glob, ex.: **/*.ts"},
            "caminho": {"type": "string", "description": "pasta onde procurar (padrão: a pasta de trabalho)"},
        },
        ["padrao"],
    ),
    _def(
        "apply_patch",
        "Aplica um diff unificado (formato git diff) nos arquivos do projeto, de uma vez.",
        {
            "diff": {
                "type": "string",
                "description": "diff unificado completo, com cabeçalhos ---/+++ e hunks @@",
            }
        },
        ["diff"],
    ),
]
