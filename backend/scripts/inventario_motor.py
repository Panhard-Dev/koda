"""Registra arquivos transferidos e, opcionalmente, inventaria um repositório Git."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

BACKEND = Path(__file__).resolve().parents[1]


def digest(path):
    data = os.fsencode(os.readlink(path)) if path.is_symlink() else path.read_bytes()
    return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def arquivos(origem, destino, categoria):
    registros = []
    for arquivo in sorted(origem.rglob("*")):
        if not arquivo.is_file() and not arquivo.is_symlink():
            continue
        if "__pycache__" in arquivo.parts or arquivo.suffix == ".pyc":
            continue
        relativo = arquivo.relative_to(origem)
        alvo = destino / relativo
        if not alvo.is_file() and not alvo.is_symlink():
            raise FileNotFoundError(f"Arquivo transferido ausente: {alvo}")
        registros.append({"categoria": categoria, "arquivo": relativo.as_posix(),
                          "destino": alvo.relative_to(BACKEND).as_posix(),
                          "origem": digest(arquivo), "transferido": digest(alvo)})
    return registros


def inventariar_git(repositorio):
    nomes = subprocess.check_output(["git", "-C", str(repositorio), "ls-files", "-z"])
    revisao = subprocess.check_output(["git", "-C", str(repositorio), "rev-parse", "HEAD"], text=True).strip()
    entradas = []
    for nome in nomes.split(b"\0"):
        if nome:
            caminho = os.fsdecode(nome)
            arquivo = repositorio / caminho
            entradas.append({"arquivo": caminho, "tipo": "link" if arquivo.is_symlink() else "arquivo", **digest(arquivo)})
    return {"revisao": revisao, "arquivos": entradas}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pacote-origem", type=Path, required=True)
    parser.add_argument("--testes-origem", type=Path, required=True)
    parser.add_argument("--cenarios-origem", type=Path, required=True)
    parser.add_argument("--repositorio", type=Path, help="Opcional: também inventariar os arquivos rastreados pelo Git")
    parser.add_argument("--extra", action="append", nargs=3, metavar=("TIPO", "ORIGEM", "DESTINO"), default=[])
    parser.add_argument("--saida", type=Path, required=True)
    args = parser.parse_args()
    registros = arquivos(args.pacote_origem, BACKEND / "app/motor_koda", "modulo")
    registros += arquivos(args.testes_origem, BACKEND / "tests/motor_koda", "teste")
    registros += arquivos(args.cenarios_origem, BACKEND / "tests/motor_koda/cenarios_patch", "cenario")
    for categoria, origem, destino in args.extra:
        origem, destino = Path(origem), BACKEND / destino
        registros.append({"categoria": categoria, "arquivo": origem.name,
                          "destino": destino.relative_to(BACKEND).as_posix(),
                          "origem": digest(origem), "transferido": digest(destino)})
    resultado = {"descricao": "Arquivos transferidos; hashes diferentes indicam adaptações.", "arquivos": registros}
    if args.repositorio:
        resultado["repositorio"] = inventariar_git(args.repositorio)
    args.saida.write_text(json.dumps(resultado, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{len(registros)} arquivos transferidos conferidos")


if __name__ == "__main__":
    main()
