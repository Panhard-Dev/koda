"""Download do instalador, feito pelo backend local.

A nuvem publica um link; quem baixa é este processo, não o navegador. O motivo é o
comportamento do app: um `<a href>` joga o usuário para fora do Koda (janela nova,
"salvar como", pasta escolhida à mão) e o instalador acaba em qualquer lugar. Aqui o
arquivo vai direto para a pasta de downloads do sistema, com progresso na tela.

O que vale para todo download:

* o endereço **não vem do cliente**: sai do último estado da nuvem, já passado por
  `link_seguro` (HTTPS, sem credenciais embutidas, host permitido quando há lista);
* sem redirecionamento: um 302 para outro host não é seguido, então a nuvem não
  consegue puxar o arquivo de um endereço arbitrário;
* teto de tamanho — serviço comprometido não enche o disco;
* escrita em `.part` e só então o nome final: download interrompido não deixa um
  arquivo pela metade com cara de instalador.

Nada aqui levanta para fora: erro vira `estado="erro"` com uma mensagem curta, sem
endereço, sem token e sem detalhe de rede.
"""

from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel

from .config import Settings
from .nuvem import link_seguro

USER_AGENT = "Koda/1.0 (+backend)"
"""Mesmo identificador das consultas — o serviço já conhece o app por ele."""

LIMITE_BYTES = 512 * 1024 * 1024
"""Teto do arquivo baixado (meio giga): instalador maior que isso não é o nosso."""

PEDACO = 128 * 1024
"""Bytes por leitura do stream. É o que faz o progresso andar durante o download."""

NOME_SEGURO = re.compile(r"[^A-Za-z0-9._-]")
NOME_RESERVA = "koda-setup.exe"
"""Nome usado quando a URL não traz nada aproveitável."""


def nome_do_arquivo(url: str) -> str:
    """Nome de arquivo seguro, tirado da última parte da URL.

    Tira consulta e fragmento (o `?versao=...` do link não é nome), recusa `..` e
    caminho embutido, limita o tamanho e cai num nome padrão se não sobrar nada.
    """
    caminho = urlsplit(url or "").path
    bruto = caminho.rsplit("/", 1)[-1].strip()
    limpo = NOME_SEGURO.sub("_", bruto).lstrip(".")
    limpo = limpo[:100]
    if limpo in ("", "_"):
        return NOME_RESERVA
    return limpo


class ErroDownload(Exception):
    """Falha já traduzida para o que a interface pode mostrar."""


class StatusDownload(BaseModel):
    """O que a tela precisa para desenhar o progresso do download."""

    estado: Literal["parado", "baixando", "concluido", "erro"] = "parado"
    recebido: int = 0
    total: int | None = None
    arquivo: str | None = None
    pasta: str | None = None
    caminho: str | None = None
    versao: str | None = None
    erro: str | None = None


