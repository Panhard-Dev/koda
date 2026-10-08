"""Escolha do provider a partir da configuração.

São **dois**, e não há um terceiro: o **host** com os modelos oficiais (o `c-host.exe`) e o
**local**, que responde offline e sem ferramentas. O `auto` procura nesta ordem: o host, se
estiver respondendo, e o local se não estiver.

Não existe provider de terceiro. Havia um caminho OpenAI-compatible, escolhido por uma
`OPENAI_API_KEY` que estivesse no ambiente — inclusive a de outro programa —, e era ele que
fazia o seletor oferecer os modelos da casa a um serviço que não os tem.
"""

from __future__ import annotations

import httpx

from .. import host_auth
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
from .openai_compat import HostProvider, OpenAICompatibleProvider, conteudo_do_turno

__all__ = [
    "ChatOptions",
    "ChatTurn",
    "HostProvider",
    "LocalProvider",
    "OpenAICompatibleProvider",
    "Provider",
    "ProviderError",
    "TransientProviderError",
    "build_provider",
    "conteudo_do_turno",
    "host_disponivel",
    "system_prompt",
]


def host_disponivel(settings: Settings, timeout: float = 3.0) -> bool:
    """O host com os modelos oficiais está no ar? Uma pergunta só, com timeout generoso.

    O timeout já foi 0,6 s e era apertado demais: o `/v1/models` do serviço busca o catálogo
    na primeira chamada, e uma resposta um pouco mais lenta fazia o `auto`
    concluir que o serviço estava fora — caindo no provider `local`, que **não tem
    ferramentas**. O agente ficava sem tool calling sem nada avisar. Como isto roda uma
    vez, na subida, esperar alguns segundos é barato; escolher o provider errado não é.
    """
    url = f"{settings.host_url.rstrip('/')}/models"
    # O host com autorização remota responde 401 em `/models` para quem não manda credencial
    # — e 401 aqui viraria "host fora do ar", jogando o `auto` no provider local, que não
    # tem ferramentas. A credencial tem de ir nesta sonda igual vai na conversa.
    chave = host_auth.credencial(settings)
    cabecalhos = {"Authorization": f"Bearer {chave}"} if chave else None
    try:
        resposta = httpx.get(url, timeout=timeout, headers=cabecalhos)
    except httpx.HTTPError:
        return False
    return resposta.status_code < 400


def build_provider(settings: Settings) -> Provider:
    if settings.provider == "local":
        return LocalProvider(settings)
    if settings.provider == "host":
        return HostProvider(settings)
    if host_disponivel(settings):
        return HostProvider(settings)
    return LocalProvider(settings)
