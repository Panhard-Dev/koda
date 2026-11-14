"""
Cliente do PC para o koda-link.

É o lado "hbbs" do RustDesk visto pelo PC: o Koda local abre uma conexão de
**saída** para o servidor de link e fica esperando pedidos. Nada de abrir porta
no roteador, nada de expor o backend na internet.

O servidor de link só vê quadros JSON; o token da API local é injetado aqui,
dentro do PC, e nunca atravessa a rede.
"""

from __future__ import annotations

import asyncio
import base64
import codecs
import contextlib
import json
import os
import re
import time
from typing import Any
from urllib.parse import quote

import httpx
import websockets
from websockets.exceptions import ConnectionClosed

METODOS = frozenset({"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"})
MAX_QUADRO = 24 * 1024 * 1024

#: A mesma lista fechada do link. O link já recusa o que não está aqui; o PC
#: repete a checagem para não depender de um servidor de link bem comportado.
REGRAS_DE_API: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("GET", re.compile(r"/api/provedores")),
    ("GET", re.compile(r"/api/provedores/[^/]+/modelos")),
    ("GET", re.compile(r"/api/permissions")),
    ("PUT", re.compile(r"/api/permissions")),
    ("GET", re.compile(r"/api/projects")),
    ("POST", re.compile(r"/api/chat")),
    ("POST", re.compile(r"/api/chat/approval")),
    ("GET", re.compile(r"/api/live")),
    ("GET", re.compile(r"/api/live/[^/]+")),
    ("GET", re.compile(r"/api/live/[^/]+/eventos")),
    ("POST", re.compile(r"/api/live/parar")),
    ("POST", re.compile(r"/api/attachments")),
    ("GET", re.compile(r"/api/health")),
)


def _permitido(metodo: str, caminho: str) -> bool:
    alvo = caminho.split("?", 1)[0]
    return any(metodo == regra_metodo and padrao.fullmatch(alvo) for regra_metodo, padrao in REGRAS_DE_API)


def _ws_base(link: str) -> str:
    base = link.strip().rstrip("/")
    if base.startswith("https://"):
        return "wss://" + base[len("https://") :]
    if base.startswith("http://"):
        return "ws://" + base[len("http://") :]
    if base.startswith(("ws://", "wss://")):
        return base
    return "ws://" + base


