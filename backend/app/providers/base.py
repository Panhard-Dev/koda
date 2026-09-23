"""Contrato dos providers de resposta.

A interface chama só isso: qualquer coisa que produza pedaços de texto em streaming
serve como provider (modelo local, OpenAI, Ollama, o que vier).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from ..identidade import NOME, regras


class ProviderError(RuntimeError):
    """Falha ao falar com o provedor, já com uma mensagem que dá para mostrar na tela."""


class TransientProviderError(ProviderError):
    """Vale a pena tentar de novo: cota (429), 5xx, timeout, resposta vazia."""


@dataclass(slots=True)
class ChatTurn:
    role: str  # 'user' | 'assistant' | 'system'
    text: str


@dataclass(slots=True)
class ChatOptions:
    model: str
    reasoning: bool = True
    web: bool = False
    project: str | None = None
    attachments: list[str] = field(default_factory=list)
    #: Nome com que o assistente se identifica (o host injeta uma persona própria).
    assistente: str = NOME
    #: Esforço de raciocínio escolhido no seletor (`None` = o botão Reasoning decide).
    effort: str | None = None


@dataclass(slots=True)
class Piece:
    """Um pedaço do que o provedor devolve: o texto final ou o raciocínio antes dele.

    O host manda os dois no mesmo stream — `content` e `reasoning_content`. Descartar o
    raciocínio deixava a tela parada enquanto o modelo pensava e a resposta parecia chegar
    de uma vez: no `liz-mini-2` são **cerca de dois minutos** de raciocínio (2859 pedaços)
    antes da primeira palavra do texto.
    """

    text: str
    reasoning: bool = False


@runtime_checkable
class Provider(Protocol):
    name: str
    ready: bool

    def stream(self, turns: list[ChatTurn], options: ChatOptions) -> AsyncIterator[Piece]:
        """Produz o raciocínio e o texto da resposta em pedaços, na ordem."""
        ...


def system_prompt(options: ChatOptions) -> str:
    """Instrução base enviada aos provedores reais."""
    parts: list[str] = [
        "Você é o Koda, um assistente de programação dentro de uma interface de chat.",
        "Responda em português do Brasil, direto ao ponto, com blocos de código quando ajudar.",
    ]
    if options.project:
        parts.append(f"O contexto de código ativo é o projeto {options.project}.")
    if options.reasoning:
        parts.append("Pense passo a passo antes de concluir, sem narrar o raciocínio inteiro.")
    if options.web:
        parts.append("Se precisar de informação atual, diga que a busca na Web não está disponível aqui.")
    if options.attachments:
        parts.append("O usuário anexou: " + ", ".join(options.attachments) + ".")
    # A identidade vai por último: é a instrução que precisa vencer a persona que o host
    # injeta na conversa (ver `app/identidade.py`).
    parts.append(regras(options.assistente))
    return " ".join(parts)
