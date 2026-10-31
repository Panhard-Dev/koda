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
import uuid
from collections.abc import AsyncIterator
from typing import Any

import httpx

from .. import koda_headers, oauth_login
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
MINIMAX_URLS = {
    "minimax-code": "https://agent.minimax.cn/mavis/api/v1/llm/v1/messages",
    "minimax-code-global": "https://agent.minimax.io/mavis/api/v1/llm/v1/messages",
}
GROK_CLI_URL = "https://cli-chat-proxy.grok.com/v1/chat/completions"
NOUS_URL = "https://inference-api.nousresearch.com/v1/chat/completions"
CLINE_URL = "https://api.cline.bot/api/v1/chat/completions"
KILO_URL = "https://api.kilo.ai/api/gateway/chat/completions"
KIMCHI_URL = "https://llm.kimchi.dev/openai/v1/chat/completions"
GLM_URL = "https://api.z.ai/api/coding/paas/v4/chat/completions"
IFLOW_URL = "https://apis.iflow.cn/v1/chat/completions"
MUSE_URL = "https://api.meta.ai/v1/responses"
CODEBUDDY_URLS = {
    "codebuddy-cn": "https://copilot.tencent.com/v2/chat/completions",
    "codebuddy-intl": "https://www.codebuddy.ai/v2/chat/completions",
}
MIMO_API_URL = "https://api.xiaomimimo.com/v1/chat/completions"


def _mimo_chave_direta(conta: dict[str, Any], modelo: str = "") -> bool:
    from .. import mimo_conta_koda

    especificos = conta.get("specific") or {}
    return not mimo_conta_koda.usa_conta(conta, modelo) and bool(
        especificos.get("apiKey") or conta.get("access")
    )


