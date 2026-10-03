"""O registro das ferramentas: **quais existem** e como se chamam.

Cada ferramenta declara o próprio schema aqui (`_def`) — nome, descrição, argumentos e
apelidos. O despacho (`dispatcher.py`) só pergunta ao registro; ele não guarda lista
paralela. É o que impede o `ferramentas.py` de voltar a ser um objeto de 4 mil linhas: a
ferramenta nova entra no domínio dela, e o registro apenas a vê.

`FERRAMENTAS_LOCAIS`, `FERRAMENTAS_DE_SHELL`, `FERRAMENTAS_DO_AMBIENTE`,
`FERRAMENTAS_DE_ARQUIVO` e `FERRAMENTAS_WEB` são os **domínios de restrição**: é por eles
que a proibição do pedido («não use shell») vira um conjunto de nomes.
"""

from __future__ import annotations

from ..contracts.tools import _def
from typing import Any

#: Ferramentas de acesso web, disponíveis somente quando a pessoa liga o botão Web.
FERRAMENTAS_WEB = frozenset({"web_search", "url_reader", "browser", "download_file"})
#: Nomes que um modelo costuma escrever no lugar do nome real da ferramenta. O catálogo
#: anuncia o nome canônico; o apelido existe para a chamada **funcionar** em vez de voltar
#: "ferramenta desconhecida" — que era o que fazia a tarefa inteira parar numa tarefa
#: grande, com o modelo tentando `run_command`, `list_directory`, `apply_patch`.
APELIDOS: dict[str, str] = {
    # execução
    "run_command": "shell",
    "execute_command": "shell",
    "run_terminal": "shell",
    "terminal_command": "shell",
    "execute_shell": "shell",
    "bash": "shell",
    "sh": "shell",
    "exec": "shell",
    "run_code": "code_interpreter",
    "execute_code": "code_interpreter",
    "run_python": "code_interpreter",
    "python": "code_interpreter",
    "eval": "code_interpreter",
    # arquivos
    "read": "read_file",
    "cat": "read_file",
    "open_file": "read_file",
    "view_file": "read_file",
    "read_text_file": "read_file",
    "write": "write_file",
    "create_file": "write_file",
    "save_file": "write_file",
    "write_text_file": "write_file",
    "edit": "edit_file",
    "replace_in_file": "edit_file",
    "str_replace": "str_replace_editor",
    "delete": "delete_file",
    "remove_file": "delete_file",
    "list_directory": "list_dir",
    "listdir": "list_dir",
    "list_files": "list_dir",
    "ls": "list_dir",
    "dir": "list_dir",
    "mkdir": "create_directory",
    "make_directory": "create_directory",
    "create_dir": "create_directory",
    "rmdir": "delete_directory",
    "remove_directory": "delete_directory",
    "delete_dir": "delete_directory",
    "move": "move_file",
    "copy": "copy_file",
    "rename": "rename_file",
    "search_files": "search_files",
    "glob": "search_files",
    "find_files": "search_files",
    "file_search": "search_files",
    "list_files_by_pattern": "search_files",
    "search_code": "search_codebase",
    "code_search": "search_codebase",
    "search_in_files": "search_codebase",
    "grep_search": "regex_search",
    "search_regex": "regex_search",
    "lint": "get_problems",
    "check_file": "get_problems",
    "apply_diff": "apply_patch",
    "patch": "edit_file",  # o `patch` do Koda/OpenAI é find-and-replace, igual ao nosso edit_file
    "apply_changes": "apply_patch",
    # ambiente, web, git
    "env": "get_environment",
    "environment": "get_environment",
    "get_env": "get_environment",
    "system_info": "get_environment",
    "open_url": "url_reader",
    "fetch_url": "url_reader",
    "read_url": "url_reader",
    "web_fetch": "url_reader",
    "web_extract": "url_reader",
    "extract_url": "url_reader",
    "visit_url": "url_reader",
    "search_web": "web_search",
    "websearch": "web_search",
    "google": "web_search",
    "status": "git_status",
    "diff": "git_diff",
    "git_diff_staged": "git_diff",
    "commit": "git_commit",
    "push": "git_push",
    "pull": "git_pull",
    "log": "git_log",
    "download": "download_file",
    "fetch_file": "download_file",
    "upload": "upload_file",
    "send_file": "upload_file",
    "install": "install_package",
    "add_package": "install_package",
    "install_dependency": "install_package",
    "pip_install": "install_package",
    "npm_install": "install_package",
    "uninstall": "uninstall_package",
    "remove_package": "uninstall_package",
    "uninstall_dependency": "uninstall_package",
    # plano
    "todo_list": "update_todos",
    "todo_write": "update_todos",
    "write_todos": "update_todos",
    "set_todos": "update_todos",
}
#: Sinônimos de **argumento**: o mesmo campo escrito como o modelo lembra. Sem isso, o
#: `write_file({"path": ..., "content": ...})` chegava sem `caminho` e a ferramenta
#: respondia "criei /tmp/x" — ou pior, gravava no lugar errado.
SINONIMOS: dict[str, str] = {
    "path": "caminho",
    "file": "caminho",
    "filepath": "caminho",
    "file_path": "caminho",
    "filename": "caminho",
    "file_name": "caminho",
    "arquivo": "caminho",
    "folder": "caminho",
    "directory": "caminho",
    # Anexo é lido por `id` — o modelo às vezes escreve o nome do campo por extenso.
    "attachment_id": "id",
    "attachment": "id",
    "anexo": "id",
    "anexo_id": "id",
    "content": "conteudo",
    "contents": "conteudo",
    "text": "conteudo",
    "new_content": "conteudo",
    "old": "old_string",
    "old_str": "old_string",
    "old_text": "old_string",
    "find": "old_string",
    "search": "old_string",
    "new": "new_string",
    "new_str": "new_string",
    "new_text": "new_string",
    "replace": "new_string",
    "replacement": "new_string",
    "source": "origem",
    "src": "origem",
    "from": "origem",
    "destination": "destino",
    "dest": "destino",
    "target": "destino",
    "to": "destino",
    "new_name": "novo_nome",
    "language": "linguagem",
    "lang": "linguagem",
    "runtime": "linguagem",
    "pattern": "padrao",
    "file_pattern": "padrao",
    "regex_pattern": "padrao",
    "expression": "padrao",
    "query": "termo",
    "q": "termo",
    "needle": "termo",
    "busca": "termo",
    "search_term": "termo",
    "command": "comando",
    "cmd": "comando",
    "timeout": "tempo_limite",
    "tempo": "tempo_limite",
    "timeout_s": "tempo_limite",
    "code": "codigo",
    "script": "codigo",
    "message": "mensagem",
    "commit_message": "mensagem",
    "msg": "mensagem",
    "limit": "limite",
    "max_lines": "limite",
    "lines": "limite",
    "start": "inicio",
    "offset": "inicio",
    "line": "inicio",
    "count": "quantidade",
    "number": "quantidade",
    "package": "pacote",
    "packages": "pacote",
    "dependency": "pacote",
    "dependencia": "pacote",
    "manager": "gerenciador",
    "package_manager": "gerenciador",
    "diff": "diff",
    "patch": "diff",
    "unified_diff": "diff",
    "link": "url",
    "href": "url",
    "endereco": "url",
    "remote": "remoto",
    "branch": "ramo",
    "ramo_nome": "ramo",
    "itens": "todos",
    "tarefas": "todos",
    "plan": "todos",
    "plano": "todos",
    "checklist": "todos",
}
def canonico(nome: str) -> str:
    """Nome real da ferramenta, resolvendo apelidos (`run_command` → `shell`)."""
    limpo = (nome or "").strip().lower()
    return APELIDOS.get(limpo, limpo)
