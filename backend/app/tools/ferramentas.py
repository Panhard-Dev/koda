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
import re
import socket
import subprocess
import sys
import tempfile
import urllib.parse
from pathlib import Path
from typing import Any

import httpx

LIMITE_SAIDA = 12_000
TEMPO_COMANDO = 120
USER_AGENT = "KodaAgente/1.0"

EXTENSOES_IGNORADAS = {".png", ".jpg", ".jpeg", ".zip", ".exe", ".dll", ".pdf", ".woff2"}


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
        "Executa código Python no interpretador local e devolve a saída (print etc).",
        {"codigo": {"type": "string", "description": "Código Python completo a executar"}},
        ["codigo"],
    ),
    _def(
        "shell",
        "Executa um comando no terminal (cmd) e devolve stdout+stderr.",
        {
            "comando": {"type": "string"},
            "tempo_limite": {"type": "integer", "description": "segundos, padrão 120"},
        },
        ["comando"],
    ),
    _def("terminal", "Alias de shell: executa um comando no terminal.", {"comando": {"type": "string"}}, ["comando"]),
    # ---- arquivos ----
    _def(
        "read_file",
        "Lê um arquivo de texto (relativo à pasta de trabalho ou absoluto).",
        {"caminho": {"type": "string"}},
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
]

#: Todas as ferramentas que executam algo no disco ou na máquina.
ESCRITA = {"write_file", "edit_file", "str_replace_editor", "delete_file", "git_commit"}

#: Ferramentas que recebem um `caminho` e por isso passam pela checagem de pasta.
FERRAMENTAS_DE_ARQUIVO = {
    "read_file",
    "write_file",
    "edit_file",
    "str_replace_editor",
    "list_dir",
    "delete_file",
    "get_problems",
    "linter",
}

#: Quantos redirecionamentos o `url_reader` segue antes de desistir.
SALTOS_MAXIMOS = 5


def catalogo(negadas: set[str] | None = None) -> list[dict[str, Any]]:
    """Catálogo enviado ao modelo, sem as ferramentas desligadas na configuração."""
    if not negadas:
        return DEFINICOES
    return [
        item
        for item in DEFINICOES
        if item["function"]["name"] not in negadas
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


def _validar_caminho(
    workspace: Path, argumentos: dict[str, Any], acesso_livre: bool
) -> str | None:
    """Devolve a mensagem de erro se o caminho escapar da pasta de trabalho.

    A checagem é feita uma vez, antes do despacho, em vez de dentro de cada
    ferramenta: assim um caminho novo não entra sem passar por aqui.
    """
    if acesso_livre:
        return None
    rota = _resolver(workspace, str(argumentos.get("caminho", "") or "."))
    if _dentro_do_workspace(workspace, rota):
        return None
    return (
        f"ERRO: {rota} está fora da pasta de trabalho ({workspace}).\n"
        "As ferramentas de arquivo só mexem dentro do projeto. Para liberar tudo, "
        "defina KODA_ACESSO_LIVRE=1 no .env e reinicie o backend."
    )


def _limitar(texto: str) -> str:
    if len(texto) > LIMITE_SAIDA:
        return texto[:LIMITE_SAIDA] + f"\n...[saída truncada, {len(texto) - LIMITE_SAIDA} caracteres restantes]"
    return texto


def _argv_shell(comando: str) -> list[str]:
    if sys.platform == "win32":
        return ["cmd", "/c", comando]
    return ["/bin/sh", "-c", comando]


def _formatar(proc: subprocess.CompletedProcess[str]) -> str:
    saida = f"exit code: {proc.returncode}\n"
    if proc.stdout:
        saida += f"--- stdout ---\n{proc.stdout}"
    if proc.stderr:
        saida += f"\n--- stderr ---\n{proc.stderr}"
    return _limitar(saida.strip()) or "(sem saída)"


def _rodar_lista(argv: list[str], workspace: Path, tempo: int = TEMPO_COMANDO) -> str:
    """Executa um argv direto (sem shell) — para comandos compostos pelo agente."""
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
        )
        return _formatar(proc)
    except subprocess.TimeoutExpired:
        return f"ERRO: comando excedeu {tempo}s e foi interrompido"
    except FileNotFoundError:
        return f"ERRO: executável não encontrado: {argv[0]}"


def _rodar(comando: str, workspace: Path, tempo: int = TEMPO_COMANDO) -> str:
    try:
        proc = subprocess.run(
            _argv_shell(comando),
            shell=False,
            cwd=str(workspace),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=tempo,
        )
        return _formatar(proc)
    except subprocess.TimeoutExpired:
        return f"ERRO: comando excedeu {tempo}s e foi interrompido"
    except FileNotFoundError:
        return f"ERRO: comando não encontrado: {comando.split()[0]}"


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


def _decodificar_url_bing(href: str) -> str:
    """Extrai a URL real do wrapper de redirect do Bing (u=a1<base64>).

    O payload do Bing é base64**url** (usa `-` e `_`), então a decodificação tem que
    ser `urlsafe_b64decode`: com o `b64decode` comum esses caracteres quebram e a URL
    volta como o wrapper `bing.com/ck/a?...` cru.
    """
    import base64

    url = href.replace("&amp;", "&")
    encontrado = re.search(r"[?&]u=a1([A-Za-z0-9+/=_-]+)", url)
    if encontrado:
        b64 = encontrado.group(1)
        b64 += "=" * (-len(b64) % 4)
        try:
            decodificada = base64.urlsafe_b64decode(b64).decode("utf-8", errors="replace")
            if decodificada.startswith("http"):
                return decodificada
        except (ValueError, TypeError):
            pass
    return url


