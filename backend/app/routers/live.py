"""As rotas do modo ao vivo: ver, acompanhar e parar uma rodada de qualquer tela.

A rodada é a mesma para o PC e para o celular. `GET /api/live` diz o que está
acontecendo agora; `GET /api/live/{conversa}/eventos` entrega o diário e segue
ao vivo; `POST /api/live/parar` encerra de verdade — fechar a aba não encerra.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..live import GerenciadorAoVivo
from .chat import SSE_HEADERS

router = APIRouter(tags=["live"])


def _gerenciador(request: Request) -> GerenciadorAoVivo:
    gerenciador = getattr(request.app.state, "live", None)
    if gerenciador is None:
        gerenciador = request.app.state.live = GerenciadorAoVivo()
    return gerenciador


class PararPedido(BaseModel):
    conversa: str | None = None
    sessao: str | None = None


@router.get("/live")
async def listar(request: Request, rodando: bool | None = None) -> dict[str, Any]:
    sessoes = _gerenciador(request).listar(rodando=rodando)
    return {"sessoes": [sessao.estado() for sessao in sessoes]}


@router.post("/live/parar")
async def parar(payload: PararPedido, request: Request) -> dict[str, Any]:
    sessao = await _gerenciador(request).parar(
        conversa=payload.conversa, sessao=payload.sessao
    )
    if sessao is None:
        raise HTTPException(404, "não há rodada ao vivo para parar")
    return {"ok": True, "sessao": sessao.estado()}


@router.get("/live/{conversa}")
async def estado(conversa: str, request: Request) -> dict[str, Any]:
    sessao = _gerenciador(request).por_conversa(conversa)
    if sessao is None:
        raise HTTPException(404, "essa conversa não tem rodada ao vivo")
    return sessao.estado()


@router.get("/live/{conversa}/eventos", response_model=None)
async def eventos(
    conversa: str, request: Request, desde: int = 0
) -> StreamingResponse:
    sessao = _gerenciador(request).por_conversa(conversa)
    if sessao is None:
        raise HTTPException(404, "essa conversa não tem rodada ao vivo")
    return StreamingResponse(
        sessao.assinar(max(0, desde)),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )
