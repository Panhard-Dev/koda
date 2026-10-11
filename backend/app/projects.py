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


#: Pastas que a árvore do painel de código não abre.
#:
#: É a mesma ideia da lista que a busca do agente usa (`tools.ferramentas.PASTAS_IGNORADAS`):
#: pasta gerada, enorme, ou as duas coisas — `node_modules` sozinho enterraria o projeto
#: debaixo de milhares de arquivos que ninguém vai ler. Está copiada aqui de propósito:
#: importar `tools.ferramentas` por causa de uma constante traria o httpx, o gerenciador de
#: MCP e o módulo de execução para dentro do módulo de pastas.
#:
#: As pastas que começam com `.` (`.git`, `.venv`, `.next`) ficam de fora pela regra do
#: nome e por isso não estão aqui. O painel diz na tela o que ficou de fora — esconder pasta
#: sem avisar faria o dono procurar o que não está lá.
PASTAS_FORA = frozenset({"node_modules", "venv", "__pycache__", "target", "coverage"})

#: Extensões que o painel não lista: não são código, e o clique só renderizaria binário.
#: `.svg` **não** está aqui de propósito — é texto, e é código.
EXTENSOES_FORA = frozenset(
    {
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tif", ".tiff",
        ".zip", ".gz", ".tar", ".7z", ".rar", ".bz2", ".xz",
        ".exe", ".dll", ".so", ".dylib", ".o", ".a", ".lib", ".pdb", ".bin", ".wasm",
        ".pyc", ".pyo", ".pyd", ".class", ".jar", ".rlib", ".rmeta",
        ".pdf", ".woff", ".woff2", ".ttf", ".otf", ".eot",
        ".sqlite", ".sqlite3", ".db", ".mp3", ".mp4", ".wav", ".mov", ".webm",
        ".lnk", ".iso", ".dmg", ".msi", ".apk", ".pack", ".idx",
    }
)

#: Teto do que o painel mostra de um arquivo, em caracteres.
#:
#: Não é o teto da leitura do agente (`file_read_max_chars`): aqui quem lê é uma pessoa, numa
#: coluna estreita, e ninguém rola 400 mil caracteres. O que passar disso aparece cortado e
#: com o aviso na tela — um pedaço com aviso é melhor do que uma tela travada.
TETO_DO_PAINEL = 400_000


def arvore(caminho: str) -> dict[str, object]:
    """O conteúdo de **uma** pasta, para a árvore do painel de código.

    Um nível por vez, e é escolha: a árvore inteira de um projeto de verdade não cabe numa
    tela nem numa resposta. Quem abre uma pasta pede os filhos dela.

    Pasta sem permissão de leitura devolve a lista vazia em vez de erro, igual ao `navegar`:
    quem está olhando só quer ver o que dá para abrir.
    """
    alvo = _rota(caminho)
    if not alvo.is_dir():
        raise NotADirectoryError(str(alvo))

    itens: list[dict[str, object]] = []
    try:
        filhos = list(alvo.iterdir())
    except OSError:
        filhos = []

    for item in filhos:
        nome = item.name
        # Lixeira e afins: existem na raiz de um disco e não são projeto de ninguém.
        if nome.startswith("$"):
            continue
        try:
            pasta = item.is_dir()
        except OSError:
            continue
        if pasta:
            if nome.startswith(".") or nome in PASTAS_FORA:
                continue
            itens.append({"nome": nome, "caminho": str(item), "pasta": True})
            continue
        if Path(nome).suffix.lower() in EXTENSOES_FORA:
            continue
        # Sem `stat` aqui de propósito: a árvore mostra nome, não tamanho. O tamanho aparece
        # quando o arquivo é aberto — e aí ele vem do `ler_arquivo`, que já mede o arquivo
        # de verdade em vez de repetir uma segunda medição que poderia discordar.
        itens.append({"nome": nome, "caminho": str(item), "pasta": False})

    # Pasta primeiro, depois arquivo; alfabético dentro de cada grupo. É a ordem que a mão
    # procura — o `index.html` não fica perdido no meio de sete pastas.
    itens.sort(key=lambda entrada: (not entrada["pasta"], str(entrada["nome"]).lower()))
    return {"caminho": str(alvo), "nome": alvo.name or str(alvo), "itens": itens}


def ler_arquivo(caminho: str) -> dict[str, object]:
    """O texto de um arquivo, para o visualizador do painel de código.

    Lê o arquivo **de verdade**: é o mesmo conteúdo que o agente vê quando abre o mesmo
    caminho. O teto corta o fim e o painel diz que cortou — não há resumo nem amostra.
    """
    alvo = _rota(caminho)
    if not alvo.is_file():
        raise FileNotFoundError(str(alvo))

    tamanho = alvo.stat().st_size
    with alvo.open("rb") as arquivo:
        dados = arquivo.read(TETO_DO_PAINEL)
    texto = _decodificar(dados)
    return {
        "caminho": str(alvo),
        "nome": alvo.name,
        "texto": texto,
        "linhas": texto.count("\n") + 1,
        "tamanho": tamanho,
        "truncado": tamanho > len(dados),
    }


def _decodificar(dados: bytes) -> str:
    """UTF-8, e o que sobra vira Windows-1252 — é o que sai de um arquivo salvo no Notepad.

    Sem o segundo passo, um `.py` salvo em ANSI apareceria com um `�` em cada acento. E o
    corte no teto pode partir um caractere no meio: o `replace` do fim evita que isso vire
    exceção em cima de um arquivo grande.
    """
    for codificacao in ("utf-8", "cp1252"):
        try:
            return dados.decode(codificacao)
        except UnicodeDecodeError:
            continue
    return dados.decode("utf-8", errors="replace")


def _rota(caminho: str) -> Path:
    """Caminho resolvido — e, se nem isso der, o que veio, sem estourar."""
    try:
        return Path(_limpar(caminho))
    except OSError:
        return Path(str(caminho).strip().strip('"'))


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