CONTAS_COM_RENOVACAO = {"antigravity", "gemini-cli", "cline", "clinepass", "codebuddy-cn", "codebuddy-intl", "grok-cli", "kimi", "kiro", "nous", "xai", *MINIMAX_URLS}


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
        self._sessao_minimax = str(uuid.uuid4())

    # ---------------------------------------------------------------- contas

    def _conta(self) -> dict[str, Any]:
        if self.provedor in {'grok-web', 'muse-web', 'gemini-web', 'deepseek-web', 'uc-web', 'chatgpt-web', 'perplexity-web'}:
            raise ProviderError("este provedor web foi removido do Koda")
        if self.provedor == "magpie":
            from .. import provedores

            if not provedores.garantir_gateway():
                raise ProviderError(
                    "o gateway não está no ar e eu não achei o binário para abrir — coloque o "
                    "magpie-windows-amd64.exe na Área de Trabalho."
                )
            return {"access": "", "conta": "gateway local"}
        dado = (oauth_login.garantir(self.settings, self.provedor) if self.provedor in CONTAS_COM_RENOVACAO
                else oauth_login.guardado(self.settings, self.provedor))
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
        conta = (await asyncio.to_thread(self._conta) if self.provedor in CONTAS_COM_RENOVACAO
                 else self._conta())

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
            async for pedaco in self._xai_stream(conta, modelo, turns, options):
                yield pedaco
            return
        if self.provedor == "github":
            async for pedaco in self._copilot_stream(conta, modelo, turns, options):
                yield pedaco
            return
        if self.provedor == "kimi":
            async for pedaco in self._compativel_stream(
                conta, modelo, turns, "https://api.kimi.com/coding/v1/chat/completions", self._kimi_cabecalhos(conta)
            ):
                yield pedaco
            return
        if self.provedor == "grok-cli":
            async for pedaco in self._compativel_stream(
                conta, modelo, turns, GROK_CLI_URL, self._grok_cabecalhos(conta, modelo)
            ):
                yield pedaco
            return
        if self.provedor == "nous":
            async for pedaco in self._compativel_stream(
                conta, modelo, turns, NOUS_URL, self._nous_cabecalhos(conta)
            ):
                yield pedaco
            return
        if self.provedor in {"cline", "clinepass"}:
            async for pedaco in self._compativel_stream(conta, modelo, turns, CLINE_URL, koda_headers.cline(conta)):
                yield pedaco
            return
        if self.provedor == "kilocode":
            async for pedaco in self._compativel_stream(conta, modelo, turns, KILO_URL, koda_headers.kilo(conta)):
                yield pedaco
            return
        if self.provedor == "kimchi":
            async for pedaco in self._compativel_stream(conta, modelo, turns, KIMCHI_URL, koda_headers.kimchi(conta)):
                yield pedaco
            return
        if self.provedor == "glm":
            async for pedaco in self._compativel_stream(conta, modelo, turns, GLM_URL, koda_headers.glm(conta)):
                yield pedaco
            return
        if self.provedor == "iflow":
            async for pedaco in self._compativel_stream(conta, modelo, turns, IFLOW_URL, koda_headers.iflow(conta)):
                yield pedaco
            return
        if self.provedor == "muse":
            async for pedaco in self._muse_stream(conta, modelo, turns):
                yield pedaco
            return
        if self.provedor in CODEBUDDY_URLS:
            mensagens = _mensagens_codebuddy(
                [{"role": turno.role, "content": turno.text} for turno in turns], self.provedor == "codebuddy-intl"
            )
            async for pedaco in self._compativel_stream(
                conta, modelo, turns, CODEBUDDY_URLS[self.provedor],
                koda_headers.codebuddy(conta, self.provedor == "codebuddy-intl"), mensagens,
            ):
                yield pedaco
            return
        if self.provedor in {"qoder", "qoder-cn"}:
            from .. import qoder_koda

            mensagens = _turnos_completos(turns)
            eventos = qoder_koda.linhas(self.provedor, conta, modelo, mensagens, [])
            async for pedaco in self._compativel_stream(conta, modelo, turns, "", {}, mensagens, eventos):
                yield pedaco
            return
        if self.provedor == "kiro":
            from .. import kiro_koda

            mensagens = _turnos_completos(turns)
            eventos = kiro_koda.linhas(conta, modelo, mensagens, [], self._marcar_esgotada)
            async for pedaco in self._compativel_stream(conta, modelo, turns, "", {}, mensagens, eventos):
                yield pedaco
            return
        if self.provedor == "windsurf":
            from .. import windsurf_koda

            mensagens = _turnos_completos(turns)
            eventos = windsurf_koda.linhas(conta, modelo, mensagens)
            async for pedaco in self._compativel_stream(conta, modelo, turns, "", {}, mensagens, eventos):
                yield pedaco
            return
        if self.provedor == "zed":
            from .. import zed_koda

            mensagens = _turnos_completos(turns)
            eventos = zed_koda.linhas(conta, modelo, mensagens, [])
            async for pedaco in self._compativel_stream(conta, modelo, turns, "", {}, mensagens, eventos):
                yield pedaco
            return
        if self.provedor in {"antigravity", "gemini-cli"}:
            from .. import google_conta_koda

            mensagens = _turnos_completos(turns)
            eventos = google_conta_koda.linhas(self.provedor, conta, modelo, mensagens, [], self._marcar_esgotada)
            async for pedaco in self._compativel_stream(conta, modelo, turns, "", {}, mensagens, eventos):
                yield pedaco
            return
        if self.provedor == "trae":
            from .. import trae_koda

            mensagens = _turnos_completos(turns)
            eventos = trae_koda.linhas(conta, modelo, mensagens)
            async for pedaco in self._compativel_stream(conta, modelo, turns, "", {}, mensagens, eventos):
                yield pedaco
            return
        if self.provedor == "gitlab":
            from .. import gitlab_koda

            mensagens = _turnos_completos(turns)
            eventos = gitlab_koda.linhas(conta, mensagens, [])
            async for pedaco in self._compativel_stream(conta, modelo, turns, "", {}, mensagens, eventos):
                yield pedaco
            return
        if self.provedor == "cursor":
            from .. import cursor_koda

            mensagens = _turnos_completos(turns)
            eventos = cursor_koda.linhas(conta, modelo, mensagens)
            async for pedaco in self._compativel_stream(conta, modelo, turns, "", {}, mensagens, eventos):
                yield pedaco
            return
        if self.provedor == "xiaomi-mimo":
            from .. import mimo_conta_koda

            if mimo_conta_koda.usa_conta(conta, modelo):
                mensagens = _turnos_completos(turns)
                eventos = mimo_conta_koda.linhas(conta, modelo, mensagens, [])
                async for pedaco in self._compativel_stream(conta, modelo, turns, "", {}, mensagens, eventos):
                    yield pedaco
                return
            if _mimo_chave_direta(conta, modelo):
                async for pedaco in self._compativel_stream(conta, modelo, turns, MIMO_API_URL, koda_headers.mimo_api(conta)):
                    yield pedaco
                return
        if self.provedor in MINIMAX_URLS:
            async for pedaco in self._minimax_stream(conta, modelo, turns):
                yield pedaco
            return
        raise ProviderError(f"o Koda não possui um adaptador de conversa para {self.provedor}")

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

    # ------------------------------------------------- provedores compatíveis

    def _minimax_cabecalhos(self, conta: dict[str, Any]) -> dict[str, str]:
        return {"authorization": f"Bearer {conta['access']}",
                **koda_headers.minimax(self._sessao_minimax)}

    async def _minimax_stream(
        self, conta: dict[str, Any], modelo: str, turns: list[ChatTurn]
    ) -> AsyncIterator[Piece]:
        corpo: dict[str, Any] = {
            "model": modelo, "max_tokens": MAX_TOKENS,
            "messages": self._mensagens(turns), "stream": True,
        }
        sistema = self._sistema(turns)
        if sistema:
            corpo["system"] = sistema
        async for linha in self._sse(MINIMAX_URLS[self.provedor], self._minimax_cabecalhos(conta), corpo, conta):
            if not linha.startswith("data:"):
                continue
            try:
                evento = json.loads(linha[5:].strip())
            except ValueError:
                continue
            tipo = evento.get("type")
            if tipo == "error":
                erro = evento.get("error") or {}
                raise ProviderError(f"MiniMax interrompeu a resposta: {str(erro)[:300]}")
            if tipo == "content_block_delta":
                delta = evento.get("delta") or {}
                if delta.get("type") == "text_delta" and delta.get("text"):
                    yield Piece(text=str(delta["text"]))
                elif delta.get("type") == "thinking_delta" and delta.get("thinking"):
                    yield Piece(text=str(delta["thinking"]), reasoning=True)
            elif tipo == "message_delta" and (evento.get("delta") or {}).get("stop_reason") == "max_tokens":
                yield Piece(text="", truncated=True)
            elif tipo == "message_stop":
                return

    async def _minimax_step(
        self, conta: dict[str, Any], modelo: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> StepResult:
        corpo: dict[str, Any] = {
            "model": modelo, "max_tokens": MAX_TOKENS, "messages": _mensagens_anthropic(messages),
        }
        sistema = _sistema_de(messages)
        if sistema:
            corpo["system"] = sistema
        if tools:
            corpo["tools"] = [_ferramenta_anthropic(item) for item in tools]
        async with httpx.AsyncClient(timeout=120.0) as cliente:
            resposta = await cliente.post(
                MINIMAX_URLS[self.provedor], headers=self._minimax_cabecalhos(conta), json=corpo,
            )
        if resposta.status_code == 429:
            self._marcar_esgotada(conta, _quando_renova(resposta.text), "limite de uso atingido")
            raise TransientProviderError("a conta está sem cota agora")
        if resposta.status_code >= 400:
            raise ProviderError(f"MiniMax respondeu {resposta.status_code}: {resposta.text[:300]}")
        dados = resposta.json()
        texto: list[str] = []
        pensamento: list[str] = []
        blocos_pensamento: list[dict[str, Any]] = []
        chamadas: list[ToolCall] = []
        for bloco in dados.get("content") or []:
            if bloco.get("type") == "text":
                texto.append(str(bloco.get("text") or ""))
            elif bloco.get("type") == "thinking":
                pensamento.append(str(bloco.get("thinking") or ""))
                blocos_pensamento.append(bloco)
            elif bloco.get("type") == "redacted_thinking":
                blocos_pensamento.append(bloco)
            elif bloco.get("type") == "tool_use":
                argumentos = bloco.get("input") if isinstance(bloco.get("input"), dict) else {}
                chamadas.append(ToolCall(
                    id=str(bloco.get("id") or ""), name=str(bloco.get("name") or ""),
                    arguments=argumentos, raw_arguments=json.dumps(argumentos, ensure_ascii=False),
                ))
        if chamadas and blocos_pensamento:
            # O próximo passo precisa devolver também as assinaturas opacas do provedor.
            chamadas[0].extra = {"_koda_minimax_thinking": blocos_pensamento}
        uso = dados.get("usage") or {}
        return StepResult(
            text="".join(texto), calls=chamadas,
            usage={"prompt_tokens": int(uso.get("input_tokens") or 0),
                   "completion_tokens": int(uso.get("output_tokens") or 0)},
            truncado=dados.get("stop_reason") == "max_tokens",
            reasoning_content="".join(pensamento) if pensamento else None,
        )

    def _kimi_cabecalhos(self, conta: dict[str, Any]) -> dict[str, str]:
        dispositivo = (conta.get("specific") or {}).get("deviceId")
        return {"authorization": f"Bearer {conta['access']}", "content-type": "application/json",
                **koda_headers.kimi(dispositivo)}

    async def _compativel_stream(
        self, conta: dict[str, Any], modelo: str, turns: list[ChatTurn],
        url: str, cabecalhos: dict[str, str], mensagens_preparadas: list[dict[str, Any]] | None = None,
        eventos: AsyncIterator[str] | None = None,
    ) -> AsyncIterator[Piece]:
        if mensagens_preparadas is not None:
            mensagens = mensagens_preparadas
        else:
            mensagens = self._mensagens(turns)
            sistema = self._sistema(turns)
            if sistema:
                mensagens.insert(0, {"role": "system", "content": sistema})
        corpo = {"model": modelo, "messages": mensagens, "stream": True}
        async for linha in eventos if eventos is not None else self._sse(url, cabecalhos, corpo, conta):
            if not linha.startswith("data:"):
                continue
            carga = linha[5:].strip()
            if carga == "[DONE]":
                return
            if not carga:
                continue
            try:
                evento = json.loads(carga)
            except ValueError:
                continue
            if evento.get("error"):
                raise ProviderError(f"o provedor interrompeu a resposta: {str(evento['error'])[:300]}")
            uso = evento.get("usage")
            if isinstance(uso, dict):
                yield Piece(text="", usage={
                    "prompt_tokens": int(uso.get("prompt_tokens") or 0),
                    "completion_tokens": int(uso.get("completion_tokens") or 0),
                })
            for escolha in evento.get("choices") or []:
                delta = escolha.get("delta") or {}
                if delta.get("reasoning_content"):
                    yield Piece(text=str(delta["reasoning_content"]), reasoning=True)
                if delta.get("content"):
                    yield Piece(text=str(delta["content"]))
                if escolha.get("finish_reason") == "length":
                    yield Piece(text="", truncated=True)

    async def _compativel_step(
        self, modelo: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]],
        url: str, cabecalhos: dict[str, str], nome: str,
    ) -> StepResult:
        corpo: dict[str, Any] = {"model": modelo, "messages": messages, "stream": False}
        if tools:
            corpo["tools"] = tools
        async with httpx.AsyncClient(timeout=180.0) as cliente:
            resposta = await cliente.post(
                url, headers=cabecalhos, json=corpo,
            )
        return _resultado_openai(resposta, nome)

    def _nous_cabecalhos(self, conta: dict[str, Any]) -> dict[str, str]:
        return {"authorization": f"Bearer {koda_headers.token_nous(conta)}", "content-type": "application/json"}

    async def _muse_stream(self, conta: dict[str, Any], modelo: str, turns: list[ChatTurn]) -> AsyncIterator[Piece]:
        mensagens = [{"role": turno.role, "content": turno.text} for turno in turns]
        corpo: dict[str, Any] = {"model": modelo, "input": _entrada_muse(mensagens), "stream": True, "store": False}
        sistema = _sistema_de(mensagens)
        if sistema:
            corpo["instructions"] = sistema
        terminou = False
        async for linha in self._sse(MUSE_URL, koda_headers.muse(conta), corpo, conta):
            if not linha.startswith("data:"):
                continue
            carga = linha[5:].strip()
            if carga == "[DONE]":
                break
            try:
                evento = json.loads(carga)
            except ValueError:
                continue
            tipo = evento.get("type")
            if tipo == "response.output_text.delta" and evento.get("delta"):
                yield Piece(text=str(evento["delta"]))
            elif tipo == "response.reasoning_summary_text.delta" and evento.get("delta"):
                yield Piece(text=str(evento["delta"]), reasoning=True)
            elif tipo == "response.failed":
                erro = (evento.get("response") or {}).get("error") or {}
                raise ProviderError(f"a Meta interrompeu a resposta: {erro.get('message') or 'sem detalhe'}")
            elif tipo in {"response.completed", "response.incomplete"}:
                terminou = True
                dados = evento.get("response") or {}
                uso = dados.get("usage") or {}
                if uso:
                    yield Piece(text="", usage={"prompt_tokens": int(uso.get("input_tokens") or 0),
                                                "completion_tokens": int(uso.get("output_tokens") or 0)})
                if tipo == "response.incomplete" or dados.get("status") == "incomplete":
                    yield Piece(text="", truncated=True)
        if not terminou:
            yield Piece(text="", truncated=True)

    async def _muse_step(
        self, conta: dict[str, Any], modelo: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> StepResult:
        corpo: dict[str, Any] = {"model": modelo, "input": _entrada_muse(messages), "store": False,
                                 "include": ["reasoning.encrypted_content"]}
        sistema = _sistema_de(messages)
        if sistema:
            corpo["instructions"] = sistema
        if tools:
            corpo["tools"] = [_ferramenta_responses(item) for item in tools]
        async with httpx.AsyncClient(timeout=180.0) as cliente:
            resposta = await cliente.post(MUSE_URL, headers=koda_headers.muse(conta), json=corpo)
        return _resultado_muse(resposta)

    def _grok_cabecalhos(self, conta: dict[str, Any], modelo: str) -> dict[str, str]:
        return {
            "authorization": f"Bearer {conta['access']}", "content-type": "application/json",
            "x-xai-token-auth": "xai-grok-cli", "x-grok-model-override": modelo,
            "user-agent": "grok-cli/0.2.1",
        }

    async def _grok_step(
        self, conta: dict[str, Any], modelo: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> StepResult:
        """Remonta texto e chamadas de ferramenta a partir do stream do Grok CLI."""
        return await self._streaming_openai_step(
            conta, modelo, messages, tools, GROK_CLI_URL, self._grok_cabecalhos(conta, modelo), "Grok"
        )

    async def _streaming_openai_step(
        self, conta: dict[str, Any], modelo: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]],
        url: str, cabecalhos: dict[str, str], nome: str,
        eventos: AsyncIterator[str] | None = None,
    ) -> StepResult:
        """Reconstrói as chamadas e o texto enviados em fragmentos SSE."""
        corpo: dict[str, Any] = {"model": modelo, "messages": messages, "stream": True}
        if tools:
            corpo["tools"] = tools
        texto: list[str] = []
        raciocinio: list[str] = []
        parciais: dict[int, dict[str, Any]] = {}
        uso: dict[str, Any] = {}
        motivo = ""
        terminou = False
        async for linha in eventos if eventos is not None else self._sse(url, cabecalhos, corpo, conta):
            if not linha.startswith("data:"):
                continue
            carga = linha[5:].strip()
            if carga == "[DONE]":
                terminou = True
                break
            try:
                evento = json.loads(carga)
            except ValueError:
                continue
            if evento.get("error"):
                raise ProviderError(f"{nome} interrompeu a resposta: {str(evento['error'])[:300]}")
            if isinstance(evento.get("usage"), dict):
                uso = evento["usage"]
            for escolha in evento.get("choices") or []:
                motivo = str(escolha.get("finish_reason") or motivo)
                delta = escolha.get("delta") or {}
                if delta.get("content"):
                    texto.append(str(delta["content"]))
                if isinstance(delta.get("reasoning_content"), str):
                    raciocinio.append(delta["reasoning_content"])
                for indice, chamada in enumerate(delta.get("tool_calls") or []):
                    try:
                        posicao = int(chamada.get("index", indice))
                    except (ValueError, TypeError):
                        continue
                    parcial = parciais.setdefault(posicao, {"id": "", "name": "", "args": "", "extra": {}})
                    if chamada.get("id"):
                        parcial["id"] = str(chamada["id"])
                    parcial["extra"].update({chave: valor for chave, valor in chamada.items()
                                              if chave not in {"index", "id", "type", "function"}})
                    funcao = chamada.get("function") or {}
                    if funcao.get("name"):
                        parcial["name"] += str(funcao["name"])
                    if funcao.get("arguments"):
                        parcial["args"] += str(funcao["arguments"])
        chamadas: list[ToolCall] = []
        for indice, parcial in sorted(parciais.items()):
            bruto = parcial["args"] or "{}"
            try:
                argumentos = json.loads(bruto)
            except (ValueError, TypeError):
                argumentos = {}
            chamadas.append(ToolCall(
                id=parcial["id"] or f"call_{indice}", name=parcial["name"],
                arguments=argumentos if isinstance(argumentos, dict) else {}, raw_arguments=bruto,
                extra=parcial["extra"] or None,
            ))
        return StepResult(
            text="".join(texto), calls=chamadas,
            usage={"prompt_tokens": int(uso.get("prompt_tokens") or 0),
                   "completion_tokens": int(uso.get("completion_tokens") or 0)},
            truncado=motivo == "length" or not (terminou or motivo),
            reasoning_content="".join(raciocinio) if raciocinio else None,
        )

    def _xai_cabecalhos(self, conta: dict[str, Any]) -> dict[str, str]:
        return {
            "authorization": f"Bearer {conta.get('access')}",
            "content-type": "application/json",
            "user-agent": "grok-cli/0.2.1",
            "x-grok-client-identifier": "grok-cli",
            "x-grok-client-version": "0.2.1",
        }

    async def _xai_stream(
        self, conta: dict[str, Any], modelo: str, turns: list[ChatTurn], options: ChatOptions
    ) -> AsyncIterator[Piece]:
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
        self, conta: dict[str, Any], modelo: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> StepResult:
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
        self, conta: dict[str, Any], modelo: str, turns: list[ChatTurn], options: ChatOptions
    ) -> AsyncIterator[Piece]:
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
        self, conta: dict[str, Any], modelo: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> StepResult:
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
                if self.provedor in CODEBUDDY_URLS and (
                    resposta.status_code >= 400 or "application/json" in resposta.headers.get("content-type", "")
                ):
                    bruto = (await resposta.aread()).decode("utf-8", "replace")
                    try:
                        erro = json.loads(bruto)
                    except ValueError:
                        erro = {}
                    if not isinstance(erro, dict):
                        erro = {}
                    if erro.get("code") == 6004 or resposta.status_code == 429:
                        self._marcar_esgotada(conta, _quando_renova(bruto), "limite de uso atingido")
                        raise TransientProviderError("a conta CodeBuddy está sem cota agora")
                    raise ProviderError(f"CodeBuddy recusou a conversa: {str(erro.get('msg') or bruto)[:300]}")
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
        conta = (await asyncio.to_thread(self._conta) if self.provedor in CONTAS_COM_RENOVACAO
                 else self._conta())
        if self.provedor == "anthropic":
            return await self._anthropic_step(conta, modelo, messages, tools)
        if self.provedor == "openai":
            return await self._openai_step(conta, modelo, messages, tools)
        if self.provedor == "magpie":
            return await self._magpie_step(modelo, messages, tools)
        if self.provedor == "xai":
            return await self._xai_step(conta, modelo, messages, tools)
        if self.provedor == "github":
            return await self._copilot_step(conta, modelo, messages, tools)
        if self.provedor == "kimi":
            return await self._compativel_step(
                modelo, messages, tools, "https://api.kimi.com/coding/v1/chat/completions",
                self._kimi_cabecalhos(conta), "Kimi",
            )
        if self.provedor == "nous":
            return await self._compativel_step(modelo, messages, tools, NOUS_URL, self._nous_cabecalhos(conta), "Nous")
        if self.provedor in {"cline", "clinepass"}:
            return await self._compativel_step(modelo, messages, tools, CLINE_URL, koda_headers.cline(conta), "Cline")
        if self.provedor == "kilocode":
            return await self._compativel_step(modelo, messages, tools, KILO_URL, koda_headers.kilo(conta), "Kilo")
        if self.provedor == "kimchi":
            return await self._compativel_step(modelo, messages, tools, KIMCHI_URL, koda_headers.kimchi(conta), "Kimchi")
        if self.provedor == "glm":
            return await self._compativel_step(modelo, messages, tools, GLM_URL, koda_headers.glm(conta), "GLM")
        if self.provedor == "iflow":
            return await self._compativel_step(modelo, messages, tools, IFLOW_URL, koda_headers.iflow(conta), "iFlow")
        if self.provedor == "muse":
            return await self._muse_step(conta, modelo, messages, tools)
        if self.provedor in CODEBUDDY_URLS:
            internacional = self.provedor == "codebuddy-intl"
            return await self._streaming_openai_step(
                conta, modelo, _mensagens_codebuddy(messages, internacional), tools,
                CODEBUDDY_URLS[self.provedor], koda_headers.codebuddy(conta, internacional), "CodeBuddy",
            )
        if self.provedor in {"qoder", "qoder-cn"}:
            from .. import qoder_koda

            eventos = qoder_koda.linhas(self.provedor, conta, modelo, messages, tools)
            return await self._streaming_openai_step(conta, modelo, messages, tools, "", {}, "Qoder", eventos)
        if self.provedor == "kiro":
            from .. import kiro_koda

            eventos = kiro_koda.linhas(conta, modelo, messages, tools, self._marcar_esgotada)
            return await self._streaming_openai_step(conta, modelo, messages, tools, "", {}, "Kiro", eventos)
        if self.provedor == "windsurf":
            from .. import windsurf_koda

            eventos = windsurf_koda.linhas(conta, modelo, messages)
            return await self._streaming_openai_step(conta, modelo, messages, tools, "", {}, "Windsurf", eventos)
        if self.provedor == "zed":
            from .. import zed_koda

            eventos = zed_koda.linhas(conta, modelo, messages, tools)
            return await self._streaming_openai_step(conta, modelo, messages, tools, "", {}, "Zed", eventos)
        if self.provedor in {"antigravity", "gemini-cli"}:
            from .. import google_conta_koda

            eventos = google_conta_koda.linhas(self.provedor, conta, modelo, messages, tools, self._marcar_esgotada)
            return await self._streaming_openai_step(conta, modelo, messages, tools, "", {}, "Google", eventos)
        if self.provedor == "trae":
            from .. import trae_koda

            eventos = trae_koda.linhas(conta, modelo, messages)
            return await self._streaming_openai_step(conta, modelo, messages, tools, "", {}, "Trae", eventos)
        if self.provedor == "gitlab":
            from .. import gitlab_koda

            eventos = gitlab_koda.linhas(conta, messages, tools)
            return await self._streaming_openai_step(conta, modelo, messages, tools, "", {}, "GitLab", eventos)
        if self.provedor == "cursor" and not tools:
            from .. import cursor_koda

            eventos = cursor_koda.linhas(conta, modelo, messages)
            return await self._streaming_openai_step(conta, modelo, messages, tools, "", {}, "Cursor", eventos)
        if self.provedor == "cursor":
            from .. import cursor_agent_koda

            eventos = cursor_agent_koda.linhas(self.settings, conta, modelo, messages, tools)
            return await self._streaming_openai_step(conta, modelo, messages, tools, "", {}, "Cursor", eventos)
        if self.provedor == "xiaomi-mimo":
            from .. import mimo_conta_koda

            if mimo_conta_koda.usa_conta(conta, modelo):
                eventos = mimo_conta_koda.linhas(conta, modelo, messages, tools)
                return await self._streaming_openai_step(conta, modelo, messages, tools, "", {}, "MiMo", eventos)
            if _mimo_chave_direta(conta, modelo):
                return await self._compativel_step(modelo, messages, tools, MIMO_API_URL, koda_headers.mimo_api(conta), "MiMo")
        if self.provedor == "grok-cli":
            return await self._grok_step(conta, modelo, messages, tools)
        if self.provedor in MINIMAX_URLS:
            return await self._minimax_step(conta, modelo, messages, tools)
        raise ProviderError(f"o Koda não possui um adaptador de conversa para {self.provedor}")

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
    if not isinstance(dados, dict):
        raise ProviderError(f"{quem} devolveu uma resposta inválida")
    if isinstance(dados.get("data"), dict) and isinstance(dados["data"].get("choices"), list):
        dados = dados["data"]
    escolhas = dados.get("choices")
    if not isinstance(escolhas, list) or not escolhas or not isinstance(escolhas[0], dict):
        raise ProviderError(f"{quem} devolveu uma resposta sem escolhas")
    escolha = escolhas[0]
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
                extra={chave: valor for chave, valor in item.items()
                       if chave not in {"id", "type", "function", "index"}} or None,
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
        truncado=escolha.get("finish_reason") == "length",
        reasoning_content=mensagem.get("reasoning_content"),
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
            for chamada in item["tool_calls"]:
                pensamento = chamada.get("_koda_minimax_thinking")
                if isinstance(pensamento, list):
                    blocos.extend(bloco for bloco in pensamento if isinstance(bloco, dict))
                    break
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


