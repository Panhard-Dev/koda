"""Aplicação FastAPI do Koda.

`uv run uvicorn app.main:app --reload --port 8787` e pronto: sem `.env` o provider local
responde e o banco nasce em `backend/data/koda.db`.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import __version__, mcp, seguranca
from .config import Settings, get_settings
from .db import Database
from .instalador import Baixador
from .nuvem import ServicoNuvem
from .providers import build_provider
from .routers import (
    account,
    attachments,
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
from .schemas import CloudEstado, Health, HealthMinimo
from .tools import ferramentas
from .tools import registry

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
        # O token desta execução, antes de qualquer rota atender: do stdin (o launcher o
        # escreve ali), de `KODA_API_TOKEN` em dev, ou sorteado. Sem ele não existe rota
        # protegida que valha.
        seguranca.preparar()
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
        # Junto vão os tetos de saída — o mesmo número vale para o backend inteiro.
        ferramentas.definir_limites(
            timeout=config.comando_timeout_s,
            inatividade=config.comando_inatividade_s,
            olhada=config.comando_olhada_s,
            saida=config.tool_output_max_bytes,
            listagem=config.tool_output_max_lines,
            leitura=config.file_read_max_chars,
            linha=config.tool_output_max_line_length,
        )
        # A nuvem nunca segura a subida: a consulta é opcional e roda fora do caminho
        # crítico, num task que morre junto com o app.
        servico = ServicoNuvem(config)
        app.state.nuvem = servico
        # MCP: aponta o gerenciador para a configuração e sobe os servidores **numa thread**.
        # Subir processo e esperar o handshake bloqueia; a subida do app não pode depender
        # de um servidor de terceiros responder. Enquanto não conectarem, as ferramentas
        # deles simplesmente não aparecem na rodada — e o estado aparece em `/api/mcps`.
        mcp.configurar(config.database_path.parent / "mcps.json")
        threading.Thread(target=mcp.preparar, name="koda-mcp", daemon=True).start()
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
            # Os servidores MCP são processos: morrem junto com o app, para não ficarem
            # órfãos segurando porta e CPU.
            mcp.encerrar()
            if tarefa is not None:
                tarefa.cancel()
                with suppress(asyncio.CancelledError):
                    await tarefa

    # No app empacotado a documentação sai do ar: `/docs`, `/redoc` e `/openapi.json`
    # descrevem a API inteira — inclusive as rotas de permissão que o agente não deve nem
    # saber que existem — e não servem a ninguém na máquina do cliente. Em dev continuam,
    # que é onde elas ajudam.
    empacotado = seguranca.empacotado()
    app = FastAPI(
        title="Koda API",
        version=__version__,
        summary="Chat com streaming, histórico e uso em SQLite",
        lifespan=lifespan,
        docs_url=None if empacotado else "/docs",
        redoc_url=None if empacotado else "/redoc",
        openapi_url=None if empacotado else "/openapi.json",
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

    @app.middleware("http")
    async def _exigir_token(request: Request, call_next):  # type: ignore[no-untyped-def]
        """Exige o token da execução em tudo que é `/api` — **deny-by-default**.

        A checagem é por prefixo, e não por lista de rotas protegidas: rota nova nasce
        protegida, sem ninguém precisar lembrar de incluí-la aqui. As exceções estão em
        `seguranca.ROTAS_ABERTAS` e cada uma tem motivo escrito lá.

        O `OPTIONS` sai antes de tudo porque é o *preflight* do CORS: o navegador não manda
        `Authorization` nesse pedido, e recusá-lo derruba toda chamada do app — inclusive
        as legítimas.
        """
        if request.method != "OPTIONS" and not seguranca.liberada(request.url.path):
            if not seguranca.confere(request.headers.get("authorization")):
                return JSONResponse(
                    status_code=401,
                    content={"detail": "token da execução ausente ou inválido"},
                    headers={"WWW-Authenticate": "Bearer"},
                )
        return await call_next(request)

    app.include_router(chat.router, prefix="/api")
    app.include_router(attachments.router, prefix="/api")
    app.include_router(models.router, prefix="/api")
    app.include_router(conversations.router, prefix="/api")
    app.include_router(usage.router, prefix="/api")
    app.include_router(account.router, prefix="/api")
    app.include_router(skills.router, prefix="/api")
    app.include_router(mcps.router, prefix="/api")
    app.include_router(nuvem.router, prefix="/api")
    app.include_router(projects.router, prefix="/api")
    app.include_router(host.router, prefix="/api")

    @app.get("/api/handshake", tags=["system"])
    async def handshake(nonce: str = "") -> dict[str, str]:
        """Desafio do launcher: prove que este processo conhece o token, sem dizê-lo.

        Quem pergunta manda um nonce e confere o HMAC do lado de lá. Um backend de execução
        anterior não tem o token desta e não acerta — que é exatamente o que o launcher
        precisa saber para não adotar serviço alheio.
        """
        return {"hmac": seguranca.hmac_do_nonce(nonce)}

    @app.get("/api/health", response_model=HealthMinimo, tags=["system"])
    async def health() -> HealthMinimo:
        """Resposta mínima, **aberta**: existe alguém atendendo aqui?

        É o que o launcher bate para saber se o serviço subiu e o que a interface pergunta
        ao carregar. Nada de workspace, caminho de banco ou lista de ferramentas: quem quer
        o retrato completo pede `/api/health/detalhado`, que exige o token.
        """
        return HealthMinimo(version=__version__)

    @app.get("/api/health/detalhado", response_model=Health, tags=["system"])
    async def health_detalhado() -> Health:
        """O retrato completo do backend — só com o token da execução."""
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
            tools=[item["function"]["name"] for item in registry.catalogo(config.tools_negadas)],
            contexto_tokens=config.contexto_tokens,
            cloud=_cloud(app),
        )

    if not empacotado:

        @app.get("/", include_in_schema=False)
        async def index() -> dict[str, object]:
            return {
                "app": "Koda API",
                "version": __version__,
                "docs": "/docs",
                "routes": [
                    "GET    /api/health",
                    "GET    /api/health/detalhado",
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
