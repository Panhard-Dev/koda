"""Aplicação FastAPI do Koda.

`uv run uvicorn app.main:app --reload --port 8787` e pronto: sem `.env` o provider local
responde e o banco nasce em `backend/data/koda.db`.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .config import Settings, get_settings
from .db import Database
from .providers import build_provider
from .routers import account, chat, conversations, models, usage
from .schemas import Health
from .tools import ferramentas


def create_app(settings: Settings | None = None) -> FastAPI:
    config = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        database = Database(config.database_path)
        database.initialize()
        app.state.settings = config
        app.state.db = database
        app.state.provider = build_provider(config)
        yield

    app = FastAPI(
        title="Koda API",
        version=__version__,
        summary="Chat com streaming, histórico e uso em SQLite",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(chat.router, prefix="/api")
    app.include_router(models.router, prefix="/api")
    app.include_router(conversations.router, prefix="/api")
    app.include_router(usage.router, prefix="/api")
    app.include_router(account.router, prefix="/api")

    @app.get("/api/health", response_model=Health, tags=["system"])
    async def health() -> Health:
        """O front chama isso ao carregar para saber se há backend de pé."""
        engine = app.state.provider
        return Health(
            provider=engine.name,
            provider_ready=engine.ready,
            # Sem provedor externo não existe "modelo": quem responde é o servidor.
            model=getattr(engine, "model", "local"),
            database=str(config.database_path),
            version=__version__,
            workspace=str(config.workspace_path),
            tools_ready=hasattr(engine, "step"),
            tools=[item["function"]["name"] for item in ferramentas.catalogo(config.tools_negadas)],
        )

    @app.get("/", include_in_schema=False)
    async def index() -> dict[str, object]:
        return {
            "app": "Koda API",
            "version": __version__,
            "docs": "/docs",
            "routes": [
                "GET    /api/health",
                "GET    /api/models",
                "POST   /api/chat            (text/event-stream)",
                "GET    /api/conversations",
                "POST   /api/conversations",
                "GET    /api/conversations/{id}",
                "DELETE /api/conversations/{id}",
                "GET    /api/usage?tz_offset_minutes=",
                "GET    /api/account",
                "PATCH  /api/account",
                "POST   /api/account/sign-out",
            ],
        }

    return app


app = create_app()