def _turnos_completos(turnos: list[ChatTurn]) -> list[dict[str, Any]]:
    mensagens: list[dict[str, Any]] = []
    for turno in turnos:
        mensagem: dict[str, Any] = {"role": turno.role, "content": turno.text}
        if turno.chamadas:
            mensagem["tool_calls"] = turno.chamadas
        if turno.chamada_id:
            mensagem["tool_call_id"] = turno.chamada_id
        if turno.reasoning_content is not None:
            mensagem["reasoning_content"] = turno.reasoning_content
        if turno.imagens:
            mensagem["content"] = ([{"type": "text", "text": turno.text}] if turno.text else []) + [
                {"type": "image_url", "image_url": {"url": imagem}} for imagem in turno.imagens
            ]
        mensagens.append(mensagem)
    return mensagens


def _mensagens_codebuddy(messages: list[dict[str, Any]], internacional: bool) -> list[dict[str, Any]]:
    """Preserva as instruções do Koda e normaliza mensagens para o gateway."""
    saida = [{**mensagem, "role": "system"} if mensagem.get("role") == "developer" else dict(mensagem)
             for mensagem in messages]
    if not saida or saida[0].get("role") != "system":
        saida.insert(0, {"role": "system", "content": "Você é Koda, um assistente de programação."})
    if internacional:
        for mensagem in saida:
            if mensagem.get("role") == "user" and isinstance(mensagem.get("content"), str):
                mensagem["content"] = [{"type": "text", "text": mensagem["content"]}]
    return saida


