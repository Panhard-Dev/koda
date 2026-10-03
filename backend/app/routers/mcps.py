"""GET/POST /api/mcps — servidores MCP configurados, do jeito que o submenu MCPs usa.

O Koda ainda não conversa com servidores MCP de verdade — não há cliente nem chamada de
ferramenta externa. A lista vem de `backend/data/mcps.json` (uma lista de
`{name, description, command, params, enabled}`); o arquivo não nasce com o projeto, então
sem ele a rota devolve lista vazia e a interface mostra o estado vazio. O cadastro da tela
grava nesse mesmo arquivo, e é ele que o cliente MCP vai consumir quando existir.
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

from ..config import Settings
from ..schemas import McpCreate, McpInfo

router = APIRouter(tags=["mcps"])


def caminho_config(settings: Settings) -> Path:
    """Onde ficam os servidores MCP configurados, ao lado do banco."""
    return settings.database_path.parent / "mcps.json"


def ler_config(caminho: Path) -> list[McpInfo]:
    """Arquivo ausente ou ilegível = nenhum servidor configurado."""
    return [_info(item) for item in _brutos(caminho)]


def _info(item: dict) -> McpInfo:
    """Um item do arquivo -> `McpInfo`. Campos novos são opcionais, para o arquivo antigo
    (que só tinha nome e descrição) continuar valendo."""
    return McpInfo(
        name=str(item["name"]),
        description=str(item.get("description", "")),
        command=str(item.get("command", "")),
        params=str(item.get("params", "")),
        enabled=bool(item.get("enabled", True)),
    )


@router.get("/mcps", response_model=list[McpInfo])
async def mcps(request: Request) -> list[McpInfo]:
    """Lista os servidores MCP configurados, na ordem do arquivo."""
    settings: Settings = request.app.state.settings
    return ler_config(caminho_config(settings))


@router.post("/mcps", response_model=McpInfo, status_code=201)
async def cadastrar_mcp(payload: McpCreate, request: Request) -> McpInfo:
    """Cadastra um servidor MCP (nome, comando/endpoint e parâmetros) e devolve ele pronto.

    Recusa nome já usado com 409: sobrescrever calado trocaria a configuração de um servidor
    de verdade sem aviso. Nome e comando vazios são barrados no schema (`McpCreate`), que
    responde 422.
    """
    settings: Settings = request.app.state.settings
    caminho = caminho_config(settings)
    brutos = _brutos(caminho)
    if any(str(item.get("name", "")).casefold() == payload.name.casefold() for item in brutos):
        raise HTTPException(
            status_code=409, detail=f'já existe um servidor MCP chamado "{payload.name}"'
        )

    novo = {
        "name": payload.name,
        "description": payload.description,
        "command": payload.command,
        "params": payload.params,
        "enabled": True,
    }
    _salvar(caminho, [*brutos, novo])
    return _info(novo)


@router.post("/mcps/{name}/toggle", response_model=McpInfo)
async def alternar_mcp(name: str, request: Request) -> McpInfo:
    """Liga/desliga um servidor MCP e regrava o arquivo de configuração."""
    settings: Settings = request.app.state.settings
    caminho = caminho_config(settings)
    configurados = ler_config(caminho)
    servidor = next((item for item in configurados if item.name == name), None)
    if servidor is None:
        raise HTTPException(status_code=404, detail="servidor MCP não encontrado")

    # Regrava preservando a ordem e os campos extras que o arquivo tiver.
    brutos = _brutos(caminho)
    for item in brutos:
        if str(item.get("name")) == name:
            item["enabled"] = not servidor.enabled
    _salvar(caminho, brutos)
    return McpInfo(
        name=servidor.name,
        description=servidor.description,
        command=servidor.command,
        params=servidor.params,
        enabled=not servidor.enabled,
    )


def _brutos(caminho: Path) -> list[dict]:
    """Os itens crus do arquivo. Sem nome, o item é descartado — listar assim mesmo daria
    um servidor que não dá para ligar nem desligar."""
    try:
        dados = json.loads(caminho.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(dados, list):
        return []
    return [
        item
        for item in dados
        if isinstance(item, dict) and str(item.get("name", "")).strip()
    ]


def _salvar(caminho: Path, itens: list[dict]) -> None:
    caminho.parent.mkdir(parents=True, exist_ok=True)
    caminho.write_text(json.dumps(itens, ensure_ascii=False, indent=2), encoding="utf-8")
