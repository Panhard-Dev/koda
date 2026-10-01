"""Store de anexos da conversa — separado do workspace do agente.

O arquivo que o usuário escolhe na conversa **não** é arquivo do projeto: ele vive aqui,
numa pasta própria ao lado do banco, **fora** do workspace, e só é alcançável pelo
`attachment_id`. Quem lê o conteúdo é a ferramenta `read_attachment`, que aceita id e nada
mais; `read_file` continua preso à pasta de trabalho. Essa separação é o que impede um
anexo de virar leitura de disco: não há caminho que o modelo possa escrever para escapar.

O que entra aqui é validado — tamanho, extensão numa lista branca, e assinatura de bytes
para os binários (pdf/imagem), sem confiar no tipo declarado pelo navegador.
"""

from __future__ import annotations

import hashlib
import re
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from .config import Settings
from .db import Database

#: Teto de tamanho de um anexo. Maior que isto não é anexo de conversa — é arquivo que
#: deveria estar no projeto. O erro é dito na cara, não truncado em silêncio.
MAX_BYTES = 32 * 1024 * 1024

#: Lista branca: extensão → mime. O que não está aqui é recusado com o motivo. Código e
#: texto entram como texto; pdf e imagem entram com o seu mime.
TIPOS: dict[str, str] = {
    ".txt": "text/plain",
    ".log": "text/plain",
    ".ini": "text/plain",
    ".cfg": "text/plain",
    ".env": "text/plain",
    ".sql": "text/plain",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".json": "application/json",
    ".jsonl": "application/json",
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".xml": "application/xml",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
    ".toml": "application/toml",
    ".sh": "text/x-shellscript",
    ".bash": "text/x-shellscript",
    ".py": "text/x-python",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".cjs": "text/javascript",
    ".jsx": "text/javascript",
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
    ".html": "text/html",
    ".htm": "text/html",
    ".css": "text/css",
    ".scss": "text/css",
    ".rs": "text/x-rust",
    ".go": "text/x-go",
    ".java": "text/x-java",
    ".c": "text/x-c",
    ".h": "text/x-c",
    ".cpp": "text/x-c++",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}

#: Mimes que **não** começam com `text/` mas ainda são texto puro — dá para ler como string.
TEXTO_APLICADO = frozenset(
    {
        "application/json",
        "application/xml",
        "application/yaml",
        "application/toml",
        "text/javascript",
        "text/typescript",
    }
)

NOME_INSEGURO = re.compile(r"[^0-9A-Za-z._-]")
CONTROLE = re.compile(r"[\x00-\x1f\x7f]")


class AnexoError(ValueError):
    """Anexo recusado, com o motivo que a tela mostra."""


def nome_de_exibicao(nome: str) -> str:
    """O nome como o usuário o conhece: só o basename, sem controle nem caminho."""
    base = (nome or "").replace("\\", "/").split("/")[-1]
    return CONTROLE.sub("", base).strip()[:120] or "arquivo"


def nome_seguro(nome: str) -> str:
    """Nome que pode ir para o disco: sem separador de caminho, sem `..`, sem controle."""
    base = (nome or "").replace("\\", "/").split("/")[-1]
    limpo = NOME_INSEGURO.sub("_", base).lstrip(".")
    return (limpo or "arquivo")[:80]


def extensao(nome: str) -> str:
    partes = nome_de_exibicao(nome).split(".")
    return f".{partes[-1].lower()}" if len(partes) > 1 else ""


def _imagem(dados: bytes) -> str | None:
    if dados.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if dados.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if dados.startswith(b"GIF87a") or dados.startswith(b"GIF89a"):
        return "image/gif"
    if dados[:4] == b"RIFF" and dados[8:12] == b"WEBP":
        return "image/webp"
    return None


def validar(nome: str, dados: bytes) -> tuple[str, str]:
    """Confere o anexo e devolve `(mime, extensao)`. Levanta `AnexoError` se recusar."""
    if not dados:
        raise AnexoError("arquivo vazio")
    if len(dados) > MAX_BYTES:
        raise AnexoError(
            f"arquivo maior que o teto de {MAX_BYTES // (1024 * 1024)} MB para um anexo"
        )
    ext = extensao(nome)
    if not ext:
        raise AnexoError("arquivo sem extensão")
    mime = TIPOS.get(ext)
    if mime is None:
        raise AnexoError(
            f"tipo .{ext.lstrip('.')} não é aceito como anexo "
            "(texto, código, pdf ou imagem png/jpeg/gif/webp)"
        )
    # Binário: confere a assinatura — não confia na extensão nem no tipo declarado.
    if mime == "application/pdf" and not dados.startswith(b"%PDF"):
        raise AnexoError("o arquivo .pdf não começa com %PDF — não é um PDF")
    if mime.startswith("image/"):
        detectado = _imagem(dados)
        if detectado is None:
            raise AnexoError("conteúdo não reconhecido como imagem png, jpeg, gif ou webp")
        if detectado != mime:
            raise AnexoError(f"extensão .{ext.lstrip('.')} não corresponde ao conteúdo {detectado}")
    return mime, ext


