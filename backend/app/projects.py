"""Pastas de verdade.

O Koda não guarda nome de projeto inventado: cada projeto é **uma pasta do disco** e o
que fica salvo é o caminho completo. Nome de pasta muda de máquina para máquina e some
quando a pessoa renomeia; o caminho é o que dá para abrir de novo.

A pasta padrão é a Área de Trabalho de quem está usando — em qualquer PC, com o idioma
que for (inclusive quando o Windows a coloca dentro do OneDrive).
"""

from __future__ import annotations

import os
import sqlite3
import string
import time
from pathlib import Path

from .repository import new_id

#: Nome usado quando a pessoa não dá um.
NOME_PADRAO = "Sem nome"


def area_de_trabalho() -> Path:
    """A Área de Trabalho do usuário, do jeito que ela existe nesta máquina.

    No Windows a pasta pode estar em `Desktop`, em `OneDrive/Desktop`, em
    `OneDrive - Empresa/Desktop` ou no nome traduzido (`Área de Trabalho`). Se nenhuma
    existir, o lar do usuário é a resposta mais próxima — nunca uma pasta que não existe.
    """
    lar = Path.home()
    candidatos = [
        lar / "Desktop",
        lar / "Área de Trabalho",
        lar / "OneDrive" / "Desktop",
        lar / "OneDrive" / "Área de Trabalho",
    ]
    try:
        candidatos += [
            pasta / "Desktop"
            for pasta in sorted(lar.glob("OneDrive*"))
            if pasta.is_dir()
        ]
    except OSError:
        pass
    for caminho in candidatos:
        if caminho.is_dir():
            return caminho.resolve()
    return lar.resolve()


def atalhos() -> list[dict[str, str]]:
    """Os lugares onde alguém realmente trabalha, para escolher com dois cliques."""
    lar = Path.home()
    opcoes = [
        ("Área de trabalho", area_de_trabalho()),
        ("Documentos", lar / "Documents"),
        ("Downloads", lar / "Downloads"),
        ("Imagens", lar / "Pictures"),
        ("Este PC", lar),
    ]
    vistos: set[str] = set()
    saida: list[dict[str, str]] = []
    for nome, caminho in opcoes:
        try:
            resolvido = caminho.expanduser().resolve()
        except OSError:
            continue
        chave = str(resolvido).lower()
        if chave in vistos or not resolvido.is_dir():
            continue
        vistos.add(chave)
        saida.append({"nome": nome, "caminho": str(resolvido)})
    return saida


def unidades() -> list[dict[str, str]]:
    """Raízes de disco — só no Windows, e só as que respondem."""
    if os.name != "nt":
        return [{"nome": "/", "caminho": "/"}]
    saida: list[dict[str, str]] = []
    for letra in string.ascii_uppercase:
        raiz = Path(f"{letra}:\\")
        try:
            if raiz.exists():
                saida.append({"nome": f"{letra}:", "caminho": str(raiz)})
        except OSError:
            # Drive sem mídia (leitor de cartão vazio) demora e falha: simplesmente não é.
            continue
    return saida


def navegar(caminho: str | None) -> dict[str, object]:
    """Subpastas de um caminho, para escolher a pasta sem diálogo nativo.

    Funciona no app instalado e no navegador de desenvolvimento, que é onde um diálogo
    do sistema não existe. Pasta sem permissão de leitura devolve a lista vazia em vez de
    erro: quem está navegando só quer ver o que dá para abrir.
    """
    alvo = Path(caminho).expanduser() if caminho else area_de_trabalho()
    try:
        alvo = alvo.resolve()
    except OSError:
        alvo = area_de_trabalho()
    if not alvo.is_dir():
        alvo = area_de_trabalho()

    pastas: list[dict[str, str]] = []
    try:
        filhos = sorted(alvo.iterdir(), key=lambda item: item.name.lower())
    except OSError:
        filhos = []
    for item in filhos:
        if item.name.startswith(".") or item.name.startswith("$"):
            continue
        try:
            if item.is_dir():
                pastas.append({"nome": item.name, "caminho": str(item)})
        except OSError:
            continue

    pai = alvo.parent if alvo.parent != alvo else None
    return {
        "caminho": str(alvo),
        "pai": str(pai) if pai else None,
        "pastas": pastas,
        "atalhos": atalhos(),
        "unidades": unidades() if pai is None else [],
    }


def _linha(row: sqlite3.Row) -> dict[str, object]:
    return {
        "id": row["id"],
        "nome": row["name"],
        "caminho": row["path"],
        "criado_em": row["created_at"],
        "usado_em": row["last_used_at"],
        "existe": Path(row["path"]).is_dir(),
    }


