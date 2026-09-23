"""Modelos de entrada e saída da API."""

from __future__ import annotations

import json
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

Role = Literal["user", "assistant"]


Effort = Literal["auto", "minimal", "low", "medium", "high"]
"""Esforço de raciocínio escolhido no seletor ao lado do modelo.

`auto` (padrão) deixa o botão Reasoning decidir; os outros valores vão como
`reasoning_effort` para o provedor. Sem `none` de propósito: o host recusa esse valor em
parte do catálogo (ver `providers/openai_compat.py`).
"""


class ChatRequest(BaseModel):
    """O que o prompt box envia ao apertar Enter."""

    text: str = Field(min_length=1, max_length=8000)
    model: str = "liz-nano"
    reasoning: bool = True
    effort: Effort = "auto"
    web: bool = False
    project: str | None = None
    attachments: list[str] = Field(default_factory=list)
    conversation_id: str | None = None
    """Ferramentas nesta mensagem: `None` segue a configuração do servidor."""
    tools: bool | None = None
    """Teto de passos do modo agente (o padrão vem da configuração)."""
    max_steps: int | None = Field(default=None, ge=1, le=40)
    """Fuso do cliente em minutos (como `Date.getTimezoneOffset()`), para o uso contar no dia local."""
    tz_offset_minutes: int = 0

    @field_validator("text")
    @classmethod
    def _strip(cls, value: str) -> str:
        clean = value.strip()
        if not clean:
            raise ValueError("a mensagem não pode ficar vazia")
        return clean


class ToolStepOut(BaseModel):
    """Uma ferramenta que o modelo chamou, com o que ela devolveu."""

    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    output: str = ""
    duration_ms: int = 0
    call_id: str = ""
    ok: bool = True


class Message(BaseModel):
    id: str
    role: Role
    text: str
    attachments: list[str] = Field(default_factory=list)
    model: str | None = None
    elapsed_ms: int | None = None
    at: int
    """Ferramentas chamadas nesta resposta (vazio fora do modo agente)."""
    steps: list[ToolStepOut] = Field(default_factory=list)


class ConversationSummary(BaseModel):
    id: str
    title: str
    preview: str
    message_count: int
    updated_at: int


class Conversation(ConversationSummary):
    messages: list[Message]


class UsageWindow(BaseModel):
    used: int
    limit: int


class Usage(BaseModel):
    """Números da tela de uso, já nas janelas diária, semanal e mensal."""

    daily: UsageWindow
    weekly: UsageWindow
    monthly: UsageWindow
    conversations: int
    messages: int


class Account(BaseModel):
    name: str
    plan: str
    phone: str | None = None
    google: bool = False
    email: str | None = None


class AccountPatch(BaseModel):
    phone: str | None = None
    google: bool | None = None

    @field_validator("phone")
    @classmethod
    def _digits(cls, value: str | None) -> str | None:
        if value is None:
            return None
        digits = "".join(char for char in value if char.isdigit())
        if len(digits) < 8:
            raise ValueError("telefone precisa de pelo menos 8 dígitos")
        return digits


class ModelInfo(BaseModel):
    """Um modelo que o provedor atual aceita, do jeito que o seletor precisa."""

    value: str
    label: str
    hint: str | None = None


class Health(BaseModel):
    status: Literal["ok"] = "ok"
    provider: str
    provider_ready: bool
    model: str
    database: str
    version: str
    """Pasta onde as ferramentas do modo agente trabalham."""
    workspace: str = ""
    """O provedor atual sabe chamar ferramentas?"""
    tools_ready: bool = False
    """Nomes das ferramentas disponíveis nesta configuração."""
    tools: list[str] = Field(default_factory=list)


def sse(event: str, data: dict[str, Any]) -> str:
    """Formata um evento no protocolo SSE (`event:` + `data:` + linha em branco)."""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
