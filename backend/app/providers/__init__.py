"""Escolha do provider a partir da configuração.

São **dois**, e não há um terceiro: o **host** com os modelos oficiais (o `gateway-local`,
OpenAI-compatible) e o **local**, que responde offline e sem ferramentas. O `auto` procura
nesta ordem: o host, se estiver respondendo, e o local se não estiver.

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
    "host_no_ar",
    "system_prompt",
]


def host_disponivel(settings: Settings, timeout: float = 3.0) -> bool:
    """O host com os modelos oficiais está no ar e aceita a credencial atual?

    O timeout já foi 0,6 s e era apertado demais: o `/v1/models` do serviço busca o catálogo
    na primeira chamada, e uma resposta um pouco mais lenta fazia o `auto`
    concluir que o serviço estava fora — caindo no provider `local`, que **não tem
    ferramentas**. O agente ficava sem tool calling sem nada avisar. Como isto roda uma
    vez, na subida, esperar alguns segundos é barato; escolher o provider errado não é.
    """
    url = f"{settings.host_url.rstrip('/')}/models"
    # O LizProxy exige a senha do dia inclusive em `/models`. Sem sessão, `host_key`
    # ainda é uma credencial de serviço legada: apresentá-la aqui faria 401 e a subida
    # esperaria 90 s por um host que não pode autorizar ninguém até o login.
    chave = host_auth.credencial(settings)
    from .. import host_dinamica

    if not host_dinamica.vigente(settings) and not host_auth.atual():
        return False
    cabecalhos = {"Authorization": f"Bearer {chave}"} if chave else None
    try:
        resposta = httpx.get(url, timeout=timeout, headers=cabecalhos)
    except httpx.HTTPError:
        return False
    return resposta.status_code < 400


def host_no_ar(settings: Settings, timeout: float = 1.0) -> bool:
    """O serviço local está ouvindo, mesmo antes de haver uma credencial de conta?

    Um 401 do LizProxy antes do login é esperado: a senha do dia só chega depois de
    `POST /api/host/sessao`. Sondar somente a porta/TCP diz se o host subiu, sem
    ficar martelando `/models` com uma credencial que se sabe inválida.
    """
    try:
        resposta = httpx.get(
            f"{settings.host_url.rstrip('/')}/models", timeout=timeout
        )
    except httpx.HTTPError:
        return False
    return resposta.status_code < 500


#: O upstream pode recusar a primeira conexão por DNS/TLS intermitente ou
#: publicar um 502 momentâneo. Uma repetição curta, antes de qualquer delta,
#: resolve a oscilação sem duplicar texto nem exigir que a pessoa reenvie.
TENTATIVAS_DE_REDE = 2
ESPERA_DE_REDE_S = 0.4

#: O que a pessoa lê quando o teto do minuto pega. Diz o número, diz que é do app inteiro e
#: diz o que fazer — as três coisas que faltariam numa mensagem só de erro.
MSG_DO_TETO = (
    "Teto de {n} requisições por minuto atingido. O teto é do Koda inteiro: conta todos os "
    "chats abertos e cada sub-agente lançado. Espere um pouco e mande de novo — nada do que "
    "você escreveu foi perdido."
)


def _motivo_da_rede(erro: ProviderError) -> str:
    """Erro de upstream depois das retentativas: diz a causa sem expor segredos."""
    return (
        "Não foi possível falar com os servidores do Liz AI Studio agora. "
        "O Koda tentou novamente; confira a conexão com a internet, DNS, "
        "firewall, proxy/VPN e o relógio do computador. "
        f"Detalhe técnico: {str(erro)[:220]}"
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
        #: Última vez que esta instância perguntou se o host voltou (ver `_promover`).
        self._ultima_promocao = 0.0

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
        o backend pode abrir o `gateway-local`. A espera curta também cobre o tempo em que
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

            # A mesma paciência da subida: um gateway que acabou de ser reaberto pode
            # levar dezenas de segundos até publicar o catálogo. Doze segundos davam por
            # encerrada uma recuperação que estava a caminho, e o passo morria à toa.
            for _ in range(120):
                # A porta pode ter mudado enquanto o gateway reiniciava.
                settings.host_url = provedor.base_url
                if await asyncio.to_thread(host_disponivel, settings, 2.0):
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

    async def _promover(self) -> None:
        """Troca o `local` pelo host quando ele aparece **depois** da subida.

        A escolha do provider acontece uma vez, na abertura. Se o gateway ainda não estava
        pronto naquele instante, o app ficava no `local` — sem ferramentas — até alguém
        reiniciar, mesmo com o host no ar segundos depois. Aqui a primeira conversa (ou o
        primeiro passo do agente) já encontra o host: a pergunta é barata, roda fora do
        event loop e tem espera entre tentativas para não virar uma sonda por passo.

        Só vale para `auto`: com `KODA_PROVIDER=local` a escolha é explícita e não se mexe.
        """
        provedor = self._provider
        if not isinstance(provedor, LocalProvider):
            return
        if provedor.settings.provider != "auto":
            return
        agora = time.monotonic()
        if agora - self._ultima_promocao < 10.0:
            return
        self._ultima_promocao = agora
        if await asyncio.to_thread(host_disponivel, provedor.settings, 2.0):
            self._provider = HostProvider(provedor.settings)

    async def _renovar_credencial(self) -> bool:
        """Renova a senha do dia após um 401 do LizProxy.

        A virada da meia-noite UTC acontece sem o usuário sair da conta. O
        `headers()` do host relê a credencial a cada pedido; basta gravar o
        JSON novo para a repetição já sair autorizada. O throttle da busca no
        painel impede rajadas, e o mesmo pedido é repetido no máximo uma vez.
        """
        # `asyncio.to_thread` não herda ContextVar. Sem levar a janela que fez o
        # pedido, a renovação lia a sessão global (geralmente vazia) e não
        # conseguia buscar a senha nova no painel depois da virada UTC.
        janela = host_auth.contexto_atual().window
        contexto = host_auth.capturar(janela)

        def renovar() -> bool:
            settings = getattr(self._provider, "settings", None)
            if settings is None:
                return False
            ficha = host_auth.vincular(contexto)
            try:
                token = host_auth.atual()
                host_dinamica._cache.clear()
                for _ in range(3):
                    if token:
                        host_dinamica.atualizar(settings, token)
                    if host_dinamica.vigente(settings):
                        return True
                    if not token:
                        break
                    time.sleep(0.3)
                return False
            finally:
                host_auth.desvincular(ficha)

        return await asyncio.to_thread(renovar)

    async def _repetir_stream(
        self, turns: list[ChatTurn], options: ChatOptions
    ) -> AsyncIterator[Piece]:
        if not options.model.startswith('provedor:'):
            await self._promover()
        await self._esperar_vez()
        try:
            async for pedaco in self._provider.stream(turns, options):
                yield pedaco
        except ProviderError as erro:
            if not ("respondeu 401" in str(erro) or "provedor respondeu 401" in str(erro)):
                if isinstance(erro, TransientProviderError) and "respondeu 502" in str(erro):
                    for tentativa in range(TENTATIVAS_DE_REDE):
                        await asyncio.sleep(ESPERA_DE_REDE_S * (tentativa + 1))
                        try:
                            # Nenhum delta saiu antes do 502: refazer aqui não
                            # duplica resposta na tela.
                            async for pedaco in self._provider.stream(turns, options):
                                yield pedaco
                            return
                        except TransientProviderError as repetido:
                            erro = repetido
                    raise ProviderError(_motivo_da_rede(erro)) from erro
                raise
            if not await self._renovar_credencial():
                raise ProviderError("a credencial diária do Koda expirou — entre novamente na conta") from erro
            # Nenhum delta saiu antes do erro: a chamada pode ser refeita sem
            # duplicar resposta na tela.
            async for pedaco in self._provider.stream(turns, options):
                yield pedaco

    async def stream(
        self, turns: list[ChatTurn], options: ChatOptions
    ) -> AsyncIterator[Piece]:
        async for pedaco in self._repetir_stream(turns, options):
            yield pedaco

    async def step(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]], model: str = ""
    ) -> Any:
        if not model.startswith('provedor:'):
            await self._promover()
        await self._esperar_vez()
        try:
            return await self._provider.step(messages, tools, model)
        except ProviderError as erro:
            if not ("respondeu 401" in str(erro) or "provedor respondeu 401" in str(erro)):
                if isinstance(erro, TransientProviderError) and "respondeu 502" in str(erro):
                    for tentativa in range(TENTATIVAS_DE_REDE):
                        await asyncio.sleep(ESPERA_DE_REDE_S * (tentativa + 1))
                        try:
                            return await self._provider.step(messages, tools, model)
                        except TransientProviderError as repetido:
                            erro = repetido
                    raise ProviderError(_motivo_da_rede(erro)) from erro
                raise
            if not await self._renovar_credencial():
                raise ProviderError("a credencial diária do Koda expirou — entre novamente na conta") from erro
            return await self._provider.step(messages, tools, model)


def build_provider(settings: Settings) -> Provider:
    """O provedor desta execução, já atrás do teto de requisições."""
    # A senha dinâmica do dia, se estiver faltando ou expirada, é buscada aqui
    # (com espera entre tentativas): assim o app que acabou de abrir já conversa
    # com o host pela credencial que sobrevive a uma queda do painel.
    host_dinamica.garantir(settings)
    if settings.provider == "local":
        return ComTeto(LocalProvider(settings))
    if not host_boot.dono_e_o_shell():
        host_boot.subir(settings)
    if settings.provider == "host":
        return ComTeto(HostProvider(settings))
    if host_disponivel(settings):
        return ComTeto(HostProvider(settings))
    # Antes de alguém entrar, o LizProxy responde 401 porque ainda não recebeu a senha
    # do dia. Isso não é host quebrado: o serviço está de pé e o login reescolhe o
    # provider. Ficar até 90 s repetindo uma sonda sempre não autorizada só travava a
    # abertura do app. O provider local continua disponível para a tela, sem ferramentas,
    # até `POST /api/host/sessao` promovê-lo ao host.
    if not host_auth.atual() and not host_dinamica.vigente(settings):
        if host_no_ar(settings):
            return ComTeto(LocalProvider(settings))
    # O host não respondeu. Antes de aceitar o local — que não tem ferramentas —, tenta
    # **reerguer** o serviço de modelos. É o que dá ao «Reconectando» o poder de reabrir o
    # host: a tela insiste, a reescolha acontece, e o processo volta ao ar sozinho. No app
    # instalado quem cuida disso é o vigia do shell, e aí esta tentativa nem acontece (ver
    # `host_boot.dono_e_o_shell`).
    if host_boot.subir(settings):
        # Um gateway recém-aberto pode levar dezenas de segundos até publicar o catálogo.
        # Só vale esperar por uma resposta autorizada quando já existe credencial para ela.
        if host_auth.atual() or host_dinamica.vigente(settings):
            limite = time.monotonic() + host_boot.ESPERA_DO_GATEWAY_S
            while time.monotonic() < limite:
                if host_disponivel(settings, timeout=2.0):
                    return ComTeto(HostProvider(settings))
                if not host_boot.processo_vivo():
                    break
                time.sleep(0.5)
    return ComTeto(LocalProvider(settings))
