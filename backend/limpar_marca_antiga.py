"""Tira a marca antiga do repositório inteiro do Koda — nome de arquivo e conteúdo.

O que faz:

1. Apaga `app/Skill-mcp-use/` — 2048 arquivos, 28 MB de código trazido numa sessão
   anterior e que **nada importa** (conferido: nem o backend, nem `src/`, nem `src-tauri`).
   É peso morto, e é a maior fonte da marca no repositório.
2. Renomeia pasta e arquivo com a marca antiga, trocando a marca pelo nome do Koda.
3. Reescreve a marca no conteúdo — identificadores, variáveis de ambiente e strings — e
   conserta os imports dos arquivos que mudaram de nome.

O que **não** faz: apagar `backend/trabalho/` nem mexer em `nucleo/` (já limpo). O material
de referência sai do repositório em outro passo, para o repo não carregar a marca.

    cd backend && .venv/Scripts/python.exe tirar_a_marca_do_repo.py
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

RAIZ = Path(r"C:\Users\Administrator\Downloads\koda")
BACKEND = RAIZ / "backend"
PYTHON = BACKEND / ".venv" / "Scripts" / "python.exe"

#: Onde a marca é varrida. `nucleo/` fica de fora porque já passou por isso.
ALVOS = [BACKEND / "app", RAIZ / "scripts", BACKEND / "tests"]

#: Pasta morta: 28 MB de código que ninguém importa.
MORTA = BACKEND / "app" / "Skill-mcp-use"

#: Substituições de conteúdo, do mais específico para o mais genérico — a ordem importa:
#: o genérico rodando antes transforma `marca_yaml` em `koda_yaml` e o nome específico não
#: casa mais (foi o que quebrou o rename anterior).
SUBSTITUICOES = [
    ("REFERENCIA_HOME", "KODA_HOME"),
    ("REFERENCIA_DIR", "KODA_DIR"),
    ("REFERENCIA_ROOT", "KODA_ROOT"),
    ("REFERENCIA_LOG", "KODA_LOG"),
    ("REFERENCIA_", "KODA_"),
    ("referência_home", "koda_home"),
    ("referência_dir", "koda_dir"),
    ("referência_root", "koda_root"),
    ("o material de referênciaHome", "KodaHome"),
    ("_referência_", "_koda_"),
    ("o material de referência", "Koda"),
    ("referência", "koda"),
    ("REFERENCIA", "KODA"),
]

#: Linha de import, para consertar caminho de arquivo que mudou de nome.
LINHA_DE_IMPORT = re.compile(
    r"^(?P<indent>\s*)(?P<kind>from|import)\s+(?P<mod>[A-Za-z_][\w.]*)",
    re.MULTILINE,
)


def apagar_morta() -> str:
    """Remove a pasta morta. Devolve o que foi feito."""
    if not MORTA.exists():
        return "pasta morta: já não existia"
    arquivos = sum(1 for _ in MORTA.rglob("*") if _.is_file())
    tamanho = sum(f.stat().st_size for f in MORTA.rglob("*") if f.is_file()) / 1024 / 1024
    shutil.rmtree(MORTA, ignore_errors=True)
    return f"pasta morta removida: {arquivos} arquivos, {tamanho:.1f} MB"


def renomear(alvos: list[Path]) -> int:
    """Renomeia pasta e arquivo com a marca. De dentro para fora, para o caminho não invalidar."""
    mudados = 0
    for alvo in alvos:
        if not alvo.exists():
            continue
        for caminho in sorted(alvo.rglob("*"), key=lambda p: -len(p.parts)):
            if "referência" not in caminho.name.lower():
                continue
            novo = re.sub(r"referência", "koda", caminho.name, flags=re.IGNORECASE)
            if not (caminho.parent / novo).exists():
                caminho.rename(caminho.parent / novo)
                mudados += 1
    return mudados


def reescrever(alvos: list[Path]) -> int:
    """Troca a marca no conteúdo e conserta o import de quem mudou de nome."""
    tocados = 0
    for alvo in alvos:
        if not alvo.exists():
            continue
        for caminho in alvo.rglob("*"):
            if not caminho.is_file() or caminho.suffix not in {".py", ".ts", ".tsx", ".mjs", ".json", ".md"}:
                continue
            try:
                texto = caminho.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            original = texto
            for velho, novo in SUBSTITUICOES:
                texto = texto.replace(velho, novo)
            if caminho.suffix in {".py", ".ts", ".tsx", ".mjs"}:
                texto = LINHA_DE_IMPORT.sub(
                    lambda m: f"{m.group('indent')}{m.group('kind')} "
                    f"{re.sub(r'referência', 'koda', m.group('mod'), flags=re.IGNORECASE)}",
                    texto,
                )
            if texto != original:
                caminho.write_text(texto, encoding="utf-8")
                tocados += 1
    return tocados


def sobras(alvos: list[Path]) -> list[str]:
    """Caminhos que ainda carregam a marca no nome ou no conteúdo."""
    achados: list[str] = []
    for alvo in alvos:
        if not alvo.exists():
            continue
        for caminho in alvo.rglob("*"):
            if "referência" in caminho.name.lower():
                achados.append(str(caminho.relative_to(RAIZ)))
            elif caminho.is_file() and caminho.suffix in {".py", ".ts", ".tsx"}:
                try:
                    if "referência" in caminho.read_text(encoding="utf-8").lower():
                        achados.append(str(caminho.relative_to(RAIZ)))
                except (UnicodeDecodeError, OSError):
                    pass
    return achados


def verificar() -> tuple[bool, str]:
    """O app sobe e a suíte passa depois da limpeza?"""
    importacao = subprocess.run(
        [str(PYTHON), "-c", "import app.main"],
        capture_output=True, text=True, cwd=str(BACKEND), env={**os.environ}, timeout=180,
    )
    if importacao.returncode != 0:
        return False, f"app.main não sobe:\n{(importacao.stderr or '')[-1200:]}"
    suite = subprocess.run(
        [str(PYTHON), "-m", "pytest", "tests/", "-q"],
        capture_output=True, text=True, cwd=str(BACKEND), env={**os.environ}, timeout=900,
    )
    cauda = "\n".join((suite.stdout or "").strip().splitlines()[-3:])
    return suite.returncode == 0, cauda


def main() -> None:
    print(f"1) {apagar_morta()}")
    print(f"2) nomes renomeados: {renomear(ALVOS)}")
    print(f"3) arquivos com conteúdo reescrito: {reescrever(ALVOS)}")

    restam = sobras(ALVOS)
    print(f"4) ainda com a marca: {len(restam)}")
    for item in restam[:10]:
        print(f"     {item}")

    ok, detalhe = verificar()
    print()
    if ok:
        print("VERIFICAÇÃO PASSOU")
        print(detalhe)
        return
    print("VERIFICAÇÃO FALHOU")
    print(detalhe)
    raise SystemExit(1)


if __name__ == "__main__":
    main()
