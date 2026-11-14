"""
Túnel Cloudflare do koda-link.

O celular precisa de um endereço público, mas o backend do Koda não pode ficar
exposto. A saída é a mesma do RustDesk quando não há hole punching: um túnel de
saída. O `cloudflared` abre uma URL HTTPS aleatória e a mantém viva enquanto o
processo viver — o link só escuta em `127.0.0.1`, e o Cloudflare é a única
porta de entrada.

Cada QR novo ganha uma porta local, uma URL pública, uma sala e um código
novos. Nada é reaproveitado entre QR.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import platform
import re
import shutil
import stat
import tarfile
from pathlib import Path

import httpx

RAIZ = Path(__file__).resolve().parents[1]

_URL_DO_TUNEL = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")


def _nome_local() -> str:
    return "cloudflared.exe" if platform.system().lower() == "windows" else "cloudflared"


def pasta_de_binarios() -> Path:
    """Onde o cloudflared baixado pode ser gravado.

    No app instalado o `backend/` fica dentro da pasta do programa, que é
    **somente leitura**: gravar ali dava `PermissionError` na primeira abertura
    do QR. O launcher já entrega a pasta gravável em `KODA_DATA_DIR` (a mesma do
    banco); fora do instalado, `backend/data/bin` continua valendo.
    """
    escolhida = os.environ.get("KODA_DATA_DIR")
    if escolhida:
        return Path(escolhida).expanduser() / "bin"
    banco = os.environ.get("KODA_DATABASE_PATH")
    if banco:
        return Path(banco).expanduser().parent / "bin"
    return RAIZ / "data" / "bin"


def _embarcado() -> Path | None:
    """O cloudflared que veio dentro do instalador (`<Koda>/bin/cloudflared`).

    Empacotar o binário é o que faz o QR abrir sem internet para baixar nada e
    sem depender de o GitHub estar alcançável na máquina de quem instalou.
    """
    caminho = RAIZ.parent / "bin" / _nome_local()
    return caminho if caminho.is_file() else None


def _garantir_executavel(caminho: Path) -> None:
    if platform.system().lower() == "windows":
        return
    with contextlib.suppress(OSError):
        caminho.chmod(caminho.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def localizar() -> Path | None:
    """O binário do cloudflared: variável, PATH, o do instalador ou o baixado."""
    escolhido = os.environ.get("KODA_CLOUDFLARED")
    if escolhido:
        caminho = Path(escolhido).expanduser()
        if caminho.is_file():
            return caminho
    achado = shutil.which("cloudflared")
    if achado:
        return Path(achado)
    embarcado = _embarcado()
    if embarcado is not None:
        return embarcado
    caminho = pasta_de_binarios() / _nome_local()
    return caminho if caminho.is_file() else None


def _asset() -> tuple[str, bool]:
    """Nome do asset no GitHub e se ele vem em `.tgz`."""
    sistema = platform.system().lower()
    maquina = platform.machine().lower()

    if sistema == "linux":
        if maquina in {"x86_64", "amd64"}:
            return "cloudflared-linux-amd64", False
        if maquina in {"aarch64", "arm64"}:
            return "cloudflared-linux-arm64", False
        if maquina in {"armv7l", "armv6l", "arm"}:
            return "cloudflared-linux-arm", False
        if maquina in {"i386", "i686", "x86"}:
            return "cloudflared-linux-386", False
    if sistema == "darwin":
        if maquina in {"arm64", "aarch64"}:
            return "cloudflared-darwin-arm64.tgz", True
        return "cloudflared-darwin-amd64.tgz", True
    if sistema == "windows":
        if maquina in {"arm64", "aarch64"}:
            return "cloudflared-windows-arm64.exe", False
        return "cloudflared-windows-amd64.exe", False
    raise RuntimeError(f"não sei baixar o cloudflared para {sistema}/{maquina}")


async def _versao(caminho: Path) -> str:
    processo = await asyncio.create_subprocess_exec(
        str(caminho),
        "--version",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    saida, _ = await processo.communicate()
    if processo.returncode != 0:
        raise RuntimeError("o cloudflared baixado não executa nesta máquina")
    return saida.decode(errors="replace").strip().splitlines()[0] if saida else "cloudflared"


async def garantir() -> Path:
    """Devolve o cloudflared, baixando do GitHub na primeira vez.

    O download é o único passo que depende da internet; depois o binário fica em
    `backend/data/bin` e o túnel abre sem tocar em nada externo além do próprio
    Cloudflare.
    """
    existente = localizar()
    if existente is not None:
        _garantir_executavel(existente)
        return existente

    pasta = pasta_de_binarios()
    pasta.mkdir(parents=True, exist_ok=True)
    asset, compactado = _asset()
    url = f"https://github.com/cloudflare/cloudflared/releases/latest/download/{asset}"
    destino = pasta / _nome_local()
    temporario = pasta / (destino.name + ".tmp")

    try:
        limite = httpx.Timeout(60.0, read=180.0, write=60.0, pool=60.0)
        async with httpx.AsyncClient(follow_redirects=True, timeout=limite) as cliente:
            async with cliente.stream("GET", url) as resposta:
                resposta.raise_for_status()
                with temporario.open("wb") as arquivo:
                    async for pedaco in resposta.aiter_bytes():
                        arquivo.write(pedaco)
    except Exception as erro:  # noqa: BLE001 — a mensagem vira a explicação na tela
        temporario.unlink(missing_ok=True)
        raise RuntimeError(
            "não consegui baixar o cloudflared; instale-o à mão e coloque no PATH "
            f"(ou em {pasta})"
        ) from erro

    if compactado:
        with tarfile.open(temporario, "r:gz") as pacote:
            pacote.extractall(pasta, filter="data")
        temporario.unlink(missing_ok=True)
        extraido = pasta / "cloudflared"
        if not extraido.is_file():
            raise RuntimeError("o pacote do cloudflared não trouxe o binário")
        destino = extraido
    else:
        temporario.replace(destino)

    destino.chmod(destino.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    await _versao(destino)
    return destino


class TunelCloudflare:
    """Um processo `cloudflared tunnel --url` vivo, com a URL pública dele."""

    def __init__(self, porta: int) -> None:
        self.porta = porta
        self.url: str | None = None
        self.processo: asyncio.subprocess.Process | None = None
        self.erro: str | None = None
        self._leitor: asyncio.Task[None] | None = None

    @property
    def vivo(self) -> bool:
        return (
            self.processo is not None
            and self.processo.returncode is None
            and self.url is not None
        )

    async def abrir(self, timeout: float = 60.0) -> str:
        binario = await garantir()
        self.processo = await asyncio.create_subprocess_exec(
            str(binario),
            "tunnel",
            "--url",
            f"http://127.0.0.1:{self.porta}",
            "--no-autoupdate",
            "--protocol",
            "http2",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )

        loop = asyncio.get_running_loop()
        #: Resolve só quando a URL já saiu **e** a conexão registrou no edge.
        #: A URL aparece alguns instantes antes do registro, e um pedido nessa
        #: janela recebe o erro 1033 do Cloudflare em vez da resposta do Koda.
        futuro: asyncio.Future[None] = loop.create_future()
        achado_url: dict[str, str | None] = {"url": None}

        async def ler() -> None:
            assert self.processo is not None and self.processo.stderr is not None
            ultimas: list[str] = []
            async for linha in self.processo.stderr:
                texto = linha.decode(errors="replace").rstrip()
                if texto:
                    ultimas.append(texto)
                    ultimas = ultimas[-8:]
                achado = _URL_DO_TUNEL.search(texto)
                if achado and achado_url["url"] is None:
                    achado_url["url"] = achado.group(0)
                if (
                    achado_url["url"] is not None
                    and "Registered tunnel connection" in texto
                    and not futuro.done()
                ):
                    futuro.set_result(None)
            if not futuro.done():
                futuro.set_exception(
                    RuntimeError(
                        "o cloudflared saiu sem abrir o túnel"
                        + (f": {ultimas[-1]}" if ultimas else "")
                    )
                )

        self._leitor = asyncio.create_task(ler())
        try:
            await asyncio.wait_for(futuro, timeout)
        except TimeoutError as erro:
            await self.parar()
            raise RuntimeError("o cloudflared não abriu o túnel a tempo") from erro
        except asyncio.CancelledError:
            # `CancelledError` não herda de `Exception`. Sem este ramo, fechar a
            # tela durante a abertura deixava o cloudflared vivo e sem link.
            self.matar_agora()
            raise
        except Exception as erro:  # noqa: BLE001
            await self.parar()
            raise RuntimeError(str(erro) or "o cloudflared não abriu o túnel") from erro
        url = achado_url["url"]
        if url is None:  # o futuro só resolve depois da URL; guarda para o tipo
            await self.parar()
            raise RuntimeError("o cloudflared registrou a conexão sem devolver a URL")
        self.url = url
        try:
            await self.confirmar_publico()
        except RuntimeError:
            await self.parar()
            raise
        return url

    async def confirmar_publico(self, tentativas: int = 8) -> None:
        """Confirma que a URL pública atravessa o edge antes de virar QR.

        «Registered tunnel connection» é local: o DNS/edge pode ainda devolver 1033. Sem
        esta sondagem, a tela mostrava «Túnel no ar» com um QR que o celular não abria.
        O health do link é público e não expõe sala, token nem segredo.
        """
        if not self.url:
            raise RuntimeError("o túnel não tem URL pública")
        ultimo = "sem resposta"
        async with httpx.AsyncClient(timeout=httpx.Timeout(4.0), follow_redirects=False) as cliente:
            for tentativa in range(tentativas):
                try:
                    resposta = await cliente.get(f"{self.url}/api/health")
                    if resposta.status_code == 200:
                        dados = resposta.json()
                        if dados.get("ok") is True and dados.get("nome") == "koda-link":
                            return
                        ultimo = "a URL pública não respondeu pelo link do Koda"
                    else:
                        ultimo = f"a URL pública respondeu HTTP {resposta.status_code}"
                except (httpx.HTTPError, ValueError) as erro:
                    ultimo = type(erro).__name__
                if tentativa + 1 < tentativas:
                    await asyncio.sleep(1.0)
        raise RuntimeError(f"o túnel não ficou alcançável: {ultimo}")

    async def parar(self) -> None:
        if self._leitor is not None:
            self._leitor.cancel()
            self._leitor = None
        processo = self.processo
        self.processo = None
        self.url = None
        if processo is None or processo.returncode is not None:
            return
        processo.terminate()
        try:
            await asyncio.wait_for(processo.wait(), 5.0)
        except TimeoutError:
            processo.kill()
            with contextlib.suppress(Exception):
                await processo.wait()

    def matar_agora(self) -> None:
        """Para o `atexit`: sem event loop, só o sinal."""
        if self._leitor is not None:
            self._leitor.cancel()
            self._leitor = None
        processo = self.processo
        self.processo = None
        self.url = None
        if processo is not None and processo.returncode is None:
            processo.terminate()
            with contextlib.suppress(ProcessLookupError):
                processo.kill()
