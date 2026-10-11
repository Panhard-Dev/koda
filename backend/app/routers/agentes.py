"""GET/POST/DELETE /api/agents — os sub-agentes, do jeito que a seção Agentes usa.

A definição mora em `app/subagentes.py` (infraestrutura de raiz), que lê e escreve o
`subs.agentes.md` ao lado do banco. Esta rota é a porta HTTP dela: listar, salvar e apagar.

Salvar com um nome que já existe **substitui** aquele agente — é editar, e não duplicar. A
tela manda a lista inteira de skills e MCPs de cada um, então o que não veio na lista fica
fora: o poder do agente é o que está escrito, nunca o que sobrou de antes.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from ..config import Settings
from ..schemas import AgenteInfo, AgenteInput
from ..subagentes import SubAgente, esquecer, listar, salvar

router = APIRouter(tags=["agents"])


def _info(agente: SubAgente) -> AgenteInfo:
    return AgenteInfo(
        nome=agente.nome,
        prompt=agente.prompt,
        skills=list(agente.skills),
        mcps=list(agente.mcps),
        modelo=agente.modelo,
    )


@router.get("/agents", response_model=list[AgenteInfo])
async def agentes(request: Request) -> list[AgenteInfo]:
    """Os sub-agentes escritos no `subs.agentes.md`, na ordem do arquivo."""
    settings: Settings = request.app.state.settings
    return [_info(item) for item in listar(settings)]


@router.post("/agents", response_model=list[AgenteInfo], status_code=201)
async def salvar_agente(payload: AgenteInput, request: Request) -> list[AgenteInfo]:
    """Cria ou substitui um sub-agente pelo nome. Devolve a lista como ficou.

    O nome é recusado quando tem o que não pode ter num título de seção (`#`, quebra de
    linha): ele é o cabeçalho do arquivo, e um `##` dentro dele quebraria o arquivo inteiro.
    """
    settings: Settings = request.app.state.settings
    nome = payload.nome.strip()
    if not nome or any(marca in nome for marca in ("#", "\n", "\r")):
        raise HTTPException(
            status_code=400, detail="o nome do agente não pode ter «#» nem quebra de linha"
        )
    salvar(
        settings,
        SubAgente(
            nome=nome,
            prompt=payload.prompt.strip(),
            skills=[item.strip() for item in payload.skills if item.strip()],
            mcps=[item.strip() for item in payload.mcps if item.strip()],
            modelo=payload.modelo.strip(),
        ),
    )
    return [_info(item) for item in listar(settings)]


@router.delete("/agents/{nome}", response_model=list[AgenteInfo])
async def apagar_agente(nome: str, request: Request) -> list[AgenteInfo]:
    """Tira o sub-agente do arquivo. Devolve a lista como ficou.

    Não é erro apagar um que não existe: a tela pediu o estado final, e o estado final é o
    que ela recebe. Recusar obrigaria a tela a tratar um caso que não muda nada.
    """
    settings: Settings = request.app.state.settings
    esquecer(settings, nome)
    return [_info(item) for item in listar(settings)]
