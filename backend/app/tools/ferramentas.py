"""Ferramentas que o modelo pode chamar durante a conversa.

Portado do projeto `TOOLS` do usuário (agente CLI em Python): o catálogo e as mensagens
de erro são os mesmos, só trocando `requests` por `httpx` para o backend não ganhar uma
dependência nova. Tudo executa na máquina local, sempre com `cwd` na pasta de trabalho.

A busca na web usa **só o Bing**: um GET na página de resultados e as tags lidas na mão.
Sem chave, sem dependência nova e sem serviço no meio — ver `_busca_bing`.
"""

from __future__ import annotations

import html
import ipaddress
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import uuid
from pathlib import Path
from typing import Any

import httpx

LIMITE_SAIDA = 12_000
#: Tempo padrão de um comando no terminal, em segundos. Era 120 s e cortava justamente o
#: que a pessoa pediu: suíte de testes grande, build, instalação de dependência. O modelo
#: pode pedir mais em `tempo_limite`, até o teto de `TEMPO_COMANDO_MAX`.
TEMPO_COMANDO = 600
TEMPO_COMANDO_MAX = 3600
#: De quanto em quanto tempo o comando que não terminou devolve a palavra ao modelo.
#:
#: Comando de verdade (build, instalação, bateria de teste) passa de dez minutos, e antes
#: ele era **morto** no tempo limite — trabalho perdido no meio. Agora ele continua rodando
#: e, a cada quatro minutos, o modelo recebe a saída até agora com o id do processo: ele
#: olha, diz que está tudo certo e continua acompanhando (`continuar`), ou para (`parar`)
#: quando percebe que aquilo não termina sozinho — servidor, programa com janela, prévia.
INTERVALO_DE_OLHADA = 240

#: Quanto da saída de um comando longo fica guardado, em caracteres. Comando tagarela
#: (build com milhares de linhas) não pode encher a memória do app: guarda o **fim**, que é
#: onde está o erro, e diz quanta coisa ficou de fora.
LIMITE_SAIDA_RODANDO = 24_000

#: Quantas olhadas seguidas **sem uma linha nova** antes de considerar o comando travado.
#:
#: É o que substitui o teto por tempo. Um build de duas horas que está imprimindo continua
#: vivo — trabalho de verdade não morre por relógio. Já o comando que parou de escrever
#: (travou, ficou esperando entrada, entrou em laço mudo) é interrompido depois de três
#: olhadas sem nada novo: doze minutos sem uma linha é travado, não "quase terminando".
OLHADAS_SEM_SAIDA = 3

#: Depois de tantas olhadas, o retorno para de só oferecer `continuar` e cobra a decisão: ou
#: o comando terminou, ou não é para terminar sozinho (servidor, programa com janela, prévia)
#: e o certo é parar. É o antídoto do modelo que fica dizendo "vou continuar" para sempre.
OLHADAS_ATE_COBRAR = 10

#: Comandos que ficaram rodando depois de uma olhada, por id. O processo é do app: sai daqui
#: quando termina, quando o modelo para, ou quando o app fecha.
_RODANDO: dict[str, "ComandoRodando"] = {}

#: Teto de tamanho para `download_file`/`upload_file`, em bytes (100 MB). Sem isto um
#: download acidental de um arquivo enorme enche o disco do usuário sem aviso.
LIMITE_REDE = 100_000_000
#: Tetos do `search_files`: quantidade de caminhos e profundidade de varredura.
LIMITE_ARQUIVOS_BUSCA = 200

#: Quantas entradas o `list_dir` mostra de uma pasta. Alto de propósito: pasta de projeto
#: tem centenas de arquivos, e cortar calado faz o modelo trabalhar com meia lista na
#: cabeça. Passando disso, o retorno diz quantas ficaram de fora.
LIMITE_LISTAGEM = 800
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
"""Como o Koda se apresenta ao pedir uma página.

Era `KodaAgente/1.0`, e isso **quebrava a busca**: com UA de robô o Bing serve uma página
degradada (resultado aleatório, sem relação com a consulta — "YouTube Help" para
"documentacao do fastapi"); com UA de navegador a página HTML dele vem sem resultado
nenhum, porque monta com JavaScript. Por isso a busca lê o **RSS** do Bing (mesmo
resultado, em XML, sem anti-robô: 10 de 10 relevantes contra 0 de 10 do HTML), e o UA de
navegador fica para os sites que recusam cliente identificado como robô.
"""

ACCEPT_LANGUAGE = "pt-BR,pt;q=0.9,en;q=0.8"

#: Cabeçalhos das leituras de página: um navegador de verdade, para os sites que filtram
#: cliente por UA não devolverem 403 a um "robô".
CABECALHOS_WEB = {
    "User-Agent": USER_AGENT,
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,"
        "application/json;q=0.8,*/*;q=0.7"
    ),
    "Accept-Language": ACCEPT_LANGUAGE,
}

#: Palavras que não dizem nada sobre o assunto. Além de não ajudarem na busca, a
#: **forma de pergunta** é o que faz o Bing devolver lixo: "o que é fastapi" trazia "YouTube
#: TV Help" e "quem ganhou o brasileirao" trazia o VLC (medido); "fastapi" e "brasileirao"
#: trazem o certo.
VAZIAS = {
    "quem", "que", "qual", "quais", "quando", "onde", "como", "porque", "por", "pra",
    "para", "dos", "das", "uma", "uns", "umas", "the", "what", "who", "when", "where",
    "how", "why", "which", "is", "are", "was", "were", "a", "o", "as", "os", "de", "do",
    "da", "em", "no", "na", "e", "é", "um",
}

#: Cliente único das buscas: guardar os cookies da sessão do Bing é o que segura o
#: anti-robô — pedido sem cookie nenhum é o que ele trata como robô e degrada.
_cliente_web: httpx.Client | None = None
_sessao_do_bing = False

#: Etiquetas que **não** são conteúdo: saem antes de ler o texto da página.
RUIDO = (
    "script",
    "style",
    "nav",
    "header",
    "footer",
    "aside",
    "form",
    "svg",
    "noscript",
    "iframe",
)

#: O que não é texto: procurar dentro devolve lixo binário, e lixo binário ocupa o teto de
#: resultados. `.pyc`/`.pyo` estão aqui porque são justamente os arquivos que aparecem depois
#: de rodar código no projeto — a busca já devolveu bytes de `__pycache__` no lugar do código.
EXTENSOES_IGNORADAS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".zip",
    ".gz",
    ".tar",
    ".7z",
    ".rar",
    ".exe",
    ".dll",
    ".so",
    ".o",
    ".a",
    ".bin",
    ".pyc",
    ".pyo",
    ".pyd",
    ".class",
    ".jar",
    ".pdf",
    ".woff",
    ".woff2",
    ".ttf",
    ".sqlite",
    ".db",
    ".mp3",
    ".mp4",
}

#: Pastas que não interessam a uma busca de código: são geradas, enormes, ou as duas coisas.
#: Quem precisa procurar dentro delas tem o `shell`.
PASTAS_IGNORADAS = {
    ".git",
    "__pycache__",
    ".venv",
    "venv",
    "node_modules",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
}


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
    "patch": "apply_patch",
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

#: Nomes aceitos dentro de um item da lista de tarefas, além de `texto`/`feito`/`atual`.
SINONIMOS_DE_ITEM: dict[str, str] = {
    "text": "texto",
    "titulo": "texto",
    "title": "texto",
    "descricao": "texto",
    "description": "texto",
    "tarefa": "texto",
    "task": "texto",
    "step": "texto",
    "done": "feito",
    "concluido": "feito",
    "completed": "feito",
    "completo": "feito",
    "finished": "feito",
    "status": "atual",
    "current": "atual",
    "ativo": "atual",
    "em_andamento": "atual",
    "in_progress": "atual",
}

#: Estados escritos como texto (o modelo manda `"status": "feito"` com frequência).
ESTADOS_DE_ITEM = {
    "feito": (True, False),
    "done": (True, False),
    "concluido": (True, False),
    "completed": (True, False),
    "atual": (False, True),
    "em_andamento": (False, True),
    "in_progress": (False, True),
    "fazendo": (False, True),
    "pendente": (False, False),
    "todo": (False, False),
    "pending": (False, False),
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


def _def(
    nome: str, descricao: str, props: dict[str, Any], obrigatorios: list[str]
) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": nome,
            "description": descricao,
            "parameters": {"type": "object", "properties": props, "required": obrigatorios},
        },
    }


# ---------------------------------------------------------------- catálogo