def _tirar_tags(marcado: str) -> str:
    limpo = re.sub(r"<script.*?</script>|<style.*?</style>", " ", marcado, flags=re.S | re.I)
    return _limpar_texto(limpo)


def _busca_bing(consulta: str) -> str:
    """Raspa a página de resultados do Bing e formata os 6 primeiros.

    O Bing é a única fonte da busca na web deste projeto. Ele aceita o `User-Agent` de bot
    do Koda sem reclamar, e a URL real de cada resultado vem dentro de um wrapper de
    redirect (`bing.com/ck/a?u=a1...`) que `_decodificar_url_bing` desfaz.
    """
    resp = httpx.get(
        "https://www.bing.com/search",
        params={"q": consulta},
        headers={"User-Agent": USER_AGENT},
        timeout=7,
        follow_redirects=True,
    )
    blocos = re.findall(r'<li class="b_algo".*?</li>', resp.text, re.S)
    linhas = []
    for i, bloco in enumerate(blocos[:6], 1):
        achado = re.search(r'<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', bloco, re.S)
        if not achado:
            continue
        url = _decodificar_url_bing(achado.group(1))
        titulo = _limpar_texto(achado.group(2))
        snippet = ""
        trecho = re.search(r"<p[^>]*>(.*?)</p>", bloco, re.S)
        if trecho:
            snippet = _limpar_texto(trecho.group(1))[:220]
        linhas.append(f"{i}. {titulo or url}\n   {url}" + (f"\n   {snippet}" if snippet else ""))
    return "\n".join(linhas)


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
    return _limitar(achados or "(sem resultados)")


def _web_ler(url: str) -> str:
    """Lê uma URL pública seguindo os redirects um a um, checando cada destino.

    O `follow_redirects=True` do httpx não serve aqui: ele checa a URL de partida e
    depois segue cego, então um host público que devolve `Location: http://127.0.0.1`
    (ou `169.254.169.254`, o metadata da nuvem) entrava direto. Seguindo na mão, cada
    salto passa pelo mesmo `host_publico`.
    """
    if not host_publico(url):
        return "ERRO: apenas URLs http/https PÚBLICAS são permitidas (localhost/rede privada bloqueados)"

    atual = url
    try:
        with httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=25) as cliente:
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

        texto = _tirar_tags(resp.text)
        return _limitar(f"URL: {resp.url}\nHTTP {resp.status_code}\n\n{texto}" or "(página vazia)")
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


# ---------------------------------------------------------------- execução


def executar(
    nome: str,
    argumentos: dict[str, Any],
    workspace: Path,
    negadas: set[str] | None = None,
    *,
    acesso_livre: bool = False,
) -> str:
    """Roda uma ferramenta e devolve o texto que volta para o modelo."""
    argumentos = argumentos or {}
    if negadas and nome in negadas:
        return f"ERRO: a ferramenta {nome} está desligada (KODA_TOOLS_DENY)."

    if nome in FERRAMENTAS_DE_ARQUIVO:
        fora = _validar_caminho(workspace, argumentos, acesso_livre)
        if fora:
            return fora

    if nome.startswith("git_"):
        problema = _checar_repo(workspace, nome)
        if problema:
            return problema

    if nome in ("shell", "terminal"):
        comando = str(argumentos.get("comando", "")).strip()
        if not comando:
            return "ERRO: comando vazio"
        try:
            tempo = min(int(argumentos.get("tempo_limite", TEMPO_COMANDO)), 600)
        except (TypeError, ValueError):
            tempo = TEMPO_COMANDO
        return _rodar(comando, workspace, tempo)

    if nome == "code_interpreter":
        codigo = str(argumentos.get("codigo", "")).strip()
        if not codigo:
            return "ERRO: código vazio"
        # Roda fora do projeto: um tmp qualquer, sem sujar a pasta de trabalho.
        with tempfile.TemporaryDirectory(prefix="koda-") as pasta:
            arquivo = Path(pasta) / "snippet.py"
            arquivo.write_text(codigo, encoding="utf-8")
            return _rodar_lista([sys.executable, str(arquivo)], workspace)

    if nome == "read_file":
        rota = _resolver(workspace, str(argumentos.get("caminho", "")))
        try:
            texto = rota.read_text(encoding="utf-8", errors="replace")
            return _limitar(texto) if texto.strip() else "(arquivo vazio)"
        except FileNotFoundError:
            return f"ERRO: arquivo não encontrado: {rota}"
        except PermissionError:
            return f"ERRO: sem permissão para ler {rota}"
        except OSError as exc:
            return f"ERRO ao ler {rota}: {exc}"

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
            linhas = []
            for item in sorted(rota.iterdir())[:500]:
                tipo = "[DIR] " if item.is_dir() else "      "
                tamanho = "" if item.is_dir() else f"  {item.stat().st_size} B"
                linhas.append(f"{tipo}{item.name}{tamanho}")
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
                    or ".git" in arquivo.parts
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
                        rel = arquivo.relative_to(workspace)
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
        try:
            quantidade = min(int(argumentos.get("quantidade", 10)), 50)
        except (TypeError, ValueError):
            quantidade = 10
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