class Baixador:
    """Um download por vez, com o progresso guardado em memória.

    Uma instância por aplicação (vive no `app.state`). Não é uma fila: o segundo pedido
    enquanto um download corre devolve o que já está rodando, em vez de baixar de novo.
    """

    def __init__(self, settings: Settings, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.settings = settings
        #: Transporte do httpx. `None` = rede de verdade; os testes injetam um falso.
        self.transport = transport
        self._tarefa: asyncio.Task[None] | None = None
        self._status = StatusDownload()

    @property
    def status(self) -> StatusDownload:
        return self._status

    @property
    def pasta(self) -> Path:
        """Onde o instalador é salvo: `KODA_DOWNLOAD_DIR` ou a pasta do sistema."""
        escolhida = (self.settings.download_dir or "").strip()
        if escolhida:
            return Path(escolhida).expanduser()
        padrao = Path.home() / "Downloads"
        return padrao if padrao.is_dir() else Path.home()

    def em_andamento(self) -> bool:
        return self._tarefa is not None and not self._tarefa.done()

    def iniciar(
        self,
        url: str,
        *,
        versao: str | None = None,
        permitidos: list[str] | None = None,
    ) -> StatusDownload:
        """Começa o download e devolve o status do instante do pedido."""
        if self.em_andamento():
            return self._status
        if not url or not link_seguro(url, permitidos):
            self._status = StatusDownload(
                estado="erro", erro="o link publicado não é um endereço seguro", versao=versao
            )
            return self._status

        nome = nome_do_arquivo(url)
        self._status = StatusDownload(
            estado="baixando",
            arquivo=nome,
            pasta=str(self.pasta),
            versao=versao,
        )
        self._tarefa = asyncio.create_task(self._baixar(url, nome))
        return self._status

    def cancelar(self) -> None:
        """Desliga o download (usado quando o app fecha) sem deixar arquivo pela metade."""
        tarefa = self._tarefa
        if tarefa is None or tarefa.done():
            return
        tarefa.cancel()

    async def _baixar(self, url: str, nome: str) -> None:
        destino = self.pasta
        parcial = destino / f"{nome}.part"
        final = destino / nome
        try:
            destino.mkdir(parents=True, exist_ok=True)
            total = await self._escrever(url, parcial)
            os.replace(parcial, final)
        except asyncio.CancelledError:
            parcial.unlink(missing_ok=True)
            self._status = StatusDownload(estado="parado", erro="download cancelado")
            raise
        except (ErroDownload, httpx.HTTPError, OSError, ValueError) as erro:
            parcial.unlink(missing_ok=True)
            mensagem = erro.args[0] if isinstance(erro, ErroDownload) and erro.args else ""
            self._status = StatusDownload(
                estado="erro",
                arquivo=nome,
                pasta=str(destino),
                versao=self._status.versao,
                erro=mensagem or "não consegui baixar o instalador",
            )
            return

        self._status = self._status.model_copy(
            update={
                "estado": "concluido",
                "recebido": self._status.recebido,
                "total": self._status.total or self._status.recebido,
                "caminho": str(final),
            }
        )

    async def _escrever(self, url: str, parcial: Path) -> int | None:
        """Baixa para o arquivo `.part`, atualizando o progresso. Devolve o total."""
        # Timeout de leitura vale por pedaço: um arquivo grande e lento continua válido,
        # o que não pode é a conexão ficar muda no meio.
        tempo = httpx.Timeout(self.settings.cloud_timeout_s, read=60.0)
        async with httpx.AsyncClient(
            timeout=tempo,
            follow_redirects=False,
            transport=self.transport,
        ) as cliente:
            async with cliente.stream(
                "GET", url, headers={"Accept": "*/*", "User-Agent": USER_AGENT}
            ) as resposta:
                if resposta.status_code != 200:
                    raise ErroDownload("o serviço não entregou o arquivo")
                total = self._tamanho_declarado(resposta)
                if total is not None and total > LIMITE_BYTES:
                    raise ErroDownload("o arquivo é maior do que o limite aceito")
                with parcial.open("wb") as arquivo:
                    async for pedaco in resposta.aiter_bytes(PEDACO):
                        recebido = self._status.recebido + len(pedaco)
                        if recebido > LIMITE_BYTES:
                            raise ErroDownload("o arquivo é maior do que o limite aceito")
                        arquivo.write(pedaco)
                        self._status.recebido = recebido
                        self._status.total = total
        return total

    @staticmethod
    def _tamanho_declarado(resposta: httpx.Response) -> int | None:
        """Tamanho anunciado no cabeçalho. `None` quando ele não veio ou não faz sentido.

        O número não é confiável para decidir nada além de barra de progresso: quem manda
        no teto é o que chega de verdade, contado pedaço a pedaço.
        """
        cabecalho = resposta.headers.get("content-length", "")
        if not cabecalho.isdigit():
            return None
        total = int(cabecalho)
        return total if total > 0 else None
