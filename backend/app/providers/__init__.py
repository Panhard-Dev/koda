"""Escolha do provider a partir da configuração.

São **dois**, e não há um terceiro: o **host** com os modelos oficiais (o `c-host.exe`) e o
**local**, que responde offline e sem ferramentas. O `auto` procura nesta ordem: o host, se
estiver respondendo, e o local se não estiver.

Não existe provider de terceiro. Havia um caminho OpenAI-compatible, escolhido por uma
`OPENAI_API_KEY` que estivesse no ambiente — inclusive a de outro programa —, e era ele que
fazia o seletor oferecer os modelos da casa a um serviço que não os tem.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import httpx

from .. import host_auth
from ..config import Settings
from ..limits import LIMITE_DE_REQUISICOES, TetoAtingido
from .base import (
    Piece,
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


#: O que a pessoa lê quando o teto do minuto pega. Diz o número, diz que é do app inteiro e
#: diz o que fazer — as três coisas que faltariam numa mensagem só de erro.
MSG_DO_TETO = (
    "Teto de {n} requisições por minuto atingido. O teto é do Koda inteiro: conta todos os "
    "chats abertos e cada sub-agente lançado. Espere um pouco e mande de novo — nada do que "
    "você escreveu foi perdido."
)


class ComTeto:
    """O provedor de verdade, atrás do teto de requisições do **app**.

    O invólucro fica na **construção** do provedor, e não em cada caminho que o usa: se cada
    caminho tivesse o seu, o teto seria por caminho — e bastaria abrir outra conversa, ou
    lançar um sub-agente, para ter outro teto. Aqui passa tudo: o chat de baixo, os outros
    chats e cada sub-agente lançado.

    As duas portas do provedor são `stream` (a resposta avulsa) e `step` (o passo do agente);
    o resto dos atributos é repassado como está, porque quem os lê (`name`, `ready`,
    `resolve_model`) não fala com o serviço.
    """

    def __init__(self, provider: Provider) -> None:
        self._provider = provider

    def __getattr__(self, nome: str) -> Any:
        return getattr(self._provider, nome)

    async def _esperar_vez(self) -> None:
        """Pede a vaga no teto do app, traduzindo «cheio» na mensagem que a pessoa lê.

        `ProviderError` e **não** `TransientProviderError`: tentar de novo na hora bateria no
        mesmo teto, e a espera só cresceria. Quem decide quando tentar de novo é quem lê a
        mensagem — e ela diz quanto tempo falta.
        """
        try:
            await LIMITE_DE_REQUISICOES.esperar()
        except TetoAtingido as cheio:
            raise ProviderError(MSG_DO_TETO.format(n=cheio.por_minuto)) from cheio

    async def stream(
        self, turns: list[ChatTurn], options: ChatOptions
    ) -> AsyncIterator[Piece]:
        await self._esperar_vez()
        async for pedaco in self._provider.stream(turns, options):
            yield pedaco

    async def step(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]], model: str = ""
    ) -> Any:
        await self._esperar_vez()
        return await self._provider.step(messages, tools, model)


def build_provider(settings: Settings) -> Provider:
    """O provedor desta execução, já atrás do teto de requisições."""
    if settings.provider == "local":
        return ComTeto(LocalProvider(settings))
    if settings.provider == "host":
        return ComTeto(HostProvider(settings))
    if host_disponivel(settings):
        return ComTeto(HostProvider(settings))
    return ComTeto(LocalProvider(settings))
