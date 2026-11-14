"""GET/PUT /api/economia — os cinco modos de economia de tokens.

A tela manda **um modo por vez** (`{id, ligado}`), e não o objeto inteiro: dois cliques
rápidos em cartões diferentes não se sobrescrevem com um retrato velho da tela. A resposta
é sempre o estado inteiro como ficou, para a tela se corrigir sozinha se precisar.

O estado é lido pelo agente a cada rodada — não há cache para invalidar. Isso é de
propósito: um interruptor que só vale depois de reiniciar o app seria uma mentira na tela.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from .. import economia
from ..config import Settings

router = APIRouter(tags=["economia"])


class ModoDeEconomia(BaseModel):
    id: str
    ligado: bool
    nivel: str | None = None


@router.get("/economia")
async def ler(request: Request) -> dict[str, object]:
    """Os cinco modos, na ordem dos cartões, com o estado atual."""
    settings: Settings = request.app.state.settings
    return economia.para_api(settings)


@router.put("/economia")
async def alterar(payload: ModoDeEconomia, request: Request) -> dict[str, object]:
    """Liga/desliga um modo. Devolve o estado inteiro."""
    settings: Settings = request.app.state.settings
    try:
        economia.alterar(settings, payload.id, payload.ligado, payload.nivel)
    except KeyError as exc:
        raise HTTPException(404, f"modo de economia desconhecido: {payload.id}") from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return economia.para_api(settings)