DEFINICOES: list[dict[str, Any]] = [
    # ---- execução ----
    _def(
        "code_interpreter",
        "Executa um trecho de código e devolve a saída (print etc). Python por padrão; "
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
        "Executa um comando no terminal (cmd) e devolve stdout+stderr. Comando que demora "
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
    # ---- arquivos ----
    _def(
        "read_file",
        "Lê um arquivo de texto inteiro. Não passe `limite` por hábito: o arquivo vem "
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
        "write_file",
        "Cria ou sobrescreve um arquivo de texto (cria subpastas).",
        {"caminho": {"type": "string"}, "conteudo": {"type": "string"}},
        ["caminho", "conteudo"],
    ),
    _def(
        "edit_file",
        "Substitui trecho exato em um arquivo (old_string deve ocorrer uma única vez).",
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
        "Lista arquivos e subpastas de um diretório (padrão: pasta de trabalho).",
        {"caminho": {"type": "string", "description": "padrão: ."}},
        [],
    ),
    _def("delete_file", "Apaga um arquivo (não apaga pastas).", {"caminho": {"type": "string"}}, ["caminho"]),
    _def(
        "create_directory",
        "Cria uma pasta (cria também as pastas acima dela que faltarem).",
        {"caminho": {"type": "string"}},
        ["caminho"],
    ),
    _def(
        "move_file",
        "Move um arquivo ou uma pasta para outro caminho (o destino não pode existir).",
        {"origem": {"type": "string"}, "destino": {"type": "string"}},
        ["origem", "destino"],
    ),
    _def(
        "copy_file",
        "Copia um arquivo ou uma pasta inteira para outro caminho.",
        {"origem": {"type": "string"}, "destino": {"type": "string"}},
        ["origem", "destino"],
    ),
    _def(
        "rename_file",
        "Renomeia um arquivo ou pasta dentro da mesma pasta (só o nome, sem caminho).",
        {"caminho": {"type": "string"}, "novo_nome": {"type": "string"}},
        ["caminho", "novo_nome"],
    ),
    _def(
        "delete_directory",
        "Apaga uma pasta inteira, com tudo dentro dela. Nunca apaga a pasta de trabalho.",
        {"caminho": {"type": "string"}},
        ["caminho"],
    ),
    _def(
        "get_environment",
        "Informa o ambiente de trabalho: sistema, pasta do projeto, Python, git e o que há nela.",
        {},
        [],
    ),
    # ---- busca ----
    _def(
        "search_codebase",
        "Busca um termo (texto ou regex) em todos os arquivos do projeto e devolve arquivo:linha com a linha.",
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
        "Busca com expressão regular nos arquivos do projeto (arquivo:linha:trecho).",
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
    # ---- web ----
    _def("web_search", "Pesquisa na web e devolve título, URL e resumo dos resultados.", {"consulta": {"type": "string"}}, ["consulta"]),
    _def("url_reader", "Baixa uma URL pública (http/https) e devolve o texto da página.", {"url": {"type": "string"}}, ["url"]),
    _def("browser", "Alias de url_reader: abre uma URL e devolve o texto.", {"url": {"type": "string"}}, ["url"]),
    # ---- git ----
    _def("git_status", "Mostra o status git do projeto.", {}, []),
    _def("git_diff", "Mostra o diff não-commitado (staged + unstaged).", {}, []),
    _def("git_log", "Mostra os últimos commits (padrão 10).", {"quantidade": {"type": "integer"}}, []),
    _def("git_commit", "Faz git add -A e commit com a mensagem dada.", {"mensagem": {"type": "string"}}, ["mensagem"]),
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
    _def(
        "search_files",
        "Procura arquivos pelo nome ou por um padrão glob (ex.: **/*.py) e devolve os caminhos.",
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
    # ---- git (remoto) ----
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
    # ---- dependências ----
    _def(
        "install_package",
        "Instala uma dependência no projeto (npm/pnpm/yarn, uv/pip ou cargo, pelo que o projeto usa).",
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
    # ---- arquivos pela rede ----
    _def(
        "download_file",
        "Baixa uma URL http(s) para um arquivo dentro da pasta de trabalho.",
        {"url": {"type": "string"}, "destino": {"type": "string"}},
        ["url", "destino"],
    ),
    _def(
        "upload_file",
        "Envia um arquivo da pasta de trabalho para uma URL http(s) (PUT).",
        {"caminho": {"type": "string"}, "url": {"type": "string"}},
        ["caminho", "url"],
    ),
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

#: Ferramentas de arquivo com **dois** caminhos na chamada: os dois passam pela checagem
#: de pasta, senão mover para fora do projeto passaria batido.
CAMINHOS_EXTRA: dict[str, tuple[str, ...]] = {
    "move_file": ("origem", "destino"),
    "copy_file": ("origem", "destino"),
    "download_file": ("destino",),
}

#: Quantos redirecionamentos o `url_reader` segue antes de desistir.
SALTOS_MAXIMOS = 5


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


# ---------------------------------------------------------------- utilidades


def _resolver(workspace: Path, caminho: str) -> Path:
    """Caminho relativo à pasta de trabalho; absoluto passa como veio.

    Quem decide se um caminho absoluto pode ser usado é `_validar_caminho`, chamada
    antes de qualquer ferramenta de arquivo rodar.
    """
    rota = Path((caminho or ".").strip())
    if not rota.is_absolute():
        rota = workspace / rota
    return rota


def _dentro_do_workspace(workspace: Path, rota: Path) -> bool:
    """True se `rota` está dentro de `workspace` — resolvendo symlink e `..`."""
    try:
        raiz = workspace.resolve()
        alvo = rota.resolve()
    except OSError:
        return False
    return alvo == raiz or raiz in alvo.parents


def alvos(nome: str, argumentos: dict[str, Any]) -> list[str]:
    """Todos os caminhos que a chamada toca.

    As ferramentas de arquivo têm um (`caminho`); mover, copiar e baixar têm dois (`origem`
    e `destino`), e os dois precisam passar pela checagem de pasta — senão bastaria mover
    para fora do projeto para escapar dela.
    """
    nome = canonico(nome)
    argumentos = _sinonimos(argumentos)
    if nome not in FERRAMENTAS_DE_ARQUIVO:
        return []
    if nome in CAMINHOS_EXTRA:
        return [str(argumentos.get(chave, "") or "") for chave in CAMINHOS_EXTRA[nome]]
    return [str(argumentos.get("caminho", "") or ".")]


def _validar_caminho(
    workspace: Path, argumentos: dict[str, Any], acesso_livre: bool
) -> str | None:
    """Devolve a mensagem de erro se o caminho escapar da pasta de trabalho.

    A checagem é feita uma vez, antes do despacho, em vez de dentro de cada
    ferramenta: assim um caminho novo não entra sem passar por aqui.
    """
    return _validar_alvos(workspace, "", argumentos, acesso_livre)


def _validar_alvos(
    workspace: Path, nome: str, argumentos: dict[str, Any], acesso_livre: bool
) -> str | None:
    """A checagem de pasta para todos os caminhos da chamada.

    O caminho é a pasta do projeto, e sair dela é coisa que se pede: a mensagem de erro
    diz **como** pedir (deixar a pessoa liberar a pasta no cartão de permissão), porque
    quem lê isso é o modelo — e um "defina KODA_ACESSO_LIVRE" só o empurrava para o
    `code_interpreter`, que não passa por checagem nenhuma.
    """
    if acesso_livre:
        return None
    for caminho in alvos(nome, argumentos):
        rota = _resolver(workspace, caminho)
        if _dentro_do_workspace(workspace, rota):
            continue
        return (
            f"ERRO: {rota} está fora da pasta de trabalho ({workspace}).\n"
            "As ferramentas de arquivo só mexem dentro do projeto. Duas saídas: use um "
            "caminho relativo à pasta de trabalho, ou peça à pessoa para autorizar esta "
            "pasta (o pedido de permissão aparece na conversa). **Não** tente fazer o "
            "mesmo com code_interpreter nem com shell: operação de arquivo é com a "
            "ferramenta de arquivo."
        )
    return None


def fora_da_pasta(nome: str, argumentos: dict[str, Any], workspace: Path) -> bool:
    """A chamada mexe em algo fora da pasta de trabalho?

    Quem pergunta isso é o loop, para saber que uma autorização vale como acesso livre
    **nesta** chamada: o cartão de permissão já descreve a ação como «fora da pasta»
    (`classificar`), então aprovar precisa valer de verdade — antes disso a pessoa dizia
    «sim» e a ferramenta recusava do mesmo jeito.
    """
    return any(
        not _dentro_do_workspace(workspace, _resolver(workspace, caminho))
        for caminho in alvos(nome, argumentos)
    )


def _trava_da_pasta(workspace: Path, rota: Path) -> str | None:
    """O que `delete_directory` nunca apaga: a pasta de trabalho, quem a contém, raízes.

    Apagar pasta é recursivo, e o modelo é quem escolhe o caminho. Sem esta trava, um
    `delete_directory` com `..` apagaria o projeto inteiro (ou a pasta acima dele) — e
    nenhum cartão de permissão conserta o que já foi apagado.
    """
    try:
        alvo = rota.resolve()
        raiz = workspace.resolve()
    except OSError:
        return f"ERRO: não consegui resolver o caminho: {rota}"
    if alvo == raiz or alvo in raiz.parents:
        return (
            f"ERRO: {alvo} é a pasta de trabalho (ou uma pasta acima dela) — "
            "não apago esta pasta."
        )
    if alvo.parent == alvo:
        return f"ERRO: {alvo} é a raiz do disco — não apago."
    return None


def _ambiente(workspace: Path) -> str:
    """O retrato do ambiente: onde o agente está, com o quê, e o que há por aqui."""
    linhas = [
        f"sistema: {platform.system()} {platform.release()} ({platform.machine()})",
        f"pasta de trabalho: {workspace}",
        f"python: {sys.version.split()[0]} em {sys.executable}",
        f"shell padrão: {'cmd.exe' if sys.platform == 'win32' else '/bin/sh'}",
        f"git: {shutil.which('git') or 'não encontrado'}",
    ]
    try:
        itens = sorted(workspace.iterdir(), key=lambda item: (item.is_file(), item.name))
    except OSError as exc:
        linhas.append(f"(não consegui listar a pasta de trabalho: {exc})")
        return "\n".join(linhas)
    pastas = [item.name for item in itens if item.is_dir() and item.name not in PASTAS_IGNORADAS]
    arquivos = [item.name for item in itens if item.is_file()]
    linhas.append(f"pastas ({len(pastas)}): {', '.join(pastas[:30]) or '(nenhuma)'}")
    linhas.append(f"arquivos ({len(arquivos)}): {', '.join(arquivos[:30]) or '(nenhum)'}")
    return "\n".join(linhas)


def _inteiro(valor: Any, padrao: int) -> int:
    """Inteiro do argumento, com o padrão quando o modelo manda texto solto."""
    try:
        return int(valor)
    except (TypeError, ValueError):
        return padrao


def _limitar(texto: str) -> str:
    if len(texto) > LIMITE_SAIDA:
        return texto[:LIMITE_SAIDA] + f"\n...[saída truncada, {len(texto) - LIMITE_SAIDA} caracteres restantes]"
    return texto


#: Onde os programas costumam ficar no Windows. O app é aberto pelo Explorer, e o PATH que
#: ele herda **não** é o mesmo do terminal de quem instalou: `node`, `npm`, `git` e `python`
#: somem sem que nada esteja quebrado. Sem isto, metade dos comandos do projeto morria em
#: "is not recognized" — e o modelo tentava de novo, de outro jeito, até gastar a tarefa.
LUGARES_DE_PROGRAMA = (
    r"C:\Program Files\nodejs",
    r"C:\Program Files (x86)\nodejs",
    r"~\AppData\Roaming\npm",
    r"~\AppData\Local\Programs\nodejs",
    r"C:\Program Files\Git\cmd",
    r"C:\Program Files\Git\bin",
    r"~\AppData\Local\Programs\Python",
    r"~\AppData\Local\Programs\Python\Scripts",
    r"~\AppData\Local\Microsoft\WindowsApps",
    r"~\AppData\Roaming\Python",
    r"C:\Python313",
    r"C:\Python312",
    r"C:\Python311",
    r"C:\Python310",
    r"~\.local\bin",
    r"~\.cargo\bin",
    r"~\scoop\shims",
    r"C:\ProgramData\chocolatey\bin",
)

#: O PATH aumentado, montado uma vez por processo (a busca em disco é cara para repetir).
_PATH_AUMENTADO: str | None = None


def _path_com_programas() -> str:
    """O PATH do processo **mais** os lugares conhecidos que existem de verdade.

    Só entra o diretório que tem executável dentro: adivinhar caminho não resolve nada.
    """
    global _PATH_AUMENTADO
    if _PATH_AUMENTADO is not None:
        return _PATH_AUMENTADO

    atual = os.environ.get("PATH", "")
    partes = atual.split(os.pathsep) if atual else []
    vistos = {p.rstrip("\\/").lower() for p in partes}

    extras: list[str] = []
    for bruto in LUGARES_DE_PROGRAMA:
        base = Path(os.path.expanduser(bruto))
        candidatos = [base]
        if base.name == "Python":  # as versões ficam em subpastas: Python\Python311
            candidatos = sorted(
                (filho for filho in base.glob("Python3*") if filho.is_dir()), reverse=True
            )
        for pasta in candidatos:
            if not pasta.is_dir():
                continue
            chave = str(pasta).rstrip("\\/").lower()
            if chave in vistos:
                continue
            if not any(pasta.glob("*.exe")):
                continue
            vistos.add(chave)
            extras.append(str(pasta))
            # As ferramentas de linha de comando dos scripts ficam ao lado.
            scripts = pasta / "Scripts"
            if scripts.is_dir() and any(scripts.glob("*.exe")):
                vistos.add(str(scripts).lower())
                extras.append(str(scripts))

    _PATH_AUMENTADO = os.pathsep.join([*partes, *extras]) if extras else atual
    return _PATH_AUMENTADO


def _ambiente_do_comando() -> dict[str, str]:
    return {**os.environ, "PATH": _path_com_programas()}


def _argv_shell(comando: str) -> str:
    """O comando como o shell do sistema espera recebê-lo.

    **String, e não lista** — e isso é o conserto de metade dos comandos que falhavam. Com
    `["cmd", "/c", comando]` o `cmd` come as aspas internas: `python -c "print(1 + 1)"`
    chegava no Python como `print(1 + 1` e voltava `exit code: 1`. Medido com os comandos
    que os modelos escrevem: **6 de 12 falhavam** na lista contra **0 de 12** com a string
    (que é o `shell=True` do Python). O modelo tentava de novo, tentava de outro jeito, e
    era isso que parecia "os modelos não conseguem rodar comando".
    """
    return comando


#: Quando o shell não conhece o programa: em inglês e em português, cmd e PowerShell.
NAO_RECONHECIDO = re.compile(
    r"is not recognized|n[aã]o [eé] reconhecido|CommandNotFound|n[aã]o pode ser encontrado",
    re.IGNORECASE,
)

#: Programas que o modelo mais tenta rodar. A dica abaixo responde a pergunta que ele ia
#: fazer em três tentativas — "então o que existe nesta máquina?".
PROGRAMAS = ("python", "python3", "py", "node", "npm", "npx", "git", "pip", "uv")


def _dica_de_programa(saida: str) -> str:
    """O que fazer quando o comando não existe nesta máquina.

    Sem isto o modelo tentava `python`, depois `python3`, depois `py`, depois `cmd`… e
    gastava a tarefa inteira nisso — era o "tenta tudo e não vai" que o dono descreveu. Com
    a lista na mão ele muda de caminho na primeira tentativa.
    """
    if not NAO_RECONHECIDO.search(saida):
        return ""
    achados = []
    caminho_original = os.environ.get("PATH")
    os.environ["PATH"] = _path_com_programas()
    try:
        for programa in PROGRAMAS:
            caminho = shutil.which(programa)
            if caminho:
                achados.append(f"{programa} → {caminho}")
    finally:
        if caminho_original is not None:
            os.environ["PATH"] = caminho_original
    if not achados:
        return "\n\nDICA: nenhum destes programas está no PATH desta máquina: " + ", ".join(
            PROGRAMAS
        )
    return (
        "\n\nDICA: este programa não existe (ou não está no PATH). O que **existe** aqui: "
        + " · ".join(achados)
        + ". Use um destes, ou resolva por outra ferramenta (arquivo com `write_file`, "
        "código com `code_interpreter`) em vez de insistir no mesmo nome."
    )


def _formatar(proc: subprocess.CompletedProcess[str]) -> str:
    saida = f"exit code: {proc.returncode}\n"
    if proc.stdout:
        saida += f"--- stdout ---\n{proc.stdout}"
    if proc.stderr:
        saida += f"\n--- stderr ---\n{proc.stderr}"
    return _limitar((saida.strip() or "(sem saída)") + _dica_de_programa(saida))


def _rodar_lista(
    argv: list[str],
    workspace: Path,
    tempo: int = TEMPO_COMANDO,
    env: dict[str, str] | None = None,
) -> str:
    """Executa um argv direto (sem shell) — para comandos compostos pelo agente.

    `env` é mesclado ao ambiente do processo: é o que permite pedir ao git para **não**
    abrir prompt de senha (`GIT_TERMINAL_PROMPT=0`) — sem isso um `git push` num remoto
    que pede credencial fica parado até o tempo limite, sem nada na tela.
    """
    ambiente = None
    if env:
        ambiente = {**os.environ, **env}
    try:
        proc = subprocess.run(
            argv,
            shell=False,
            cwd=str(workspace),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=tempo,
            env=ambiente,
        )
        return _formatar(proc)
    except subprocess.TimeoutExpired:
        return f"ERRO: comando excedeu {tempo}s e foi interrompido"
    except FileNotFoundError:
        return f"ERRO: executável não encontrado: {argv[0]}"


class ComandoRodando:
    """Um comando que passou da olhada e continua vivo, com a saída guardada.

    A saída é lida por duas threads (stdout e stderr) que só **acrescentam** à lista — quem
    espera é a thread principal, no `wait` do processo. Assim a saída parcial está sempre
    disponível para a próxima olhada, e nada do que o comando já escreveu se perde.
    """

    def __init__(self, identificador: str, comando: str, proc: subprocess.Popen[str]) -> None:
        self.id = identificador
        self.comando = comando
        self.proc = proc
        self.saida: list[str] = []
        self.erro: list[str] = []
        self.inicio = time.monotonic()
        #: Quantos caracteres o comando já escreveu (contador, e não `len()` da lista: a
        #: saída guardada é cortada no teto, e o corte faria um comando tagarela parecer
        #: parado).
        self.escrito = 0
        #: Quantas olhadas já houve, e quantas seguidas não trouxeram **nada novo**.
        self.olhadas = 0
        self.paradas = 0
        #: Marca d'água da última olhada que viu saída nova.
        self._visto = 0
        for fluxo, destino in ((proc.stdout, self.saida), (proc.stderr, self.erro)):
            if fluxo is not None:
                threading.Thread(target=self._ler, args=(fluxo, destino), daemon=True).start()

    def _ler(self, fluxo: Any, destino: list[str]) -> None:
        try:
            for linha in fluxo:
                destino.append(linha)
                self.escrito += len(linha)
        except (ValueError, OSError):
            # O processo morreu e levou o cano junto: o que já foi lido fica.
            pass

    def olhar(self) -> int:
        """Conta a olhada e devolve quantas seguidas vieram sem saída nova.

        O contador é o que diz se o comando está **trabalhando** ou **parado** — e é isso
        que decide se ele continua vivo ou é interrompido. Tempo sozinho não decide nada:
        build de duas horas é trabalho, comando mudo de doze minutos é travamento.
        """
        self.olhadas += 1
        antes = self.escrito
        if antes > self._visto:
            self._visto = antes
            self.paradas = 0
        else:
            self.paradas += 1
        return self.paradas

    def decorrido(self) -> float:
        return time.monotonic() - self.inicio

    def terminou(self) -> bool:
        return self.proc.poll() is not None

    def esperar(self, segundos: float) -> bool:
        """Espera até `segundos`. `True` quando o comando terminou nesse meio-tempo."""
        try:
            self.proc.wait(timeout=segundos)
            return True
        except subprocess.TimeoutExpired:
            return False

    def texto(self) -> str:
        """O que o comando escreveu até agora — o fim da saída, que é onde está o erro."""
        junto = "".join(self.saida)
        if self.erro:
            junto += ("\n--- stderr ---\n" if junto else "--- stderr ---\n") + "".join(self.erro)
        junto = junto.strip()
        if len(junto) > LIMITE_SAIDA_RODANDO:
            fora = len(junto) - LIMITE_SAIDA_RODANDO
            return (
                f"(...{fora} caracteres anteriores descartados...)\n"
                + junto[-LIMITE_SAIDA_RODANDO:]
            )
        return junto or "(sem saída até agora)"

    def parar(self) -> str:
        """Interrompe o comando e a árvore dele, e devolve o que já tinha saído."""
        if self.terminou():
            return _formatar(
                subprocess.CompletedProcess(
                    args=self.comando,
                    returncode=self.proc.returncode or 0,
                    stdout=self.texto(),
                    stderr="",
                )
            )
        _matar_arvore(self.proc.pid)
        self.esperar(5)
        return (
            f"interrompido a pedido (pid {self.proc.pid})\n"
            f"--- saída até a interrupção ---\n{self.texto()}"
        )


def _matar_arvore(pid: int) -> None:
    """Mata o processo **e os filhos** dele.

    `proc.kill()` sozinho deixa filho órfão rodando (o `npm run dev` que sobrevive ao
    `npm`), e no Windows quem sabe derrubar a árvore é o `taskkill /T`.
    """
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                capture_output=True,
                text=True,
                timeout=15,
            )
        else:
            os.killpg(os.getpgid(pid), 9)
    except (OSError, subprocess.SubprocessError):
        pass


def _relatorio_de_olhada(rodando: "ComandoRodando") -> str:
    """O retorno da olhada: o comando **não** morreu, e o modelo decide o que fazer.

    As duas últimas linhas são o que o modelo precisa para agir — sem elas ele responde
    texto, a conversa trava e o comando fica rodando sem ninguém olhando.

    Passando de `OLHADAS_SEM_SAIDA` olhadas **sem saída nova**, o comando é interrompido:
    parado é travado, e esperar mais não ia resolver. Quem manda é o progresso, não o
    relógio — build de duas horas que está imprimindo segue vivo.
    """
    minutos = rodando.decorrido() / 60
    paradas = rodando.olhar()

    if paradas >= OLHADAS_SEM_SAIDA:
        _RODANDO.pop(rodando.id, None)
        # Interromper é **matar**, não só tirar do registro. Sem o `parar()` aqui o processo
        # continuava rodando e, pior, órfão: fora do registro, ninguém conseguia pará-lo pelo
        # id. A mensagem dizia "interrompi" e era falso.
        rodando.parar()
        minutos_parado = (paradas * INTERVALO_DE_OLHADA) // 60
        return (
            f"INTERROMPIDO: o comando parece TRAVADO — {paradas} olhadas seguidas sem uma "
            f"linha nova (~{minutos_parado} min sem escrever nada) — id={rodando.id}\n"
            f"comando: {rodando.comando}\n"
            f"--- saída até a interrupção ---\n{rodando.texto()}\n"
            f"--- fim da saída ---\n"
            "Comando que para de escrever por doze minutos está travado (esperando entrada, "
            "em laço mudo, ou morto por dentro), e continuar esperando não ia resolver. "
            "Isso **não** é o fim da tarefa: siga por outro caminho (comando mais direto, "
            "`code_interpreter`, ou a ferramenta de arquivo) e diga o que ficou pronto."
        )

    aviso = ""
    if rodando.olhadas >= OLHADAS_ATE_COBRAR:
        # Sem teto por tempo, este é o freio do "vou continuar" infinito: o modelo é cobrado
        # a decidir — mas quem decide continua sendo ele.
        aviso = (
            f"\nATENÇÃO: já são {rodando.olhadas} olhadas neste mesmo comando "
            f"({minutos:.0f} min). Se ele não termina sozinho (servidor, programa com janela, "
            "prévia), **pare agora**. Se está perto de terminar, continue — mas decida, não "
            "fique só acompanhando."
        )

    return (
        f"AINDA RODANDO ({minutos:.1f} min) — id={rodando.id}\n"
        f"comando: {rodando.comando}\n"
        f"--- saída até agora ---\n{rodando.texto()}\n"
        f"--- fim da saída até agora ---\n"
        f"O comando NÃO foi interrompido: ele continua rodando.\n"
        f"- Está indo bem e pode demorar? Continue acompanhando: "
        f'shell com {{"continuar": "{rodando.id}"}}\n'
        f"- Não termina sozinho (servidor, programa com janela, prévia) ou travou? Pare: "
        f'shell com {{"parar": "{rodando.id}"}}'
        f"{aviso}"
    )


def _comecar(comando: str, workspace: Path) -> "ComandoRodando":
    proc = subprocess.Popen(
        _argv_shell(comando),
        shell=True,
        cwd=str(workspace),
        env=_ambiente_do_comando(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    identificador = uuid.uuid4().hex[:8]
    rodando = ComandoRodando(identificador, comando, proc)
    _RODANDO[identificador] = rodando
    return rodando


def _acompanhar(identificador: str, tempo: int) -> str:
    """Espera mais um tanto por um comando que já estava rodando."""
    rodando = _RODANDO.get(identificador)
    if rodando is None:
        return (
            f"ERRO: não há comando rodando com id {identificador!r} — ele já terminou ou o "
            "id está errado. Rode o comando de novo se precisar."
        )
    if rodando.esperar(min(tempo, INTERVALO_DE_OLHADA)):
        _RODANDO.pop(identificador, None)
        return _formatar(
            subprocess.CompletedProcess(
                args=rodando.comando,
                returncode=rodando.proc.returncode or 0,
                stdout=rodando.texto(),
                stderr="",
            )
        )
    return _relatorio_de_olhada(rodando)


def _parar(identificador: str) -> str:
    rodando = _RODANDO.pop(identificador, None)
    if rodando is None:
        return f"ERRO: não há comando rodando com id {identificador!r}."
    return rodando.parar()


def _rodar(comando: str, workspace: Path, tempo: int = TEMPO_COMANDO) -> str:
    """Roda o comando e **não** o mata quando demora: devolve a olhada e segue vivo.

    Era `subprocess.run(timeout=...)`, que interrompia o comando no limite — um build de
    vinte minutos morria no meio e o trabalho ia junto. Agora o processo fica no registro e,
    a cada `INTERVALO_DE_OLHADA`, o modelo recebe a saída até agora para decidir: continuar
    acompanhando (`continuar`) ou parar (`parar`). `tempo` é teto total (0 = sem teto).
    """
    try:
        rodando = _comecar(comando, workspace)
    except FileNotFoundError:
        return f"ERRO: comando não encontrado: {comando.split()[0]}"
    except OSError as exc:
        return f"ERRO ao rodar {comando!r}: {exc}"

    limite = min(tempo, INTERVALO_DE_OLHADA) if tempo else INTERVALO_DE_OLHADA
    if rodando.esperar(limite):
        _RODANDO.pop(rodando.id, None)
        return _formatar(
            subprocess.CompletedProcess(
                args=comando,
                returncode=rodando.proc.returncode or 0,
                stdout=rodando.texto(),
                stderr="",
            )
        )
    return _relatorio_de_olhada(rodando)


# ---------------------------------------------------------------- web


def host_publico(url: str) -> bool:
    """True apenas para http/https resolvendo para IP público (nada de

    localhost, rede privada, link-local, reservado ou loopback).
    """
    partes = urllib.parse.urlparse(url)
    if partes.scheme not in ("http", "https") or not partes.hostname:
        return False
    try:
        infos = socket.getaddrinfo(
            partes.hostname, partes.port or (443 if partes.scheme == "https" else 80)
        )
    except OSError:
        return False
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            return False
    return True


def _limpar_texto(marcado: str) -> str:
    """Tira as tags e desfaz as entidades HTML.

    Sem o `unescape` o modelo lê `D&#243;lar` e `cota&#231;&#227;o` no lugar de "Dólar" e
    "cotação" — os buscadores devolvem os acentos assim.
    """
    sem_tags = re.sub(r"<[^>]+>", " ", marcado)
    return re.sub(r"\s+", " ", html.unescape(sem_tags)).strip()


def _tirar_tags(marcado: str) -> str:
    """O texto que interessa da página: o miolo, sem menu, rodapé, código e script.

    Página de aplicação (SPA) chega quase vazia — quem lê o retorno é o modelo, e é melhor
    ele saber que a página "não tem texto" do que receber o menu de navegação como se fosse
    o conteúdo.
    """
    miolo = re.search(r"<(article|main)\b.*?</\1>", marcado, re.S | re.I)
    corpo = miolo.group(0) if miolo else marcado
    for etiqueta in RUIDO:
        corpo = re.sub(rf"<{etiqueta}\b.*?</{etiqueta}>", " ", corpo, flags=re.S | re.I)
    return _limpar_texto(corpo)


def _titulo_da_pagina(marcado: str) -> str:
    achado = re.search(r"<title[^>]*>(.*?)</title>", marcado, re.S | re.I)
    return _limpar_texto(achado.group(1))[:120] if achado else ""


def _texto_do_item(item: str, etiqueta: str) -> str:
    """Um campo do item do RSS, já sem CDATA e sem entidades HTML."""
    achado = re.search(rf"<{etiqueta}>(.*?)</{etiqueta}>", item, re.S)
    if not achado:
        return ""
    return _limpar_texto(re.sub(r"^<!\[CDATA\[(.*)\]\]>$", r"\1", achado.group(1).strip()))


def _cliente_das_buscas() -> httpx.Client:
    """O cliente HTTP das buscas, com a sessão do Bing já iniciada.

    A visita à home existe para pegar os cookies (`MUID`, `SRCHHPGUSR`…): é o que o Bing
    usa para separar navegador de robô. Sem cookie, ele serve a página degradada.
    """
    global _cliente_web, _sessao_do_bing
    if _cliente_web is None:
        _cliente_web = httpx.Client(
            headers=CABECALHOS_WEB, timeout=10, follow_redirects=True
        )
    if not _sessao_do_bing:
        _sessao_do_bing = True
        try:
            _cliente_web.get("https://www.bing.com/")
        except httpx.HTTPError:
            pass
    return _cliente_web


def _enxugar(consulta: str) -> str:
    """A consulta sem as palavras de pergunta: as que sobram são as que buscam."""
    palavras = [p for p in re.findall(r"[\wÀ-ÿ]+", consulta) if p.lower() not in VAZIAS]
    return " ".join(palavras)


def _tem_a_ver(resultado: str, consulta: str) -> bool:
    """Algum título do resultado traz uma palavra significativa da consulta?

    É o detector da página degradada: quando o Bing decide que quem pergunta é robô, ele
    devolve resultados aleatórios ("Gmail", "VLC", "知乎") que não têm palavra nenhuma da
    consulta. Aí vale tentar de novo com a consulta enxuta, em vez de entregar lixo ao
    modelo — que é o que fazia ele responder bobagem com toda a confiança.
    """
    if not resultado:
        return False
    alvo = resultado.lower()
    palavras = [p for p in re.findall(r"[\wÀ-ÿ]{4,}", consulta.lower()) if p not in VAZIAS]
    return not palavras or any(p in alvo for p in palavras)


def _busca_bing(consulta: str) -> str:
    """Os resultados do Bing, lidos do **RSS** dele.

    O HTML do Bing não serve para isto, e isso foi medido: com `User-Agent` de robô ele
    devolve uma página **degradada** (resultado aleatório, sem relação com a consulta —
    "YouTube Help" para "documentacao do fastapi": 0 de 10 relevantes) e com UA de navegador
    devolve uma casca que só monta com JavaScript (0 resultados). O RSS (`format=rss`) é o
    mesmo Bing, a mesma consulta e a mesma ordem — em XML, sem o anti-robô no caminho:
    **10 de 10 relevantes** nas mesmas consultas.

    O Bing continua sendo a única fonte: não há plano B, nem serviço no meio, nem chave.
    """
    def uma_rodada(termo: str) -> str:
        resp = _cliente_das_buscas().get(
            "https://www.bing.com/search", params={"q": termo, "format": "rss"}
        )
        linhas = []
        for i, item in enumerate(re.findall(r"<item>(.*?)</item>", resp.text, re.S)[:8], 1):
            titulo = _texto_do_item(item, "title")
            url = _texto_do_item(item, "link")
            if not (titulo or url):
                continue
            resumo = _texto_do_item(item, "description")[:220]
            linhas.append(
                f"{i}. {titulo or url}\n   {url}" + (f"\n   {resumo}" if resumo else "")
            )
        return "\n".join(linhas)

    primeira = uma_rodada(consulta)
    if _tem_a_ver(primeira, consulta):
        return primeira

    # A página degradada veio: tenta de novo com a consulta enxuta (sem as palavras de
    # pergunta). O que salvou os casos medidos foi justamente isto.
    enxuta = _enxugar(consulta)
    if enxuta and enxuta.lower() != consulta.strip().lower():
        segunda = uma_rodada(enxuta)
        if _tem_a_ver(segunda, consulta) or not primeira:
            return segunda
    return primeira


def _web_buscar(consulta: str) -> str:
    """Busca na web — só o Bing, e só ele.

    Sem SearXNG, sem DuckDuckGo e sem corrida entre fontes: uma requisição, um resultado.
    Se o Bing devolver uma página de bloqueio ou nada que dê para ler, o retorno é
    "(sem resultados)" — não existe plano B.
    """
    if not consulta.strip():
        return "ERRO: consulta vazia"
    try:
        achados = _busca_bing(consulta)
    except httpx.HTTPError as exc:
        return f"ERRO: o Bing não respondeu ({exc})"
    if not achados:
        return "(sem resultados)"
    if not _tem_a_ver(achados, consulta):
        # Dizer isto é o que evita o modelo concluir bobagem a partir de resultado que não
        # tem nada a ver: sem o aviso, ele lia "Gmail" e respondia como se fosse a resposta.
        return _limitar(
            "AVISO: o Bing devolveu resultados que **não têm relação** com a consulta "
            "(proteção anti-robô dele). Não use isto como resposta — tente outra consulta, "
            "com menos palavras e sem forma de pergunta.\n\n" + achados
        )
    return _limitar(achados)


def _web_ler(url: str) -> str:
    """Lê uma URL pública seguindo os redirects um a um, checando cada destino.

    O `follow_redirects=True` do httpx não serve aqui: ele checa a URL de partida e
    depois segue cego, então um host público que devolve `Location: http://127.0.0.1`
    (ou `169.254.169.254`, o metadata da nuvem) entrava direto. Seguindo na mão, cada
    salto passa pelo mesmo `host_publico`.

    O que volta é o **miolo** da página (ver `_tirar_tags`) e o título dela, para o modelo
    saber onde caiu. Página que só funciona com JavaScript sai quase vazia, e o retorno diz
    isso com todas as letras — antes o modelo recebia o menu de navegação como se fosse
    conteúdo e concluía bobagem a partir dele.
    """
    if not host_publico(url):
        return "ERRO: apenas URLs http/https PÚBLICAS são permitidas (localhost/rede privada bloqueados)"

    atual = url
    try:
        with httpx.Client(headers=CABECALHOS_WEB, timeout=25) as cliente:
            for _ in range(SALTOS_MAXIMOS + 1):
                resp = cliente.get(atual)
                destino = resp.headers.get("location")
                if not resp.is_redirect or not destino:
                    break
                proximo = str(httpx.URL(atual).join(destino))
                if not host_publico(proximo):
                    return (
                        f"ERRO: {atual} redireciona para {proximo}, que não é um host "
                        "público. Redirecionamento bloqueado."
                    )
                atual = proximo
            else:
                return f"ERRO: {url} redireciona em ciclo (mais de {SALTOS_MAXIMOS} saltos)"

        tipo = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
        cabeca = f"URL: {resp.url}\nHTTP {resp.status_code}"

        # O que não é página vai como veio: JSON, texto puro, CSV — cortar isso em "texto"
        # já é o certo, e passar por extrator de HTML só estragaria o conteúdo.
        if tipo and not any(marca in tipo for marca in ("html", "xml", "xhtml")):
            return _limitar(f"{cabeca} · {tipo}\n\n{resp.text}")

        titulo = _titulo_da_pagina(resp.text)
        texto = _tirar_tags(resp.text)
        if titulo:
            cabeca += f' · título: "{titulo}"'

        # Página curta é diferente de página que depende de JavaScript: `example.com` tem
        # 100 caracteres e está completa. O aviso só vale quando há script na página e
        # mesmo assim quase não saiu texto — aí o miolo é montado no navegador.
        if len(texto) < 200 and "<script" in resp.text.lower():
            return _limitar(
                f"{cabeca}\n\n"
                "(esta página monta o conteúdo com JavaScript: o texto abaixo é o que veio "
                "no HTML, e provavelmente não é o conteúdo principal — vale procurar outra "
                f"fonte ou outra URL)\n\n{texto}"
            )
        return _limitar(f"{cabeca}\n\n{texto}")
    except httpx.HTTPError as exc:
        return f"ERRO ao ler {url}: {exc}"


# ---------------------------------------------------------------- git


def _raiz_git(workspace: Path) -> str | None:
    """Raiz do repositório que contém a pasta de trabalho, ou None se não houver."""
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=str(workspace),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=20,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout.strip() or None


def _checar_repo(workspace: Path, nome: str) -> str | None:
    """Recusa as ferramentas git quando o repositório não é o da pasta de trabalho.

    Sem isso, um projeto que mora dentro de outro repositório (caso do Koda, que fica
    dentro de uma pasta versionada) faz `git add -A` no repositório do pai — e o
    commit sai no projeto errado, com o histórico de outra pessoa.
    """
    raiz = _raiz_git(workspace)
    if raiz is None:
        return (
            f"ERRO: {workspace} não é um repositório git.\n"
            "Rode `git init` aqui dentro se quiser versionar este projeto."
        )
    if Path(raiz).resolve() != workspace.resolve():
        return (
            f"ERRO: a pasta de trabalho está dentro de outro repositório git ({raiz}),\n"
            f"então `{nome}` mexeria no projeto errado. "
            "Rode `git init` na pasta de trabalho para ter um repositório só dela."
        )
    return None


# ---------------------------------------------------------------- classificação

#: Comandos que costumam ser irreversíveis ou que saem da pasta do projeto. Não decide
#: nada sozinhos — só fazem a permissão aparecer com o aviso mais forte.
COMANDO_PERIGOSO = re.compile(
    r"(rm\s+-|\bdel\s|\berase\s|\bformat\s|shutdown|taskkill|\breg\s+delete|takeown|"
    r"icacls|cipher\s+/w|git\s+push|git\s+reset\s+--hard|git\s+clean|\bremove-item|"
    r"stop-process|invoke-expression|\|\s*(ba)?sh\b|--force|-f\b)",
    re.IGNORECASE,
)

#: Onde a regra «sempre/nunca» é ancorada quando não há alvo melhor.
ESCOPO_QUALQUER = "*"


def classificar(
    nome: str, argumentos: dict[str, Any], workspace: Path
) -> dict[str, Any] | None:
    """Traduz a chamada da ferramenta no que ela vai fazer — e no risco que tem.

    `None` quando a chamada não muda nada no disco (buscar na web, por exemplo). Quem
    decide se precisa pedir permissão é `approvals.resolver`; aqui só se descreve a ação
    em português, para a pessoa ler antes de dizer sim.
    """
    argumentos = argumentos or {}
    pasta = str(workspace)
    # Apelido e sinônimo primeiro: o cartão de permissão descreve a ação **real**, então
    # `run_command` tem que ser tratado como `shell` — senão passava sem descrição.
    nome = canonico(nome)
    argumentos = _sinonimos(argumentos)

    if nome in ("shell", "terminal"):
        acompanhar = str(argumentos.get("continuar") or argumentos.get("parar") or "").strip()
        if acompanhar:
            # Acompanhar ou parar um comando que o **próprio agente** começou não passa pelo
            # cartão de novo: a permissão foi dada quando ele começou a rodar, e parar é o
            # lado seguro. Sem isto o cartão saía como "Rodar comando: (comando vazio)".
            return None
        comando = str(argumentos.get("comando", "")).strip()
        pedacos = comando.split()
        programa = pedacos[0] if pedacos else comando
        return {
            "kinds": ["comando"],
            "escopos": {"comando": programa.lower() or ESCOPO_QUALQUER},
            "titulo": "Rodar comando",
            "resumo": comando or "(comando vazio)",
            "explicacao": f"Rodar este comando no terminal, dentro de {pasta}.",
            "lembrar": f"rodar {programa} nesta máquina",
            "risco": "alto" if COMANDO_PERIGOSO.search(comando) else "medio",
        }

    if nome == "code_interpreter":
        codigo = str(argumentos.get("codigo", "")).strip()
        return {
            "kinds": ["comando"],
            "escopos": {"comando": "code_interpreter"},
            "titulo": "Rodar código Python",
            "resumo": codigo.splitlines()[0][:120] if codigo else "(código vazio)",
            "explicacao": (
                "Rodar um trecho de Python na sua máquina, a partir de "
                f"{pasta}. O código inteiro aparece no passo acima."
            ),
            "lembrar": "rodar código Python solto nesta máquina",
            "risco": "alto" if COMANDO_PERIGOSO.search(codigo) else "medio",
        }

    if nome == "git_commit":
        return {
            "kinds": ["comando"],
            "escopos": {"comando": "git commit"},
            "titulo": "Fazer commit",
            "resumo": str(argumentos.get("mensagem", ""))[:200],
            "explicacao": (
                f"Marcar como commit tudo que está alterado em {pasta} "
                "(git add -A). O histórico do repositório muda."
            ),
            "lembrar": "fazer commits nesta pasta",
            "risco": "medio",
        }

    if nome in ("git_push", "git_pull"):
        remoto = str(argumentos.get("remoto", "")).strip() or "origin"
        ramo = str(argumentos.get("ramo", "")).strip()
        enviando = nome == "git_push"
        return {
            "kinds": ["comando"],
            "escopos": {"comando": f"git {nome}"},
            "titulo": "Enviar commits" if enviando else "Baixar commits",
            "resumo": f"git {nome} {remoto} {ramo}".strip(),
            "explicacao": (
                f"{'Enviar' if enviando else 'Baixar'} os commits "
                f"{'para' if enviando else 'de'} {remoto}"
                + (f" (ramo {ramo})" if ramo else "")
                + f", a partir de {pasta}."
            ),
            "lembrar": f"{nome} neste repositório",
            "risco": "alto" if enviando else "medio",
        }

    if nome in ("install_package", "uninstall_package"):
        pacote = str(argumentos.get("pacote", "")).strip()
        instalando = nome == "install_package"
        return {
            "kinds": ["comando"],
            "escopos": {"comando": nome},
            "titulo": "Instalar dependência" if instalando else "Remover dependência",
            "resumo": pacote,
            "explicacao": (
                f"{'Instalar' if instalando else 'Remover'} o pacote `{pacote}` no projeto "
                f"{pasta}, usando o gerenciador que ele já usa. Isso altera os arquivos de "
                "dependência do projeto."
            ),
            "lembrar": f"{nome} nesta pasta",
            "risco": "medio",
        }

    if nome == "apply_patch":
        diff = str(argumentos.get("diff", ""))
        arquivos = _arquivos_do_diff(diff)
        if not diff.strip():
            return None
        return {
            "kinds": ["escrita"],
            "escopos": {"escrita": str(workspace)},
            "titulo": "Aplicar alterações em código",
            "resumo": ", ".join(arquivos[:4]) or "(diff sem arquivo legível)",
            "explicacao": (
                f"Aplicar um diff em {len(arquivos) or 1} arquivo(s) de {pasta}: "
                + (", ".join(arquivos[:8]) or "(sem caminho no diff)")
                + ". O trecho antigo de cada arquivo é substituído pelo novo."
            ),
            "lembrar": "aplicar diffs nesta pasta",
            "risco": "alto",
        }

    if nome == "upload_file":
        rota = _resolver(workspace, str(argumentos.get("caminho", "")))
        return {
            "kinds": ["comando"],
            "escopos": {"comando": "upload_file"},
            "titulo": "Enviar arquivo pela rede",
            "resumo": f"{rota} → {str(argumentos.get('url', ''))[:120]}",
            "explicacao": (
                f"Enviar o conteúdo de {rota} para o endereço "
                f"{str(argumentos.get('url', ''))[:120]} (saída de dados desta máquina)."
            ),
            "lembrar": f"enviar arquivos de {workspace} pela rede",
            "risco": "alto",
        }

    if nome in FERRAMENTAS_DE_ARQUIVO:
        # Mover e copiar mexem em dois caminhos: quem manda para a permissão é a origem,
        # e o destino aparece no resumo (é ele que muda o mapa do projeto).
        alvo = str(argumentos.get("caminho", "") or "")
        if not alvo and nome in CAMINHOS_EXTRA:
            alvo = str(argumentos.get(CAMINHOS_EXTRA[nome][0], "") or "")
        rota = _resolver(workspace, alvo or ".")
        destino = (
            _resolver(workspace, str(argumentos.get("destino", "") or ""))
            if nome in CAMINHOS_EXTRA
            else None
        )
        fora = not _dentro_do_workspace(workspace, rota)
        if destino is not None and not _dentro_do_workspace(workspace, destino):
            fora = True
        pasta_do_arquivo = str(rota.parent)
        kinds: list[str] = []
        titulo = ""
        explicacao = ""
        risco = "baixo"

        if nome == "delete_file":
            kinds.append("exclusao")
            titulo = "Apagar arquivo"
            explicacao = f"Apagar o arquivo {rota}. Isso não volta pelo histórico do Koda."
            risco = "alto"
        elif nome == "delete_directory":
            kinds.append("exclusao")
            titulo = "Apagar pasta"
            explicacao = (
                f"Apagar a pasta {rota} inteira, com tudo o que está dentro dela. "
                "Isso não volta pelo histórico do Koda."
            )
            risco = "alto"
        elif nome == "create_directory":
            kinds.append("escrita")
            titulo = "Criar pasta"
            explicacao = f"Criar a pasta {rota}."
        elif nome in ("move_file", "copy_file"):
            kinds.append("escrita")
            verbo = "Mover" if nome == "move_file" else "Copiar"
            titulo = f"{verbo} arquivo"
            explicacao = f"{verbo} {rota} para {destino}."
            risco = "medio"
        elif nome == "rename_file":
            kinds.append("escrita")
            titulo = "Renomear"
            explicacao = (
                f"Renomear {rota} para {str(argumentos.get('novo_nome', '')).strip()}."
            )
        elif nome == "write_file":
            conteudo = str(argumentos.get("conteudo", ""))
            kinds.append("escrita")
            if rota.exists():
                titulo = "Sobrescrever arquivo"
                explicacao = (
                    f"Sobrescrever {rota} com {len(conteudo)} caracteres novos — "
                    "o que está lá agora é perdido."
                )
                risco = "alto"
            else:
                titulo = "Criar arquivo"
                explicacao = f"Criar o arquivo {rota} com {len(conteudo)} caracteres."
        elif nome in ("edit_file", "str_replace_editor"):
            kinds.append("escrita")
            titulo = "Editar arquivo"
            explicacao = (
                f"Substituir um trecho exato de {rota} pelo texto novo "
                f"({len(str(argumentos.get('new_string', '')))} caracteres)."
            )
        elif nome == "download_file":
            kinds.append("escrita")
            titulo = "Baixar arquivo da internet"
            explicacao = (
                f"Baixar {str(argumentos.get('url', ''))[:120]} e gravar em {rota}."
            )
            risco = "medio"

        if fora:
            kinds.append("fora_da_pasta")
            if not titulo:
                titulo = "Mexer fora da pasta do projeto"
                explicacao = f"Ler ou listar {rota}, que está fora de {pasta}."
            else:
                explicacao += f" Atenção: {rota} está fora da pasta do projeto ({pasta})."

        if not kinds:
            return None

        escopos = {kind: pasta_do_arquivo for kind in kinds}
        if "fora_da_pasta" in kinds:
            escopos["fora_da_pasta"] = pasta_do_arquivo
        return {
            "kinds": kinds,
            "escopos": escopos,
            "titulo": titulo,
            "resumo": f"{rota} → {destino}" if destino is not None else str(rota),
            "explicacao": explicacao,
            "lembrar": f"mexer em {pasta_do_arquivo}",
            "risco": risco if not fora else ("alto" if risco == "alto" else "medio"),
        }

    return None


# ---------------------------------------------------------------- lista de tarefas

#: Marca de item no começo do texto: "- ", "1. ", "* ", "- [x] ".
_MARCA_DE_ITEM = re.compile(r"^\s*(?:[-*\u2022]|\d+[.)])?\s*(?:\[[ xX]\]\s*)?")


def _limpar_item(texto: str) -> str:
    """O texto do item sem as marcas de lista que o modelo escreve junto."""
    return _MARCA_DE_ITEM.sub("", texto or "").strip()[:400]


def _booleano(valor: Any) -> bool:
    if isinstance(valor, bool):
        return valor
    return str(valor or "").strip().lower() in ("true", "1", "sim", "yes", "x")


def todos_dos_argumentos(argumentos: dict[str, Any]) -> list[dict[str, Any]]:
    """A lista de tarefas que o modelo mandou, sempre na mesma forma.

    O que sai daqui é o que a interface desenha e o que fica gravado junto da mensagem.
    Aceita o formato certo (`todos: [{texto, feito, atual}]`), lista de texto solto
    (`todos: ["fazer x"]`), lista em **uma string** com uma linha por item, campos com
    outro nome (`title`, `done`, `status`) e o estado escrito por extenso ("feito",
    "em_andamento"). Sem isso, cada modelo inventava uma forma e a lista não aparecia.
    """
    argumentos = _sinonimos(argumentos or {})
    bruto = argumentos.get("todos")
    if isinstance(bruto, str):
        itens: list[Any] = [linha for linha in bruto.splitlines() if linha.strip()]
    elif isinstance(bruto, list):
        itens = list(bruto)
    else:
        return []

    prontos: list[dict[str, Any]] = []
    for item in itens:
        if isinstance(item, str):
            # "- [x] coisa" escrito como texto também conta como item feito.
            feito = "[x]" in item[:8].lower()
            texto = _limpar_item(item)
            if texto:
                prontos.append({"texto": texto, "feito": feito, "atual": False})
            continue
        if not isinstance(item, dict):
            continue
        dados = {str(chave).lower(): valor for chave, valor in item.items()}
        normalizado = {SINONIMOS_DE_ITEM.get(chave, chave): valor for chave, valor in dados.items()}
        texto = _limpar_item(str(normalizado.get("texto") or ""))
        if not texto:
            continue
        estado = str(dados.get("status") or "").strip().lower()
        if estado in ESTADOS_DE_ITEM:
            feito, atual = ESTADOS_DE_ITEM[estado]
        else:
            feito = _booleano(normalizado.get("feito"))
            atual = _booleano(normalizado.get("atual"))
        prontos.append({"texto": texto, "feito": feito, "atual": False if feito else atual})

    # Só um item pode estar "em andamento": a interface não tem como desenhar dois
    # "fazendo agora", e lista com dois é lista malformada.
    ja_tem_atual = False
    for item in prontos:
        if not item["atual"]:
            continue
        if ja_tem_atual:
            item["atual"] = False
        ja_tem_atual = True
    return prontos[:50]


def lista_em_texto(itens: list[dict[str, Any]]) -> str:
    """A lista como ela volta para o modelo — e como ela é lida na conversa."""
    feitos = sum(1 for item in itens if item["feito"])
    linhas = [f"lista de tarefas ({feitos}/{len(itens)} feitos):"]
    for indice, item in enumerate(itens, 1):
        marca = "x" if item["feito"] else ("~" if item["atual"] else " ")
        linhas.append(f"{indice}. [{marca}] {item['texto']}")
    return "\n".join(linhas)


#: Nome da ferramenta do plano — o loop a trata à parte (ver `loop.FERRAMENTA_DO_PLANO`).
FERRAMENTA_DO_PLANO = "update_todos"


# ---------------------------------------------------------------- dependências

GESTORES = {"npm", "pnpm", "yarn", "uv", "pip", "cargo"}

#: Como o gerenciador do projeto é descoberto: o primeiro arquivo que existir manda.
#: A ordem importa — `package-lock.json` (npm) tem que ganhar de `package.json`, e
#: `uv.lock` de `pyproject.toml`.
ARQUIVO_DO_GESTOR: tuple[tuple[str, str], ...] = (
    ("pnpm-lock.yaml", "pnpm"),
    ("yarn.lock", "yarn"),
    ("package-lock.json", "npm"),
    ("package.json", "npm"),
    ("uv.lock", "uv"),
    ("pyproject.toml", "uv"),
    ("requirements.txt", "pip"),
    ("Cargo.toml", "cargo"),
)


def _gerenciador_do_projeto(workspace: Path) -> str:
    """Qual gerenciador este projeto usa, pelo que ele já deixou na pasta."""
    for arquivo, gestor in ARQUIVO_DO_GESTOR:
        if not (workspace / arquivo).exists():
            continue
        # uv/pnpm/yarn são opcionais: sem o executável na máquina, o npm/pip resolve.
        if gestor in ("uv", "pnpm", "yarn") and shutil.which(gestor) is None:
            continue
        return gestor
    return ""


def _linha_do_gestor(gestor: str, pacote: str, instalando: bool) -> str:
    """A linha de comando de instalar/remover, no dialeto de cada gerenciador.

    Devolve uma **linha** (e não um argv) porque no Windows `npm` é um `.cmd`: rodar pelo
    shell é o que funciona sempre, e o nome do pacote já passou pela validação de
    caracteres perigosos.
    """
    if gestor == "pip":
        acao = "install" if instalando else "uninstall -y"
        return f'"{sys.executable}" -m pip {acao} "{pacote}"'
    acao = {
        "npm": "install" if instalando else "uninstall",
        "pnpm": "add" if instalando else "remove",
        "yarn": "add" if instalando else "remove",
        "uv": "add" if instalando else "remove",
        "cargo": "add" if instalando else "remove",
    }[gestor]
    return f'"{shutil.which(gestor) or gestor}" {acao} "{pacote}"'


# ---------------------------------------------------------------- patch

#: Cabeçalho de hunk: `@@ -12,7 +12,9 @@` (as contagens são opcionais).
_PEDACO = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def _caminho_do_diff(linha: str) -> str:
    """Caminho de um cabeçalho `--- a/x` / `+++ b/x` (vazio para /dev/null)."""
    limpo = linha.strip().split("\t")[0].split(" ")[0]
    if limpo in ("/dev/null", "nul"):
        return ""
    for prefixo in ("a/", "b/", "./"):
        if limpo.startswith(prefixo):
            return limpo[len(prefixo) :]
    return limpo


def _arquivos_do_diff(diff: str) -> list[str]:
    """Arquivos que o diff toca, na ordem em que aparecem."""
    achados: list[str] = []
    for linha in (diff or "").splitlines():
        if not linha.startswith("+++ "):
            continue
        caminho = _caminho_do_diff(linha[4:])
        if caminho and caminho not in achados:
            achados.append(caminho)
    return achados


def _separar(corpo: list[str]) -> tuple[list[str], list[str]]:
    """Separa o corpo de um hunk no que sai (antigas) e no que entra (novas)."""
    antigas: list[str] = []
    novas: list[str] = []
    for linha in corpo:
        if linha.startswith("\\"):
            continue  # "\ No newline at end of file"
        if linha == "":
            antigas.append("")
            novas.append("")
            continue
        marca, texto = linha[0], linha[1:]
        if marca == " ":
            antigas.append(texto)
            novas.append(texto)
        elif marca == "-":
            antigas.append(texto)
        elif marca == "+":
            novas.append(texto)
        else:  # linha sem marca nenhuma: contexto literal
            antigas.append(linha)
            novas.append(linha)
    return antigas, novas


def _ler_diff(diff: str) -> tuple[list[tuple[str, list[tuple[int, list[str], list[str]]]]], str]:
    """Lê um diff unificado em (arquivo, [(início, antigas, novas)])."""
    linhas = (diff or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    # Todo diff termina com `\n`, e `split` transforma isso num último elemento vazio —
    # que **não** é linha de contexto (o git prefixa contexto com um espaço). Sem tirar
    # aqui, o hunk ganha uma linha a mais e nunca casa com o arquivo.
    if linhas and linhas[-1] == "":
        linhas.pop()
    arquivos: list[tuple[str, list[tuple[int, list[str], list[str]]]]] = []
    indice = 0
    while indice < len(linhas):
        comeca_arquivo = (
            linhas[indice].startswith("+++ ")
            and indice > 0
            and linhas[indice - 1].startswith("--- ")
        )
        if not comeca_arquivo:
            indice += 1
            continue
        destino = _caminho_do_diff(linhas[indice][4:]) or _caminho_do_diff(linhas[indice - 1][4:])
        if not destino:
            return [], "o diff não diz em que arquivo aplicar (cabeçalho +++ sem caminho)"
        hunks: list[tuple[int, list[str], list[str]]] = []
        indice += 1
        while indice < len(linhas):
            linha = linhas[indice]
            if (
                linha.startswith("--- ")
                and indice + 1 < len(linhas)
                and linhas[indice + 1].startswith("+++ ")
            ):
                break
            casamento = _PEDACO.match(linha)
            if not casamento:
                indice += 1
                continue
            corpo: list[str] = []
            indice += 1
            while indice < len(linhas):
                seguinte = linhas[indice]
                if _PEDACO.match(seguinte):
                    break
                if (
                    seguinte.startswith("--- ")
                    and indice + 1 < len(linhas)
                    and linhas[indice + 1].startswith("+++ ")
                ):
                    break
                corpo.append(seguinte)
                indice += 1
            antigas, novas = _separar(corpo)
            hunks.append((int(casamento.group(1)), antigas, novas))
        arquivos.append((destino, hunks))
    return arquivos, ""


#: Até onde procurar o trecho de um hunk fora da linha pedida (o git aceita fuzz pequeno;
#: aqui é generoso porque o arquivo pode ter sido editado entre o diff e a aplicação).
TOLERANCIA_HUNK = 5000


def _achar_bloco(linhas: list[str], esperado: int, antigas: list[str]) -> int | None:
    """Onde o trecho está de verdade: no lugar pedido, ou perto dele."""
    antigas = [item.rstrip("\r") for item in antigas]
    if not antigas:
        return min(max(esperado, 0), len(linhas))
    total = len(antigas)
    for distancia in range(TOLERANCIA_HUNK + 1):
        candidatos = {esperado} if distancia == 0 else {esperado - distancia, esperado + distancia}
        for posicao in candidatos:
            if posicao < 0 or posicao + total > len(linhas):
                continue
            if [item.rstrip("\r") for item in linhas[posicao : posicao + total]] == antigas:
                return posicao
    return None


def _aplicar_hunks(texto: str, hunks: list[tuple[int, list[str], list[str]]]) -> tuple[str | None, str]:
    """Aplica os hunks no conteúdo; devolve (texto novo, erro)."""
    linhas = texto.split("\n")
    terminava_com_quebra = texto.endswith("\n")
    if linhas and linhas[-1] == "":
        linhas.pop()
    deslocamento = 0
    for inicio, antigas, novas in hunks:
        esperado = max(0, inicio - 1 + deslocamento)
        posicao = _achar_bloco(linhas, esperado, antigas)
        if posicao is None:
            return None, f"não encontrei o trecho do hunk @@ -{inicio} (o arquivo mudou?)"
        linhas[posicao : posicao + len(antigas)] = novas
        deslocamento += len(novas) - len(antigas)
    final = "\n".join(linhas)
    if terminava_com_quebra and not final.endswith("\n"):
        final += "\n"
    return final, ""


def _aplicar_patch(diff: str, workspace: Path, acesso_livre: bool) -> str:
    """Aplica um diff unificado — tudo em memória, e só depois grava.

    Se o terceiro arquivo do diff não bate, os dois primeiros **não** podem ficar alterados:
    um patch pela metade deixa o projeto num estado que o modelo não sabe reconstruir.
    """
    if not diff.strip():
        return "ERRO: diff vazio"
    arquivos, erro = _ler_diff(diff)
    if erro:
        return f"ERRO: {erro}"
    if not arquivos:
        return "ERRO: não achei cabeçalho de arquivo no diff (--- / +++). Mande um diff unificado."
    prontos: list[tuple[Path, str]] = []
    for destino, hunks in arquivos:
        rota = _resolver(workspace, destino)
        if not acesso_livre and not _dentro_do_workspace(workspace, rota):
            return f"ERRO: {rota} está fora da pasta de trabalho ({workspace})"
        if not hunks:
            continue
        try:
            atual = rota.read_text(encoding="utf-8", errors="replace") if rota.exists() else ""
        except OSError as exc:
            return f"ERRO ao ler {rota}: {exc}"
        final, problema = _aplicar_hunks(atual, hunks)
        if final is None:
            return f"ERRO em {rota}: {problema}"
        prontos.append((rota, final))
    if not prontos:
        return "ERRO: o diff não tem nenhuma alteração para aplicar"
    for rota, texto in prontos:
        try:
            rota.parent.mkdir(parents=True, exist_ok=True)
            rota.write_text(texto, encoding="utf-8")
        except OSError as exc:
            return f"ERRO ao gravar {rota}: {exc}"
    return (
        f"ok: patch aplicado em {len(prontos)} arquivo(s): "
        + ", ".join(str(rota) for rota, _ in prontos)
    )


def executar(
    nome: str,
    argumentos: dict[str, Any],
    workspace: Path,
    negadas: set[str] | None = None,
    *,
    acesso_livre: bool = False,
) -> str:
    """Roda uma ferramenta e devolve o texto que volta para o modelo."""
    argumentos = _sinonimos(argumentos or {})
    nome = canonico(nome)
    if negadas and nome in {canonico(item) for item in negadas}:
        return f"ERRO: a ferramenta {nome} está desligada (KODA_TOOLS_DENY)."

    if nome in FERRAMENTAS_DE_ARQUIVO:
        fora = _validar_alvos(workspace, nome, argumentos, acesso_livre)
        if fora:
            return fora

    if nome.startswith("git_"):
        problema = _checar_repo(workspace, nome)
        if problema:
            return problema

    if nome in ("shell", "terminal"):
        try:
            tempo = min(int(argumentos.get("tempo_limite", TEMPO_COMANDO)), TEMPO_COMANDO_MAX)
        except (TypeError, ValueError):
            tempo = TEMPO_COMANDO
        # Acompanhar/parar vêm antes do comando: quem chama assim já tem um processo
        # rodando, e `comando` vem vazio de propósito.
        acompanhar = str(argumentos.get("continuar") or "").strip()
        if acompanhar:
            return _acompanhar(acompanhar, tempo)
        interromper = str(argumentos.get("parar") or "").strip()
        if interromper:
            return _parar(interromper)
        comando = str(argumentos.get("comando", "")).strip()
        if not comando:
            return (
                "ERRO: informe o `comando`, ou o `continuar`/`parar` de um comando que já "
                "está rodando"
            )
        return _rodar(comando, workspace, tempo)

    if nome == "code_interpreter":
        codigo = str(argumentos.get("codigo", "")).strip()
        if not codigo:
            return "ERRO: código vazio"
        linguagem = str(argumentos.get("linguagem") or "python").strip().lower()
        # O interpretador é o do Koda, não o do projeto: ele vem embutido no app e é o
        # mesmo em qualquer máquina. Num projeto JS, `linguagem: node` roda o trecho na
        # linguagem do projeto — o runner segue sendo o que existe aqui.
        if linguagem in ("node", "javascript", "js", "mjs", "typescript", "ts"):
            no = shutil.which("node")
            if not no:
                return (
                    "ERRO: node não está instalado nesta máquina — rode este trecho em "
                    "Python, ou use o `shell` para o que o projeto já tem (npm, node)."
                )
            # Node rodando fora do projeto: os caminhos do projeto vão absolutos no
            # código, igual ao Python. O arquivo é `.mjs` para `import` funcionar.
            with tempfile.TemporaryDirectory(prefix="koda-") as pasta:
                arquivo = Path(pasta) / "snippet.mjs"
                arquivo.write_text(codigo, encoding="utf-8")
                return _rodar_lista([no, str(arquivo)], workspace)
        # Roda fora do projeto: um tmp qualquer, sem sujar a pasta de trabalho.
        with tempfile.TemporaryDirectory(prefix="koda-") as pasta:
            arquivo = Path(pasta) / "snippet.py"
            arquivo.write_text(codigo, encoding="utf-8")
            # `-X utf8` + PYTHONUTF8/PYTHONIOENCODING: sem isso o Python do Windows escreve
            # em cp1252 e um `print` com `●`, `→` ou acento derruba o script inteiro com
            # UnicodeEncodeError — o resultado já estava calculado e a pessoa via um
            # Traceback no lugar dele (o modelo, então, gastava o passo seguinte só para
            # descobrir `sys.stdout.reconfigure`).
            return _rodar_lista(
                [sys.executable, "-X", "utf8", str(arquivo)],
                workspace,
                env={"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
            )

    if nome == "read_file":
        rota = _resolver(workspace, str(argumentos.get("caminho", "")))
        if rota.is_dir():
            return f"ERRO: {rota} é uma pasta — use list_dir"
        try:
            texto = rota.read_text(encoding="utf-8", errors="replace")
        except FileNotFoundError:
            return f"ERRO: arquivo não encontrado: {rota}"
        except PermissionError:
            return f"ERRO: sem permissão para ler {rota}"
        except OSError as exc:
            return f"ERRO ao ler {rota}: {exc}"
        if not texto.strip():
            return "(arquivo vazio)"
        # Arquivo grande é a regra num projeto grande: sem um recorte por linha, ler um
        # arquivo de 5 mil linhas volta cortado no teto de saída e o modelo fica com a
        # metade de cima achando que viu o arquivo inteiro.
        linhas = texto.splitlines()
        total = len(linhas)
        inicio = _inteiro(argumentos.get("inicio"), 1)
        limite = _inteiro(argumentos.get("limite"), 0)
        if inicio > 1 or limite > 0:
            inicio = min(max(inicio, 1), total)
            fim = total if limite <= 0 else min(total, inicio + limite - 1)
            recorte = "\n".join(linhas[inicio - 1 : fim])
            aviso = ""
            if fim < total:
                # O modelo pediu um pedaço: dizer **o que ficou de fora** é o que evita ele
                # achar que viu o arquivo inteiro e voltar a ler do começo — era o "lê os
                # mesmos arquivos várias e várias vezes" que o dono viu.
                aviso = (
                    f"\n...[faltam as linhas {fim + 1}-{total}: leia com "
                    f'inicio={fim + 1} se precisar do resto]'
                )
            return _limitar(f"({rota}: linhas {inicio}-{fim} de {total})\n{recorte}{aviso}")
        return _limitar(texto)

    if nome == "write_file":
        rota = _resolver(workspace, str(argumentos.get("caminho", "")))
        conteudo = str(argumentos.get("conteudo", ""))
        try:
            rota.parent.mkdir(parents=True, exist_ok=True)
            rota.write_text(conteudo, encoding="utf-8")
            return f"ok: {len(conteudo)} caracteres gravados em {rota}"
        except OSError as exc:
            return f"ERRO ao gravar {rota}: {exc}"

    if nome in ("edit_file", "str_replace_editor"):
        rota = _resolver(workspace, str(argumentos.get("caminho", "")))
        antigo = str(argumentos.get("old_string", ""))
        novo = str(argumentos.get("new_string", ""))
        if not antigo:
            return "ERRO: old_string vazio"
        try:
            texto = rota.read_text(encoding="utf-8")
        except FileNotFoundError:
            return f"ERRO: arquivo não encontrado: {rota}"
        except OSError as exc:
            return f"ERRO ao ler {rota}: {exc}"
        ocorrencias = texto.count(antigo)
        if ocorrencias == 0:
            return "ERRO: old_string não encontrado no arquivo"
        if ocorrencias > 1:
            return f"ERRO: old_string aparece {ocorrencias} vezes; informe um trecho único"
        rota.write_text(texto.replace(antigo, novo, 1), encoding="utf-8")
        return f"ok: substituição aplicada em {rota}"

    if nome == "list_dir":
        rota = _resolver(workspace, str(argumentos.get("caminho", ".")))
        if not rota.exists():
            return f"ERRO: diretório não existe: {rota}"
        if rota.is_file():
            return f"(é um arquivo) {rota.name}"
        try:
            tudo = sorted(rota.iterdir())
            linhas = []
            for item in tudo[:LIMITE_LISTAGEM]:
                tipo = "[DIR] " if item.is_dir() else "      "
                tamanho = "" if item.is_dir() else f"  {item.stat().st_size} B"
                linhas.append(f"{tipo}{item.name}{tamanho}")
            if len(tudo) > LIMITE_LISTAGEM:
                # Cortar calado faz o modelo achar que viu a pasta inteira e trabalhar com
                # meia lista na cabeça. Dizer o que ficou de fora é o que ele precisa para
                # pedir a parte que falta (ou usar `search_files`).
                linhas.append(
                    f"...(mostrando {LIMITE_LISTAGEM} de {len(tudo)} entradas desta pasta — "
                    "há mais; use search_files para achar um nome específico)"
                )
        except OSError as exc:
            return f"ERRO ao listar {rota}: {exc}"
        return _limitar("\n".join(linhas) or "(diretório vazio)")

    if nome == "delete_file":
        rota = _resolver(workspace, str(argumentos.get("caminho", "")))
        try:
            if rota.is_dir():
                return "ERRO: use delete apenas em arquivos, não em pastas"
            rota.unlink()
            return f"ok: {rota} apagado"
        except FileNotFoundError:
            return f"ERRO: arquivo não encontrado: {rota}"
        except OSError as exc:
            return f"ERRO ao apagar {rota}: {exc}"

    if nome == "create_directory":
        caminho = str(argumentos.get("caminho", "")).strip()
        if not caminho or caminho in (".", "./"):
            return "ERRO: informe o caminho da pasta a criar"
        rota = _resolver(workspace, caminho)
        try:
            rota.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            return f"ERRO ao criar a pasta {rota}: {exc}"
        return f"ok: pasta criada em {rota}"

    if nome in ("move_file", "copy_file"):
        origem = _resolver(workspace, str(argumentos.get("origem", "")))
        destino = _resolver(workspace, str(argumentos.get("destino", "")))
        if not str(argumentos.get("origem", "")).strip():
            return "ERRO: informe a origem"
        if not str(argumentos.get("destino", "")).strip():
            return "ERRO: informe o destino"
        if origem.resolve() == destino.resolve():
            return "ERRO: origem e destino são o mesmo caminho"
        if not origem.exists():
            return f"ERRO: a origem não existe: {origem}"
        if destino.exists():
            return f"ERRO: o destino já existe: {destino} (escolha outro nome ou apague antes)"
        try:
            destino.parent.mkdir(parents=True, exist_ok=True)
            if nome == "move_file":
                shutil.move(str(origem), str(destino))
                return f"ok: {origem} movido para {destino}"
            if origem.is_dir():
                shutil.copytree(
                    origem, destino, ignore=shutil.ignore_patterns(*PASTAS_IGNORADAS)
                )
                return f"ok: pasta {origem} copiada para {destino}"
            shutil.copy2(origem, destino)
            return f"ok: {origem} copiado para {destino}"
        except OSError as exc:
            verbo = "mover" if nome == "move_file" else "copiar"
            return f"ERRO ao {verbo} {origem}: {exc}"

    if nome == "rename_file":
        origem = _resolver(workspace, str(argumentos.get("caminho", "")))
        novo = str(argumentos.get("novo_nome", "")).strip()
        if not novo:
            return "ERRO: informe o novo nome"
        if Path(novo).name != novo or novo in (".", ".."):
            return (
                "ERRO: novo_nome é só o nome, sem pasta — para mudar de pasta use move_file"
            )
        if not origem.exists():
            return f"ERRO: não existe: {origem}"
        destino = origem.with_name(novo)
        if destino.exists():
            return f"ERRO: já existe um item chamado {destino}"
        try:
            origem.rename(destino)
        except OSError as exc:
            return f"ERRO ao renomear {origem}: {exc}"
        return f"ok: {origem.name} agora é {novo} em {origem.parent}"

    if nome == "delete_directory":
        rota = _resolver(workspace, str(argumentos.get("caminho", "")))
        trava = _trava_da_pasta(workspace, rota)
        if trava:
            return trava
        if not rota.exists():
            return f"ERRO: a pasta não existe: {rota}"
        if not rota.is_dir():
            return "ERRO: isso é um arquivo — use delete_file"
        try:
            shutil.rmtree(rota)
        except OSError as exc:
            return f"ERRO ao apagar a pasta {rota}: {exc}"
        return f"ok: pasta {rota} apagada com tudo o que havia dentro"

    if nome == FERRAMENTA_DO_PLANO:
        itens = todos_dos_argumentos(argumentos)
        if not itens:
            return (
                "ERRO: a lista veio vazia. Mande `todos` como lista de itens, cada um com "
                "`texto` (e opcionalmente `feito` e `atual`)."
            )
        return lista_em_texto(itens)

    if nome == "search_files":
        padrao = str(argumentos.get("padrao") or argumentos.get("termo") or "").strip()
        if not padrao:
            return "ERRO: informe o padrão (ex.: **/*.py ou *.json)"
        base = _resolver(workspace, str(argumentos.get("caminho") or "."))
        if not base.exists():
            return f"ERRO: pasta não existe: {base}"
        if not base.is_dir():
            return f"ERRO: {base} é um arquivo — use read_file"
        try:
            encontrados = sorted(base.glob(padrao))
        except (OSError, ValueError, NotImplementedError) as exc:
            return f"ERRO: padrão inválido ({padrao}): {exc}"
        linhas: list[str] = []
        for item in encontrados:
            if any(parte in PASTAS_IGNORADAS for parte in item.parts):
                continue
            if item.is_file() and item.suffix.lower() in EXTENSOES_IGNORADAS:
                continue
            try:
                # Barras normais: é o separador que o modelo usa para escrever os
                # caminhos de volta nas ferramentas, e funciona no Windows também.
                linhas.append(item.relative_to(workspace).as_posix())
            except ValueError:
                linhas.append(item.as_posix())
            if len(linhas) >= LIMITE_ARQUIVOS_BUSCA:
                break
        corpo = "\n".join(linhas) or "(nenhum arquivo com esse padrão)"
        if len(encontrados) > len(linhas):
            corpo += (
                f"\n...(mostrando {len(linhas)} de {len(encontrados)} arquivos; estreite o "
                "padrão para ver o resto)"
            )
        return _limitar(corpo)

    if nome == "apply_patch":
        return _aplicar_patch(str(argumentos.get("diff", "")), workspace, acesso_livre)

    if nome == "git_push":
        argv = ["git", "push"]
        remoto = str(argumentos.get("remoto", "")).strip()
        ramo = str(argumentos.get("ramo", "")).strip()
        if remoto and ramo:
            argv += [remoto, ramo]
        elif remoto:
            argv.append(remoto)
        elif ramo:
            argv += ["-u", "origin", ramo]
        return _rodar_lista(argv, workspace, env={"GIT_TERMINAL_PROMPT": "0"})

    if nome == "git_pull":
        argv = ["git", "pull", "--ff-only"]
        remoto = str(argumentos.get("remoto", "")).strip()
        ramo = str(argumentos.get("ramo", "")).strip()
        if remoto:
            argv.append(remoto)
        if ramo:
            argv.append(ramo)
        return _rodar_lista(argv, workspace, env={"GIT_TERMINAL_PROMPT": "0"})

    if nome in ("install_package", "uninstall_package"):
        pacote = str(argumentos.get("pacote", "")).strip()
        if not pacote:
            return "ERRO: informe o pacote"
        if re.search(r"[;&|<>$`\n\"'\\]", pacote):
            return f"ERRO: nome de pacote inválido: {pacote}"
        instalando = nome == "install_package"
        gerenciador = str(argumentos.get("gerenciador", "")).strip().lower()
        if gerenciador and gerenciador not in GESTORES:
            return (
                f"ERRO: gerenciador desconhecido: {gerenciador}. "
                f"Use um destes: {', '.join(sorted(GESTORES))}"
            )
        escolhido = gerenciador or _gerenciador_do_projeto(workspace)
        if not escolhido:
            return (
                "ERRO: não achei o gerenciador deste projeto (nem package.json, nem "
                "pyproject.toml, nem Cargo.toml na pasta de trabalho). Informe em "
                "`gerenciador`: npm, pnpm, yarn, uv, pip ou cargo."
            )
        if escolhido != "pip" and shutil.which(escolhido) is None:
            return f"ERRO: {escolhido} não está instalado nesta máquina"
        return _rodar(_linha_do_gestor(escolhido, pacote, instalando), workspace)

    if nome == "download_file":
        url = str(argumentos.get("url", "")).strip()
        if not url.lower().startswith(("http://", "https://")):
            return "ERRO: informe uma URL http(s)"
        destino = str(argumentos.get("destino", "")).strip()
        if not destino:
            return "ERRO: informe o destino"
        rota = _resolver(workspace, destino)
        if rota.is_dir() or destino.endswith(("/", "\\")):
            nome_remoto = Path(urllib.parse.urlparse(url).path).name or "arquivo.baixado"
            rota = rota / nome_remoto
        try:
            with httpx.stream(
                "GET", url, timeout=60, follow_redirects=True, headers={"User-Agent": USER_AGENT}
            ) as resposta:
                if resposta.status_code >= 400:
                    return f"ERRO: {url} respondeu {resposta.status_code}"
                rota.parent.mkdir(parents=True, exist_ok=True)
                total = 0
                with rota.open("wb") as arquivo:
                    for pedaco in resposta.iter_bytes():
                        total += len(pedaco)
                        if total > LIMITE_REDE:
                            arquivo.close()
                            rota.unlink(missing_ok=True)
                            return (
                                "ERRO: o arquivo passa de "
                                f"{LIMITE_REDE // 1_000_000} MB — baixe fora do Koda"
                            )
                        arquivo.write(pedaco)
        except httpx.HTTPError as exc:
            return f"ERRO ao baixar {url}: {exc}"
        except OSError as exc:
            return f"ERRO ao gravar {rota}: {exc}"
        return f"ok: {total} bytes baixados de {url} para {rota}"

    if nome == "upload_file":
        url = str(argumentos.get("url", "")).strip()
        if not url.lower().startswith(("http://", "https://")):
            return "ERRO: informe uma URL http(s)"
        rota = _resolver(workspace, str(argumentos.get("caminho", "")))
        if not rota.is_file():
            return f"ERRO: arquivo não encontrado: {rota}"
        if rota.stat().st_size > LIMITE_REDE:
            return f"ERRO: {rota} passa de {LIMITE_REDE // 1_000_000} MB"
        try:
            with httpx.Client(timeout=120) as cliente:
                resposta = cliente.put(
                    url,
                    content=rota.read_bytes(),
                    headers={
                        "User-Agent": USER_AGENT,
                        "Content-Type": "application/octet-stream",
                        "X-Koda-Arquivo": rota.name,
                    },
                )
        except httpx.HTTPError as exc:
            return f"ERRO ao enviar {rota}: {exc}"
        return f"ok: {rota} enviado para {url} — resposta {resposta.status_code}"

    if nome == "get_environment":
        return _ambiente(workspace)

    if nome in ("search_codebase", "vector_search", "grep", "regex_search"):
        termo = str(argumentos.get("termo") or argumentos.get("padrao") or "")
        if not termo:
            return "ERRO: termo de busca vazio"
        usar_regex = nome in ("grep", "regex_search") or bool(argumentos.get("regex"))
        try:
            padrao = re.compile(termo if usar_regex else re.escape(termo), re.I)
        except re.error as exc:
            return f"ERRO: regex inválida: {exc}"
        achados: list[str] = []
        for arquivo in sorted(workspace.rglob("*")):
            try:
                if (
                    not arquivo.is_file()
                    or any(parte in PASTAS_IGNORADAS for parte in arquivo.parts)
                    or arquivo.stat().st_size > 2_000_000
                    or arquivo.suffix.lower() in EXTENSOES_IGNORADAS
                ):
                    continue
            except OSError:
                continue
            try:
                for num, linha in enumerate(
                    arquivo.read_text(encoding="utf-8", errors="replace").splitlines(), 1
                ):
                    if padrao.search(linha):
                        rel = arquivo.relative_to(workspace).as_posix()
                        achados.append(f"{rel}:{num}: {linha.strip()[:160]}")
                        if len(achados) >= 80:
                            break
            except (OSError, ValueError):
                continue
            if len(achados) >= 80:
                break
        return _limitar("\n".join(achados) or "(nenhuma ocorrência)")

    if nome in ("get_problems", "linter"):
        rota = _resolver(workspace, str(argumentos.get("caminho", "")))
        if not rota.is_file():
            return f"ERRO: arquivo não encontrado: {rota}"
        if rota.suffix != ".py":
            return f"(sem linter para {rota.suffix}; apenas .py)"
        resultado = _rodar_lista([sys.executable, "-m", "py_compile", str(rota)], workspace, 60)
        saida = "sintaxe OK" if "exit code: 0" in resultado else resultado
        try:
            pyflakes = subprocess.run(
                [sys.executable, "-m", "pyflakes", str(rota)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=60,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError):
            return _limitar(saida)
        if pyflakes.returncode == 0 and pyflakes.stdout.strip():
            saida += "\n--- pyflakes ---\n" + pyflakes.stdout.strip()
        return _limitar(saida)

    if nome == "web_search":
        return _web_buscar(str(argumentos.get("consulta", "")))

    if nome in ("url_reader", "browser"):
        return _web_ler(str(argumentos.get("url", "")))

    if nome == "git_status":
        return _rodar_lista(["git", "status", "--porcelain", "-b"], workspace)

    if nome == "git_diff":
        return _rodar_lista(["git", "diff", "HEAD"], workspace)

    if nome == "git_log":
        quantidade = min(
            _inteiro(argumentos.get("quantidade") or argumentos.get("limite"), 10), 50
        )
        return _rodar_lista(["git", "log", "--oneline", "-n", str(quantidade)], workspace)

    if nome == "git_commit":
        mensagem = str(argumentos.get("mensagem", "")).strip()
        if not mensagem:
            return "ERRO: mensagem de commit vazia"
        adicionado = _rodar_lista(["git", "add", "-A"], workspace)
        if "exit code: 0" not in adicionado:
            return adicionado
        return _rodar_lista(["git", "commit", "-m", mensagem], workspace)

    return f"ERRO: ferramenta desconhecida: {nome}"


def resumo(argumentos: dict[str, Any], limite: int = 120) -> str:
    """Argumentos em uma linha, para mostrar na interface."""
    return json.dumps(argumentos, ensure_ascii=False)[:limite]
