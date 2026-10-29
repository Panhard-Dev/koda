"""Escolha do provider a partir da configuração.

São **dois**, e não há um terceiro: o **host** com os modelos oficiais (o `c-host.exe`) e o
**local**, que responde offline e sem ferramentas. O `auto` procura nesta ordem: o host, se
estiver respondendo, e o local se não estiver.

Não existe provider de terceiro. Havia um caminho OpenAI-compatible, escolhido por uma
`OPENAI_API_KEY` que estivesse no ambiente — inclusive a de outro programa —, e era ele que
fazia o seletor oferecer os modelos da casa a um serviço que não os tem.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator
from typing import Any

import httpx

from .. import host_auth, host_dinamica
from ..config import Settings
from ..limits import LIMITE_DE_REQUISICOES, TetoAtingido
from . import host_boot
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
    "ComTeto",
    "HostProvider",
    "LocalProvider",
    "OpenAICompatibleProvider",
    "Provider",
    "ProviderError",
    "TransientProviderError",
    "build_provider",
    "conteudo_do_turno",
    "host_boot",
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

    def desembrulhar(self) -> Provider:
        """O provedor de dentro, sem o teto na frente.

        Quem precisa saber **que tipo** de provedor está no ar usa isto, e não uma
        checagem de tipo no invólucro: `isinstance` não passa pelo `__getattr__`, então
        perguntar `isinstance(engine, HostProvider)` a um `ComTeto` responderia sempre
        «não» mesmo com o host no ar — foi assim que o `GET /api/models` devolvia lista
        vazia e o seletor caía na lista da casa.
        """
        return self._provider

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

    async def reconectar(self, erro: BaseException) -> bool:
        """Reergue o host em erro de rede para a próxima tentativa do mesmo passo.

        No app instalado, o vigia do shell é quem sobe o processo; em desenvolvimento,
        o backend pode abrir o `c-host` local. A espera curta também cobre o tempo em que
        o vigia instalado nota a queda. Erros HTTP como 429/500 não iniciam outro host.
        """
        provedor = self._provider
        if isinstance(provedor, HostProvider):
            causa: BaseException | None = erro
            while causa is not None and not isinstance(causa, httpx.HTTPError):
                causa = causa.__cause__ or causa.__context__
            if causa is None:
                return False

            settings = provedor.settings
            if not host_boot.dono_e_o_shell():
                await asyncio.to_thread(host_boot.subir, settings)

            for _ in range(24):
                if await asyncio.to_thread(host_disponivel, settings, 0.5):
                    return True
                await asyncio.sleep(0.5)
            return False

        # O host podia já estar fora quando o chat começou, fazendo `auto` escolher o
        # provider local. A tarefa continua viva; tenta trocar a implementação assim que
        # o mesmo processo subir, sem exigir que a pessoa reenvie a mensagem.
        if isinstance(provedor, LocalProvider) and provedor.settings.provider == "auto":
            escolhido = await asyncio.to_thread(build_provider, provedor.settings)
            if escolhido.name != "local":
                self._provider = escolhido.desembrulhar()
                return True
        return False

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
    # A senha dinâmica do dia, se estiver faltando ou expirada, é buscada aqui
    # (com espera entre tentativas): assim o app que acabou de abrir já conversa
    # com o host pela credencial que sobrevive a uma queda do painel.
    host_dinamica.garantir(settings)
    if settings.provider == "local":
        return ComTeto(LocalProvider(settings))
    if settings.provider == "host":
        return ComTeto(HostProvider(settings))
    if host_disponivel(settings):
        return ComTeto(HostProvider(settings))
    # O host não respondeu. Antes de aceitar o local — que não tem ferramentas —, tenta
    # **reerguer** o serviço de modelos. É o que dá ao «Reconectando» o poder de reabrir o
    # host: a tela insiste, a reescolha acontece, e o processo volta ao ar sozinho. No app
    # instalado quem cuida disso é o vigia do shell, e aí esta tentativa nem acontece (ver
    # `host_boot.dono_e_o_shell`).
    if host_boot.subir(settings):
        # O binário leva cerca de um segundo para abrir a porta: espera curta e em pedaços,
        # para não segurar a resposta da tela por causa de um host que não vem.
        for _ in range(8):
            if host_disponivel(settings, timeout=0.5):
                return ComTeto(HostProvider(settings))
            time.sleep(0.35)
    return ComTeto(LocalProvider(settings))
