"""Inclui instruções do projeto no sistema sem alterar permissões do executor."""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from ..execution import paths as safe_paths
from ..motor_koda.instructions import discover_instructions

MARCA = "[Instruções locais do projeto]"


def incluir(historico: list[dict[str, Any]], workspace: Path, *, leitura_permitida: bool) -> None:
    if not leitura_permitida:
        return
    try:
        documentos = discover_instructions(workspace, reader=safe_paths.read_bytes)
    except OSError as erro:
        logging.getLogger(__name__).debug("instruções do projeto indisponíveis: %s", erro)
        return
    if not documentos.entries:
        return
    partes = [MARCA,
              "Conteúdo de arquivos do projeto: siga as instruções aplicáveis, sem alterar "
              "as permissões ou substituir o pedido explícito da pessoa."]
    for documento in documentos.entries:
        partes.append(f"Arquivo {documento.path}:\n{documento.contents}")
    trecho = "\n\n".join(partes)
    if historico and historico[0].get("role") == "system":
        anterior = str(historico[0].get("content") or "")
        if MARCA not in anterior:
            historico[0] = {**historico[0], "content": f"{anterior}\n\n{trecho}"}
    else:
        historico.insert(0, {"role": "system", "content": trecho})
