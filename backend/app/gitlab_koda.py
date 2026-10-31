"""Acesso direto à API de conversa do GitLab Duo para contas já configuradas."""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from typing import Any

import httpx

from .koda_tool_protocol import _chamadas, _sse
from .providers.base import ProviderError, TransientProviderError


URL = "https://gitlab.com/api/v4/chat/completions"


def _prompt(mensagens: list[dict[str, Any]], tools: list[dict[str, Any]], nonce: str = "") -> str:
    partes = []
    if tools:
        if not nonce:
            raise ProviderError("identificador de ferramentas inválido")
        funcoes = [item.get("function") or item for item in tools]
        partes.append(
            'Quando precisar usar uma ferramenta, responda somente com tags '
            f'<koda_tool>{{"name":"nome","arguments":{{}},"nonce":"{nonce}"}}</koda_tool> com nomes e '
            'argumentos da lista; caso contrário responda normalmente. Ferramentas: '
            + json.dumps(funcoes, ensure_ascii=False)
        )
    for mensagem in mensagens:
        conteudo = mensagem.get("content")
        if isinstance(conteudo, list):
            if any(isinstance(item, dict) and item.get("type") == "image_url" for item in conteudo):
                raise ProviderError("a API de conversa GitLab não aceita imagens nesta integração")
            conteudo = "\n".join(str(item.get("text") or "") for item in conteudo if isinstance(item, dict) and item.get("type") == "text")
        if not isinstance(conteudo, str):
            conteudo = ""
        if mensagem.get("tool_calls"):
            conteudo += "\nChamadas anteriores: " + json.dumps(mensagem["tool_calls"], ensure_ascii=False)
        if conteudo.strip():
            partes.append(f"[{mensagem.get('role') or 'user'}]\n{conteudo}")
    if not partes:
        raise ProviderError("a pergunta para o GitLab está vazia")
    prompt = "\n\n".join(partes)
    if len(prompt) > 150000:
        raise ProviderError("o contexto é grande demais para a conversa GitLab")
    return prompt


async def linhas(conta: dict[str, Any], mensagens: list[dict[str, Any]], tools: list[dict[str, Any]]) -> AsyncIterator[str]:
    token = str(conta.get("access") or "").strip()
    if not token or "\r" in token or "\n" in token:
        raise ProviderError("a conta GitLab não tem um token de acesso válido")
    nonce = uuid.uuid4().hex if tools else ""
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=20.0), follow_redirects=False) as cliente:
            resposta = await cliente.post(URL, headers={"authorization": f"Bearer {token}"},
                                          json={"content": _prompt(mensagens, tools, nonce), "with_clean_history": True})
    except httpx.HTTPError as erro:
        raise TransientProviderError(f"não consegui falar com o GitLab: {erro}") from erro
    if resposta.status_code == 429:
        raise TransientProviderError("a conta GitLab está sem cota agora")
    if resposta.status_code >= 400:
        raise ProviderError(f"GitLab recusou a conversa (HTTP {resposta.status_code}); a API exige acesso ao Duo")
    try:
        texto = resposta.json()
    except ValueError as erro:
        raise ProviderError("GitLab devolveu uma resposta inválida") from erro
    if not isinstance(texto, str) or not texto.strip():
        raise ProviderError("GitLab encerrou a conversa sem texto")
    chamadas = _chamadas(texto, tools, nonce)
    if chamadas:
        yield _sse({"tool_calls": [{"index": i, **chamada} for i, chamada in enumerate(chamadas)]})
    else:
        yield _sse({"content": texto})
    yield _sse(motivo="tool_calls" if chamadas else "stop")
    yield "data: [DONE]"
