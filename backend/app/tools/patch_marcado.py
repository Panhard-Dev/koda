"""Aplica patches com marcadores usando os controles de arquivo do Koda."""
from __future__ import annotations

import os
from pathlib import Path
import stat
import tempfile
from typing import Callable

from ..contracts import mudancas
from ..execution import paths as safe_paths
from ..motor_koda.patch_parser import ParseError, parse_patch
from ..motor_koda.patch_update import PatchError, apply_update


def e_marcado(texto: str) -> bool:
    linhas = texto.lstrip().splitlines()
    if not linhas:
        return False
    if linhas[0] in ("<<EOF", "<<'EOF'", '<<"EOF"'):
        return len(linhas) > 1 and linhas[1].strip() == "*** Begin Patch"
    return linhas[0].strip() == "*** Begin Patch"


def caminhos(texto: str) -> list[str]:
    try:
        patch = parse_patch(texto)
    except ParseError:
        return []
    caminhos: list[str] = []
    for hunk in patch.hunks:
        for nome in (hunk.path, hunk.move_path):
            if nome and nome not in caminhos:
                caminhos.append(nome)
    return caminhos


def aplicar(texto: str, workspace: Path, acesso_livre: bool, chamada: str,
            verificar_cancelamento: Callable[[], None]) -> str:
    try:
        patch = parse_patch(texto)
    except ParseError as erro:
        return f"ERRO: patch inválido: {erro}"
    if patch.environment_id is not None:
        return "ERRO: o patch indica outro ambiente; informe caminhos desta pasta de trabalho."
    if not patch.hunks:
        return "ERRO: o patch não contém arquivos."

    raiz = workspace.resolve()
    originais: dict[Path, bytes | None] = {}
    modos: dict[Path, int | None] = {}
    alteracoes: dict[Path, bytes | None] = {}

    def caminho(nome: str) -> Path:
        if not nome or not nome.strip():
            raise ValueError("caminho vazio no patch")
        rota = Path(nome.strip())
        if not rota.is_absolute():
            rota = workspace / rota
        rota = Path(os.path.abspath(rota))
        if not acesso_livre:
            resolvida = rota.resolve()
            if resolvida != raiz and raiz not in resolvida.parents:
                raise ValueError(f"caminho fora da pasta de trabalho: {nome}")
        return rota

    def carregar(rota: Path) -> bytes | None:
        if rota not in originais:
            if rota.is_symlink() or (hasattr(rota, "is_junction") and rota.is_junction()):
                raise ValueError(f"link recusado: {rota}")
            if rota.exists():
                if not rota.is_file():
                    raise ValueError(f"não é um arquivo: {rota}")
                originais[rota] = safe_paths.read_bytes(rota)
                modos[rota] = stat.S_IMODE(rota.stat().st_mode)
            else:
                originais[rota] = None
                modos[rota] = None
        return alteracoes.get(rota, originais[rota])

    try:
        with safe_paths.PathGuard() as guard:
            for hunk in patch.hunks:
                verificar_cancelamento()
                rota = caminho(hunk.path)
                guard.parents(rota, create=True)
                atual = carregar(rota)
                if hunk.kind == "add":
                    alteracoes[rota] = hunk.contents.encode("utf-8")
                elif hunk.kind == "delete":
                    if atual is None:
                        raise ValueError(f"arquivo não encontrado: {rota}")
                    alteracoes[rota] = None
                elif hunk.kind == "update":
                    if atual is None:
                        raise ValueError(f"arquivo não encontrado: {rota}")
                    novo = apply_update(atual.decode("utf-8"), hunk.chunks, str(rota)).encode("utf-8")
                    if hunk.move_path is None:
                        alteracoes[rota] = novo
                    else:
                        destino = caminho(hunk.move_path)
                        if destino == rota:
                            raise ValueError("origem e destino do movimento são iguais")
                        guard.parents(destino, create=True)
                        carregar(destino)
                        alteracoes[rota] = None
                        alteracoes[destino] = novo
                        if modos[destino] is None:
                            modos[destino] = modos[rota]
                else:
                    raise ValueError(f"operação desconhecida: {hunk.kind}")
            verificar_cancelamento()
            return _gravar(originais, modos, alteracoes, chamada)
    except (OSError, ValueError, UnicodeError, RuntimeError, PatchError) as erro:
        return f"ERRO ao preparar o patch: {erro}"


def _temporario(rota: Path, conteudo: bytes, modo: int | None) -> Path:
    descritor, nome = tempfile.mkstemp(prefix=f".{rota.name}.koda-", suffix=".tmp", dir=rota.parent)
    temporario = Path(nome)
    try:
        with os.fdopen(descritor, "wb") as arquivo:
            arquivo.write(conteudo)
            arquivo.flush()
            os.fsync(arquivo.fileno())
        if modo is not None:
            os.chmod(temporario, modo)
        return temporario
    except BaseException:
        temporario.unlink(missing_ok=True)
        raise


def _gravar(originais: dict[Path, bytes | None], modos: dict[Path, int | None],
            alteracoes: dict[Path, bytes | None], chamada: str) -> str:
    temporarios: dict[Path, Path] = {}
    reservas: dict[Path, Path] = {}
    trocados: list[Path] = []
    try:
        for rota, novo in alteracoes.items():
            anterior = originais[rota]
            if anterior is not None:
                reservas[rota] = _temporario(rota, anterior, modos[rota])
            if novo is not None:
                temporarios[rota] = _temporario(rota, novo, modos[rota])
        # Uma edição externa durante o preparo não pode ser sobrescrita silenciosamente.
        for rota, anterior in originais.items():
            if rota.is_symlink() or (rota.exists() != (anterior is not None)):
                raise OSError(f"arquivo mudou durante o preparo: {rota}")
            if anterior is not None and safe_paths.read_bytes(rota) != anterior:
                raise OSError(f"arquivo mudou durante o preparo: {rota}")
        for rota, novo in alteracoes.items():
            if novo is None:
                if rota.exists():
                    rota.unlink()
            else:
                os.replace(temporarios[rota], rota)
            trocados.append(rota)
    except OSError as erro:
        falhas: list[str] = []
        for rota in reversed(trocados):
            try:
                if originais[rota] is None:
                    rota.unlink(missing_ok=True)
                else:
                    os.replace(reservas[rota], rota)
            except OSError as desfazer:
                falhas.append(f"{rota}: {desfazer}")
        detalhe = "; restauração incompleta: " + "; ".join(falhas) if falhas else ""
        return f"ERRO ao gravar o patch: {erro}{detalhe}"
    finally:
        for temporario in (*temporarios.values(), *reservas.values()):
            try:
                temporario.unlink(missing_ok=True)
            except OSError:
                pass
    for rota, novo in alteracoes.items():
        antes = originais[rota]
        mudancas.anotar(str(rota), None if antes is None else antes.decode("utf-8", errors="replace"),
                        None if novo is None else novo.decode("utf-8", errors="replace"), "apply_patch", chamada)
    return f"ok: patch aplicado em {len(alteracoes)} arquivo(s): " + ", ".join(map(str, alteracoes))
