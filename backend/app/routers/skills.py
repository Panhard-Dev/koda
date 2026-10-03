"""GET/POST /api/skills — skills instaladas e cadastradas, do jeito que a seção Skills usa.

A lógica de descoberta e leitura mora em `app/skills.py` (infraestrutura de raiz): a mesma
que a ferramenta `use_skill` usa para carregar as instruções. Esta rota é a porta HTTP dela —
listar, cadastrar e ligar/desligar.

Nome repetido: projeto vence global. Skill cadastrada não aceita nome já usado — cadastrar
de novo com o mesmo nome é recusado com 409, em vez de sobrescrever em silêncio.

Ligada/desligada: skill nasce **ligada**; o estado fica em `data/skills-state.json` (só os
desvios do padrão) e sobrevive a reinícios. Desligada, ela continua na lista da interface,
mas sai do prompt do agente.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from ..config import Settings
from ..schemas import SkillCreate, SkillInfo
from ..skills import (
    Skill,
    caminho_cadastradas,
    caminho_estado,
    indice_para_agente,
    ler_cadastradas,
    ler_estado,
    listar,
    salvar_cadastradas,
    salvar_estado,
)

router = APIRouter(tags=["skills"])

__all__ = ["router", "indice_para_agente"]


def _info(skill: Skill, workspace) -> SkillInfo:
    if skill.file is None:
        caminho = ""
    else:
        try:
            caminho = str(skill.file.relative_to(workspace)).replace("\\", "/")
        except ValueError:
            caminho = str(skill.file)
    return SkillInfo(
        name=skill.name,
        description=skill.description,
        scope=skill.scope,
        path=caminho,
        enabled=skill.enabled,
    )


@router.get("/skills", response_model=list[SkillInfo])
async def skills(request: Request) -> list[SkillInfo]:
    """Lista as skills instaladas e cadastradas (cadastradas primeiro) para a tela."""
    settings: Settings = request.app.state.settings
    estado = ler_estado(caminho_estado(settings))
    return [
        _info(skill, settings.workspace_path)
        for skill in listar(
            settings.workspace_path, estado, ler_cadastradas(caminho_cadastradas(settings))
        )
    ]


@router.post("/skills", response_model=SkillInfo, status_code=201)
async def cadastrar_skill(payload: SkillCreate, request: Request) -> SkillInfo:
    """Cadastra uma skill nova (nome, descrição e ação) e devolve ela pronta.

    Recusa nome já usado por outra skill (instalada ou cadastrada) com 409: sobrescrever
    calado apagaria uma skill de verdade sem aviso. O resto da validação de campo vazio
    fica no schema (`SkillCreate`), que responde 422.
    """
    settings: Settings = request.app.state.settings
    caminho = caminho_cadastradas(settings)
    estado = ler_estado(caminho_estado(settings))
    existentes = {
        skill.name.casefold()
        for skill in listar(settings.workspace_path, estado, ler_cadastradas(caminho))
    }
    if payload.name.casefold() in existentes:
        raise HTTPException(status_code=409, detail=f'já existe uma skill chamada "{payload.name}"')

    itens = ler_cadastradas(caminho)
    itens.append(
        {"name": payload.name, "description": payload.description, "action": payload.action}
    )
    salvar_cadastradas(caminho, itens)

    return SkillInfo(
        name=payload.name,
        description=payload.description,
        scope="cadastrada",
        path="",
        enabled=estado.get(payload.name, True),
    )


@router.post("/skills/{name}/toggle", response_model=SkillInfo)
async def alternar_skill(name: str, request: Request) -> SkillInfo:
    """Liga/desliga uma skill e guarda o estado ao lado do banco."""
    settings: Settings = request.app.state.settings
    caminho = caminho_estado(settings)
    estado = ler_estado(caminho)
    skill = next(
        (
            item
            for item in listar(
                settings.workspace_path, estado, ler_cadastradas(caminho_cadastradas(settings))
            )
            if item.name == name
        ),
        None,
    )
    if skill is None:
        raise HTTPException(status_code=404, detail="skill não encontrada")
    estado[name] = not estado.get(name, True)
    salvar_estado(caminho, estado)
    # O objeto veio de antes da virada: ele precisa refletir o estado novo.
    skill.enabled = estado[name]
    return _info(skill, settings.workspace_path)