@dataclass(slots=True)
class Anexo:
    """Um anexo já gravado no store."""

    id: str
    nome: str
    nome_seguro: str
    caminho: Path
    mime: str
    tamanho: int
    sha256: str
    criado_em: int

    @property
    def texto(self) -> bool:
        """Dá para ler como texto? (o que a `read_attachment` devolve cru)"""
        return self.mime.startswith("text/") or self.mime in TEXTO_APLICADO

    @property
    def imagem(self) -> bool:
        return self.mime.startswith("image/")


def _linha(registro: object) -> Anexo:
    return Anexo(
        id=registro["id"],  # type: ignore[index]
        nome=registro["nome"],  # type: ignore[index]
        nome_seguro=registro["nome_seguro"],  # type: ignore[index]
        caminho=Path(registro["caminho"]),  # type: ignore[index]
        mime=registro["mime"],  # type: ignore[index]
        tamanho=int(registro["tamanho"]),  # type: ignore[index]
        sha256=registro["sha256"],  # type: ignore[index]
        criado_em=int(registro["criado_em"]),  # type: ignore[index]
    )


def pasta(settings: Settings) -> Path:
    """Onde os anexos vivem: ao lado do banco, **nunca** dentro do workspace."""
    return Path(settings.database_path).parent / "anexos"


class AnexoStore:
    """Acesso ao store a partir do id — é o que a ferramenta `read_attachment` usa.

    Abre a própria conexão a cada operação: a ferramenta roda numa thread (`to_thread`),
    e uma conexão por operação é o mesmo padrão do resto do backend.
    """

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.db = Database(settings.database_path)

    # ------------------------------------------------------------------ escrita
    def guardar(self, nome: str, dados: bytes) -> Anexo:
        """Valida e grava o anexo; devolve o registro. Levanta `AnexoError` se recusar."""
        mime, _ = validar(nome, dados)
        exibicao = nome_de_exibicao(nome)
        seguro = nome_seguro(nome)
        anexo_id = uuid.uuid4().hex
        destino_dir = pasta(self.settings) / anexo_id
        destino_dir.mkdir(parents=True, exist_ok=True)
        destino = destino_dir / seguro
        destino.write_bytes(dados)
        criado = int(time.time() * 1000)
        registro = Anexo(
            id=anexo_id,
            nome=exibicao,
            nome_seguro=seguro,
            caminho=destino,
            mime=mime,
            tamanho=len(dados),
            sha256=hashlib.sha256(dados).hexdigest(),
            criado_em=criado,
        )
        with self.db.connect() as conn:
            conn.execute(
                "INSERT INTO attachments "
                "(id, nome, nome_seguro, caminho, mime, tamanho, sha256, criado_em) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    registro.id,
                    registro.nome,
                    registro.nome_seguro,
                    str(registro.caminho),
                    registro.mime,
                    registro.tamanho,
                    registro.sha256,
                    registro.criado_em,
                ),
            )
        return registro

    def remover(self, anexo_id: str) -> bool:
        """Tira o anexo do índice e apaga o conteúdo do store."""
        anexo = self.buscar(anexo_id)
        if anexo is None:
            return False
        with self.db.connect() as conn:
            conn.execute("DELETE FROM attachments WHERE id = ?", (anexo_id,))
        # Apaga a pasta inteira do anexo (o arquivo e o diretório com o id).
        try:
            anexo.caminho.unlink(missing_ok=True)
            anexo.caminho.parent.rmdir()
        except OSError:
            # Conteúdo já ausente ou pasta compartilhada: o índice já saiu, que é o que
            # decide se o anexo existe. Não vale derrubar a rota por causa disso.
            pass
        return True

    # ------------------------------------------------------------------ leitura
    def buscar(self, anexo_id: str) -> Anexo | None:
        if not anexo_id:
            return None
        with self.db.connect() as conn:
            linha = conn.execute(
                "SELECT * FROM attachments WHERE id = ?", (anexo_id,)
            ).fetchone()
        return _linha(linha) if linha is not None else None

    def buscar_varios(self, ids: list[str]) -> list[Anexo]:
        """Resolve ids → anexos, **na ordem pedida** e sem os desconhecidos."""
        encontrados: dict[str, Anexo] = {}
        limpos = [item for item in (str(i).strip() for i in ids) if item]
        if not limpos:
            return []
        with self.db.connect() as conn:
            for anexo_id in limpos:
                linha = conn.execute(
                    "SELECT * FROM attachments WHERE id = ?", (anexo_id,)
                ).fetchone()
                if linha is not None:
                    encontrados[anexo_id] = _linha(linha)
        return [encontrados[i] for i in limpos if i in encontrados]