def _sinonimos(argumentos: dict[str, Any]) -> dict[str, Any]:
    """Renomeia os campos escritos como sinônimo, sem nunca perder o canônico."""
    if not argumentos:
        return {}
    normalizado: dict[str, Any] = {}
    for chave, valor in argumentos.items():
        normalizado[str(chave)] = valor
    for chave, valor in list(normalizado.items()):
        destino = SINONIMOS.get(chave.lower())
        if destino and destino not in normalizado:
            normalizado[destino] = valor
    return normalizado

from .domains.files.schema import DEFINICOES as _ARQUIVOS
from .domains.git.schema import DEFINICOES as _GIT
from .domains.plano.schema import DEFINICOES as _PLANO
from .domains.shell.schema import DEFINICOES as _EXECUCAO
from .domains.skills.schema import DEFINICOES as _SKILLS
from .domains.web.schema import DEFINICOES as _WEB

#: O catálogo inteiro, na ordem em que o modelo o recebe.
DEFINICOES: list[dict[str, Any]] = [
    *_ARQUIVOS,
    *_EXECUCAO,
    *_GIT,
    *_WEB,
    *_PLANO,
    *_SKILLS,
]
#: Todas as ferramentas que executam algo no disco ou na máquina.
ESCRITA = {
    "write_file",
    "edit_file",
    "str_replace_editor",
    "delete_file",
    "create_directory",
    "move_file",
    "copy_file",
    "rename_file",
    "delete_directory",
    "git_commit",
    "git_push",
    "git_pull",
    "install_package",
    "uninstall_package",
    "apply_patch",
    "download_file",
    "upload_file",
}
#: Ferramentas que recebem um `caminho` e por isso passam pela checagem de pasta.
FERRAMENTAS_DE_ARQUIVO = {
    "read_file",
    "write_file",
    "edit_file",
    "str_replace_editor",
    "list_dir",
    "search_files",
    "delete_file",
    "create_directory",
    "move_file",
    "copy_file",
    "rename_file",
    "delete_directory",
    "get_problems",
    "linter",
    "download_file",
    "upload_file",
}
#: Tudo o que **alcança a máquina da pessoa**: os arquivos, o shell, o interpretador de
#: código, o ambiente e o git.
#:
#: "Não leia meus arquivos" tem de tirar o grupo inteiro, não só `read_file`: o mesmo
#: conteúdo fica a um `shell` (`cat`, `dir`) ou a um `code_interpreter` (`os.environ`,
#: `pathlib`) de distância. Antes, `SEM_ARQUIVOS` tirava só `FERRAMENTAS_DE_ARQUIVO` e o
#: agente ainda respondia "que informações internas eu consigo saber" com o ambiente da
#: máquina lido por outra porta — foi assim que uma proibição explícita de acesso local
#: terminou em acesso local (achado do dono, 02/10/2026).
FERRAMENTAS_LOCAIS = frozenset(
    set(FERRAMENTAS_DE_ARQUIVO)
    | {
        "apply_patch",
        "shell",
        "terminal",
        "code_interpreter",
        "get_environment",
        "git_status",
        "git_diff",
        "git_log",
        "git_commit",
        "git_push",
        "git_pull",
        "install_package",
        "uninstall_package",
        "grep",
        "search_codebase",
        "regex_search",
        "vector_search",
    }
)
#: O que executa **comando** na máquina. "Não use o shell" tira este grupo — e não os 33,
#: porque quem proíbe o shell continua podendo pedir a leitura de um arquivo pelo caminho
#: próprio. `code_interpreter` e os gerenciadores de pacote entram junto: os três rodam
#: código na máquina, e deixar qualquer um deles de fora transforma a proibição em enfeite
#: (um `os.environ` no interpretador lê o mesmo que o shell leria).
FERRAMENTAS_DE_SHELL = frozenset(
    {"shell", "terminal", "code_interpreter", "install_package", "uninstall_package"}
)
#: O que lê o **estado da máquina**: ambiente, versões, caminhos e o que está rodando.
#: É o grupo do `get_environment` — o que responde "qual o SO", "quais as variáveis de
#: ambiente", "quais processos". `shell` e `code_interpreter` entram porque respondem a
#: mesma pergunta por outra porta (o QA viu exatamente isso: o Koda devolveu SO, caminhos,
#: shell e Python depois de o usuário proibir o acesso local).
FERRAMENTAS_DO_AMBIENTE = frozenset(
    {"get_environment", "shell", "terminal", "code_interpreter"}
)
#: Ferramentas de arquivo com **dois** caminhos na chamada: os dois passam pela checagem
#: de pasta, senão mover para fora do projeto passaria batido.
CAMINHOS_EXTRA: dict[str, tuple[str, ...]] = {
    "move_file": ("origem", "destino"),
    "copy_file": ("origem", "destino"),
    "download_file": ("destino",),
}
def catalogo(negadas: set[str] | None = None) -> list[dict[str, Any]]:
    """Catálogo enviado ao modelo, sem as ferramentas desligadas na configuração."""
    if not negadas:
        return DEFINICOES
    proibidas = {canonico(nome) for nome in negadas}
    return [
        item
        for item in DEFINICOES
        if item["function"]["name"] not in proibidas
    ]