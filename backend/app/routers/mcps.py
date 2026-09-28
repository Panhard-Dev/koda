"""GET /api/mcps — servidores MCP configurados, do jeito que o submenu MCPs usa.

O Koda ainda não conversa com servidores MCP de verdade — não há cliente nem chamada
de ferramenta externa. A lista vem de `backend/data/mcps.json` (uma lista de
`{name, description, enabled}`); o arquivo não nasce com o projeto, então sem ele a
rota devolve lista vazia e a interface mostra o estado vazio. Quando o cliente MCP
existir, é essa lista que ele passa a consumir.
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

from ..config import Settings
from ..schemas import McpInfo

router = APIRouter(tags=["mcps"])


def caminho_config(settings: Settings) -> Path:
    """Onde ficam os servidores MCP configurados, ao lado do banco."""
    return settings.database_path.parent / "mcps.json"


def ler_config(caminho: Path) -> list[McpInfo]:
    """Arquivo ausente ou ilegível = nenhum servidor configurado."""
    try:
        dados = json.loads(caminho.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(dados, list):
        return []
    itens: list[McpInfo] = []
    for item in dados:
        if not isinstance(item, dict) or not str(item.get("name", "")).strip():
            continue
        itens.append(
            McpInfo(
                name=str(item["name"]),
                description=str(item.get("description", "")),
                enabled=bool(item.get("enabled", True)),
            )
        )
    return itens


@router.get("/mcps", response_model=list[McpInfo])
async def mcps(request: Request) -> list[McpInfo]:
    """Lista os servidores MCP configurados, na ordem do arquivo."""
    settings: Settings = request.app.state.settings
    return ler_config(caminho_config(settings))


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
        enabled=not servidor.enabled,
    )


def _brutos(caminho: Path) -> list[dict]:
    try:
        dados = json.loads(caminho.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [item for item in dados if isinstance(item, dict)] if isinstance(dados, list) else []


def _salvar(caminho: Path, itens: list[dict]) -> None:
    caminho.parent.mkdir(parents=True, exist_ok=True)
    caminho.write_text(json.dumps(itens, ensure_ascii=False, indent=2), encoding="utf-8")
