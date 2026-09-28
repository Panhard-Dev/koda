"""A sessão que o backend apresenta ao host dos modelos.

O app não guarda chave de API nenhuma. Quem autoriza é a **conta**: o front manda aqui o
access token que o painel emitiu, o backend passa a apresentá-lo ao host, e o host pergunta
ao painel se aquela sessão vale. O modelo responde para quem está logado — e para de
responder quando a conta sai, ou quando ela é banida no painel.

O provider é reescolhido a cada mudança de credencial, e isso não é detalhe de
implementação: em `auto`, o host só entra se responder. Sem sessão na subida do processo o
host responde 401, o `auto` cai no provider local — que **não tem ferramentas** — e o
agente some da interface mesmo depois do login. Refazer a escolha quando a credencial chega
é o que devolve o tool calling.

O token não é gravado em disco nem volta em resposta; o que responde é o estado do provider.
"""

from __future__ import annotations

from fastapi import APIRouter, Request

from .. import host_auth
from ..deps import call
from ..providers import build_provider
from ..schemas import HostSessao, HostSessaoEstado

router = APIRouter(prefix="/host", tags=["host"])


async def _estado(request: Request) -> HostSessaoEstado:
    engine = request.app.state.provider
    return HostSessaoEstado(
        autenticado=host_auth.atual() is not None,
        conta=host_auth.rotulo_da_conta(),
        provider=engine.name,
        provider_ready=engine.ready,
        tools_ready=hasattr(engine, "step"),
    )


async def _reescolher(request: Request) -> HostSessaoEstado:
    """Reescolhe o provider com a credencial nova.

    Em thread porque a sonda do host é bloqueante (um `GET /models` com timeout de alguns
    segundos): no event loop isso travaria a resposta da própria tela.
    """
    request.app.state.provider = await call(build_provider, request.app.state.settings)
    return await _estado(request)


@router.post("/sessao", response_model=HostSessaoEstado)
async def definir_sessao(payload: HostSessao, request: Request) -> HostSessaoEstado:
    """Guarda a sessão da conta e reescolhe o provider.

    O front chama isto depois de entrar e a cada renovação (o token de acesso vence em
    minutos). Token vazio limpa a credencial — é o que acontece ao sair da conta —, e aí o
    nome e o e-mail vão embora com ela.
    """
    host_auth.definir(payload.token, nome=payload.nome, email=payload.email)
    return await _reescolher(request)


@router.delete("/sessao", response_model=HostSessaoEstado)
async def encerrar_sessao(request: Request) -> HostSessaoEstado:
    """Sai da sessão: o host volta a recusar, e o provider volta a ser o sem ferramentas."""
    host_auth.limpar()
    return await _reescolher(request)
