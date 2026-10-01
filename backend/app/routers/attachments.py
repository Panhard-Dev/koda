"""`POST /api/attachments` — recebe o arquivo que o usuário anexou na conversa.

A interface manda **multipart/form-data** com o `File` de verdade (não o nome). Aqui o
conteúdo é validado e gravado no store próprio — uma pasta ao lado do banco, **fora** do
workspace —, e o que volta é o `attachment_id` + nome + tipo + tamanho. É esse id que o
chat envia depois, e o que a ferramenta `read_attachment` usa para ler o conteúdo.

Nada é copiado para a pasta do projeto, e o store não é servido estaticamente: o único
caminho até o conteúdo é a ferramenta, por id.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, File, HTTPException, Request, UploadFile

from .. import anexos
from ..schemas import AttachmentInfo

router = APIRouter(tags=["attachments"])

#: Lemos no máximo o teto + 1 byte: o suficiente para o store recusar o que passa, sem
#: carregar um arquivo gigante inteiro na memória só para dizer que é grande demais.
_TETO_LEITURA = anexos.MAX_BYTES + 1


def _store(request: Request) -> anexos.AnexoStore:
    return anexos.AnexoStore(request.app.state.settings)


@router.post("/attachments")
async def criar(request: Request, arquivo: UploadFile = File(...)) -> AttachmentInfo:
    """Grava o anexo no store e devolve os metadados (o id é o que vale dali em diante)."""
    dados = await arquivo.read(_TETO_LEITURA)
    store = _store(request)
    try:
        anexo = await asyncio.to_thread(store.guardar, arquivo.filename or "arquivo", dados)
    except anexos.AnexoError as erro:
        raise HTTPException(status_code=422, detail=str(erro)) from erro
    return AttachmentInfo(id=anexo.id, nome=anexo.nome, tipo=anexo.mime, tamanho=anexo.tamanho)


@router.get("/attachments/{anexo_id}")
async def metadados(anexo_id: str, request: Request) -> AttachmentInfo:
    """Só os metadados — nunca o conteúdo. O conteúdo sai pela ferramenta, não por HTTP."""
    anexo = await asyncio.to_thread(_store(request).buscar, anexo_id)
    if anexo is None:
        raise HTTPException(status_code=404, detail="esse anexo não existe mais")
    return AttachmentInfo(id=anexo.id, nome=anexo.nome, tipo=anexo.mime, tamanho=anexo.tamanho)


@router.delete("/attachments/{anexo_id}")
async def remover(anexo_id: str, request: Request) -> dict[str, bool]:
    """Remove o anexo do store (o usuário tirou o chip antes de enviar)."""
    removido = await asyncio.to_thread(_store(request).remover, anexo_id)
    if not removido:
        raise HTTPException(status_code=404, detail="esse anexo não existe mais")
    return {"ok": True}
