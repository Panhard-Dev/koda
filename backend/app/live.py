"""Rodadas ao vivo: o trabalho pertence ao backend, não à conexão.

Antes, o `/api/chat` era um gerador preso ao stream HTTP. Quando o celular saía
do app — ou trocava de Wi-Fi — a conexão caía, o gerador era fechado e o agente
parava no meio, deixando a tarefa pela metade. Aqui a rodada roda numa tarefa
própria; o HTTP apenas se inscreve no diário de eventos.

Quem chega depois — o PC, o celular que voltou, outra aba — recebe o que já
passou e continua vendo ao vivo, do ponto em que parou. Parar é explícito: um
pedido a `/api/live/parar`, e não o simples fechamento de uma aba.
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from .schemas import sse

#: De quanto em quanto tempo um inscrito calado recebe um comentário SSE. É o
#: mesmo sinal de vida do `/api/chat`: mantém viva a conexão através de proxies.
SINAL_DE_VIDA_S = 15.0

#: Quantos eventos ficam no diário. Um turno longo tem milhares de deltas; o
#: suficiente para quem reconecta no meio sem deixar a memória crescer sem fim.
MAX_EVENTOS = 6000

#: Quanto tempo uma sessão terminada ainda pode ser lida (para o celular que
#: voltou ao app logo depois do fim receber o desfecho).
RETENCAO_S = 30 * 60

_log = logging.getLogger(__name__)


def _ler_bloco(bruto: str) -> tuple[str, dict[str, Any]] | None:
    """Lê um bloco SSE do produtor. Comentários (`:sinal-de-vida`) não são eventos."""
    nome = "message"
    dados: dict[str, Any] = {}
    achou = False
    for linha in bruto.splitlines():
        if linha.startswith("event:"):
            nome = linha[6:].strip()
        elif linha.startswith("data:"):
            try:
                valor = json.loads(linha[5:].strip())
            except ValueError:
                return None
            if isinstance(valor, dict):
                dados = valor
                achou = True
    if not achou:
        return None
    return nome, dados


@dataclass(slots=True)
class Evento:
    seq: int
    nome: str
    dados: dict[str, Any]
    bruto: str


@dataclass
class SessaoAoVivo:
    """Uma rodada em curso, com o diário do que ela já contou."""

    conversa: str | None
    origem: str
    dono: str
    id: str = field(default_factory=lambda: secrets.token_urlsafe(9))
    iniciada: float = field(default_factory=time.time)
    terminada: float | None = None
    rodando: bool = True
    motivo: str | None = None
    eventos: list[Evento] = field(default_factory=list)
    ouvintes: set[asyncio.Queue[Evento]] = field(default_factory=set)
    texto: list[str] = field(default_factory=list)
    passos: int = 0
    sequencia: int = 0
    terminal: bool = False
    tarefa: asyncio.Task[None] | None = None

    # ------------------------------------------------------------- leitura

    def estado(self) -> dict[str, Any]:
        return {
            "sessao": self.id,
            "conversa": self.conversa,
            "origem": self.origem,
            "rodando": self.rodando,
            "iniciada_em": self.iniciada,
            "terminada_em": self.terminada,
            "motivo": self.motivo,
            "texto": "".join(self.texto)[-4000:],
            "passos": self.passos,
            "ultimo": self.sequencia,
        }

    # ------------------------------------------------------------- escrita

    def publicar(self, nome: str, dados: dict[str, Any]) -> None:
        self.sequencia += 1
        dados = {**dados, "seq": self.sequencia}
        bruto = sse(nome, dados)
        evento = Evento(seq=self.sequencia, nome=nome, dados=dados, bruto=bruto)
        self.eventos.append(evento)
        if len(self.eventos) > MAX_EVENTOS:
            del self.eventos[: len(self.eventos) - MAX_EVENTOS]
        if nome == "delta":
            self.texto.append(str(dados.get("text") or ""))
        elif nome == "text_replace":
            self.texto = [str(dados.get("text") or "")]
        elif nome in ("start", "done"):
            conversa = dados.get("conversation_id")
            if isinstance(conversa, str) and conversa:
                self.conversa = conversa
        elif nome == "tool_call":
            self.passos += 1
        if nome in ("done", "error"):
            self.terminal = True
        for fila in list(self.ouvintes):
            fila.put_nowait(evento)

    async def assinar(self, desde: int = 0) -> AsyncIterator[str]:
        """Repete o diário a partir de `desde` e segue ao vivo até o terminal.

        A inscrição e a leitura do diário acontecem sem `await` no meio: no mesmo
        laço de eventos, nenhum evento pode escapar entre as duas.
        """
        fila: asyncio.Queue[Evento] = asyncio.Queue()
        self.ouvintes.add(fila)
        try:
            pendentes = [evento for evento in self.eventos if evento.seq > desde]
            for evento in pendentes:
                yield evento.bruto
            if not self.rodando:
                return
            while True:
                try:
                    evento = await asyncio.wait_for(fila.get(), timeout=SINAL_DE_VIDA_S)
                except asyncio.TimeoutError:
                    yield ":sinal-de-vida\n\n"
                    continue
                yield evento.bruto
                if evento.nome in ("done", "error"):
                    return
        finally:
            self.ouvintes.discard(fila)


class GerenciadorAoVivo:
    """As rodadas deste processo, indexadas pela conversa."""

    def __init__(self) -> None:
        self.sessoes: dict[str, SessaoAoVivo] = {}

    # ------------------------------------------------------------- consulta

    def listar(self, rodando: bool | None = None) -> list[SessaoAoVivo]:
        sessoes = sorted(self.sessoes.values(), key=lambda item: item.iniciada)
        if rodando is None:
            return sessoes
        return [item for item in sessoes if item.rodando is rodando]

    def por_conversa(self, conversa: str) -> SessaoAoVivo | None:
        for sessao in reversed(self.sessoes.values()):
            if sessao.conversa == conversa:
                return sessao
        return None

    def por_id(self, sessao: str) -> SessaoAoVivo | None:
        return self.sessoes.get(sessao)

    # ------------------------------------------------------------- início

    def iniciar(
        self,
        *,
        conversa: str | None,
        origem: str,
        dono: str,
        gerador: AsyncIterator[str],
    ) -> SessaoAoVivo:
        sessao = SessaoAoVivo(conversa=conversa, origem=origem, dono=dono)
        self.sessoes[sessao.id] = sessao
        sessao.tarefa = asyncio.create_task(
            self._rodar(sessao, gerador), name=f"koda-live-{sessao.id}"
        )
        return sessao

    async def _rodar(self, sessao: SessaoAoVivo, gerador: AsyncIterator[str]) -> None:
        try:
            async for bruto in gerador:
                lido = _ler_bloco(bruto)
                if lido is None:
                    continue
                sessao.publicar(*lido)
        except asyncio.CancelledError:
            sessao.motivo = "stopped"
            # O `finally` do produtor grava o que já saiu. Não relançar: a tarefa é
            # destacada, e quem pediu o Parar está esperando o desfecho, não o erro.
        except Exception as erro:  # noqa: BLE001 — a sessão precisa de um fim legível
            _log.error("live_failed conversa=%s tipo=%s", sessao.conversa, type(erro).__name__)
            sessao.motivo = "internal_error"
            if not sessao.terminal:
                sessao.publicar(
                    "delta",
                    {
                        "text": (
                            "\n\nUma falha interna interrompeu esta rodada. "
                            "Confira o que já foi executado antes de retomar."
                        )
                    },
                )
        finally:
            if not sessao.terminal:
                # Fechou sem `done`: o cliente precisa de um estado terminal para
                # sair de «Trabalhando…» e mostrar o cartão de tarefa interrompida.
                sessao.publicar(
                    "done",
                    {
                        "conversation_id": sessao.conversa or "",
                        "message_id": "",
                        "elapsed_ms": int((time.time() - sessao.iniciada) * 1000),
                        "steps": sessao.passos,
                        "completed": False,
                        "reason": sessao.motivo or "interrupted",
                        "pending_items": [],
                        "executed": 0,
                        "resumable": True,
                        "tokens": None,
                        "usage": {},
                    },
                )
            sessao.rodando = False
            sessao.terminada = time.time()
            asyncio.create_task(self._limpar_depois(sessao))

    async def _limpar_depois(self, sessao: SessaoAoVivo) -> None:
        await asyncio.sleep(RETENCAO_S)
        if self.sessoes.get(sessao.id) is sessao:
            self.sessoes.pop(sessao.id, None)

    # ------------------------------------------------------------- parada

    async def parar(
        self, *, conversa: str | None = None, sessao: str | None = None
    ) -> SessaoAoVivo | None:
        alvo = self.por_id(sessao) if sessao else (
            self.por_conversa(conversa) if conversa else None
        )
        if alvo is None or not alvo.rodando:
            return alvo
        alvo.motivo = "stopped"
        if alvo.tarefa is not None and not alvo.tarefa.done():
            alvo.tarefa.cancel()
            try:
                await asyncio.wait_for(alvo.tarefa, timeout=6.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass
        return alvo