def _entrada_muse(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Reenvia itens Responses completos nas voltas do agente, inclusive estado opaco."""
    itens: list[dict[str, Any]] = []
    for mensagem in messages:
        chamadas = mensagem.get("tool_calls") if mensagem.get("role") == "assistant" else None
        if chamadas:
            originais = next((chamada.get("_koda_muse_output") for chamada in chamadas
                              if isinstance(chamada.get("_koda_muse_output"), list)), None)
            if originais is not None:
                itens.extend(item for item in originais if isinstance(item, dict))
            else:
                if mensagem.get("content"):
                    itens.append({"type": "message", "role": "assistant", "phase": "commentary",
                                  "content": [{"type": "output_text", "text": str(mensagem["content"])}]})
                itens.extend(_entrada_responses([mensagem]))
            continue
        itens.extend(_entrada_responses([mensagem]))
    return itens


def _resultado_muse(resposta: Any) -> StepResult:
    if resposta.status_code >= 400:
        raise ProviderError(f"Meta respondeu {resposta.status_code}: {resposta.text[:300]}")
    try:
        dados = resposta.json()
    except ValueError as erro:
        raise ProviderError("a Meta devolveu uma resposta inválida") from erro
    if not isinstance(dados, dict) or not isinstance(dados.get("output"), list):
        raise ProviderError("a Meta devolveu uma resposta sem saída")
    if dados.get("error") or dados.get("status") == "failed":
        erro = dados.get("error") if isinstance(dados.get("error"), dict) else {}
        raise ProviderError(f"a Meta interrompeu a resposta: {erro.get('message') or 'sem detalhe'}")
    texto: list[str] = []
    chamadas: list[ToolCall] = []
    itens_replay: list[dict[str, Any]] = []
    for item in dados["output"]:
        if not isinstance(item, dict):
            continue
        tipo = item.get("type")
        if tipo == "reasoning" and item.get("encrypted_content"):
            itens_replay.append(item)
        elif tipo == "message":
            itens_replay.append(item)
            for bloco in item.get("content") or []:
                if isinstance(bloco, dict) and bloco.get("type") == "output_text":
                    texto.append(str(bloco.get("text") or ""))
        elif tipo == "function_call":
            itens_replay.append(item)
            bruto = str(item.get("arguments") or "{}")
            try:
                argumentos = json.loads(bruto)
            except ValueError:
                argumentos = {}
            chamadas.append(ToolCall(id=str(item.get("call_id") or ""), name=str(item.get("name") or ""),
                                     arguments=argumentos if isinstance(argumentos, dict) else {}, raw_arguments=bruto))
    if chamadas:
        chamadas[0].extra = {"_koda_muse_output": itens_replay}
    uso = dados.get("usage") or {}
    return StepResult(text="".join(texto), calls=chamadas,
                      usage={"prompt_tokens": int(uso.get("input_tokens") or 0),
                             "completion_tokens": int(uso.get("output_tokens") or 0)},
                      truncado=dados.get("status") == "incomplete")


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
