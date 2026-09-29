"""Provider OpenAI-compatível: streaming para o texto e um passo com ferramentas.

Serve OpenAI, Groq, OpenRouter e o Ollama (`http://localhost:11434/v1`) — muda só a
`OPENAI_BASE_URL` e a chave. `HostProvider` herda daqui apontando para o serviço de
modelos oficial do projeto (o host em `host/c-host.exe`), que fala o mesmo protocolo.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Iterable
from typing import Any

import httpx

from .. import host_auth
from ..config import Settings
from ..identidade import FiltroIdentidade, limpar_identidade, pergunta_identidade
from ..tools.loop import StepResult, ToolCall
from .base import (
    ChatOptions,
    ChatTurn,
    Piece,
    ProviderError,
    TransientProviderError,
    system_prompt,
)

#: HTTP que vale a pena tentar de novo (cota, indisponibilidade temporária).
TRANSITORIOS = {408, 409, 425, 429, 500, 502, 503, 504}

#: O upstream do host devolve 404 no meio da conversa e o próximo passo costuma
#: funcionar — no projeto TOOLS original o 404 também entra na lista de retentativas.
TRANSITORIOS_PROXY = TRANSITORIOS | {404}

#: Prazo de **leitura** de uma chamada de modelo: dez minutos.
#:
#: Generoso de propósito. Com `stream: false` — e com o host repassando o que vem do serviço
#: — **não chega byte nenhum** enquanto o modelo não começa a responder. Um modelo de
#: raciocínio, com prompt grande e caminho lento até o serviço, ficava mais de 120 s calado, e
#: a chamada morria por timeout. Medido no print do dono, no outro PC: cinco tentativas
#: estourando o teto antigo de 120 s davam **508 s** até desistir — o print dizia **513 s**.
#: Não era queda de conexão: era o app cortando um modelo que ainda estava pensando.
#:
#: O `connect` continua curto: **não conseguir conectar** é outra coisa, e aí esperar dez
#: minutos não ajuda ninguém.
TEMPO_DE_LEITURA = 600.0
TIME_STREAM = httpx.Timeout(TEMPO_DE_LEITURA, connect=10.0)

#: Teto de tokens **de saída** em cada passo, mandado explícito no pedido.
#:
#: Existe por causa dos modelos de raciocínio: medido, o `liz-4` devolve **texto vazio** com
#: `max_tokens` 80 e 400 — o orçamento inteiro vai para o pensamento — e só fala a partir de
#: ~1000. Sem o campo, vale o padrão do gateway, e era isso que deixava `liz-4` e `layze-2`
#: calados a tarefa inteira. Oito mil é teto, não meta.
MAX_TOKENS_SAIDA = 8192


def _descrever_erro_de_rede(error: httpx.HTTPError) -> str:
    """Explica a falha sem expor URL, credenciais ou texto da requisicao."""
    nome = type(error).__name__
    if isinstance(error, httpx.ReadTimeout):
        return f"o provedor ficou {TIME_STREAM.read:g}s sem enviar dados ({nome})"
    if isinstance(error, httpx.ConnectTimeout):
        return f"a conexao com o provedor excedeu {TIME_STREAM.connect:g}s ({nome})"
    if isinstance(error, httpx.TimeoutException):
        return f"tempo de espera esgotado ({nome})"
    if isinstance(error, httpx.ConnectError):
        return f"nao foi possivel conectar ao servico do provedor ({nome})"
    if isinstance(error, httpx.ProtocolError):
        return f"a comunicacao HTTP com o provedor foi interrompida ({nome})"
    return f"erro de comunicacao com o provedor ({nome})"


def _texto_do_usuario(turno: Any) -> str:
    """O conteúdo do usuário, que chega ora como `ChatTurn`, ora como mensagem crua."""
    if isinstance(turno, dict):
        return str(turno.get("content") or "")
    return str(getattr(turno, "text", "") or "")


def _identidade_pedida(historico: Iterable[Any]) -> bool:
    """O pedido mais recente do usuário é sobre quem responde?

    Sai do próprio histórico em vez de um parâmetro novo: o filtro é montado nos dois
    caminhos (texto e passo do agente) e os dois já têm as mensagens na mão.
    """
    for turno in reversed(list(historico)):
        papel = turno.get("role") if isinstance(turno, dict) else getattr(turno, "role", "")
        if papel == "user":
            return pergunta_identidade(_texto_do_usuario(turno))
    return False

#: Esforço de raciocínio mandado ao host conforme o botão Reasoning da interface.
#:
#: O padrão do host faz o `liz-mini-2` pensar **~2 minutos** antes da primeira palavra da
#: resposta (2859 pedaços de `reasoning_content`), e é isso que fazia a resposta parecer
#: chegar de uma vez. Medido no `liz-mini-2` para a mesma pergunta:
#:
#:   padrão do host → 1º texto em 120,6s · `low` → passou de 6min · `minimal` → 11,8s ·
#:   `none` → 7,2s
#:
#: Daí a escolha: desligado manda `none` (não pensa), ligado manda `minimal` (pensa, mas
#: em segundos). `low` e acima ficam de fora por serem mais lentos que o próprio padrão.
ESFORCO_LIGADO = "minimal"
ESFORCO_DESLIGADO = "none"

#: `none` é o que o botão Reasoning desligado **pede** — mas o gateway recusa o campo com
#: **400** em todos os modelos, com ou sem ferramentas (medido no serve-liz, set/2026).
#: Quem resolve é o `esforco_valido`: `none` nunca está na lista de suportados (ver
#: `_catalogo_de_esforcos`) e o pedido sobe para `minimal`, que responde em segundos.
ESFORCO_SEGURO = "minimal"

#: Níveis de esforço na ordem do mais barato para o mais caro. É a régua usada para subir
#: até o nível que o modelo aceita quando o pedido não está na lista dele (`koda-1` não tem
#: `minimal` → vai de `low`).
NIVEIS_ESFORCO = ("none", "minimal", "low", "medium", "high", "xhigh", "max")


def esforco_valido(pedido: str, suportados: frozenset[str] | None) -> str:
    """O nível pedido, ou o vizinho mais próximo que o modelo aceita.

    `suportados` é o que o host publicou para o modelo em `/v1/models`; `None`/vazio (sem
    catálogo) cai no `ESFORCO_SEGURO`, que passa em todos os modelos medidos.
    """
    if not suportados:
        return ESFORCO_SEGURO if pedido == ESFORCO_DESLIGADO else pedido
    if pedido in suportados:
        return pedido
    if pedido not in NIVEIS_ESFORCO:
        return ESFORCO_SEGURO if ESFORCO_SEGURO in suportados else next(iter(sorted(suportados)))
    indice = NIVEIS_ESFORCO.index(pedido)
    # Arredonda para cima — o vizinho que pensa um pouco mais — e, sem nada acima, o
    # maior nível abaixo. `none` no `layze-2` sobe para `minimal`; `minimal` no `koda-1`
    # sobe para `low`.
    acima = [nivel for nivel in NIVEIS_ESFORCO[indice:] if nivel in suportados]
    if acima:
        return acima[0]
    abaixo = [nivel for nivel in NIVEIS_ESFORCO[:indice] if nivel in suportados]
    return abaixo[-1] if abaixo else ESFORCO_SEGURO


class OpenAICompatibleProvider:
    name = "openai"
    #: Manda `reasoning_effort` no corpo? Só o host entende o campo — OpenAI, Groq e o
    #: Ollama podem recusar campo desconhecido, então fica desligado por padrão.
    manda_esforco = False

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.base_url = settings.openai_base_url.rstrip("/")
        self.api_key = settings.openai_api_key
        #: Modelo padrão para streaming e para os passos com ferramentas.
        self.model = settings.openai_model
        self.ready = bool(self.api_key)
        #: Cliente HTTP reaproveitado entre passos. Antes cada passo criava o seu
        #: (`async with httpx.AsyncClient(...)`): conexão TCP nova — e handshake TLS novo,
        #: quando o endereço é https — a cada chamada. Um passo sozinho não sente; uma
        #: tarefa faz dezenas, e a conversa fica mais lenta do que precisa.
        self._cliente_http: httpx.AsyncClient | None = None

    # ------------------------------------------------------------ comum

    def _cliente(self) -> httpx.AsyncClient:
        """O cliente HTTP do provider, criado uma vez e reaproveitado nos passos."""
        if self._cliente_http is None or self._cliente_http.is_closed:
            self._cliente_http = httpx.AsyncClient(timeout=TIME_STREAM)
        return self._cliente_http

    def headers(self) -> dict[str, str]:
        base = {"Content-Type": "application/json"}
        if self.api_key:
            base["Authorization"] = f"Bearer {self.api_key}"
        return base

    def resolve_model(self, model: str) -> str:
        return self.settings.resolve_model(model, self.settings.openai_model)

    def _messages(self, turns: list[ChatTurn], options: ChatOptions) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": system_prompt(options)}
        ]
        messages += [{"role": turn.role, "content": turn.text} for turn in turns]
        return messages

    def _erro(self, status: int, detalhe: str) -> ProviderError:
        mensagem = f"O provedor respondeu {status}: {detalhe}"
        return TransientProviderError(mensagem) if status in TRANSITORIOS else ProviderError(mensagem)

    async def esforco(self, reasoning: bool, modelo: str, escolha: str | None = None) -> str:
        """`reasoning_effort` da mensagem (só quem manda o campo usa).

        `escolha` é o seletor de esforço da interface; sem ele, quem decide é o botão
        Reasoning.
        """
        if escolha:
            return escolha
        return ESFORCO_LIGADO if reasoning else ESFORCO_DESLIGADO

    # ------------------------------------------------------------ streaming

    async def stream(self, turns: list[ChatTurn], options: ChatOptions) -> AsyncIterator[Piece]:
        if not self.ready:
            raise ProviderError(
                "Provider OpenAI escolhido sem chave: preencha OPENAI_API_KEY no backend/.env "
                "(ou use KODA_PROVIDER=local)."
            )

        modelo = self.resolve_model(options.model)
        payload: dict[str, Any] = {
            "model": modelo,
            "messages": self._messages(turns, options),
            "stream": True,
        }
        if self.manda_esforco:
            payload["reasoning_effort"] = await self.esforco(
                options.reasoning, modelo, options.effort
            )

        # A apresentação que o host injeta é tirada aqui, antes do primeiro pedaço chegar
        # à tela (ver `app/identidade.py`).
        filtro = FiltroIdentidade(options.assistente, _identidade_pedida(turns))

        try:
            async with self._cliente().stream(
                "POST",
                f"{self.base_url}/chat/completions",
                headers=self.headers(),
                json=payload,
            ) as response:
                if response.status_code >= 400:
                    detalhe = (await response.aread()).decode("utf-8", "replace")[:300]
                    raise self._erro(response.status_code, detalhe)

                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    if not data:
                        continue
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}
                    # O raciocínio vem antes do texto e pode durar minutos. Ele não é a
                    # resposta, mas vai para a tela: sem isso o usuário encara uma tela
                    # parada e a resposta parece aparecer de uma vez no fim.
                    razao = delta.get("reasoning_content")
                    if razao:
                        yield Piece(str(razao), reasoning=True)
                    piece = delta.get("content")
                    if piece:
                        limpo = filtro.push(str(piece))
                        if limpo:
                            yield Piece(limpo)
        except httpx.HTTPError as error:  # rede, DNS, timeout
            raise TransientProviderError(_descrever_erro_de_rede(error)) from error

        # O que ficou preso na cabeça sai agora; se era só apresentação, sai a resposta
        # padrão — nunca uma resposta vazia.
        resto = filtro.fechar()
        if resto:
            yield Piece(resto)

    # ------------------------------------------------------------ ferramentas

    async def step(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        model: str = "",
        escolha_ferramenta: str | dict[str, Any] | None = None,
    ) -> StepResult:
        """Um passo não-streaming com as ferramentas à mão.

        O projeto TOOLS usa exatamente isso (`stream: false` + `tools`), que é o caminho
        que o proxy trata melhor: as `tool_calls` chegam completas, com o id que ele
        espera de volta no eco.

        `escolha_ferramenta` vai como `tool_choice` no corpo: `"required"` obriga a
        resposta a trazer uma chamada, e `{"type": "function", "function": {"name": …}}`
        aponta a ferramenta pelo nome — é o conserto do "anunciou e encerrou".
        """
        if not self.ready:
            raise ProviderError("Provider sem chave para chamar ferramentas.")

        payload: dict[str, Any] = {
            "model": self.resolve_model(model),
            "stream": False,
            "messages": messages,
            # Teto **generoso** de tokens de saída, e explícito. Os modelos de raciocínio
            # (o `liz-4`, o `layze-2`) gastam o orçamento **pensando**: medido, o `liz-4`
            # devolveu texto vazio com `max_tokens` 80 e 400 e só falou a partir de ~1000.
            # Sem campo nenhum, vale o padrão do gateway — e era por isso que eles ficavam
            # calados do começo ao fim da tarefa, sem uma linha para a pessoa ler. É teto,
            # não meta: quem responde curto continua respondendo curto.
            "max_tokens": MAX_TOKENS_SAIDA,
        }
        if tools:
            payload["tools"] = tools
            if escolha_ferramenta:
                payload["tool_choice"] = escolha_ferramenta

        try:
            response = await self._cliente().post(
                f"{self.base_url}/chat/completions",
                headers=self.headers(),
                json=payload,
            )
        except httpx.HTTPError as error:
            raise TransientProviderError(_descrever_erro_de_rede(error)) from error

        if response.status_code >= 400:
            raise self._erro(response.status_code, response.text[:300])

        try:
            dados = response.json()
        except ValueError as error:
            raise TransientProviderError(
                f"resposta não-JSON do provedor: {response.text[:200]}"
            ) from error

        choices = dados.get("choices") or []
        if not choices:
            raise TransientProviderError("resposta sem choices")

        mensagem = choices[0].get("message") or {}
        calls = [
            ToolCall(
                id=str(item.get("id", "")),
                name=str((item.get("function") or {}).get("name", "")),
                arguments=_json_ou_vazio((item.get("function") or {}).get("arguments")),
                raw_arguments=str((item.get("function") or {}).get("arguments") or "{}"),
            )
            for item in (mensagem.get("tool_calls") or [])
        ]
        uso = dados.get("usage") or {}
        return StepResult(
            text=limpar_identidade(str(mensagem.get("content") or ""), self.settings.assistente),
            calls=calls,
            usage={
                "prompt_tokens": int(uso.get("prompt_tokens", 0) or 0),
                "completion_tokens": int(uso.get("completion_tokens", 0) or 0),
                "total_tokens": int(uso.get("total_tokens", 0) or 0),
            },
        )

    async def step_streaming(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        model: str = "",
        reasoning: bool = True,
        effort: str | None = None,
        escolha_ferramenta: str | dict[str, Any] | None = None,
    ) -> AsyncIterator[Piece | StepResult]:
        """O mesmo passo do `step()`, mas narrando o texto enquanto ele sai.

        O `step()` é `stream: false`, então o texto do passo chegava inteiro num único
        delta — e como o modo agente vem ligado por padrão, **toda** resposta aparecia de
        uma vez na tela. Aqui o pedido vai com `stream: true`.

        As `tool_calls` chegam fatiadas (`id` e `name` no primeiro pedaço, `arguments` nos
        seguintes, agrupadas por `index`) e são remontadas exatamente como o `step()` as
        devolveria, para o eco continuar casando com a assinatura que o host guarda.

        `escolha_ferramenta` vai como `tool_choice` (ver `step()`).
        """
        modelo = self.resolve_model(model)
        payload: dict[str, Any] = {
            "model": modelo,
            "stream": True,
            "messages": messages,
        }
        if tools:
            payload["tools"] = tools
            if escolha_ferramenta:
                payload["tool_choice"] = escolha_ferramenta
        if self.manda_esforco:
            payload["reasoning_effort"] = await self.esforco(reasoning, modelo, effort)

        texto: list[str] = []
        parciais: dict[int, dict[str, str]] = {}
        uso: dict[str, Any] = {}
        filtro = FiltroIdentidade(self.settings.assistente, _identidade_pedida(messages))

        try:
            async with self._cliente().stream(
                "POST",
                f"{self.base_url}/chat/completions",
                headers=self.headers(),
                json=payload,
            ) as response:
                if response.status_code >= 400:
                    detalhe = (await response.aread()).decode("utf-8", "replace")[:300]
                    raise self._erro(response.status_code, detalhe)

                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    if not data:
                        continue
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    if chunk.get("usage"):
                        uso = chunk["usage"]
                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}

                    razao = delta.get("reasoning_content")
                    if razao:
                        yield Piece(str(razao), reasoning=True)
                    pedaco = delta.get("content")
                    if pedaco:
                        limpo = filtro.push(str(pedaco))
                        if limpo:
                            texto.append(limpo)
                            yield Piece(limpo)

                    for bruto in delta.get("tool_calls") or []:
                        indice = int(bruto.get("index") or 0)
                        atual = parciais.setdefault(indice, {"id": "", "name": "", "args": ""})
                        if bruto.get("id"):
                            atual["id"] = str(bruto["id"])
                        funcao = bruto.get("function") or {}
                        if funcao.get("name"):
                            atual["name"] = str(funcao["name"])
                        if funcao.get("arguments"):
                            atual["args"] += str(funcao["arguments"])
        except httpx.HTTPError as error:
            raise TransientProviderError(_descrever_erro_de_rede(error)) from error

        # O que estava preso na cabeça entra no texto do passo — e na tela — antes de o
        # passo terminar, senão o que a tela mostrava e o que ficava gravado divergiam.
        resto = filtro.fechar()
        if resto:
            texto.append(resto)
            yield Piece(resto)

        yield StepResult(
            text="".join(texto),
            calls=[
                ToolCall(
                    id=parcial["id"],
                    name=parcial["name"],
                    arguments=_json_ou_vazio(parcial["args"]),
                    raw_arguments=parcial["args"] or "{}",
                )
                for _, parcial in sorted(parciais.items())
            ],
            usage={
                "prompt_tokens": int(uso.get("prompt_tokens", 0) or 0),
                "completion_tokens": int(uso.get("completion_tokens", 0) or 0),
                "total_tokens": int(uso.get("total_tokens", 0) or 0),
            },
        )


class HostProvider(OpenAICompatibleProvider):
    """O provider do serviço de modelos oficial (Liz): a mesma API da OpenAI, do outro lado.

    O host é o `host/c-host.exe`, que publica o catálogo em `/v1/models` e recebe a
    conversa em `/v1/chat/completions`. Sem painel de contas — quem valida o
    id do modelo é o próprio host, que responde com uma mensagem clara quando não o
    reconhece.

    A chave de cliente é opcional e vem do ambiente (`KODA_HOST_KEY`): o host aberto ignora
    o cabeçalho, e o build com autorização remota recusa com 401 quem não manda. Sem chave
    configurada nenhum `Authorization` é enviado, que é o caso normal do host local.
    """

    name = "host"
    manda_esforco = True

    def __init__(self, settings: Settings) -> None:
        super().__init__(settings)
        self.base_url = settings.host_url.rstrip("/")
        # A credencial **não** fica guardada aqui: ela é lida a cada pedido (ver
        # `headers`), porque a sessão da conta chega depois da subida do processo.
        self.api_key = None
        self.model = settings.host_model
        self.ready = True
        self._esforcos: dict[str, frozenset[str]] | None = None

    def headers(self) -> dict[str, str]:
        """O que vai em todo pedido ao host: a sessão da conta, ou a chave de serviço.

        Lido do ambiente em memória na hora, e não no construtor: o backend sobe antes de
        alguém entrar, então guardar o valor na subida congelaria uma credencial que ainda
        não existe — e o host responderia 401 pelo resto da sessão. Vazio não vira
        "Bearer " solto: sem credencial o cabeçalho simplesmente não vai, que é o certo
        para o host aberto.
        """
        base = {"Content-Type": "application/json"}
        chave = host_auth.credencial(self.settings)
        if chave:
            base["Authorization"] = f"Bearer {chave}"
        return base

    async def _catalogo_de_esforcos(self) -> dict[str, frozenset[str]]:
        """Níveis de esforço que cada modelo aceita, direto do `/v1/models` do host.

        O host publica `efforts` por modelo, e é a única fonte confiável: `koda-1` não tem
        `minimal` e recusa com 400. O `targetFormat` entra por cima porque a lista
        publicada é generosa demais — `liz-4` e `layze-2` anunciam `none` e mesmo assim
        recusam o campo (medido).

        Lido uma vez e guardado — o catálogo não muda em execução. Catálogo fora do ar
        devolve `{}`, e aí todo mundo cai no valor seguro.
        """
        if self._esforcos is not None:
            return self._esforcos
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
                # Com a chave: sem ela o host com autorização remota responde 401 e o
                # catálogo sairia vazio, derrubando todo mundo no esforço padrão.
                resposta = await client.get(f"{self.base_url}/models", headers=self.headers())
            dados = resposta.json()
        except (httpx.HTTPError, ValueError):
            dados = None
        itens = dados.get("data") if isinstance(dados, dict) else None
        if not isinstance(itens, list):
            self._esforcos = {}
            return self._esforcos

        suportados: dict[str, frozenset[str]] = {}
        for item in itens:
            if not isinstance(item, dict):
                continue
            identificador = str(item.get("id", "")).split("/")[-1]
            if not identificador:
                continue
            publicados = item.get("efforts")
            niveis = {
                str(nivel).lower()
                for nivel in (publicados if isinstance(publicados, list) else ())
                if isinstance(nivel, str)
            }
            # Modelo que não publica a lista aceita qualquer nível: nenhuma restrição.
            if not niveis:
                niveis = set(NIVEIS_ESFORCO)
            # O gateway recusa `none` com 400 em **todos** os modelos, com e sem
            # ferramentas no corpo (medido no serve-liz, set/2026) — a lista publicada
            # anuncia `none`, mas o campo não passa. Tirar daqui faz o arredondamento
            # subir para `minimal`, que é o nível que de fato responde.
            niveis.discard(ESFORCO_DESLIGADO)
            suportados[identificador] = frozenset(niveis)
        self._esforcos = suportados
        return suportados

    async def esforco(self, reasoning: bool, modelo: str, escolha: str | None = None) -> str:
        """O seletor da interface manda; sem ele, quem decide é o botão Reasoning.

        O valor sai ajustado ao catálogo do host — é o que evita o 400 na tela.
        """
        escolhido = escolha or (ESFORCO_LIGADO if reasoning else ESFORCO_DESLIGADO)
        catalogo = await self._catalogo_de_esforcos()
        return esforco_valido(escolhido, catalogo.get(modelo))

    #: Nomes decorativos do seletor antigo. Conversa gravada antes do serviço atual ainda
    #: manda um desses; melhor cair no padrão do que virar um 400 lá.
    LEGADOS = frozenset(
        {
            "koda-flash",
            "koda-pro",
            "koda-vision",
            "liz-flash",
            "liz-pro",
            "liz-vision",
        }
    )

    def resolve_model(self, model: str) -> str:
        """O catálogo é do host, não nosso: id desconhecido vai como veio.

        Antes isto devolvia o modelo padrão para tudo que não batesse com um catálogo fixo,
        o que engolia o catálogo inteiro do host (`liz-nano`, `koda-1`, `layze-2`…) e mandava
        todo mundo para o mesmo modelo. Quem valida o id agora é o host, que responde com uma
        mensagem clara quando não reconhece.
        """
        alias = self.settings.model_aliases.get(model)
        if alias:
            return alias
        if not model or model in self.LEGADOS:
            return self.settings.host_model
        return model

    def _erro(self, status: int, detalhe: str) -> ProviderError:
        motivo = _motivo_do_host(detalhe)
        if status in TRANSITORIOS_PROXY:
            return TransientProviderError(f"o host respondeu {status}: {motivo}")
        return ProviderError(f"o host respondeu {status}: {motivo}")


def _motivo_do_host(detalhe: str) -> str:
    """Erro do host em uma linha: JSON cru atrapalha quem está lendo o chat."""
    try:
        dados = json.loads(detalhe)
    except (json.JSONDecodeError, TypeError):
        return detalhe.strip()[:200]
    mensagem = str((dados.get("error") or {}).get("message", detalhe))
    if "429" in mensagem:
        return "o host bateu no limite de cota (429)"
    return mensagem[:200]


def _json_ou_vazio(valor: Any) -> dict[str, Any]:
    if isinstance(valor, dict):
        return valor
    try:
        dados = json.loads(valor or "{}")
    except (json.JSONDecodeError, TypeError):
        return {}
    return dados if isinstance(dados, dict) else {}
