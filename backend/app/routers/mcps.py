"""GET/POST /api/mcps — servidores MCP configurados, do jeito que o submenu MCPs usa.

Um servidor MCP é um processo que publica **ferramentas** — a outra metade da diferença com
as skills, que são instruções. A configuração vive em `data/mcps.json`
(`{name, description, command, params, enabled}`), e quem a consome é o gerenciador
(`app/mcp/`): ele sobe o processo, faz o handshake, lista as ferramentas e as entrega ao
agente.

**A lista devolve estado, não só configuração.** Cada servidor vem com `conectado`, `erro` e
`ferramentas` — os números de agora. Um comando errado aparece como `conectado: false` com o
que o servidor escreveu no `stderr`, em vez de parecer um servidor funcionando.

**A conexão é reaberta quando a configuração muda.** Cadastrar ou ligar/desligar chama
`mcp.recarregar()` e espera a nova tentativa (em thread): sem isso, a tela mostraria o
servidor novo como "ligado" e o agente continuaria sem as ferramentas dele até o app
reiniciar.
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.concurrency import run_in_threadpool

from .. import mcp
from ..config import Settings
from ..schemas import McpCreate, McpInfo

router = APIRouter(tags=["mcps"])


def caminho_config(settings: Settings) -> Path:
    """Onde ficam os servidores MCP configurados, ao lado do banco."""
    return settings.database_path.parent / "mcps.json"


def _estado_por_nome() -> dict[str, dict]:
    """O que o gerenciador sabe de cada servidor agora (`conectado`, `erro`, `ferramentas`)."""
    return {item["name"]: item for item in mcp.status()}


def _info(item: dict, estado: dict[str, dict] | None = None) -> McpInfo:
    """Um item do arquivo -> `McpInfo`. Campos novos são opcionais, para o arquivo antigo
    (que só tinha nome e descrição) continuar valendo."""
    nome = str(item["name"])
    vivo = (estado or {}).get(nome, {})
    return McpInfo(
        name=nome,
        description=str(item.get("description", "")),
        command=str(item.get("command", "")),
        params=str(item.get("params", "")),
        enabled=bool(item.get("enabled", True)),
        conectado=bool(vivo.get("conectado", False)),
        erro=vivo.get("erro"),
        ferramentas=int(vivo.get("ferramentas", 0) or 0),
    )


@router.get("/mcps", response_model=list[McpInfo])
async def mcps(request: Request) -> list[McpInfo]:
    """Lista os servidores MCP configurados, na ordem do arquivo, com o estado de agora."""
    settings: Settings = request.app.state.settings
    estado = _estado_por_nome()
    return [_info(item, estado) for item in _brutos(caminho_config(settings))]


@router.post("/mcps", response_model=McpInfo, status_code=201)
async def cadastrar_mcp(payload: McpCreate, request: Request) -> McpInfo:
    """Cadastra um servidor MCP (nome, comando/endpoint e parâmetros) e devolve ele pronto.

    Recusa nome já usado com 409: sobrescrever calado trocaria a configuração de um servidor
    de verdade sem aviso. Nome e comando vazios são barrados no schema (`McpCreate`), que
    responde 422.

    Depois de gravar, **tenta conectar** — o retorno já diz se o servidor subiu e quantas
    ferramentas publicou. Um servidor que não sobe continua cadastrado, com o motivo em
    `erro`; recusar o cadastro por causa de um comando que talvez seja corrigido depois
    seria pior.
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
    await _reconectar()
    return _info(novo, _estado_por_nome())


@router.post("/mcps/{name}/toggle", response_model=McpInfo)
async def alternar_mcp(name: str, request: Request) -> McpInfo:
    """Liga/desliga um servidor MCP e regrava o arquivo de configuração.

    Desligar **derruba** a conexão: as ferramentas dele saem do catálogo da próxima rodada.
    Ligar sobe de novo — e a resposta diz se subiu.
    """
    settings: Settings = request.app.state.settings
    caminho = caminho_config(settings)
    configurados = [_info(item) for item in _brutos(caminho)]
    servidor = next((item for item in configurados if item.name == name), None)
    if servidor is None:
        raise HTTPException(status_code=404, detail="servidor MCP não encontrado")

    # Regrava preservando a ordem e os campos extras que o arquivo tiver.
    brutos = _brutos(caminho)
    for item in brutos:
        if str(item.get("name")) == name:
            item["enabled"] = not servidor.enabled
    _salvar(caminho, brutos)
    await _reconectar()
    atual = next((item for item in _brutos(caminho) if str(item.get("name")) == name), None)
    if atual is None:  # pragma: no cover — o arquivo acabou de ser gravado com este item
        raise HTTPException(status_code=404, detail="servidor MCP não encontrado")
    return _info(atual, _estado_por_nome())


async def _reconectar() -> None:
    """Derruba as conexões velhas e reconecta — em thread, porque subir processo bloqueia."""
    mcp.recarregar()
    await run_in_threadpool(mcp.preparar)


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
