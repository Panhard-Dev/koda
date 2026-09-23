"""Escolha do provider a partir da configuração.

`auto` procura nesta ordem: OpenAI (se houver chave), o host local (se estiver
respondendo) e, por fim, o provider local — que responde sem depender de nada.
"""

from __future__ import annotations

import httpx

from ..config import Settings
from .base import (
    ChatOptions,
    ChatTurn,
    Provider,
    ProviderError,
    TransientProviderError,
    system_prompt,
)
from .local import LocalProvider
from .openai_compat import GeminiProxyProvider, OpenAICompatibleProvider

__all__ = [
    "ChatOptions",
    "ChatTurn",
    "GeminiProxyProvider",
    "LocalProvider",
    "OpenAICompatibleProvider",
    "Provider",
    "ProviderError",
    "TransientProviderError",
    "build_provider",
    "proxy_disponivel",
    "system_prompt",
]


def proxy_disponivel(settings: Settings, timeout: float = 3.0) -> bool:
    """O host local está no ar? Uma pergunta só, com timeout generoso.

    O timeout já foi 0,6 s e era apertado demais: o `/v1/models` do host busca o catálogo
    do upstream na primeira chamada, e uma resposta um pouco mais lenta fazia o `auto`
    concluir que o host estava fora — caindo no provider `local`, que **não tem
    ferramentas**. O agente ficava sem tool calling sem nada avisar. Como isto roda uma
    vez, na subida, esperar alguns segundos é barato; escolher o provider errado não é.
    """
    url = f"{settings.gemini_proxy_url.rstrip('/')}/models"
    try:
        resposta = httpx.get(url, timeout=timeout)
    except httpx.HTTPError:
        return False
    return resposta.status_code < 400


def build_provider(settings: Settings) -> Provider:
    if settings.provider == "local":
        return LocalProvider(settings)
    if settings.provider == "gemini":
        return GeminiProxyProvider(settings)
    if settings.provider == "openai" or settings.openai_api_key:
        return OpenAICompatibleProvider(settings)
    if proxy_disponivel(settings):
        return GeminiProxyProvider(settings)
    return LocalProvider(settings)
