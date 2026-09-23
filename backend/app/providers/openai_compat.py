"""Provider OpenAI-compatível: streaming para o texto e um passo com ferramentas.

Serve OpenAI, Groq, OpenRouter e o Ollama (`http://localhost:11434/v1`) — muda só a
`OPENAI_BASE_URL` e a chave. `GeminiProxyProvider` herda daqui apontando para o gateway
local do serviço, que fala o mesmo protocolo.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx

from ..config import Settings
from ..identidade import FiltroIdentidade, limpar_identidade
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

TIME_STREAM = httpx.Timeout(120.0, connect=10.0)

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

#: Nem todo modelo aceita `none`: parte do catálogo do serviço recusa o campo com **400**,
#: com ou sem ferramentas no corpo — era o erro que aparecia na tela. `minimal` passa em
#: todos os medidos, então é ele que vai quando o modelo não está na lista dos que aceitam
#: `none` (ou quando o catálogo não responde).
ESFORCO_SEGURO = "minimal"


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

    # ------------------------------------------------------------ comum

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
        filtro = FiltroIdentidade(options.assistente)

        try:
            async with httpx.AsyncClient(timeout=TIME_STREAM) as client:
                async with client.stream(
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
            raise TransientProviderError(f"Não consegui falar com o provedor: {error}") from error

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
    ) -> StepResult:
        """Um passo não-streaming com as ferramentas à mão.

        O projeto TOOLS usa exatamente isso (`stream: false` + `tools`), que é o caminho
        que o proxy trata melhor: as `tool_calls` chegam completas, com o id que ele
        espera de volta no eco.
        """
        if not self.ready:
            raise ProviderError("Provider sem chave para chamar ferramentas.")

        payload: dict[str, Any] = {
            "model": self.resolve_model(model),
            "stream": False,
            "messages": messages,
        }
        if tools:
            payload["tools"] = tools

        try:
            async with httpx.AsyncClient(timeout=TIME_STREAM) as client:
                response = await client.post(
                    f"{self.base_url}/chat/completions",
                    headers=self.headers(),
                    json=payload,
                )
        except httpx.HTTPError as error:
            raise TransientProviderError(f"falha ao falar com o provedor: {error}") from error

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
    ) -> AsyncIterator[Piece | StepResult]:
        """O mesmo passo do `step()`, mas narrando o texto enquanto ele sai.

        O `step()` é `stream: false`, então o texto do passo chegava inteiro num único
        delta — e como o modo agente vem ligado por padrão, **toda** resposta aparecia de
        uma vez na tela. Aqui o pedido vai com `stream: true`.

        As `tool_calls` chegam fatiadas (`id` e `name` no primeiro pedaço, `arguments` nos
        seguintes, agrupadas por `index`) e são remontadas exatamente como o `step()` as
        devolveria, para o eco continuar casando com a assinatura que o host guarda.
        """
        modelo = self.resolve_model(model)
        payload: dict[str, Any] = {
            "model": modelo,
            "stream": True,
            "messages": messages,
        }
        if tools:
            payload["tools"] = tools
        if self.manda_esforco:
            payload["reasoning_effort"] = await self.esforco(reasoning, modelo, effort)

        texto: list[str] = []
        parciais: dict[int, dict[str, str]] = {}
        uso: dict[str, Any] = {}
        filtro = FiltroIdentidade(self.settings.assistente)

        try:
            async with httpx.AsyncClient(timeout=TIME_STREAM) as client:
                async with client.stream(
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
            raise TransientProviderError(f"falha ao falar com o provedor: {error}") from error

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


class GeminiProxyProvider(OpenAICompatibleProvider):
    """O gateway local (`host/c-host.exe`): a mesma API da OpenAI, do lado do serviço.

    O nome `gemini` e a classe vieram do proxy do projeto anterior e ficaram por herança — o
    que está do outro lado hoje é o gateway, que expõe o catálogo do serviço em `/v1/models`
    e recebe a conversa em `/v1/chat/completions`.

    Dele ele mantém a capacidade de **trocar de perfil**: quando o serviço publica os
    perfis disponíveis e um bate no limite, o próximo atende. Sem esse painel o caminho
    fica inerte e quem resolve é o retry com backoff.
    """

    name = "gemini"
    manda_esforco = True

    def __init__(self, settings: Settings) -> None:
        super().__init__(settings)
        self.base_url = settings.gemini_proxy_url.rstrip("/")
        self.api_key = None
        self.model = settings.gemini_model
        self.ready = True
        self.perfil = settings.gemini_profile or ""
        self.contas_url = f"{settings.gemini_web_url.rstrip('/')}/api/accounts"
        self._rotacoes = 0
        self._aceitam_none: frozenset[str] | None = None

    def headers(self) -> dict[str, str]:
        base = {"Content-Type": "application/json"}
        if self.perfil:
            base["X-Profile-Id"] = str(self.perfil)
        return base

    async def contas_livres(self) -> list[str]:
        """Perfis válidos e livres, do jeito que o serviço publica."""
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resposta = await client.get(self.contas_url)
            dados = resposta.json()
        except (httpx.HTTPError, ValueError):
            return []
        contas = dados.get("accounts") if isinstance(dados, dict) else None
        if not isinstance(contas, list):
            return []
        return [
            str(conta.get("profile_id"))
            for conta in contas
            if isinstance(conta, dict)
            and conta.get("is_valid")
            and conta.get("available")
            and conta.get("profile_id")
        ]

    #: Modelos que aceitam `reasoning_effort: none`. O serviço publica o alvo de cada um no
    #: catálogo e os que recusam o campo com 400 ficam de fora. Lido uma vez e guardado — o
    #: catálogo não muda em execução, e um catálogo que não responde deixa o conjunto vazio
    #: (todo mundo vai de `minimal`).
    async def _modelos_que_aceitam_none(self) -> frozenset[str]:
        if self._aceitam_none is not None:
            return self._aceitam_none
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
                resposta = await client.get(f"{self.base_url}/models")
            dados = resposta.json()
        except (httpx.HTTPError, ValueError):
            dados = None
        itens = dados.get("data") if isinstance(dados, dict) else None
        if not isinstance(itens, list):
            self._aceitam_none = frozenset()
            return self._aceitam_none
        self._aceitam_none = frozenset(
            str(item.get("id", "")).split("/")[-1]
            for item in itens
            if isinstance(item, dict)
            and "responses" not in str(item.get("targetFormat") or "").lower()
        )
        return self._aceitam_none

    async def esforco(self, reasoning: bool, modelo: str, escolha: str | None = None) -> str:
        """O seletor da interface manda; sem ele, o botão Reasoning — e `none` só para os
        modelos que aceitam o campo (`liz-4` e `layze-2` recusam com 400)."""
        escolhido = escolha or (ESFORCO_LIGADO if reasoning else ESFORCO_DESLIGADO)
        if escolhido != ESFORCO_DESLIGADO:
            return escolhido
        aceitam = await self._modelos_que_aceitam_none()
        return ESFORCO_DESLIGADO if modelo in aceitam else ESFORCO_SEGURO

    async def rotate(self) -> str | None:
        """Passa para a próxima conta livre; `None` quando não há outra para tentar.

        Sem conta livre não adianta girar: aí quem resolve é esperar o cooldown, e isso
        é decisão do loop (que tem o orçamento de tempo da tarefa na mão).
        """
        livres = [perfil for perfil in await self.contas_livres() if perfil != str(self.perfil)]
        if not livres:
            return None
        self._rotacoes += 1
        self.perfil = livres[self._rotacoes % len(livres)]
        return self.perfil

    #: Nomes decorativos do seletor antigo. Conversa gravada antes do host local ainda
    #: manda um desses; melhor cair no padrão do que virar um 400 no host.
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

        Antes isto devolvia o modelo padrão para qualquer coisa que não começasse com
        `gemini`, o que engolia o catálogo inteiro do host (`liz-nano`, `koda-1`,
        `layze-2`…) e mandava todo mundo para o mesmo modelo. Quem valida o id agora é o
        host, que responde com uma mensagem clara quando não reconhece.
        """
        alias = self.settings.model_aliases.get(model)
        if alias:
            return alias
        if not model or model in self.LEGADOS:
            return self.settings.gemini_model
        return model

    def _erro(self, status: int, detalhe: str) -> ProviderError:
        motivo = _motivo_do_proxy(detalhe)
        if status in TRANSITORIOS_PROXY:
            return TransientProviderError(f"o proxy respondeu {status}: {motivo}")
        return ProviderError(f"o proxy respondeu {status}: {motivo}")


def _motivo_do_proxy(detalhe: str) -> str:
    """Erro do proxy em uma linha: JSON cru atrapalha quem está lendo o chat."""
    try:
        dados = json.loads(detalhe)
    except (json.JSONDecodeError, TypeError):
        return detalhe.strip()[:200]
    mensagem = str((dados.get("error") or {}).get("message", detalhe))
    if "nenhuma conta" in mensagem.lower():
        return "o proxy está sem conta disponível (todas em cooldown)"
    if "429" in mensagem:
        return "a conta do proxy bateu no limite de cota (429)"
    return mensagem[:200]


def _json_ou_vazio(valor: Any) -> dict[str, Any]:
    if isinstance(valor, dict):
        return valor
    try:
        dados = json.loads(valor or "{}")
    except (json.JSONDecodeError, TypeError):
        return {}
    return dados if isinstance(dados, dict) else {}
