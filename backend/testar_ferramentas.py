# -*- coding: utf-8 -*-
"""Bate em todas as 22 ferramentas do catalogo, uma por uma.

Roda numa pasta temporaria propria (nao suja o projeto) e imprime ok/ERRO por ferramenta.
O que se espera de cada uma esta em ESPERADO; o script falha se a ferramenta devolver
erro onde deveria funcionar.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.config import Settings  # noqa: E402
from app.tools import ferramentas  # noqa: E402

resultados: list[tuple[str, bool, str]] = []


def roda(ws: Path, nome: str, args: dict, deve_falhar: bool = False) -> str:
    try:
        saida = ferramentas.executar(nome, args, ws)
    except Exception as exc:  # noqa: BLE001
        saida = f"EXCECAO {type(exc).__name__}: {exc}"
    erro = saida.lstrip().startswith("ERRO") or saida.startswith("EXCECAO")
    ok = erro if deve_falhar else not erro
    resultados.append((nome, ok, saida.replace("\n", " ")[:150]))
    return saida


with tempfile.TemporaryDirectory(prefix="koda-tools-") as pasta:
    ws = Path(pasta)
    (ws / "src").mkdir()
    (ws / "src" / "app.py").write_text(
        "def ola():\n    return 'oi'\n\n\nclass Coisa:\n    pass\n", encoding="utf-8"
    )
    (ws / "notas.md").write_text("# notas\n\ntexto de teste\n", encoding="utf-8")
    (ws / "quebrado.py").write_text("def x(:\n", encoding="utf-8")

    # --- execucao ---
    roda(ws, "code_interpreter", {"codigo": "print(6 * 7)"})
    roda(ws, "shell", {"comando": "echo oi-do-shell"})
    roda(ws, "terminal", {"comando": "echo oi-do-terminal"})

    # --- arquivos ---
    roda(ws, "read_file", {"caminho": "notas.md"})
    roda(ws, "write_file", {"caminho": "novo.txt", "conteudo": "conteudo novo"})
    roda(ws, "edit_file", {"caminho": "novo.txt", "old_string": "conteudo", "new_string": "CONTEUDO"})
    roda(ws, "str_replace_editor", {"caminho": "novo.txt", "old_string": "novo", "new_string": "editado"})
    roda(ws, "list_dir", {"caminho": "."})
    roda(ws, "delete_file", {"caminho": "novo.txt"})

    # --- busca no codigo ---
    roda(ws, "search_codebase", {"termo": "ola"})
    # `vector_search` e alias de `search_codebase`: o argumento e `termo`, nao `consulta`.
    roda(ws, "vector_search", {"termo": "funcao que retorna oi"})
    roda(ws, "grep", {"padrao": "def\\s+\\w+"})
    roda(ws, "regex_search", {"padrao": "class\\s+(\\w+)"})

    # --- linter ---
    roda(ws, "get_problems", {"caminho": "src/app.py"})
    roda(ws, "linter", {"caminho": "src/app.py"})
    # O arquivo quebrado TEM que ser denunciado — mas como diagnostico, nao como ERRO.
    diag = roda(ws, "get_problems", {"caminho": "quebrado.py"})
    if "syntax" not in diag.lower():
        resultados.append(("get_problems(quebrado)", False, "nao apontou o erro de sintaxe"))

    # --- web (rede de verdade) ---
    roda(ws, "web_search", {"consulta": "cotacao do dolar hoje"})
    roda(ws, "url_reader", {"url": "https://example.com/"})

    # --- travas de seguranca (tem que RECUSAR) ---
    roda(ws, "read_file", {"caminho": r"C:\Windows\System32\drivers\etc\hosts"}, deve_falhar=True)
    roda(ws, "url_reader", {"url": "http://127.0.0.1:8787/api/health"}, deve_falhar=True)

    # --- git: recusa porque a pasta nao e um repo proprio (esperado) ---
    for nome in ("git_status", "git_diff", "git_log", "git_commit"):
        args = {"mensagem": "teste"} if nome == "git_commit" else {}
        roda(ws, nome, args, deve_falhar=True)

    # --- browser: mesma coisa do url_reader, com rede de verdade ---
    roda(ws, "browser", {"url": "https://example.com/"})

# --- git num repo de verdade (prova que funcionam, nao so que recusam) ---
with tempfile.TemporaryDirectory(prefix="koda-git-") as pasta_git:
    repo = Path(pasta_git)
    subprocess.run(["git", "init", "-q"], cwd=repo, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "t@t"], cwd=repo, capture_output=True)
    subprocess.run(["git", "config", "user.name", "teste"], cwd=repo, capture_output=True)
    (repo / "arquivo.txt").write_text("v1\n", encoding="utf-8")

    roda(repo, "git_status", {})
    roda(repo, "git_commit", {"mensagem": "primeiro commit"})
    roda(repo, "git_log", {"quantidade": 5})
    (repo / "arquivo.txt").write_text("v2\n", encoding="utf-8")
    roda(repo, "git_diff", {})

print("=" * 100)
print("%-22s %-6s %s" % ("FERRAMENTA", "OK?", "SAIDA"))
print("=" * 100)
falhas = 0
for nome, ok, saida in resultados:
    if not ok:
        falhas += 1
    print("%-22s %-6s %s" % (nome, "ok" if ok else "FALHA", saida))
print("=" * 100)
print(f"total: {len(resultados)} chamadas | falhas: {falhas}")
print(f"ferramentas do catalogo: {len(ferramentas.DEFINICOES)}")
print(f"cobertas pelo teste    : {len({n for n, _, _ in resultados})}")
