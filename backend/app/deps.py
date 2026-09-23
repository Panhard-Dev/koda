"""Acesso ao estado da aplicação e ponte entre o mundo async e o SQLite."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any, TypeVar

from fastapi import Request

from .db import Database
from .providers import Provider

T = TypeVar("T")


def database(request: Request) -> Database:
    return request.app.state.db


def provider(request: Request) -> Provider:
    return request.app.state.provider


async def call(func: Callable[..., T], *args: Any) -> T:
    """Roda uma função do repositório fora do event loop (SQLite é síncrono)."""
    return await asyncio.to_thread(func, *args)
