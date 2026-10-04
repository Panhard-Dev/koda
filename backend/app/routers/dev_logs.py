"""GET /api/dev-logs — os erros que o MCP `koda-dev-logs` consolidou, para a aba **Logs**.

O MCP `koda-dev-logs` (em `mcp/dev-logs/`) junta duas fontes: o feed de erros que o
`koda-dev-browser` publica (`dev-browser-logs.json`) e o log do servidor do alvo. Enquanto
trabalha, ele publica o resultado em `data/dev-logs.json` — já sem repetição, com contador por
assinatura e severidade.

Este endpoint só entrega esse arquivo. Existe pelo mesmo motivo do `dev-browser.py`: o painel
não fala MCP, e a lista de erros tem de aparecer na tela **enquanto** a IA diagnostica, não só
quando ela pergunta.

O arquivo fica ao lado do banco (`data/`), o mesmo lugar do `mcps.json` — nada de pasta nova.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from fastapi import APIRouter, Request

from ..config import Settings

router = APIRouter(tags=["dev-logs"])

#: Depois disto sem atualização, a lista é dada como parada. O MCP publica a cada 2 s, então 8 s
#: é folga larga — e sem esta validade o painel mostraria uma lista velha como se fosse a de
#: agora, que é pior do que dizer que parou.
VALIDADE_S = 8.0


def _pasta(settings: Settings) -> Path:
    return settings.database_path.parent


@router.get("/dev-logs")
async def logs(request: Request) -> dict:
    """Os erros consolidados. `vivo: false` quando o MCP de logs não está publicando."""
    settings: Settings = request.app.state.settings
    arquivo = _pasta(settings) / "dev-logs.json"
    if not arquivo.is_file():
        return {"vivo": False, "motivo": "o MCP de logs ainda não publicou nada", "erros": []}
    try:
        dados = json.loads(arquivo.read_text("utf-8"))
    except (OSError, ValueError):
        return {"vivo": False, "motivo": "a lista de logs está ilegível", "erros": []}

    atualizado = float(dados.get("atualizado") or 0)
    idade_s = time.time() - atualizado / 1000 if atualizado else None
    vivo = idade_s is not None and idade_s <= VALIDADE_S
    return {
        "vivo": vivo,
        "idade_s": round(idade_s, 1) if idade_s is not None else None,
        "fontes": dados.get("fontes") or {},
        "resumo": dados.get("resumo") or {},
        "erros": dados.get("erros") if isinstance(dados.get("erros"), list) else [],
        "motivo": None if vivo else "o MCP de logs parou de publicar",
    }
