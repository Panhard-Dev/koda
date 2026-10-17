"""GET/POST /api/store/mcps — a aba MCPs da Store.

Quatro rotas, uma por passo do caminho que o dono descreveu:

* `GET    /api/store/mcps`                 — o catálogo, com o estado de cada conector;
* `POST   /api/store/mcps/{slug}/baixar`  — grava desligado e pré-baixa o pacote;
* `POST   /api/store/mcps/{slug}/entrar`  — começa o login do provedor e devolve a URL;
* `GET    /api/store/mcps/{slug}/entrar`  — o estado desse login;
* `POST   /api/store/mcps/{slug}/ativar`  — liga o servidor.

**Baixar não é ativar.** O servidor entra em `mcps.json` com `enabled: false`; nada sobe, nada
conecta. É o que faz «Baixar» ser um passo e não um atalho para ligar um processo de terceiro
que a pessoa ainda não autorizou.

**Ativar é o único passo que reconecta.** É ele que faz o servidor aparecer em *Ajustes →
MCPs* e no submenu do cabeçalho — e é o mesmo caminho de sempre (`mcp.recarregar()` +
`preparar()`), então o conector novo não tem tratamento próprio em lugar nenhum.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.concurrency import run_in_threadpool

from .. import mcp, store_mcp
from ..config import Settings
from ..nuvem import ServicoNuvem

router = APIRouter(tags=["store"])


async def _conector(request: Request, slug: str) -> dict:
    """O conector do catálogo por `slug`. 404 quando ele não existe no catálogo de agora.

    Lê o catálogo quando o cache ainda está vazio, em vez de exigir um `GET` antes: os passos
    de baixar/entrar/ativar são alcançáveis direto por URL, e um 404 só porque a tela não
    listou primeiro seria um erro que ninguém na interface conseguiria explicar.
    """
    itens, origem = request.app.state.catalogo_store
    if not itens:
        itens, origem = await store_mcp.catalogo(request.app.state.nuvem)
        request.app.state.catalogo_store = (itens, origem)
    achado = next((item for item in itens if item["slug"] == slug), None)
    if achado is None:
        raise HTTPException(status_code=404, detail="conector não está no catálogo")
    return achado


@router.get("/store/mcps")
async def listar(request: Request) -> dict:
    """O catálogo com o estado de cada conector nesta máquina."""
    itens, origem = await store_mcp.catalogo(request.app.state.nuvem)
    request.app.state.catalogo_store = (itens, origem)
    return {
        "origem": origem,
        "conectores": store_mcp.estado_dos_conectores(itens, mcp.status()),
    }


@router.post("/store/mcps/{slug}/baixar")
async def baixar(slug: str, request: Request) -> dict:
    """Grava o servidor desligado e começa o download do pacote em segundo plano.

    Não espera o `npm` — a tela acompanha por `GET /api/store/mcps/{slug}/baixar`. O servidor
    fica registrado de qualquer forma: recusar o cadastro porque o npm não estava no PATH
    deixaria a pessoa sem o conector num passo em que ela só pediu para baixar.
    """
    settings: Settings = request.app.state.settings
    conector = await _conector(request, slug)
    return store_mcp.iniciar_baixa(slug, conector, settings)


@router.get("/store/mcps/{slug}/baixar")
async def estado_da_baixa(slug: str) -> dict:
    """O estado do download em curso (`baixando`, `pronto`, `erro` ou `nenhum`)."""
    return store_mcp.estado_baixa(slug)


@router.post("/store/mcps/{slug}/entrar")
async def entrar(slug: str, request: Request) -> dict:
    """Começa o login do provedor e devolve o estado (com a URL, quando ela aparecer)."""
    settings: Settings = request.app.state.settings
    conector = await _conector(request, slug)
    return store_mcp.iniciar_login(slug, conector, settings)


@router.get("/store/mcps/{slug}/entrar")
async def estado_do_login(slug: str) -> dict:
    """O estado do login em curso. `nenhum` quando não há login para este conector."""
    return store_mcp.estado_login(slug)


@router.post("/store/mcps/{slug}/ativar")
async def ativar(slug: str, request: Request) -> dict:
    """Liga o servidor e reconecta — é o que o faz aparecer na área MCP."""
    settings: Settings = request.app.state.settings
    await _conector(request, slug)
    if not store_mcp.ativar(slug, settings):
        raise HTTPException(status_code=404, detail="baixe o conector antes de ativar")
    await run_in_threadpool(_reconectar)
    estado = next((item for item in mcp.status() if item["name"] == slug), None)
    return {
        "ok": True,
        "ativo": True,
        "conectado": bool((estado or {}).get("conectado")),
        "erro": (estado or {}).get("erro"),
        "ferramentas": int((estado or {}).get("ferramentas") or 0),
    }


def _reconectar() -> None:
    """Derruba as conexões velhas e reconecta — em thread, porque subir processo bloqueia."""
    mcp.recarregar()
    mcp.preparar()
