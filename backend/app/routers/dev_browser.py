"""GET /api/dev-browser — a sessão do navegador que a IA está dirigindo, e o último quadro.

O MCP `koda-dev-browser` (em `mcp/dev-browser/`) sobe um Chrome/Edge **já instalado** e dirige
a página por CDP. Enquanto trabalha, ele publica dois arquivos ao lado do banco:

- `dev-browser.json` — vivo, porta, url, título, quando atualizou;
- `dev-browser.png` — o último quadro.

Estes endpoints só entregam isso para o Painel Dev, e existem por um motivo específico: o
painel **não** tem navegador próprio para essa sessão. Um `<iframe>` não consegue ler nem
clicar em página de outra origem — e `localhost:3000` é outra origem de `localhost:5174`. Então
quem mostra é o quadro que o MCP publica: é a **mesma** sessão que a IA está dirigindo, e não
uma segunda instância que mostraria outra coisa.

Os dois arquivos ficam ao lado do banco (`data/`), o mesmo lugar do `mcps.json` e das skills
cadastradas — nada de pasta nova para o dono procurar.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, Response

from ..config import Settings

router = APIRouter(tags=["dev-browser"])

#: Depois disto sem atualização, a sessão é dada como morta. O MCP publica a cada ~0,9 s, então
#: 6 s é folga larga — e sem esta validade o painel mostraria um quadro velho como se estivesse
#: ao vivo, que é pior do que não mostrar nada.
VALIDADE_S = 6.0


def _pasta(settings: Settings) -> Path:
    return settings.database_path.parent


def _estado(settings: Settings) -> dict:
    """O `dev-browser.json` interpretado — e `vivo: false` quando ele não vale mais."""
    arquivo = _pasta(settings) / "dev-browser.json"
    if not arquivo.is_file():
        return {"vivo": False, "motivo": "nenhuma sessão de navegador foi aberta ainda"}
    try:
        dados = json.loads(arquivo.read_text("utf-8"))
    except (OSError, ValueError):
        return {"vivo": False, "motivo": "o estado da sessão está ilegível"}

    atualizado = float(dados.get("atualizado") or 0)
    idade_s = time.time() - atualizado / 1000 if atualizado else None
    vivo = bool(dados.get("vivo")) and idade_s is not None and idade_s <= VALIDADE_S
    rolagem = dados.get("rolagem")
    return {
        "vivo": vivo,
        "porta": dados.get("porta"),
        "url": dados.get("url"),
        "titulo": dados.get("titulo"),
        # Onde a página está rolada. O painel é outra instância do navegador e carrega a página
        # do zero: sem isto, ele fica sempre no topo enquanto a IA lê lá embaixo.
        "rolagem": rolagem if isinstance(rolagem, dict) else None,
        "idade_s": round(idade_s, 1) if idade_s is not None else None,
        "motivo": None if vivo else "a sessão parou de publicar",
    }


@router.get("/dev-browser")
async def sessao(request: Request) -> dict:
    """O estado da sessão do navegador. `vivo: false` quando não há nenhuma."""
    settings: Settings = request.app.state.settings
    return _estado(settings)


@router.get("/dev-browser/tela")
async def tela(request: Request) -> Response:
    """O último quadro publicado, em PNG.

    `no-store` é obrigatório: o painel pede este endereço repetidamente para acompanhar a
    sessão, e com cache ele ficaria preso no primeiro quadro para sempre.
    """
    settings: Settings = request.app.state.settings
    arquivo = _pasta(settings) / "dev-browser.png"
    if not arquivo.is_file():
        return Response(status_code=404, content="nenhum quadro publicado ainda")
    return FileResponse(
        arquivo,
        media_type="image/png",
        headers={"Cache-Control": "no-store, max-age=0"},
    )
