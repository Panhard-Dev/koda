"""`GET /api/transfer/<id>` — entrega o arquivo que o Koda preparou para o celular.

O id é a credencial: 128 bits aleatórios, criados pela ferramenta `send_to_phone` e
enviados só no evento `transfer` da conversa do celular. O conteúdo não é servido
estaticamente; fora deste caminho, o store não aparece em rota nenhuma.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from .. import transferencias

router = APIRouter(tags=["transferencias"])


@router.get("/transfer/{item_id}")
async def baixar(item_id: str, request: Request) -> FileResponse:
    item = await asyncio.to_thread(transferencias.buscar, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="essa transferência não existe mais")
    return FileResponse(
        item.caminho,
        media_type=item.mime,
        filename=item.nome,
        headers={"cache-control": "no-store"},
    )
