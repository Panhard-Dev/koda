"""Conversar **pela conta** do provedor: OpenAI (Responses) e Anthropic (Messages).

É o caminho que faltava: até aqui a conta só listava modelos. Quando o seletor manda
`provedor:<id>:<modelo>`, quem responde é este módulo, com o token da conta e no protocolo
nativo de cada fornecedor — nada de fingir que o host sabe falar por elas.

**Os dois protocolos, e o que cada um come:**

- **OpenAI Responses** (`/backend-api/codex/responses`): `instructions` + `input` (lista de
  itens), `tools` no formato `{type: function, name, description, parameters}`, e o stream
  em SSE com `response.output_text.delta` / `response.function_call_arguments.delta`.
- **Anthropic Messages** (`/v1/messages`): `system` + `messages` com blocos `text`,
  `tools` no formato `{name, description, input_schema}`, stream com `content_block_delta`
  (`text_delta` e `input_json_delta`).

O rodízio de contas é o mesmo do resto do app: `oauth_login.guardado()` devolve a primeira
conta com cota, e um 429 marca aquela conta e passa para a próxima.
"""

from __future__ import annotations

import json
import asyncio
from collections.abc import AsyncIterator
from typing import Any

import httpx

from .. import oauth_login
from ..config import Settings
from ..contracts.turn import StepResult, ToolCall
from .base import ChatOptions, ChatTurn, Piece, ProviderError, TransientProviderError

#: O User-Agent que o backend do ChatGPT aceita — sem ele, 404 «Model not found».
CODEX_UA = "codex_cli_rs/0.162.0 (Windows 10; x86_64) vscode"
#: O gateway do magpie fala OpenAI puro, em cima de 127.0.0.1. É o caminho para os
#: fornecedores cujo protocolo é assinado (Qoder, Codex, Gemini): quem assina é ele.
MAGPIE_URL = "http://127.0.0.1:3425/v1"
CODEX_BASE = "https://chatgpt.com/backend-api/codex"
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
MAX_TOKENS = 8192


def dono(modelo: str) -> tuple[str, str] | None:
    """`provedor:<id>:<modelo>` → (id, modelo). `None` quando não é de conta."""
    if not modelo.startswith("provedor:"):
        return None
    partes = modelo.split(":", 2)
    if len(partes) < 3 or not partes[1] or not partes[2]:
        return None
    return partes[1], partes[2]


#: Níveis de pensamento que o Koda conhece, do mais raso ao mais fundo.
NIVEIS = ("none", "minimal", "low", "medium", "high", "xhigh", "max")

#: Quanto de raciocínio cada nível pede na OpenAI. O que passa de `high` é limitado a `high`:
#: a Responses API não tem `xhigh`/`max`, e mandar um valor inventado é 400 na certa.
OPENAI_ESFORCO = {
    "none": None,
    "minimal": "minimal",
    "low": "low",
    "medium": "medium",
    "high": "high",
    "xhigh": "high",
    "max": "high",
}

#: O orçamento de raciocínio da Anthropic, em tokens. O mínimo aceito é 1.024 e o
#: `max_tokens` precisa ser **maior** que o orçamento — por isso o teto é somado ao pedido.
ANTHROPIC_ORCAMENTO = {
    "none": 0,
    "minimal": 1024,
    "low": 2048,
    "medium": 4096,
    "high": 8192,
    "xhigh": 16384,
    "max": 24576,
}


def aceita_pensar(provedor: str, modelo: str) -> bool:
    """O modelo pensa? (Tabela por família — o que não está aqui não recebe o campo.)

    Mandar `reasoning` para um modelo que não raciocina, ou `thinking` para um Haiku novo
    (que usa pensamento adaptativo e recusa orçamento manual), é 400 na cara. Na dúvida, não
    manda: a resposta sai, só sem o campo.
    """
    nome = modelo.lower()
    if provedor == "openai":
        return any(
            nome.startswith(prefixo)
            for prefixo in ("gpt-5", "gpt-6", "o1", "o3", "o4", "codex")
        )
    if provedor == "anthropic":
        if "haiku" in nome:
            # Haiku 4.5+ usa pensamento adaptativo e recusa `budget_tokens` manual.
            return False
        return any(marca in nome for marca in ("opus-4", "sonnet-4", "opus-5", "sonnet-5", "3-7"))
    return False


