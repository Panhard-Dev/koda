"""Loop agentic: o modelo pede ferramentas, o Koda executa e devolve o resultado.

Portado do `nucleo/loop_agente.py` do projeto TOOLS, adaptado para assíncrono e para
narrar cada passo como evento SSE — assim a interface mostra a ferramenta rodando em vez
de esperar a resposta final em silêncio.

Detalhe que vem do projeto original e é obrigatório com o host: as `tool_calls` são ecoadas
**exatamente** como vieram (id + string de argumentos), porque o host guarda a assinatura da
chamada do lado dele e casa pelo id. Trocar o id, reserializar os argumentos ou reordenar o
histórico quebra o casamento.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from . import ferramentas

PROMPT_FERRAMENTAS = (
    "Você é o Koda, um agente de engenharia que executa tarefas REAIS na máquina do "
    "usuário usando as ferramentas disponíveis.\n"
    "Regras:\n"
    "1. Prefira SEMPRE usar ferramentas em vez de responder de memória.\n"
    "2. Para descobrir o estado do mundo, use list_dir/read_file; para mudar o estado, "
    "use write_file/edit_file/shell.\n"
    "3. Execute uma ferramenta por vez, leia o resultado e decida o próximo passo.\n"
    "4. Valide o próprio trabalho (rode testes/comandos) antes de terminar.\n"
    "5. Quando a tarefa estiver completa, responda em texto claro com o que foi feito, "
    "em português do Brasil.\n"
    "6. Não invente saídas de comandos: se precisar de informação, chame uma ferramenta.\n"
    "7. Trabalhe dentro da pasta de trabalho informada, a menos que a tarefa peça outro "
    "caminho.\n"
    "8. No Windows: para rodar Python inline use code_interpreter (aspas de `python -c` "
    "quebram no cmd); para scripts, grave o arquivo e execute com shell."
)

CONTINUAR = (
    "(sua mensagem anterior veio vazia ou falhou) Continue a tarefa usando as ferramentas "
    "e, quando terminar, responda em texto."
)

MAX_TENTATIVAS = 3

#: Base do backoff entre tentativas (segundos × número da tentativa, teto de 10s).
ESPERA_BASE = 3.0

#: Respostas vazias seguidas antes de desistir — sem isso o loop queima todos os passos
#: empurrando continuação para um provedor que não está respondendo.
MAX_VAZIAS = 3


@dataclass(slots=True)
class ToolCall:
    """Uma chamada pedida pelo modelo."""

    id: str
    name: str
    arguments: dict[str, Any]
    raw_arguments: str = "{}"

    def para_mensagem(self) -> dict[str, Any]:
        """Formato OpenAI, com os argumentos intactos (o proxy casa pelo id)."""
        return {
            "id": self.id,
            "type": "function",
            "function": {"name": self.name, "arguments": self.raw_arguments or "{}"},
        }


@dataclass(slots=True)
class StepResult:
    """Um passo do modelo: texto e/ou pedidos de ferramenta."""

    text: str = ""
    calls: list[ToolCall] = field(default_factory=list)
    usage: dict[str, int] = field(default_factory=dict)


@dataclass(slots=True)
class ToolStep:
    """Passo de ferramenta, o que fica gravado junto da mensagem."""

    name: str
    arguments: dict[str, Any]
    output: str
    duration_ms: int
    call_id: str = ""
    ok: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "arguments": self.arguments,
            "output": self.output,
            "duration_ms": self.duration_ms,
            "call_id": self.call_id,
            "ok": self.ok,
        }


@dataclass(slots=True)
class Resultado:
    texto: str
    passos: list[ToolStep]
    completou: bool
    uso: dict[str, int]
    motivo: str = ""


class ToolModel(Protocol):
    """O que o loop precisa de um provedor: um passo com ferramentas à mão."""

    name: str
    ready: bool

    async def step(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]], model: str = ""
    ) -> StepResult: ...


Emit = Callable[[str, dict[str, Any]], Awaitable[None]]


def _somar(destino: dict[str, int], origem: dict[str, Any]) -> None:
    for chave in destino:
        try:
            destino[chave] += int(origem.get(chave, 0) or 0)
        except (TypeError, ValueError):
            continue


def _faltando(limite: float | None) -> float | None:
    """Quanto tempo ainda resta do orçamento da tarefa."""
    return None if limite is None else limite - time.monotonic()


def _argumentos(call: ToolCall) -> dict[str, Any]:
    if isinstance(call.arguments, dict) and call.arguments:
        return call.arguments
    try:
        valor = json.loads(call.raw_arguments or "{}")
    except json.JSONDecodeError:
        return {}
    return valor if isinstance(valor, dict) else {}


async def executar(
    modelo: ToolModel,
    mensagens: list[dict[str, Any]],
    *,
    workspace: Path,
    max_steps: int,
    emit: Emit,
    negadas: set[str] | None = None,
    model: str = "",
    timeout_s: float | None = None,
    tentativas: int = MAX_TENTATIVAS,
    espera_final: float = 0.0,
    acesso_livre: bool = False,
    reasoning: bool = True,
    effort: str | None = None,
) -> Resultado:
    """Roda até o modelo encerrar sem pedir ferramenta, ou até esgotar os passos.

    Falha do provedor não é falha da tarefa: cada passo é reenviado algumas vezes, com
    o histórico inteiro que já foi construído — o modelo retoma exatamente de onde
    parou, com os resultados das ferramentas já executadas no contexto.
    """
    tools = ferramentas.catalogo(negadas)
    historico = [dict(item) for item in mensagens]
    passos: list[ToolStep] = []
    uso = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    texto_final = ""
    completou = False
    motivo = ""
    vazias = 0
    limite = time.monotonic() + timeout_s if timeout_s else None

    for numero in range(1, max(1, max_steps) + 1):
        if limite and time.monotonic() > limite:
            motivo = "o tempo da tarefa acabou antes de terminar"
            break

        # `estado` conta se o texto deste passo já saiu na tela pedaço a pedaço.
        estado = {"mostrou": False}
        resultado = await _com_tentativas(
            modelo,
            historico,
            tools,
            emit,
            numero,
            model,
            limite,
            tentativas,
            espera_final,
            estado,
            reasoning,
            effort,
        )
        if resultado is None:
            motivo = "não consegui falar com o provedor"
            break

        _somar(uso, resultado.usage)
        historico.append(_mensagem_assistente(resultado))

        if not resultado.calls and not resultado.text.strip():
            # Resposta vazia do modelo: empurra uma continuação em vez de morrer — mas
            # com um teto, senão um provedor quebrado consome a tarefa inteira calado.
            vazias += 1
            if vazias >= MAX_VAZIAS:
                motivo = "o provedor respondeu vazio " f"{vazias} vezes seguidas"
                break
            await emit(
                "delta",
                {"text": f"\n\n_(passo {numero}: resposta vazia — pedindo continuação)_\n\n"},
            )
            historico.append({"role": "user", "content": CONTINUAR})
            continue

        if resultado.text.strip():
            # Texto intermediário também aparece na tela; o respiro separa a narração
            # do que vem depois das ferramentas.
            sufixo = "\n\n" if resultado.calls else ""
            if estado["mostrou"]:
                # O texto já saiu pedaço a pedaço durante o passo: repetir aqui
                # duplicaria tudo o que o usuário já leu. Só o respiro entra.
                if sufixo:
                    await emit("delta", {"text": sufixo})
            else:
                await emit("delta", {"text": resultado.text + sufixo})

        if not resultado.calls:
            texto_final = resultado.text
            completou = True
            break

        for chamada in resultado.calls:
            argumentos = _argumentos(chamada)
            await emit(
                "tool_call",
                {
                    "id": chamada.id,
                    "name": chamada.name,
                    "arguments": argumentos,
                    "step": numero,
                },
            )

            inicio = time.perf_counter()
            saida = await asyncio.to_thread(
                ferramentas.executar,
                chamada.name,
                argumentos,
                workspace,
                negadas,
                acesso_livre=acesso_livre,
            )
            duracao = int((time.perf_counter() - inicio) * 1000)
            ok = not saida.lstrip().startswith("ERRO")

            passo = ToolStep(
                name=chamada.name,
                arguments=argumentos,
                output=saida,
                duration_ms=duracao,
                call_id=chamada.id,
                ok=ok,
            )
            passos.append(passo)
            await emit(
                "tool_result",
                {
                    "id": chamada.id,
                    "name": chamada.name,
                    "output": saida,
                    "duration_ms": duracao,
                    "ok": ok,
                    "step": numero,
                },
            )
            historico.append(
                {"role": "tool", "tool_call_id": chamada.id, "content": saida}
            )

    if not completou and not texto_final:
        motivo = motivo or f"limite de {max_steps} passos atingido sem resposta final"
        texto_final = f"Não terminei a tarefa: {motivo}."

    return Resultado(
        texto=texto_final, passos=passos, completou=completou, uso=uso, motivo=motivo
    )


def _mensagem_assistente(resultado: StepResult) -> dict[str, Any]:
    mensagem: dict[str, Any] = {"role": "assistant"}
    mensagem["content"] = resultado.text or None
    if resultado.calls:
        mensagem["tool_calls"] = [chamada.para_mensagem() for chamada in resultado.calls]
    return mensagem


async def _esperar(segundos: float, limite: float | None) -> bool:
    """Dorme respeitando o que resta do orçamento da tarefa; `False` se já acabou."""
    restante = _faltando(limite)
    if restante is not None and restante <= 0:
        return False
    await asyncio.sleep(segundos if restante is None else min(segundos, restante))
    return True


async def _trocar_conta(modelo: ToolModel, emit: Emit, numero: int) -> bool:
    """Pede outra conta ao provedor, quando ele sabe fazer isso (proxy com painel de contas)."""
    rotacionar = getattr(modelo, "rotate", None)
    if rotacionar is None:
        return False
    try:
        perfil = await rotacionar()
    except Exception:  # noqa: BLE001 — girar conta é melhor esforço, nunca derruba a tarefa
        return False
    if not perfil:
        return False
    await emit(
        "delta",
        {"text": f"\n\n_(passo {numero}: trocando para a conta {perfil} do proxy)_\n\n"},
    )
    return True


async def _executar_passo(
    modelo: ToolModel,
    historico: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    model: str,
    emit: Emit,
    estado: dict[str, bool],
    reasoning: bool = True,
    effort: str | None = None,
) -> StepResult | None:
    """Roda um passo narrando o texto conforme ele é escrito.

    Quando o provedor sabe streamar com ferramentas (`step_streaming`), o texto do passo
    sai na tela enquanto o modelo escreve — antes isso só existia no `step()`, que é
    `stream: false` e devolvia o passo inteiro num delta só. Sem `step_streaming` cai no
    `step()` de sempre.

    `estado["mostrou"]` vira `True` na primeira vez que sai texto: quem chama usa isso para
    não repetir um passo que já apareceu na tela.
    """
    streamar = getattr(modelo, "step_streaming", None)
    if streamar is None:
        return await modelo.step(historico, tools, model)

    resultado: StepResult | None = None
    async for item in streamar(historico, tools, model, reasoning, effort):
        if isinstance(item, StepResult):
            resultado = item
            continue
        if item.reasoning:
            # Raciocínio não é resposta: vai para a tela, mas não conta como "mostrou".
            await emit("reasoning", {"text": item.text})
            continue
        estado["mostrou"] = True
        await emit("delta", {"text": item.text})
    return resultado


async def _com_tentativas(
    modelo: ToolModel,
    historico: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    emit: Emit,
    numero: int,
    model: str = "",
    limite: float | None = None,
    tentativas: int = MAX_TENTATIVAS,
    espera_final: float = 0.0,
    estado: dict[str, bool] | None = None,
    reasoning: bool = True,
    effort: str | None = None,
) -> StepResult | None:
    """Reenvia o passo quando quem falhou foi o provedor — e não desiste na primeira.

    Três defesas, nesta ordem: erro de cota/indisponibilidade é repetido com backoff
    (sob 429, martelar piora); erro "de vez" (400/401/403) ganha **uma** segunda chance
    em outra conta do proxy, porque é assim que o upstream do Gemini falha no meio de
    uma conversa; e, se tudo cair, ainda espera a janela curta de cooldown e tenta uma
    última vez — um 429 em rajada passa em segundos.
    """
    from ..providers.base import ProviderError, TransientProviderError

    restantes = max(1, tentativas)
    fatais = 1  # uma segunda chance por erro não-transitório, se houver outra conta
    ultima_cartada = espera_final > 0
    #: `estado["mostrou"]` vira `True` quando já saiu texto na tela: repetir o passo
    #: duplicaria o que o usuário já leu, então nesse caso é melhor parar e avisar.
    if estado is None:
        estado = {"mostrou": False}

    while True:
        try:
            return await _executar_passo(
                modelo, historico, tools, model, emit, estado, reasoning, effort
            )
        except TransientProviderError as error:
            if estado["mostrou"]:
                await emit(
                    "delta",
                    {"text": f"\n\n[o provedor caiu no meio do passo {numero}: {error}]\n"},
                )
                return None
            restantes -= 1
            if restantes > 0:
                usadas = max(1, tentativas - restantes)
                await emit(
                    "delta",
                    {"text": f"\n\n_(passo {numero}: {error} — tentando de novo)_\n\n"},
                )
                await _trocar_conta(modelo, emit, numero)
                if not await _esperar(min(ESPERA_BASE * usadas, 10), limite):
                    return None
                continue
            if ultima_cartada:
                ultima_cartada = False
                restantes = 1
                await emit(
                    "delta",
                    {
                        "text": (
                            f"\n\n_(passo {numero}: {error} — esperando "
                            f"{espera_final:.0f}s para a conta voltar)_\n\n"
                        )
                    },
                )
                if not await _esperar(espera_final, limite):
                    return None
                continue
            await emit(
                "delta", {"text": f"\n\n[erro do provedor no passo {numero}] {error}\n"}
            )
            return None
        except ProviderError as error:
            if estado["mostrou"]:
                await emit(
                    "delta",
                    {"text": f"\n\n[o provedor caiu no meio do passo {numero}: {error}]\n"},
                )
                return None
            if fatais > 0 and await _trocar_conta(modelo, emit, numero):
                fatais -= 1
                await emit(
                    "delta",
                    {"text": f"\n\n_(passo {numero}: {error} — tentando em outra conta)_\n\n"},
                )
                continue
            await emit("delta", {"text": f"[erro do provedor no passo {numero}] {error}"})
            return None