class ClienteRemoto:
    """Mantém o PC conectado ao koda-link e repassa os pedidos para a API local."""

    def __init__(
        self,
        link: str,
        sala: str,
        segredo: str,
        *,
        api_url: str | None = None,
        api_token: str | None = None,
    ) -> None:
        self.link = link.rstrip("/")
        self.sala = sala
        self.segredo = segredo
        self.api_url = (api_url or os.environ.get("KODA_API_URL") or "http://127.0.0.1:8787").rstrip("/")
        self.api_token = api_token or os.environ.get("KODA_API_TOKEN") or ""

        self.conectado = False
        self.erro: str | None = None
        self.desde: float | None = None
        self.convidado = False
        self.ultimo_sinal: float | None = None

        self._tarefa: asyncio.Task[None] | None = None
        self._parar = asyncio.Event()
        self._ws: Any = None
        self._pedidos: dict[str, asyncio.Task[None]] = {}
        self._trava = asyncio.Lock()

    # ------------------------------------------------------------------ estado

    def estado(self) -> dict[str, Any]:
        return {
            "conectado": self.conectado,
            "sala": self.sala,
            "link": self.link,
            "convidado": self.convidado,
            "desde": self.desde,
            "ultimo_sinal": self.ultimo_sinal,
            "erro": self.erro,
            "api": self.api_url,
        }

    # ------------------------------------------------------------------ ciclo

    async def iniciar(self) -> dict[str, Any]:
        if self._tarefa is not None and not self._tarefa.done():
            return self.estado()
        self._parar.clear()
        self.erro = None
        self._tarefa = asyncio.create_task(self._laco(), name="koda-link-host")
        await asyncio.sleep(0)
        return self.estado()

    async def parar(self) -> dict[str, Any]:
        self._parar.set()
        if self._ws is not None:
            with contextlib.suppress(Exception):
                await self._ws.close()
        if self._tarefa is not None:
            self._tarefa.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._tarefa
        self._tarefa = None
        for tarefa in list(self._pedidos.values()):
            tarefa.cancel()
        self._pedidos.clear()
        self.conectado = False
        self.convidado = False
        self.desde = None
        return self.estado()

    async def _laco(self) -> None:
        espera = 1.0
        while not self._parar.is_set():
            try:
                await self._sessao()
                espera = 1.0
            except asyncio.CancelledError:
                raise
            except Exception as erro:  # noqa: BLE001 — a reconexão é o comportamento
                self.erro = str(erro) or erro.__class__.__name__
            finally:
                self.conectado = False
                self.convidado = False
                self.desde = None
                self._ws = None
            if self._parar.is_set():
                break
            try:
                await asyncio.wait_for(self._parar.wait(), timeout=espera)
                break
            except TimeoutError:
                espera = min(espera * 2, 30.0)

    async def _sessao(self) -> None:
        url = (
            f"{_ws_base(self.link)}/ws/{quote(self.sala, safe='')}"
            f"?papel=host&segredo={quote(self.segredo, safe='')}"
        )
        async with websockets.connect(
            url,
            max_size=MAX_QUADRO,
            ping_interval=20,
            ping_timeout=20,
            open_timeout=15,
        ) as ws:
            self._ws = ws
            self.erro = None
            self.desde = time.time()
            async for texto in ws:
                if isinstance(texto, bytes):
                    continue
                try:
                    dados = json.loads(texto)
                except ValueError:
                    continue
                if not isinstance(dados, dict):
                    continue
                self.ultimo_sinal = time.time()
                tipo = dados.get("tipo")
                if tipo == "pareado":
                    self.conectado = True
                    self.convidado = bool(dados.get("convidado"))
                elif tipo == "presenca":
                    self.conectado = True
                    self.convidado = bool(dados.get("convidado"))
                elif tipo == "pedido":
                    await self._comecar_pedido(dados)
                elif tipo == "cancelar":
                    pedido_id = dados.get("id")
                    if isinstance(pedido_id, str):
                        tarefa = self._pedidos.pop(pedido_id, None)
                        if tarefa is not None:
                            tarefa.cancel()

    # ------------------------------------------------------------------ pedidos

    async def _comecar_pedido(self, dados: dict[str, Any]) -> None:
        pedido_id = dados.get("id")
        if not isinstance(pedido_id, str) or not pedido_id:
            return
        anterior = self._pedidos.pop(pedido_id, None)
        if anterior is not None:
            anterior.cancel()
        tarefa = asyncio.create_task(self._atender(dados))
        self._pedidos[pedido_id] = tarefa

        def _terminou(_: asyncio.Task[None]) -> None:
            if self._pedidos.get(pedido_id) is tarefa:
                self._pedidos.pop(pedido_id, None)

        tarefa.add_done_callback(_terminou)

    async def _enviar(self, quadro: dict[str, Any]) -> None:
        ws = self._ws
        if ws is None:
            return
        async with self._trava:
            await ws.send(json.dumps(quadro, ensure_ascii=False))

    async def _erro(self, pedido_id: str, mensagem: str) -> None:
        with contextlib.suppress(Exception):
            await self._enviar({"tipo": "erro", "id": pedido_id, "mensagem": mensagem})

    def _cabecalhos(self, pedido: dict[str, Any]) -> dict[str, str]:
        cabecalhos = {
            "authorization": f"Bearer {self.api_token}",
            "x-koda-window": "mobile",
        }
        recebidos = pedido.get("cabecalhos")
        if isinstance(recebidos, dict):
            for nome in ("content-type", "accept"):
                valor = recebidos.get(nome)
                if isinstance(valor, str) and len(valor) < 400:
                    cabecalhos[nome] = valor
        return cabecalhos

    @staticmethod
    def _corpo(pedido: dict[str, Any]) -> bytes | None:
        if isinstance(pedido.get("corpo_b64"), str):
            try:
                return base64.b64decode(pedido["corpo_b64"], validate=True)
            except (ValueError, TypeError):
                return None
        if isinstance(pedido.get("corpo"), str):
            return pedido["corpo"].encode("utf-8")
        return None

    async def _atender(self, pedido: dict[str, Any]) -> None:
        pedido_id = pedido["id"]
        metodo = str(pedido.get("metodo", "GET")).upper()
        caminho = str(pedido.get("caminho", ""))

        if (
            metodo not in METODOS
            or not caminho.startswith("/api/")
            or caminho.startswith("/api/remoto")
            or "://" in caminho
            or ".." in caminho
            or "\n" in caminho
            or not _permitido(metodo, caminho)
        ):
            await self._erro(pedido_id, "pedido inválido")
            return

        corpo = self._corpo(pedido)
        if corpo is None and pedido.get("corpo_b64") is not None:
            await self._erro(pedido_id, "corpo inválido")
            return

        try:
            limite = httpx.Timeout(30.0, read=None, write=30.0, pool=30.0)
            async with httpx.AsyncClient(timeout=limite) as cliente:
                async with cliente.stream(
                    metodo,
                    f"{self.api_url}{caminho}",
                    content=corpo,
                    headers=self._cabecalhos(pedido),
                ) as resposta:
                    tipo_conteudo = resposta.headers.get("content-type", "")
                    eh_texto = any(
                        marca in tipo_conteudo
                        for marca in ("text/", "json", "event-stream", "xml", "javascript")
                    )
                    await self._enviar(
                        {
                            "tipo": "inicio",
                            "id": pedido_id,
                            "status": resposta.status_code,
                            "cabecalhos": {"content-type": tipo_conteudo},
                        }
                    )

                    decodificador = codecs.getincrementaldecoder("utf-8")("replace") if eh_texto else None
                    async for pedaco in resposta.aiter_raw():
                        if decodificador is not None:
                            texto = decodificador.decode(pedaco)
                            if not texto:
                                continue
                            await self._enviar({"tipo": "pedaco", "id": pedido_id, "dados": texto})
                        else:
                            await self._enviar(
                                {
                                    "tipo": "pedaco",
                                    "id": pedido_id,
                                    "dados_b64": base64.b64encode(pedaco).decode("ascii"),
                                }
                            )

                    if decodificador is not None:
                        resto = decodificador.decode(b"", final=True)
                        if resto:
                            await self._enviar({"tipo": "pedaco", "id": pedido_id, "dados": resto})

            await self._enviar({"tipo": "fim", "id": pedido_id})
        except asyncio.CancelledError:
            with contextlib.suppress(Exception):
                await self._enviar({"tipo": "fim", "id": pedido_id, "cancelado": True})
            raise
        except ConnectionClosed:
            raise
        except Exception as erro:  # noqa: BLE001 — o celular precisa saber o que houve
            await self._erro(pedido_id, str(erro) or "falha ao falar com a API local")


# --------------------------------------------------------------------------- CLI


async def _cli() -> None:
    link = os.environ.get("KODA_LINK_URL", "").rstrip("/")
    sala = os.environ.get("KODA_LINK_SALA", "")
    segredo = os.environ.get("KODA_LINK_SEGREDO", "")
    if not (link and sala and segredo):
        raise SystemExit(
            "defina KODA_LINK_URL, KODA_LINK_SALA e KODA_LINK_SEGREDO "
            "(ou use a tela Celular no app do PC)"
        )
    cliente = ClienteRemoto(link, sala, segredo)
    await cliente.iniciar()
    print(json.dumps(cliente.estado(), ensure_ascii=False), flush=True)
    parar = asyncio.Event()
    try:
        await parar.wait()
    finally:
        await cliente.parar()


if __name__ == "__main__":
    try:
        asyncio.run(_cli())
    except KeyboardInterrupt:
        pass