class ContaProvider:
    """Um provedor que responde pela conta logada — OpenAI ou Anthropic."""

    name = "conta"
    ready = True
    manda_esforco = False
    manda_usage = False

    def __init__(self, settings: Settings, provedor: str) -> None:
        self.settings = settings
        self.provedor = provedor

    # ---------------------------------------------------------------- contas

    def _conta(self) -> dict[str, Any]:
        if self.provedor == "magpie":
            from .. import provedores

            if not provedores.garantir_gateway():
                raise ProviderError(
                    "o gateway não está no ar e eu não achei o binário para abrir — coloque o "
                    "magpie-windows-amd64.exe na Área de Trabalho."
                )
            return {"access": "", "conta": "gateway local"}
        dado = oauth_login.guardado(self.settings, self.provedor)
        if not dado or not dado.get("access"):
            raise ProviderError(
                f"nenhuma conta conectada em {self.provedor} — entre em Ajustes › "
                "Modelos e Provedores para usar este modelo."
            )
        return dado

    def _marcar_esgotada(self, conta: dict[str, Any], quando: str, motivo: str) -> None:
        oauth_login._marcar(  # noqa: SLF001 — é o único que grava a marca
            self.settings, conta["id"], esgotada_ate=quando, motivo=motivo
        )

    def resolve_model(self, modelo: str | None) -> str:
        achado = dono(modelo or "")
        return achado[1] if achado else (modelo or "")

    # --------------------------------------------------------------- stream

    async def stream(self, turns: list[ChatTurn], options: ChatOptions) -> AsyncIterator[Piece]:
        modelo = self.resolve_model(options.model)
        conta = self._conta()

        if self.provedor == "anthropic":
            async for pedaco in self._anthropic_stream(conta, modelo, turns, options):
                yield pedaco
            return
        if self.provedor == "openai":
            async for pedaco in self._openai_stream(conta, modelo, turns, options):
                yield pedaco
            return
        if self.provedor == "magpie":
            async for pedaco in self._magpie_stream(modelo, turns, options):
                yield pedaco
            return
        if self.provedor == "xai":
            async for pedaco in self._xai_stream(modelo, turns, options):
                yield pedaco
            return
        if self.provedor == "github":
            async for pedaco in self._copilot_stream(modelo, turns, options):
                yield pedaco
            return
        from .. import engine_9router

        mensagens = [{"role": turno.role, "content": turno.text} for turno in turns]
        resultado = await asyncio.to_thread(
            engine_9router.chamar, self.settings, self.provedor, conta, modelo, mensagens,
        )
        if not resultado["ok"]:
            raise ProviderError(resultado["detalhe"])
        escolha = (resultado["dados"].get("choices") or [{}])[0]
        mensagem = escolha.get("message") or {}
        if mensagem.get("reasoning_content"):
            yield Piece(text=str(mensagem["reasoning_content"]), reasoning=True)
        if mensagem.get("content"):
            yield Piece(text=str(mensagem["content"]))

    def _mensagens(self, turns: list[ChatTurn]) -> list[dict[str, Any]]:
        saida: list[dict[str, Any]] = []
        for turno in turns:
            if turno.role == "system":
                continue
            saida.append({"role": turno.role, "content": turno.text})
        return saida

    def _sistema(self, turns: list[ChatTurn]) -> str:
        return "\n\n".join(turno.text for turno in turns if turno.role == "system").strip()

    async def _anthropic_stream(
        self, conta: dict[str, Any], modelo: str, turns: list[ChatTurn], options: ChatOptions
    ) -> AsyncIterator[Piece]:
        corpo: dict[str, Any] = {
            "model": modelo,
            "max_tokens": MAX_TOKENS,
            "messages": self._mensagens(turns),
            "stream": True,
        }
        sistema = self._sistema(turns)
        if sistema:
            corpo["system"] = sistema
        _talvez_pensar(corpo, modelo, options)

        async for pedaco in self._sse(
            ANTHROPIC_URL,
            {
                "authorization": f"Bearer {conta['access']}",
                "anthropic-version": "2023-06-01",
                "anthropic-beta": "oauth-2025-04-20",
                "content-type": "application/json",
                "accept": "text/event-stream",
            },
            corpo,
            conta,
        ):
            if pedaco.startswith("data: "):
                continue
            try:
                evento = json.loads(pedaco)
            except ValueError:
                continue
            tipo = evento.get("type")
            if tipo == "content_block_delta":
                delta = evento.get("delta") or {}
                if delta.get("type") == "text_delta" and delta.get("text"):
                    yield Piece(text=str(delta["text"]))
            elif tipo == "message_stop":
                return

    async def _openai_stream(
        self, conta: dict[str, Any], modelo: str, turns: list[ChatTurn], options: ChatOptions
    ) -> AsyncIterator[Piece]:
        corpo: dict[str, Any] = {
            "model": modelo,
            "input": [
                {
                    "type": "message",
                    "role": turno.role if turno.role in ("user", "assistant") else "user",
                    "content": [{"type": "input_text", "text": turno.text}],
                }
                for turno in turns
                if turno.role != "system"
            ],
            "stream": True,
            "store": False,
        }
        sistema = self._sistema(turns)
        if sistema:
            corpo["instructions"] = sistema
        if options.reasoning and aceita_pensar("openai", modelo):
            esforco = OPENAI_ESFORCO.get(str(options.effort or "medium"), "medium")
            if esforco:
                corpo["reasoning"] = {"effort": esforco, "summary": "auto"}

        async for pedaco in self._sse(
            f"{CODEX_BASE}/responses", self._cabecalhos_openai(conta), corpo, conta
        ):
            if not pedaco.startswith("data:"):
                continue
            carga = pedaco[5:].strip()
            if not carga or carga == "[DONE]":
                continue
            try:
                evento = json.loads(carga)
            except ValueError:
                continue
            tipo = evento.get("type")
            if tipo == "response.output_text.delta" and evento.get("delta"):
                yield Piece(text=str(evento["delta"]))
            elif tipo in ("response.completed", "response.failed"):
                return

    def _turnos(self, messages: list[dict[str, Any]]) -> list[ChatTurn]:
        """Converte o histórico do agente em turnos, para o caminho do Qoder."""
        saida: list[ChatTurn] = []
        for item in messages:
            papel = str(item.get("role") or "user")
            if papel == "tool":
                continue
            saida.append(ChatTurn(role=papel, text=str(item.get("content") or "")))
        return saida

    async def _qoder_stream(
        self, modelo: str, turns: list[ChatTurn], options: ChatOptions | None
    ) -> AsyncIterator[Piece]:
        """Converte o gerador síncrono do Qoder em stream assíncrono.

        O `qoder_api.conversar` usa httpx síncrono; rodá-lo direto dentro do `async` seguraria
        o laço do servidor durante a espera da rede. Uma thread produz e a fila entrega.
        """
        import asyncio
        import threading

        mensagens = [
            {"role": turno.role, "content": [{"type": "text", "text": turno.text}]}
            for turno in turns
            if turno.role in ("user", "assistant") and turno.text
        ]
        if not mensagens:
            raise ProviderError("a mensagem está vazia")

        from .. import qoder_api

        laco = asyncio.get_running_loop()
        fila: asyncio.Queue = asyncio.Queue()

        def produzir() -> None:
            try:
                for pedaco in qoder_api.conversar(
                    self.settings, modelo, mensagens,
                    pensa=bool(getattr(options, "reasoning", True)) if options is not None else True,
                ):
                    laco.call_soon_threadsafe(fila.put_nowait, ("texto", pedaco))
            except Exception as erro:  # noqa: BLE001 — vai virar erro do provedor na tela
                laco.call_soon_threadsafe(fila.put_nowait, ("erro", erro))
            finally:
                laco.call_soon_threadsafe(fila.put_nowait, ("fim", None))

        threading.Thread(target=produzir, daemon=True).start()
        while True:
            tipo, valor = await fila.get()
            if tipo == "fim":
                return
            if tipo == "erro":
                if isinstance(valor, httpx.HTTPError):
                    raise TransientProviderError(f"o Qoder não respondeu: {valor}") from valor
                raise ProviderError(str(valor)) from valor
            yield Piece(text=str(valor))

    def _qoder_texto(
        self, modelo: str, turns: list[ChatTurn], options: ChatOptions | None
    ) -> list[str]:
        """Chama o Qoder assinado e devolve os pedaços. Erro do fornecedor vira `ProviderError`."""
        from .. import qoder_api

        mensagens = [
            {"role": turno.role, "content": [{"type": "text", "text": turno.text}]}
            for turno in turns
            if turno.role in ("user", "assistant") and turno.text
        ]
        if not mensagens:
            raise ProviderError("a mensagem está vazia")
        try:
            return list(
                qoder_api.conversar(
                    self.settings, modelo, mensagens,
                    pensa=bool(getattr(options, "reasoning", True)) if options is not None else True,
                )
            )
        except RuntimeError as erro:
            raise ProviderError(str(erro)) from erro
        except httpx.HTTPError as erro:
            raise TransientProviderError(f"o Qoder não respondeu: {erro}") from erro

    # ------------------------------------------------- xAI (token do login)

    def _xai_cabecalhos(self, conta: dict[str, Any]) -> dict[str, str]:
        return {
            "authorization": f"Bearer {conta.get('access')}",
            "content-type": "application/json",
            "user-agent": "grok-cli/0.2.1",
            "x-grok-client-identifier": "grok-cli",
            "x-grok-client-version": "0.2.1",
        }

    async def _xai_stream(
        self, modelo: str, turns: list[ChatTurn], options: ChatOptions
    ) -> AsyncIterator[Piece]:
        conta = self._conta()
        mensagens = self._mensagens(turns)
        sistema = self._sistema(turns)
        if sistema:
            mensagens = [{"role": "system", "content": sistema}] + mensagens
        corpo: dict[str, Any] = {"model": modelo, "messages": mensagens, "stream": True}
        async for linha in self._sse(
            "https://api.x.ai/v1/chat/completions", self._xai_cabecalhos(conta), corpo, conta
        ):
            if not linha.startswith("data:"):
                continue
            carga = linha[5:].strip()
            if not carga or carga == "[DONE]":
                continue
            try:
                evento = json.loads(carga)
            except ValueError:
                continue
            for escolha in evento.get("choices") or []:
                delta = escolha.get("delta") or {}
                if delta.get("reasoning_content"):
                    yield Piece(text=str(delta["reasoning_content"]), reasoning=True)
                if delta.get("content"):
                    yield Piece(text=str(delta["content"]))

    async def _xai_step(
        self, modelo: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> StepResult:
        conta = self._conta()
        corpo: dict[str, Any] = {"model": modelo, "messages": messages, "stream": False}
        if tools:
            corpo["tools"] = tools
        async with httpx.AsyncClient(timeout=180.0) as cliente:
            resposta = await cliente.post(
                "https://api.x.ai/v1/chat/completions",
                headers=self._xai_cabecalhos(conta),
                json=corpo,
            )
        return _resultado_openai(resposta, "xAI")

    # --------------------------------------------- GitHub Copilot (token do login)

    async def _copilot_token(self, conta: dict[str, Any]) -> tuple[str, dict[str, str]]:
        """Troca o token do GitHub pelo token de sessão do Copilot."""
        async with httpx.AsyncClient(timeout=30) as cliente:
            resposta = await cliente.get(
                "https://api.github.com/copilot_internal/v2/token",
                headers={
                    "authorization": f"token {conta.get('access')}",
                    "accept": "application/json",
                    "user-agent": "koda/1.0",
                },
            )
        if resposta.status_code >= 400:
            raise ProviderError(
                f"o GitHub recusou o token do Copilot ({resposta.status_code}): "
                f"{resposta.text[:200]}"
            )
        dados = resposta.json()
        token = str(dados.get("token") or "")
        if not token:
            raise ProviderError("o GitHub não devolveu token de sessão do Copilot")
        return token, {
            "authorization": f"Bearer {token}",
            "content-type": "application/json",
            "copilot-integration-id": "vscode-chat",
            "editor-version": "vscode/1.95.0",
            "editor-plugin-version": "copilot-chat/0.22.0",
            "user-agent": "GitHubCopilotChat/0.22.0",
        }

    async def _copilot_stream(
        self, modelo: str, turns: list[ChatTurn], options: ChatOptions
    ) -> AsyncIterator[Piece]:
        conta = self._conta()
        _, cabecalhos = await self._copilot_token(conta)
        mensagens = self._mensagens(turns)
        sistema = self._sistema(turns)
        if sistema:
            mensagens = [{"role": "system", "content": sistema}] + mensagens
        corpo: dict[str, Any] = {"model": modelo, "messages": mensagens, "stream": True}
        async for linha in self._sse(
            "https://api.githubcopilot.com/chat/completions", cabecalhos, corpo, conta
        ):
            if not linha.startswith("data:"):
                continue
            carga = linha[5:].strip()
            if not carga or carga == "[DONE]":
                continue
            try:
                evento = json.loads(carga)
            except ValueError:
                continue
            for escolha in evento.get("choices") or []:
                delta = escolha.get("delta") or {}
                if delta.get("content"):
                    yield Piece(text=str(delta["content"]))

    async def _copilot_step(
        self, modelo: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> StepResult:
        conta = self._conta()
        _, cabecalhos = await self._copilot_token(conta)
        corpo: dict[str, Any] = {"model": modelo, "messages": messages, "stream": False}
        if tools:
            corpo["tools"] = tools
        async with httpx.AsyncClient(timeout=180.0) as cliente:
            resposta = await cliente.post(
                "https://api.githubcopilot.com/chat/completions", headers=cabecalhos, json=corpo
            )
        return _resultado_openai(resposta, "Copilot")

    async def _magpie_stream(
        self, modelo: str, turns: list[ChatTurn], options: ChatOptions
    ) -> AsyncIterator[Piece]:
        """Conversa com o gateway do magpie — OpenAI puro, com raciocínio à parte."""
        corpo: dict[str, Any] = {
            "model": modelo,
            "messages": self._mensagens(turns),
            "stream": True,
        }
        sistema = self._sistema(turns)
        if sistema:
            corpo["messages"] = [{"role": "system", "content": sistema}] + corpo["messages"]
        if options.reasoning:
            corpo["reasoning_effort"] = str(options.effort or "medium")

        async for linha in self._sse(f"{MAGPIE_URL}/chat/completions", {}, corpo, {"conta": "magpie"}):
            if not linha.startswith("data:"):
                continue
            carga = linha[5:].strip()
            if not carga or carga == "[DONE]":
                continue
            try:
                evento = json.loads(carga)
            except ValueError:
                continue
            for escolha in evento.get("choices") or []:
                delta = escolha.get("delta") or {}
                if delta.get("reasoning_content"):
                    yield Piece(text=str(delta["reasoning_content"]), reasoning=True)
                if delta.get("content"):
                    yield Piece(text=str(delta["content"]))

    async def _magpie_step(
        self, modelo: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> StepResult:
        corpo: dict[str, Any] = {"model": modelo, "messages": messages, "stream": False}
        if tools:
            corpo["tools"] = tools
        async with httpx.AsyncClient(timeout=180.0) as cliente:
            resposta = await cliente.post(f"{MAGPIE_URL}/chat/completions", json=corpo)
        if resposta.status_code >= 400:
            raise ProviderError(f"o gateway do magpie respondeu {resposta.status_code}: "
                                f"{resposta.text[:300]}")
        dados = resposta.json()
        escolha = (dados.get("choices") or [{}])[0]
        mensagem = escolha.get("message") or {}
        chamadas: list[ToolCall] = []
        for item in mensagem.get("tool_calls") or []:
            funcao = item.get("function") or {}
            bruto = str(funcao.get("arguments") or "{}")
            try:
                entrada = json.loads(bruto)
            except ValueError:
                entrada = {}
            chamadas.append(
                ToolCall(
                    id=str(item.get("id") or ""),
                    name=str(funcao.get("name") or ""),
                    arguments=entrada if isinstance(entrada, dict) else {},
                    raw_arguments=bruto,
                )
            )
        uso = dados.get("usage") or {}
        return StepResult(
            text=str(mensagem.get("content") or ""),
            calls=chamadas,
            usage={
                "prompt_tokens": int(uso.get("prompt_tokens") or 0),
                "completion_tokens": int(uso.get("completion_tokens") or 0),
            },
        )

    def _cabecalhos_openai(self, conta: dict[str, Any]) -> dict[str, str]:
        claims = oauth_login._claims(conta.get("id_token"))  # noqa: SLF001
        conta_id = ((claims.get("https://api.openai.com/auth") or {}).get("chatgpt_account_id"))
        cabecalhos = {
            "authorization": f"Bearer {conta['access']}",
            "openai-beta": "responses=experimental",
            "originator": "codex_cli_rs",
            "version": "0.162.0",
            "user-agent": CODEX_UA,
            "accept": "text/event-stream",
            "content-type": "application/json",
        }
        if conta_id:
            cabecalhos["chatgpt-account-id"] = str(conta_id)
        return cabecalhos

    async def _sse(
        self,
        url: str,
        cabecalhos: dict[str, str],
        corpo: dict[str, Any],
        conta: dict[str, Any],
    ) -> AsyncIterator[str]:
        """Abre o stream e devolve as linhas cruas; traduz 429 e erro em exceção do Koda."""
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=20.0)) as cliente:
            async with cliente.stream("POST", url, headers=cabecalhos, json=corpo) as resposta:
                if resposta.status_code == 429:
                    texto = (await resposta.aread()).decode("utf-8", "replace")
                    quando = _quando_renova(texto)
                    self._marcar_esgotada(conta, quando, "limite de uso atingido")
                    raise TransientProviderError(
                        f"a conta {conta.get('conta') or ''} está sem cota — o Koda passa para "
                        "a próxima conta do provedor quando houver outra."
                    )
                if resposta.status_code >= 400:
                    texto = (await resposta.aread()).decode("utf-8", "replace")
                    raise ProviderError(f"o provedor respondeu {resposta.status_code}: {texto[:300]}")
                async for linha in resposta.aiter_lines():
                    if linha.strip():
                        yield linha

    # ----------------------------------------------------------------- step

    async def step(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]], model: str = ""
    ) -> StepResult:
        """Um passo do agente: texto e/ou pedidos de ferramenta, no protocolo do provedor."""
        modelo = self.resolve_model(model)
        conta = self._conta()
        if self.provedor == "anthropic":
            return await self._anthropic_step(conta, modelo, messages, tools)
        if self.provedor == "openai":
            return await self._openai_step(conta, modelo, messages, tools)
        if self.provedor == "magpie":
            return await self._magpie_step(modelo, messages, tools)
        if self.provedor == "xai":
            return await self._xai_step(modelo, messages, tools)
        if self.provedor == "github":
            return await self._copilot_step(modelo, messages, tools)
        from .. import engine_9router

        resultado = await asyncio.to_thread(
            engine_9router.chamar, self.settings, self.provedor, conta, modelo,
            messages, tools,
        )
        if not resultado["ok"]:
            raise ProviderError(resultado["detalhe"])
        dados = resultado["dados"]
        escolha = (dados.get("choices") or [{}])[0]
        mensagem = escolha.get("message") or {}
        chamadas: list[ToolCall] = []
        for item in mensagem.get("tool_calls") or []:
            funcao = item.get("function") or {}
            bruto = funcao.get("arguments") or "{}"
            try:
                argumentos = json.loads(bruto)
            except (ValueError, TypeError):
                argumentos = {}
            chamadas.append(ToolCall(
                id=str(item.get("id") or ""), name=str(funcao.get("name") or ""),
                arguments=argumentos if isinstance(argumentos, dict) else {},
                raw_arguments=bruto if isinstance(bruto, str) else json.dumps(bruto),
            ))
        return StepResult(
            text=str(mensagem.get("content") or ""), calls=chamadas,
            usage=dados.get("usage") or {},
            truncado=escolha.get("finish_reason") == "length",
            reasoning_content=mensagem.get("reasoning_content"),
        )

    async def _anthropic_step(
        self,
        conta: dict[str, Any],
        modelo: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> StepResult:
        corpo: dict[str, Any] = {
            "model": modelo,
            "max_tokens": MAX_TOKENS,
            "messages": _mensagens_anthropic(messages),
        }
        sistema = _sistema_de(messages)
        if sistema:
            corpo["system"] = sistema
        if tools:
            corpo["tools"] = [_ferramenta_anthropic(item) for item in tools]
        _talvez_pensar(corpo, modelo, None)

        async with httpx.AsyncClient(timeout=120.0) as cliente:
            resposta = await cliente.post(
                ANTHROPIC_URL,
                headers={
                    "authorization": f"Bearer {conta['access']}",
                    "anthropic-version": "2023-06-01",
                    "anthropic-beta": "oauth-2025-04-20",
                    "content-type": "application/json",
                },
                json=corpo,
            )
        if resposta.status_code == 429:
            self._marcar_esgotada(conta, _quando_renova(resposta.text), "limite de uso atingido")
            raise TransientProviderError("a conta está sem cota agora")
        if resposta.status_code >= 400:
            raise ProviderError(f"Anthropic respondeu {resposta.status_code}: {resposta.text[:300]}")

        dados = resposta.json()
        texto = ""
        chamadas: list[ToolCall] = []
        for bloco in dados.get("content") or []:
            if bloco.get("type") == "text":
                texto += str(bloco.get("text") or "")
            elif bloco.get("type") == "tool_use":
                chamadas.append(
                    ToolCall(
                        id=str(bloco.get("id") or ""),
                        name=str(bloco.get("name") or ""),
                        arguments=bloco.get("input") if isinstance(bloco.get("input"), dict) else {},
                        raw_arguments=json.dumps(bloco.get("input") or {}, ensure_ascii=False),
                    )
                )
        uso = dados.get("usage") or {}
        return StepResult(
            text=texto,
            calls=chamadas,
            usage={
                "prompt_tokens": int(uso.get("input_tokens") or 0),
                "completion_tokens": int(uso.get("output_tokens") or 0),
            },
            truncado=str(dados.get("stop_reason") or "") == "max_tokens",
        )

    async def _openai_step(
        self,
        conta: dict[str, Any],
        modelo: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> StepResult:
        """Um passo pelo Responses — **em stream**, porque o backend do ChatGPT recusa
        `stream: false` («Stream must be set to true»). O stream é lido até o fim e vira um
        `StepResult` como qualquer outro; quem consome não sabe a diferença.
        """
        corpo: dict[str, Any] = {
            "model": modelo,
            "input": _entrada_responses(messages),
            "stream": True,
            "store": False,
        }
        sistema = _sistema_de(messages)
        if sistema:
            corpo["instructions"] = sistema
        if tools:
            corpo["tools"] = [_ferramenta_responses(item) for item in tools]
        # O `step` não recebe o nível escolhido na caixa de mensagem (a assinatura não tem
        # esse parâmetro), então vai o padrão do fornecedor: `medium`. É melhor que omitir —
        # omitir faz o modelo cair no default dele, que pode ser mais caro que o pedido.
        if aceita_pensar("openai", modelo):
            corpo["reasoning"] = {"effort": "medium", "summary": "auto"}

        texto = ""
        chamadas: dict[str, dict[str, Any]] = {}
        uso: dict[str, Any] = {}

        async for linha in self._sse(f"{CODEX_BASE}/responses", self._cabecalhos_openai(conta),
                                     corpo, conta):
            if not linha.startswith("data:"):
                continue
            carga = linha[5:].strip()
            if not carga or carga == "[DONE]":
                continue
            try:
                evento = json.loads(carga)
            except ValueError:
                continue
            tipo = evento.get("type")
            if tipo == "response.output_text.delta":
                texto += str(evento.get("delta") or "")
            elif tipo == "response.output_item.added":
                item = evento.get("item") or {}
                if item.get("type") == "function_call":
                    chamadas[str(item.get("id") or "")] = {
                        "id": str(item.get("call_id") or item.get("id") or ""),
                        "name": str(item.get("name") or ""),
                        "args": str(item.get("arguments") or ""),
                    }
            elif tipo == "response.function_call_arguments.delta":
                alvo = chamadas.get(str(evento.get("item_id") or ""))
                if alvo is not None:
                    alvo["args"] += str(evento.get("delta") or "")
            elif tipo == "response.completed":
                resposta = evento.get("response") or {}
                uso = resposta.get("usage") or uso
                break
            elif tipo == "response.failed":
                erro = (evento.get("response") or {}).get("error") or {}
                raise ProviderError(f"ChatGPT falhou: {erro.get('message') or 'sem detalhe'}")

        lista: list[ToolCall] = []
        for item in chamadas.values():
            bruto = item["args"] or "{}"
            try:
                entrada = json.loads(bruto)
            except ValueError:
                entrada = {}
            lista.append(
                ToolCall(
                    id=item["id"],
                    name=item["name"],
                    arguments=entrada if isinstance(entrada, dict) else {},
                    raw_arguments=bruto,
                )
            )
        return StepResult(
            text=texto,
            calls=lista,
            usage={
                "prompt_tokens": int(uso.get("input_tokens") or 0),
                "completion_tokens": int(uso.get("output_tokens") or 0),
            },
        )


def _talvez_pensar(corpo: dict[str, Any], modelo: str, options: Any) -> None:
    """Liga o pensamento estendido da Anthropic, respeitando o contrato dela.

    `budget_tokens` mínimo é 1.024 e o `max_tokens` precisa ser **maior** que o orçamento —
    por isso o teto é recalculado. Sem nível pedido (`none`), o campo não vai: pensamento
    ligado à força gasta cota e tempo de quem só queria uma resposta curta.
    """
    if not aceita_pensar("anthropic", modelo):
        return
    nivel = str(getattr(options, "effort", "medium") or "medium") if options is not None else "medium"
    orcamento = ANTHROPIC_ORCAMENTO.get(nivel, 4096)
    if orcamento <= 0:
        return
    corpo["thinking"] = {"type": "enabled", "budget_tokens": orcamento}
    corpo["max_tokens"] = max(int(corpo.get("max_tokens") or 0), orcamento + 8192)


def _resultado_openai(resposta: Any, quem: str) -> StepResult:
    """Um `StepResult` a partir de uma resposta OpenAI (texto + tool_calls + usage)."""
    if resposta.status_code >= 400:
        raise ProviderError(f"{quem} respondeu {resposta.status_code}: {resposta.text[:300]}")
    dados = resposta.json()
    mensagem = ((dados.get("choices") or [{}])[0].get("message") or {})
    chamadas: list[ToolCall] = []
    for item in mensagem.get("tool_calls") or []:
        funcao = item.get("function") or {}
        bruto = str(funcao.get("arguments") or "{}")
        try:
            entrada = json.loads(bruto)
        except ValueError:
            entrada = {}
        chamadas.append(
            ToolCall(
                id=str(item.get("id") or ""),
                name=str(funcao.get("name") or ""),
                arguments=entrada if isinstance(entrada, dict) else {},
                raw_arguments=bruto,
            )
        )
    uso = dados.get("usage") or {}
    return StepResult(
        text=str(mensagem.get("content") or ""),
        calls=chamadas,
        usage={
            "prompt_tokens": int(uso.get("prompt_tokens") or 0),
            "completion_tokens": int(uso.get("completion_tokens") or 0),
        },
    )


# ------------------------------------------------------------------ auxiliares


def _sistema_de(messages: list[dict[str, Any]]) -> str:
    return "\n\n".join(
        str(item.get("content") or "") for item in messages if item.get("role") == "system"
    ).strip()


def _mensagens_anthropic(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Traduz o histórico do agente para o formato da Anthropic.

    Ferramenta vira `tool_result` no turno do usuário — é assim que a Anthropic espera a
    resposta de uma ferramenta, e mandar como `role: tool` faz o pedido ser recusado.
    """
    saida: list[dict[str, Any]] = []
    for item in messages:
        papel = item.get("role")
        if papel == "system":
            continue
        if papel == "tool":
            saida.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": str(item.get("tool_call_id") or ""),
                            "content": str(item.get("content") or ""),
                        }
                    ],
                }
            )
            continue
        if papel == "assistant" and item.get("tool_calls"):
            blocos: list[dict[str, Any]] = []
            if item.get("content"):
                blocos.append({"type": "text", "text": str(item["content"])})
            for chamada in item["tool_calls"]:
                funcao = chamada.get("function") or {}
                try:
                    entrada = json.loads(funcao.get("arguments") or "{}")
                except ValueError:
                    entrada = {}
                blocos.append(
                    {
                        "type": "tool_use",
                        "id": str(chamada.get("id") or ""),
                        "name": str(funcao.get("name") or ""),
                        "input": entrada,
                    }
                )
            saida.append({"role": "assistant", "content": blocos})
            continue
        saida.append({"role": papel or "user", "content": str(item.get("content") or "")})
    return saida


def _entrada_responses(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Traduz o histórico do agente para `input` do Responses."""
    itens: list[dict[str, Any]] = []
    for item in messages:
        papel = item.get("role")
        if papel == "system":
            continue
        if papel == "tool":
            itens.append(
                {
                    "type": "function_call_output",
                    "call_id": str(item.get("tool_call_id") or ""),
                    "output": str(item.get("content") or ""),
                }
            )
            continue
        if papel == "assistant" and item.get("tool_calls"):
            for chamada in item["tool_calls"]:
                funcao = chamada.get("function") or {}
                itens.append(
                    {
                        "type": "function_call",
                        "call_id": str(chamada.get("id") or ""),
                        "name": str(funcao.get("name") or ""),
                        "arguments": str(funcao.get("arguments") or "{}"),
                    }
                )
            continue
        itens.append(
            {
                "type": "message",
                "role": "assistant" if papel == "assistant" else "user",
                "content": [
                    {
                        "type": "output_text" if papel == "assistant" else "input_text",
                        "text": str(item.get("content") or ""),
                    }
                ],
            }
        )
    return itens


def _ferramenta_anthropic(item: dict[str, Any]) -> dict[str, Any]:
    funcao = item.get("function") or item
    esquema = funcao.get("parameters") or {"type": "object", "properties": {}}
    if not esquema.get("properties"):
        # A Anthropic recusa `input_schema` sem propriedades — mesma classe de erro que o
        # Bedrock deu no host (`inputSchema is empty`). Um objeto vazio explícito resolve.
        esquema = {"type": "object", "properties": {}, "additionalProperties": False}
    return {
        "name": str(funcao.get("name") or ""),
        "description": str(funcao.get("description") or ""),
        "input_schema": esquema,
    }


def _ferramenta_responses(item: dict[str, Any]) -> dict[str, Any]:
    funcao = item.get("function") or item
    return {
        "type": "function",
        "name": str(funcao.get("name") or ""),
        "description": str(funcao.get("description") or ""),
        "parameters": funcao.get("parameters") or {"type": "object", "properties": {}},
    }


def _quando_renova(texto: str) -> str:
    """O prazo do 429, do corpo; sem ele, uma hora à frente."""
    from datetime import datetime, timezone
    import time

    segundos = None
    try:
        dados = json.loads(texto)
        erro = dados.get("error") if isinstance(dados.get("error"), dict) else {}
        segundos = dados.get("resets_in_seconds") or erro.get("resets_in_seconds")
    except (ValueError, TypeError):
        pass
    if not isinstance(segundos, (int, float)) or segundos <= 0:
        segundos = 3600
    return datetime.fromtimestamp(time.time() + float(segundos), tz=timezone.utc).isoformat()
