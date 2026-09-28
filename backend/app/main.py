"""Aplicação FastAPI do Koda.

`uv run uvicorn app.main:app --reload --port 8787` e pronto: sem `.env` o provider local
responde e o banco nasce em `backend/data/koda.db`.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .config import Settings, get_settings
from .db import Database
from .instalador import Baixador
from .nuvem import ServicoNuvem
from .providers import build_provider
from .routers import (
    account,
    chat,
    conversations,
    host,
    mcps,
    models,
    nuvem,
    projects,
    skills,
    usage,
)
from .schemas import CloudEstado, Health
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
        # Permissões esperando resposta da tela, por id. Vive no processo: é o mesmo
        # processo que está rodando o loop da mensagem que pediu.
        app.state.aprovacoes = {}
        # A nuvem nunca segura a subida: a consulta é opcional e roda fora do caminho
        # crítico, num task que morre junto com o app.
        servico = ServicoNuvem(config)
        app.state.nuvem = servico
        # O download do instalador roda aqui no processo local: é ele que escreve na pasta
        # de downloads do usuário (a interface nunca escreve em disco).
        maquina = Baixador(config)
        app.state.baixador = maquina
        tarefa: asyncio.Task[None] | None = None
        if config.cloud_check_on_start and servico.cliente.ativo:
            tarefa = asyncio.create_task(servico.verificar())
        try:
            yield
        finally:
            maquina.cancelar()
            if tarefa is not None:
                tarefa.cancel()
                with suppress(asyncio.CancelledError):
                    await tarefa

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
    app.include_router(skills.router, prefix="/api")
    app.include_router(mcps.router, prefix="/api")
    app.include_router(nuvem.router, prefix="/api")
    app.include_router(projects.router, prefix="/api")
    app.include_router(host.router, prefix="/api")

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
            contexto_tokens=config.contexto_tokens,
            cloud=_cloud(app),
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
                "GET    /api/skills",
                "POST   /api/skills/{name}/toggle",
                "GET    /api/mcps",
                "POST   /api/mcps/{name}/toggle",
                "GET    /api/cloud/update",
                "GET    /api/cloud/changelog",
                "GET    /api/cloud/download",
                "POST   /api/cloud/download",
                "POST   /api/host/sessao",
                "DELETE /api/host/sessao",
            ],
        }

    return app


def _cloud(app: FastAPI) -> CloudEstado:
    """Estado da nuvem para o health, já no formato curto que a interface lê."""
    servico: ServicoNuvem = app.state.nuvem
    estado = servico.estado
    atualizacao = estado.atualizacao
    return CloudEstado(
        ativo=estado.ativo,
        disponivel=estado.disponivel,
        canal=estado.canal,
        update_available=bool(atualizacao and atualizacao.update_available),
        latest_version=atualizacao.latest_version if atualizacao else None,
        download_url=atualizacao.download_url if atualizacao else None,
        servico=servico.cliente.host,
    )


app = create_app()
