"""Provider OpenAI-compatível: streaming para o texto e um passo com ferramentas.

Serve OpenAI, Groq, OpenRouter e o Ollama (`http://localhost:11434/v1`) — muda só a
`OPENAI_BASE_URL` e a chave. `HostProvider` herda daqui apontando para o serviço de
modelos oficial do projeto (o host em `host/c-host.exe`), que fala o mesmo protocolo.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator, Iterable
from typing import Any

import httpx

from .. import host_auth
from ..config import Settings
from ..identidade import FiltroIdentidade, limpar_identidade, pergunta_identidade
from . import pensamento
from ..contracts.turn import StepResult, ToolCall, texto_do_conteudo
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

#: O 404 **não** entra mais aqui. Antes ele era repetido porque o upstream do host devolvia
#: 404 no meio da conversa e o passo seguinte costumava funcionar — mas o efeito colateral
#: era caro: um id de modelo errado ou uma `OPENAI_BASE_URL` errada (erros que **não** têm
#: conserto por retentativa) ficavam martelando com backoff por dezenas de segundos antes de
#: desistir. Falha de configuração tem de falhar rápido e dizer o que está errado.
TRANSITORIOS_PROXY = TRANSITORIOS

#: Por quanto tempo o catálogo de esforços do host fica em memória, em segundos. Sem
#: expiração, um catálogo lido quando o host ainda não tinha subido ficava `{}` **para
#: sempre**, e todo modelo caía no esforço padrão pelo resto da sessão.
CATALOGO_TTL_S = 300.0

#: Não impõe prazo de leitura: um modelo pode passar bastante tempo raciocinando antes
#: do primeiro byte. A chamada termina por resposta, erro de transporte ou cancelamento
#: explícito do usuário; não por um relógio local. O prazo de conexão continua curto.
TEMPO_DE_LEITURA: float | None = None
TIME_STREAM = httpx.Timeout(TEMPO_DE_LEITURA, connect=10.0)

#: Teto de tokens **de saída** em cada passo, mandado explícito no pedido.
#:
#: Existe por causa dos modelos de raciocínio: medido, o `liz-4` devolve **texto vazio** com
#: `max_tokens` 80 e 400 — o orçamento inteiro vai para o pensamento — e só fala a partir de
#: ~1000. Sem o campo, vale o padrão do gateway, e era isso que deixava `liz-4` e `layze-2`
#: calados a tarefa inteira.
#:
#: Era 8192 e passou para **131072** a pedido do dono (respostas longas de código não podem
#: ser cortadas no meio). É teto, não meta: quem responde curto continua respondendo curto.
#: Atenção: alguns provedores recusam `max_tokens` maior que a janela de saída do modelo
#: (400), e o valor **não** é reduzido automaticamente — se isso acontecer, baixe daqui.
MAX_TOKENS_SAIDA = 131_072


def _descrever_erro_de_rede(error: httpx.HTTPError) -> str:
    """Explica a falha sem expor URL, credenciais ou texto da requisicao."""
    nome = type(error).__name__
    if isinstance(error, httpx.ReadTimeout):
        return "o provedor parou de enviar dados (ReadTimeout)"
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
    """O conteúdo do usuário, que chega ora como `ChatTurn`, ora como mensagem crua.

    Usa `texto_do_conteudo`: com imagem, o `content` é uma lista de partes, e
    `str()` traria o base64 dentro — a pergunta de identidade seria testada contra o data
    URL inteiro em vez da frase da pessoa.
    """
    if isinstance(turno, dict):
        return texto_do_conteudo(turno.get("content"))
    return str(getattr(turno, "text", "") or "")


def conteudo_do_turno(turno: ChatTurn) -> dict[str, Any]:
    """O turno no formato do provedor: `content` string, ou lista de partes com imagem.

    Sem imagem o corpo é idêntico ao de antes (uma string) — o caminho de visão não pode
    mexer no que já funciona para todo o resto. Com imagem, `content` vira a lista
    `[{type: text}, {type: image_url}, …]`, que é o formato OpenAI para visão.
    """
    if not turno.imagens:
        return {"role": turno.role, "content": turno.text}
    partes: list[dict[str, Any]] = []
    if turno.text:
        partes.append({"type": "text", "text": turno.text})
    partes += [
        {"type": "image_url", "image_url": {"url": url}} for url in turno.imagens
    ]
    if not partes:
        # Só chega aqui um turno sem texto e sem imagem que escapou do filtro: um `content`
        # vazio é recusado por parte dos provedores.
        partes.append({"type": "text", "text": " "})
    return {"role": turno.role, "content": partes}


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


def sobe_ate_o_piso(nivel: str, piso: str | None) -> str:
    """O nível, ou o piso do modelo quando o nível está abaixo dele.

    O host publica `reasoningFloor` por modelo: o menor esforço em que o modelo **de
    fato** emite raciocínio. Abaixo dele a resposta sai sem pensar nada. Medido no
    `liz-4` (o modelo padrão) e no `layze-2`, que com `minimal` devolveram
    `reasoning_content` vazio em 3 de 3 chamadas cada e só a partir de `high` disseram
    alguma coisa — ou seja, o botão **Reasoning ligado** não produzia raciocínio nenhum
    nesses dois, porque o esforço ligado é o `minimal`.

    Só vale para o caminho "o botão decide": quando a pessoa escolhe um nível no seletor,
    a escolha dela manda, inclusive se for para pensar menos.
    """
    if not piso or piso not in NIVEIS_ESFORCO or nivel not in NIVEIS_ESFORCO:
        return nivel
    return piso if NIVEIS_ESFORCO.index(nivel) < NIVEIS_ESFORCO.index(piso) else nivel


class OpenAICompatibleProvider:
    name = "openai"
    #: Manda `reasoning_effort` no corpo? Só o host entende o campo — OpenAI, Groq e o
    #: Ollama podem recusar campo desconhecido, então fica desligado por padrão.
    manda_esforco = False
    #: Pede o bloco de `usage` no fim do stream (`stream_options.include_usage`). Sem ele o
    #: caminho de streaming — que é o que o agente usa de verdade — **nunca** reportava
    #: tokens: o medidor de contexto e o controle de custo ficavam cegos.
    manda_usage = True

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
        messages += [conteudo_do_turno(turn) for turn in turns]
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
            # O stream também precisa do teto amplo usado pelo modo agente. Sem o campo,
            # o gateway aplicava o limite padrão e encerrava respostas longas cedo.
            "max_tokens": MAX_TOKENS_SAIDA,
        }
        if self.manda_usage:
            payload["stream_options"] = {"include_usage": True}
        if self.manda_esforco:
            payload["reasoning_effort"] = await self.esforco(
                options.reasoning, modelo, options.effort
            )

        # A apresentação que o host injeta é tirada aqui, antes do primeiro pedaço chegar
        # à tela (ver `app/identidade.py`).
        filtro = FiltroIdentidade(options.assistente, _identidade_pedida(turns))
        # Achado 7: o raciocínio que o modelo escreve dentro do próprio texto (entre
        # marcações) não pode chegar à tela. O limpador segura a marcação partida entre
        # pedaços — é o que a limpeza por expressão regular, feita pedaço a pedaço, erra.
        raciocinio = pensamento.LimpaRaciocinio()
        motivo_de_fim = ""

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
                    escolha = choices[0]
                    if escolha.get("finish_reason"):
                        motivo_de_fim = str(escolha["finish_reason"])
                    delta = escolha.get("delta") or {}
                    # O raciocínio vem antes do texto e pode durar minutos. Ele não é a
                    # resposta, mas vai para a tela: sem isso o usuário encara uma tela
                    # parada e a resposta parece aparecer de uma vez no fim.
                    razao = delta.get("reasoning_content")
                    if razao:
                        yield Piece(str(razao), reasoning=True)
                    piece = delta.get("content")
                    if piece:
                        limpo = raciocinio.alimentar(filtro.push(str(piece)))
                        if limpo:
                            yield Piece(limpo)
        except httpx.HTTPError as error:  # rede, DNS, timeout
            raise TransientProviderError(_descrever_erro_de_rede(error)) from error

        # O que ficou preso na cabeça sai agora; se era só apresentação, sai a resposta
        # padrão — nunca uma resposta vazia.
        resto = raciocinio.alimentar(filtro.fechar()) + raciocinio.despejar()
        if resto:
            yield Piece(resto)
        if motivo_de_fim == "length":
            yield Piece("", truncated=True)

    # ------------------------------------------------------------ ferramentas

    async def step(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        model: str = "",
    ) -> StepResult:
        """Um passo não-streaming com as ferramentas à mão.

        O projeto TOOLS usa exatamente isso (`stream: false` + `tools`), que é o caminho
        que o proxy trata melhor: as `tool_calls` chegam completas, com o id que ele
        espera de volta no eco.

        Com ferramentas, não envia `tool_choice`: o provedor mantém a seleção automática
        e o modelo decide se chama uma ferramenta e qual delas.
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
            truncado=str(choices[0].get("finish_reason") or "") == "length",
        )

    async def step_streaming(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        model: str = "",
        reasoning: bool = True,
        effort: str | None = None,
    ) -> AsyncIterator[Piece | StepResult]:
        """O mesmo passo do `step()`, mas narrando o texto enquanto ele sai.

        O `step()` é `stream: false`, então o texto do passo chegava inteiro num único
        delta — e como o modo agente vem ligado por padrão, **toda** resposta aparecia de
        uma vez na tela. Aqui o pedido vai com `stream: true`.

        As `tool_calls` chegam fatiadas (`id` e `name` no primeiro pedaço, `arguments` nos
        seguintes, agrupadas por `index`) e são remontadas exatamente como o `step()` as
        devolveria, para o eco continuar casando com a assinatura que o host guarda.

        Com ferramentas, não envia `tool_choice`: o provedor mantém a seleção automática
        e o modelo decide se chama uma ferramenta e qual delas.
        """
        modelo = self.resolve_model(model)
        payload: dict[str, Any] = {
            "model": modelo,
            "stream": True,
            "messages": messages,
            # O teto de tokens de saída **faltava** aqui — e este é o caminho que o agente
            # usa de verdade. O `step()` (não-streaming) mandava `MAX_TOKENS_SAIDA`, então a
            # proteção contra resposta gigante não valia para a execução real.
            "max_tokens": MAX_TOKENS_SAIDA,
        }
        if self.manda_usage:
            payload["stream_options"] = {"include_usage": True}
        if tools:
            payload["tools"] = tools
        if self.manda_esforco:
            payload["reasoning_effort"] = await self.esforco(reasoning, modelo, effort)

        texto: list[str] = []
        parciais: dict[int, dict[str, str]] = {}
        uso: dict[str, Any] = {}
        motivo_de_fim = ""
        filtro = FiltroIdentidade(self.settings.assistente, _identidade_pedida(messages))
        # Mesmo limpador do outro fluxo: o raciocínio não vai para a resposta visível.
        raciocinio = pensamento.LimpaRaciocinio()

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
                    escolha = choices[0]
                    if escolha.get("finish_reason"):
                        motivo_de_fim = str(escolha["finish_reason"])
                    delta = escolha.get("delta") or {}

                    razao = delta.get("reasoning_content")
                    if razao:
                        yield Piece(str(razao), reasoning=True)
                    pedaco = delta.get("content")
                    if pedaco:
                        limpo = raciocinio.alimentar(filtro.push(str(pedaco)))
                        if limpo:
                            texto.append(limpo)
                            yield Piece(limpo)

                    for bruto in delta.get("tool_calls") or []:
                        indice_bruto = bruto.get("index")
                        novo_id = str(bruto.get("id") or "")
                        if indice_bruto is None:
                            # Nem todo OpenAI-compatible manda `index`. Sem ele, uma chamada
                            # **nova** se anuncia pelo `id` novo; sem id, o pedaço é
                            # continuação da última — assumir "sempre 0" misturava chamadas
                            # paralelas num argumento só.
                            indice = len(parciais) if (novo_id or not parciais) else max(parciais)
                        else:
                            indice = int(indice_bruto)
                        atual = parciais.setdefault(indice, {"id": "", "name": "", "args": ""})
                        if novo_id:
                            atual["id"] = novo_id
                        funcao = bruto.get("function") or {}
                        if funcao.get("name"):
                            atual["name"] = str(funcao["name"])
                        if funcao.get("arguments"):
                            atual["args"] += str(funcao["arguments"])
        except httpx.HTTPError as error:
            raise TransientProviderError(_descrever_erro_de_rede(error)) from error

        # O que estava preso na cabeça entra no texto do passo — e na tela — antes de o
        # passo terminar, senão o que a tela mostrava e o que ficava gravado divergiam.
        resto = raciocinio.alimentar(filtro.fechar()) + raciocinio.despejar()
        if resto:
            texto.append(resto)
            yield Piece(resto)

        yield StepResult(
            text="".join(texto),
            calls=[
                ToolCall(
                    # Id vazio quebra o casamento `tool_call_id` ↔ `tool_calls` do host (e o
                    # eco da assinatura). Se o provedor não mandou id, um estável é melhor do
                    # que string vazia.
                    id=parcial["id"] or f"call_{posicao}",
                    name=parcial["name"],
                    arguments=_json_ou_vazio(parcial["args"]),
                    raw_arguments=parcial["args"] or "{}",
                )
                for posicao, (_, parcial) in enumerate(sorted(parciais.items()))
            ],
            usage={
                "prompt_tokens": int(uso.get("prompt_tokens", 0) or 0),
                "completion_tokens": int(uso.get("completion_tokens", 0) or 0),
                "total_tokens": int(uso.get("total_tokens", 0) or 0),
            },
            truncado=motivo_de_fim == "length",
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
        #: Piso de raciocínio por modelo, do mesmo `/v1/models` (ver `sobe_ate_o_piso`).
        self._pisos: dict[str, str] = {}
        self._esforcos_em = 0.0

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
        `minimal` e recusa com 400. O mesmo payload traz `reasoningFloor`, o menor esforço
        em que o modelo realmente pensa — guardado em `self._pisos` e usado por
        `sobe_ate_o_piso` (ver `esforco`).

        Lido uma vez e guardado — o catálogo não muda em execução. Catálogo fora do ar
        devolve `{}`, e aí todo mundo cai no valor seguro.
        """
        if self._esforcos is not None and time.monotonic() - self._esforcos_em < CATALOGO_TTL_S:
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
            # Catálogo fora do ar **não** fica gravado: antes, um host que ainda não tinha
            # subido deixava `{}` preso para sempre, e todo modelo caía no esforço padrão
            # pelo resto da sessão. Sem cache, a próxima chamada tenta de novo.
            return {}

        suportados: dict[str, frozenset[str]] = {}
        pisos: dict[str, str] = {}
        for item in itens:
            if not isinstance(item, dict):
                continue
            identificador = str(item.get("id", "")).split("/")[-1]
            if not identificador:
                continue
            piso = item.get("reasoningFloor")
            if isinstance(piso, str) and piso.lower() in NIVEIS_ESFORCO:
                pisos[identificador] = piso.lower()
            publicados = item.get("efforts")
            niveis = {
                str(nivel).lower()
                for nivel in (publicados if isinstance(publicados, list) else ())
                if isinstance(nivel, str)
            }
            # Modelo que não publica a lista aceita qualquer nível: nenhuma restrição.
            if not niveis:
                niveis = set(NIVEIS_ESFORCO)
            # O gateway recusa `none` com 400 em parte do catálogo, com e sem ferramentas
            # no corpo (medido no serve-liz, out/2026). O host já não anuncia `none` nos
            # modelos que o recusam; tirar aqui também é o que faz o arredondamento subir
            # para `minimal` — o nível que de fato responde.
            niveis.discard(ESFORCO_DESLIGADO)
            suportados[identificador] = frozenset(niveis)
        self._esforcos = suportados
        self._pisos = pisos
        self._esforcos_em = time.monotonic()
        return suportados

    async def esforco(self, reasoning: bool, modelo: str, escolha: str | None = None) -> str:
        """O seletor da interface manda; sem ele, quem decide é o botão Reasoning.

        O valor sai ajustado ao catálogo do host — é o que evita o 400 na tela — e, no
        caminho do botão, subido até o piso do modelo (`sobe_ate_o_piso`): sem isso o
        "Reasoning ligado" não produzia raciocínio nenhum no `liz-4` e no `layze-2`.
        """
        escolhido = escolha or (ESFORCO_LIGADO if reasoning else ESFORCO_DESLIGADO)
        catalogo = await self._catalogo_de_esforcos()
        ajustado = esforco_valido(escolhido, catalogo.get(modelo))
        if reasoning and not escolha:
            ajustado = sobe_ate_o_piso(ajustado, self._pisos.get(modelo))
        return ajustado

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
