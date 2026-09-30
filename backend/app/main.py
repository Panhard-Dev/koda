"""Aplicação FastAPI do Koda.

`uv run uvicorn app.main:app --reload --port 8787` e pronto: sem `.env` o provider local
responde e o banco nasce em `backend/data/koda.db`.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

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

#: Hosts aceitos no cabeçalho `Host`. O app desktop (Tauri/WebView2) usa `tauri.localhost`;
#: o dev usa `localhost`/`127.0.0.1`; o IPv6 de loopback entra pela forma `[::1]`; e o
#: cliente de teste do FastAPI se apresenta como `testserver`.
HOSTS_LOCAIS = frozenset(
    {
        "localhost",
        "127.0.0.1",
        "::1",
        "[::1]",
        "tauri.localhost",
        "0.0.0.0",
        "testserver",
    }
)


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
        # Tetos do `shell`, separados como manda a configuração: teto total do processo,
        # tempo sem saída que caracteriza travamento, e intervalo de acompanhamento.
        ferramentas.definir_limites(
            timeout=config.comando_timeout_s,
            inatividade=config.comando_inatividade_s,
            olhada=config.comando_olhada_s,
        )
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
            # Derruba **todo** processo que ficou rodando. Sem isto um `npm run dev` (ou
            # qualquer filho) sobrevivia ao fechamento do Koda, segurando porta e CPU, e
            # ninguém mais tinha como achá-lo — o registro era só um dict no processo.
            ferramentas.encerrar_tudo()
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

    @app.middleware("http")
    async def _so_host_local(request: Request, call_next):  # type: ignore[no-untyped-def]
        """Recusa pedido cujo `Host` não é local.

        O backend escuta em localhost e **não** tem autenticação — quem alcança a porta
        alcança o `/api/chat`, e por ele o `shell`. O CORS já barra o navegador, mas ele não
        cobre cliente que não manda `Origin` nem o ataque de **DNS rebinding**: uma página
        maliciosa que resolve `evil.com` para `127.0.0.1` chega com `Host: evil.com`. Exigir
        que o `Host` seja local fecha essa porta sem mexer em quem usa o app de verdade.
        """
        host = (request.headers.get("host") or "").split(":")[0].strip().lower()
        if host and host not in HOSTS_LOCAIS:
            return JSONResponse(
                status_code=403,
                content={"detail": "o backend do Koda só aceita conexões locais"},
            )
        return await call_next(request)

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