def listar(conn: sqlite3.Connection) -> list[dict[str, object]]:
    linhas = conn.execute(
        "SELECT * FROM projects ORDER BY last_used_at DESC, created_at DESC"
    ).fetchall()
    return [_linha(row) for row in linhas]


def obter(conn: sqlite3.Connection, project_id: str) -> dict[str, object] | None:
    row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    return _linha(row) if row else None


def por_caminho(conn: sqlite3.Connection, caminho: str) -> dict[str, object] | None:
    row = conn.execute(
        "SELECT * FROM projects WHERE path = ?", (_limpar(caminho),)
    ).fetchone()
    return _linha(row) if row else None


def ativo(conn: sqlite3.Connection) -> dict[str, object] | None:
    linha = conn.execute("SELECT project_id FROM app_settings WHERE id = 1").fetchone()
    if linha is None or linha["project_id"] is None:
        return None
    return obter(conn, str(linha["project_id"]))


def usar(
    conn: sqlite3.Connection, caminho: str, nome: str | None = None
) -> dict[str, object]:
    """Registra uma pasta existente como projeto (ou reaproveita o que já existe)."""
    limpo = _limpar(caminho)
    rota = Path(limpo)
    if not rota.is_dir():
        raise NotADirectoryError(limpo)

    existente = por_caminho(conn, limpo)
    if existente:
        return definir_ativo(conn, str(existente["id"])) or existente

    agora = _agora()
    identificador = new_id()
    conn.execute(
        "INSERT INTO projects (id, name, path, created_at, last_used_at)"
        " VALUES (?, ?, ?, ?, ?)",
        (identificador, (nome or "").strip() or rota.name or NOME_PADRAO, limpo, agora, agora),
    )
    _garantir_linha(conn, identificador)
    return obter(conn, identificador) or {}


def criar(conn: sqlite3.Connection, pasta_pai: str, nome: str) -> dict[str, object]:
    """Cria a pasta do zero (dentro da pasta-pai informada) e registra o projeto."""
    limpo_nome = (nome or "").strip()
    if not limpo_nome or any(parte in limpo_nome for parte in ("/", "\\", ":", "..")):
        raise ValueError("dê um nome simples para a pasta (sem barras nem dois-pontos)")
    pai = Path(_limpar(pasta_pai))
    if not pai.is_dir():
        raise NotADirectoryError(str(pai))
    destino = pai / limpo_nome
    if destino.exists() and not destino.is_dir():
        raise ValueError(f"já existe um arquivo com esse nome em {pai}")
    destino.mkdir(parents=True, exist_ok=True)
    return usar(conn, str(destino), limpo_nome)


def definir_ativo(conn: sqlite3.Connection, project_id: str) -> dict[str, object] | None:
    projeto = obter(conn, project_id)
    if projeto is None:
        return None
    conn.execute("UPDATE projects SET last_used_at = ? WHERE id = ?", (_agora(), project_id))
    _garantir_linha(conn, project_id)
    return obter(conn, project_id)


def soltar(conn: sqlite3.Connection) -> None:
    """Fecha o projeto: nenhuma pasta selecionada (conversa solta)."""
    _garantir_linha(conn, None)


def esquecer(conn: sqlite3.Connection, project_id: str) -> bool:
    """Tira o projeto da lista. A pasta no disco **não** é tocada."""
    cursor = conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
    linha = conn.execute("SELECT project_id FROM app_settings WHERE id = 1").fetchone()
    if linha is not None and linha["project_id"] == project_id:
        _garantir_linha(conn, None)
    return cursor.rowcount > 0


def pasta_de_trabalho(
    conn: sqlite3.Connection, caminho: str | None
) -> Path | None:
    """Pasta de trabalho pedida pela interface, se for mesmo uma pasta que existe.

    Vale a pasta pedida, senão a que está aberta no banco. Caminho que não existe (pasta
    apagada, drive fora do ar) não vira workspace: melhor o padrão do que um erro no meio
    da tarefa.
    """
    candidatos = [caminho] if caminho else []
    atual = ativo(conn)
    if atual:
        candidatos.append(str(atual["caminho"]))
    for item in candidatos:
        if not item:
            continue
        rota = Path(str(item)).expanduser()
        if rota.is_dir():
            return rota.resolve()
    return None


def _garantir_linha(conn: sqlite3.Connection, project_id: str | None) -> None:
    conn.execute(
        "INSERT INTO app_settings (id, approval_mode, project_id) VALUES (1, 'default', ?)"
        " ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id",
        (project_id,),
    )


def _limpar(caminho: str) -> str:
    return str(Path(str(caminho).strip().strip('"')).expanduser().resolve())


def _agora() -> int:
    return int(time.time() * 1000)
