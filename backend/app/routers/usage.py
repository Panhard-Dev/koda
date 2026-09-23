"""GET /api/usage — cotas diária, semanal e mensal e totais."""

from __future__ import annotations

import time

from fastapi import APIRouter, Request

from ..db import Database
from ..deps import call, database
from ..repository import usage as usage_for
from ..schemas import Usage

router = APIRouter(tags=["usage"])


def _usage(db: Database, tz_offset_minutes: int) -> Usage:
    with db.connect() as conn:
        return usage_for(conn, int(time.time() * 1000), tz_offset_minutes)


@router.get("/usage", response_model=Usage)
async def show(request: Request, tz_offset_minutes: int = 0) -> Usage:
    """`tz_offset_minutes` é o `Date.getTimezoneOffset()` do cliente, para a janela
    diária virar no relógio dele e não no do servidor."""
    return await call(_usage, database(request), tz_offset_minutes)
