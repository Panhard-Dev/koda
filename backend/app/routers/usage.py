"""GET /api/usage — cotas diária, semanal e mensal e totais."""

from __future__ import annotations

import time

from fastapi import APIRouter, Request

from ..db import Database
from ..deps import call, database
from ..repository import usage as usage_for
from ..schemas import Usage
from .. import host_auth

router = APIRouter(tags=["usage"])


def _usage(db: Database, tz_offset_minutes: int) -> Usage:
    """As cotas de **quem está logado**.

    A conta sai de `host_auth` — a mesma sessão que o backend já apresenta ao host. É o
    recorte que faz o gasto pertencer à conta: sem ele, trocar de conta no mesmo PC
    continuava mostrando o tempo e as moedas da anterior.
    """
    conta = host_auth.email_da_conta()
    with db.connect() as conn:
        return usage_for(conn, int(time.time() * 1000), tz_offset_minutes, conta)


@router.get("/usage", response_model=Usage)
async def show(request: Request, tz_offset_minutes: int = 0) -> Usage:
    """`tz_offset_minutes` é o `Date.getTimezoneOffset()` do cliente, para a janela
    diária virar no relógio dele e não no do servidor."""
    return await call(_usage, database(request), tz_offset_minutes)
