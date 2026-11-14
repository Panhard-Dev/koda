"""Arquivos que o Koda manda do PC para o celular.

O agente roda na máquina da pessoa; o celular não tem como ler o disco do PC. Quando a
pessoa pede «manda esse arquivo para o meu celular», a ferramenta `send_to_phone` copia o
arquivo para este store — uma pasta ao lado do banco, **fora** do workspace — e devolve um
id. O celular recebe um evento `transfer` na conversa e baixa por
`GET /api/transfer/<id>` (no modo link, o koda-link repassa para o backend local).

O id é aleatório e é a única credencial: quem tem o id baixa o arquivo. Por isso ele não
entra no texto da conversa nem no histórico do modelo — só no evento que o celular recebe.
O store expira sozinho: transferência velha não fica para sempre no disco.
"""

from __future__ import annotations

import json
import mimetypes
import re
import shutil
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from .anexos import nome_de_exibicao, nome_seguro
from .config import Settings

#: Teto de uma transferência. Acima disto o celular sofreria para segurar o arquivo na
#: memória do WebView; para arquivo maior, o caminho é o cabo/rede local.
MAX_BYTES = 32 * 1024 * 1024

#: Quanto tempo a transferência fica disponível para baixar.
TTL_S = 3600

_ID = re.compile(r"[a-f0-9]{32}")

_RAIZ: Path | None = None


class TransferenciaError(ValueError):
    """Transferência recusada, com o motivo que a ferramenta devolve."""


@dataclass(slots=True)
class Transferencia:
    id: str
    nome: str
    caminho: Path
    mime: str
    tamanho: int
    criado_em: int


def configurar(settings: Settings) -> None:
    """Aponta o store para a pasta de dados desta execução (chamado no startup)."""
    global _RAIZ
    _RAIZ = Path(settings.database_path).parent / "transferencias"


def _raiz() -> Path:
    if _RAIZ is None:
        raise TransferenciaError("o store de transferências ainda não foi configurado")
    return _RAIZ


def _limpar_antigas(raiz: Path) -> None:
    limite = time.time() - TTL_S
    try:
        pastas = list(raiz.iterdir())
    except OSError:
        return
    for pasta in pastas:
        try:
            if pasta.is_dir() and pasta.stat().st_mtime < limite:
                shutil.rmtree(pasta, ignore_errors=True)
        except OSError:
            continue


def guardar(origem: Path, nome: str | None = None) -> Transferencia:
    """Copia `origem` para o store e devolve o registro pronto para o celular."""
    if not origem.is_file():
        raise TransferenciaError(f"arquivo não encontrado: {origem}")
    tamanho = origem.stat().st_size
    if tamanho <= 0:
        raise TransferenciaError("o arquivo está vazio")
    if tamanho > MAX_BYTES:
        raise TransferenciaError(
            f"o arquivo passa de {MAX_BYTES // (1024 * 1024)} MB; "
            "para um arquivo desse tamanho, use a rede local ou o cabo"
        )

    raiz = _raiz()
    raiz.mkdir(parents=True, exist_ok=True)
    _limpar_antigas(raiz)

    item_id = uuid.uuid4().hex
    exibicao = nome_de_exibicao(nome or origem.name)
    seguro = nome_seguro(nome or origem.name)
    pasta = raiz / item_id
    destino = pasta / seguro
    criado = int(time.time() * 1000)
    try:
        pasta.mkdir(parents=True, exist_ok=False)
        shutil.copyfile(origem, destino)
        mime = mimetypes.guess_type(seguro)[0] or "application/octet-stream"
        (pasta / "meta.json").write_text(
            json.dumps(
                {
                    "nome": exibicao,
                    "arquivo": seguro,
                    "mime": mime,
                    "tamanho": tamanho,
                    "criado_em": criado,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
    except OSError as erro:
        shutil.rmtree(pasta, ignore_errors=True)
        raise TransferenciaError(f"não consegui preparar o arquivo: {erro}") from erro

    return Transferencia(
        id=item_id,
        nome=exibicao,
        caminho=destino,
        mime=mime,
        tamanho=tamanho,
        criado_em=criado,
    )


def buscar(item_id: str) -> Transferencia | None:
    """Acha a transferência pelo id; `None` se não existe, expirou ou o id é inválido."""
    if not item_id or not _ID.fullmatch(item_id):
        return None
    raiz = _raiz()
    pasta = raiz / item_id
    try:
        if pasta.is_symlink() or not pasta.is_dir():
            return None
        meta = json.loads((pasta / "meta.json").read_text(encoding="utf-8"))
        nome = str(meta.get("nome") or "arquivo")
        arquivo = str(meta.get("arquivo") or "")
        mime = str(meta.get("mime") or "application/octet-stream")
        tamanho = int(meta.get("tamanho") or 0)
        criado = int(meta.get("criado_em") or 0)
    except (OSError, ValueError, TypeError):
        return None
    if not arquivo or "/" in arquivo or "\\" in arquivo or arquivo in {".", ".."}:
        return None
    if criado and time.time() * 1000 - criado > TTL_S * 1000:
        shutil.rmtree(pasta, ignore_errors=True)
        return None
    caminho = pasta / arquivo
    if caminho.is_symlink() or not caminho.is_file():
        return None
    if caminho.resolve().parent != pasta.resolve():
        return None
    return Transferencia(
        id=item_id,
        nome=nome,
        caminho=caminho,
        mime=mime,
        tamanho=tamanho,
        criado_em=criado,
    )
