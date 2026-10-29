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

from fastapi import APIRouter, HTTPException, Request
import httpx

from .. import host_auth, host_dinamica
from ..deps import call, provider
from ..providers import build_provider
from ..schemas import HostSessao, HostSessaoEstado
from ..repository import vincular_legado_verificado

router = APIRouter(prefix="/host", tags=["host"])


def _vincular_legado(request: Request, account: dict) -> None:
    with request.app.state.db.connect() as conn:
        vincular_legado_verificado(conn, str(account["email"]).strip().casefold(),
                                  str(account["id"]), account.get("criada_em", ""))


async def _estado(request: Request) -> HostSessaoEstado:
    engine = provider(request)
    return HostSessaoEstado(
        autenticado=host_auth.atual() is not None,
        conta=host_auth.rotulo_da_conta(),
        provider=engine.name,
        provider_ready=engine.ready,
        # O agente só roda com modelo de verdade: o provider local **tem** `step` (que
        # falha com erro claro, em vez de derrubar o stream), mas não executa ferramenta
        # nenhuma. Quem responde a verdade, portanto, é o nome do provider — o `hasattr`
        # mentiria agora que o local também tem `step`.
        tools_ready=engine.name != "local",
    )


async def _reescolher(request: Request) -> HostSessaoEstado:
    """Reescolhe o provider com a credencial nova.

    Em thread porque a sonda do host é bloqueante (um `GET /models` com timeout de alguns
    segundos): no event loop isso travaria a resposta da própria tela.
    """
    providers = getattr(request.app.state, "providers", None)
    if providers is None:
        providers = request.app.state.providers = {}
    providers[host_auth.contexto_atual().window] = await call(build_provider, request.app.state.settings)
    return await _estado(request)


@router.post("/sessao", response_model=HostSessaoEstado)
async def definir_sessao(payload: HostSessao, request: Request) -> HostSessaoEstado:
    """Guarda a sessão da conta e reescolhe o provider.

    O front chama isto depois de entrar e a cada renovação (o token de acesso vence em
    minutos). Token vazio limpa a credencial — é o que acontece ao sair da conta —, e aí o
    nome e o e-mail vão embora com ela.

    É aqui também que a **senha dinâmica do dia** chega: com sessão válida, o backend
    busca a senha no painel e grava o JSON que o `c-host` lê. Sem sessão, o arquivo é
    apagado — a credencial dinâmica não sobrevive a quem sai da conta.
    """
    token = (payload.token or "").strip()
    settings = request.app.state.settings
    if token:
        if not settings.cloud_url:
            raise HTTPException(503, "serviço de identidade indisponível")
        try:
            async with httpx.AsyncClient(timeout=settings.cloud_timeout_s, follow_redirects=False) as client:
                response = await client.get(settings.cloud_url.rstrip("/") + "/api/account/me",
                                            headers={"Authorization": f"Bearer {token}"})
            if response.status_code != 200:
                raise HTTPException(401, "sessão não validada")
            account = response.json()["conta"]
            email = str(account["email"]).strip().casefold()
            if not email or not account.get("id"):
                raise ValueError("identidade incompleta")
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            raise HTTPException(503, "não foi possível validar a sessão") from exc
        host_auth.definir(token, nome=account.get("nome"), email=email, account_id=str(account["id"]))
        await call(_vincular_legado, request, account)
        # A senha do dia não pode travar a escolha do provider: se o painel
        # não entregar agora, a sessão continua valendo e a próxima renovação
        # tenta de novo.
        await call(host_dinamica.atualizar, settings, token)
    else:
        host_auth.limpar()
        await call(host_dinamica.esquecer, settings)
    return await _reescolher(request)


@router.delete("/sessao", response_model=HostSessaoEstado)
async def encerrar_sessao(request: Request) -> HostSessaoEstado:
    """Sai da sessão: o host volta a recusar, e o provider volta a ser o sem ferramentas."""
    host_auth.limpar()
    await call(host_dinamica.esquecer, request.app.state.settings)
    return await _reescolher(request)
