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

MAX_TEXTO = 100_000
"""Teto do texto de uma mensagem.

Quem usa o Koda cola arquivo, log e trecho de código na caixa de mensagem, e um paste
grande não pode ser recusado pelo próprio serviço local — era o que acontecia com o teto
antigo de 8 mil caracteres: voltava um `422` de validação e a tela mostrava só o número.
O que passar dos 100 mil é conversa que nenhum provedor aguenta; aí quem responde é o
provedor, com uma frase que dá para ler.
"""


class ChatRequest(BaseModel):
    """O que o prompt box envia ao apertar Enter."""

    text: str = Field(min_length=1, max_length=MAX_TEXTO)
    model: str = "liz-4"
    reasoning: bool = True
    effort: Effort = "auto"
    web: bool = False
    project: str | None = None
    """Pasta completa do projeto escolhido no prompt box (o nome antigo não vai mais)."""
    project_path: str | None = None
    attachments: list[str] = Field(default_factory=list)
    conversation_id: str | None = None
    """Ferramentas nesta mensagem: `None` segue a configuração do servidor."""
    tools: bool | None = None
    """Teto de passos do modo agente (o padrão vem da configuração)."""
    max_steps: int | None = Field(default=None, ge=0, le=10_000)
    """Teto de passos desta mensagem; 0 = sem teto. `None` usa o padrão da configuração."""
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


class TodoItem(BaseModel):
    """Um item da lista de tarefas que o agente mantém durante a resposta.

    É o plano da tarefa grande: o modelo divide o pedido em itens **antes** de começar a
    mexer em qualquer coisa e vai marcando cada um conforme termina. A lista fica gravada
    junto da mensagem, então quem volta à conversa depois vê o que foi feito e o que
    faltou — em vez de um monte de ferramenta solta.
    """

    texto: str = Field(min_length=1, max_length=400)
    feito: bool = False
    """Em andamento agora: o item que o agente está executando neste momento."""
    atual: bool = False


class Message(BaseModel):
    id: str
    role: Role
    text: str
    attachments: list[str] = Field(default_factory=list)
    model: str | None = None
    elapsed_ms: int | None = None
    """
    Tokens que a resposta custou, somando todos os passos do agente.

    `None` quando o provedor não conta (servidor local, provedor sem `usage`): a ficha da
    resposta simplesmente não mostra o uso, em vez de mostrar um zero mentiroso.
    """
    tokens: int | None = None
    """
    Tamanho do contexto no **último passo** da resposta, em tokens de entrada.

    É o número que o provedor contou do que foi enviado (`prompt_tokens`), não uma
    estimativa — é ele que o medidor de contexto ao lado do modelo mostra. `None` quando o
    provedor não conta.
    """
    contexto: int | None = None
    at: int
    """Ferramentas chamadas nesta resposta (vazio fora do modo agente)."""
    steps: list[ToolStepOut] = Field(default_factory=list)
    """Lista de tarefas da resposta, quando o agente montou uma (tarefa grande)."""
    todos: list[TodoItem] = Field(default_factory=list)


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
    """
    Mensagens por dia (`AAAA-MM-DD` no fuso de quem perguntou), para o mapa do ano.

    Só os dias com uso: o mapa percorre os 365 dias e procura aqui, e mandar os 365 sempre
    (quase todos zerados) só engordaria a resposta que a tela pede a cada mensagem.
    """
    dias: dict[str, int] = Field(default_factory=dict)


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
    """
    Teto de contexto do modelo, em tokens — o denominador do medidor de contexto.

    O host **não publica** a janela de cada modelo (o `/v1/models` dele traz só id, nome e
    esforços), então o número aqui é o teto que o próprio Koda aplica à conversa
    (`KODA_CONTEXT_TOKENS`). É o valor honesto: medir contra uma janela inventada daria um
    percentual bonito e falso.
    """
    janela: int | None = None
    """
    Teto de contexto do modelo, em tokens — o denominador do medidor de contexto.

    O host **não publica** a janela de cada modelo (o `/v1/models` dele traz só id, nome e
    esforços), então o número aqui é o teto que o próprio Koda aplica à conversa
    (`KODA_CONTEXT_TOKENS`). É o valor honesto: medir contra uma janela inventada daria um
    percentual bonito e falso.
    """
    janela: int | None = None


class SkillInfo(BaseModel):
    """Uma skill instalada, do jeito que a seção Skills mostra."""

    name: str
    description: str
    """`projeto` = dentro do workspace (o agente consegue ler); `global` = da máquina."""
    scope: Literal["projeto", "global"]
    """Caminho do SKILL.md — relativo ao workspace quando for do projeto."""
    path: str
    """Desligada, a skill sai do prompt do agente (o arquivo continua em disco)."""
    enabled: bool = True


class McpInfo(BaseModel):
    """Um servidor MCP configurado, do jeito que o submenu MCPs mostra."""

    name: str
    description: str = ""
    enabled: bool = True


class CloudEstado(BaseModel):
    """Resumo da nuvem dentro do `/api/health`.

    Vai curto de propósito: a tela já chama `/api/health` ao carregar, então o aviso de
    atualização chega sem uma segunda requisição. Sem nuvem configurada (ou sem resposta
    ainda) tudo fica `false` e a interface não mostra nada.
    """

    ativo: bool = False
    disponivel: bool = False
    canal: str = "stable"
    update_available: bool = False
    latest_version: str | None = None
    download_url: str | None = None
    #: Só o host do serviço na nuvem, para a tela de Ajustes mostrar o destino.
    servico: str | None = None


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
    """Teto de contexto em tokens; 0 desliga a compactação."""
    contexto_tokens: int = 0
    """Estado da nuvem (Koda Cloud), quando há uma configurada."""
    cloud: CloudEstado = Field(default_factory=CloudEstado)


Permissao = Literal["sim", "sempre", "nao", "nunca"]
"""As quatro respostas do cartão de permissão (Sim, Sempre permitir, Não, Nunca permitir)."""

ModoPermissao = Literal["manual", "default", "auto"]


class ApprovalDecision(BaseModel):
    """Resposta do cartão de permissão, para o passo que está esperando."""

    id: str = Field(min_length=1, max_length=64)
    decisao: Permissao


class ApprovalMode(BaseModel):
    modo: ModoPermissao


class ProjectInput(BaseModel):
    """«Usar pasta existente»: o caminho completo vem da escolha na tela."""

    caminho: str = Field(min_length=1, max_length=4096)
    nome: str | None = Field(default=None, max_length=120)


class ProjectNew(BaseModel):
    """«Começar do zero»: uma pasta nova, criada dentro da pasta-pai escolhida."""

    pasta_pai: str = Field(min_length=1, max_length=4096)
    nome: str = Field(min_length=1, max_length=120)


class Project(BaseModel):
    id: str
    nome: str
    caminho: str
    criado_em: int
    usado_em: int | None = None
    """A pasta ainda está no disco? Pasta apagada não pode virar workspace."""
    existe: bool = True


class ProjectsEstado(BaseModel):
    projetos: list[Project] = Field(default_factory=list)
    ativo_id: str | None = None
    padrao: str = ""
    """Modo de permissão em vigor (manual / default / auto)."""
    permissao: ModoPermissao = "default"


class HostSessao(BaseModel):
    """A sessão da conta que o backend passa a apresentar ao host dos modelos.

    O app não tem chave de API: quem autoriza é a conta, e o token é o mesmo access token
    que o painel emitiu. Vazio ou ausente limpa a credencial.

    O nome e o e-mail vêm junto porque é o que a tela já tem em mãos: servem para o
    assistente saber com quem está falando (ver `host_auth.rotulo_da_conta`). São opcionais
    — sem eles a conversa funciona igual, só sem saber o nome de quem escreve.
    """

    token: str | None = Field(default=None, max_length=4096)
    nome: str | None = Field(default=None, max_length=120)
    email: str | None = Field(default=None, max_length=254)


class HostSessaoEstado(BaseModel):
    """Como o provider ficou depois da troca de credencial."""

    autenticado: bool
    #: Quem a sessão identifica (`Nome (email)`), quando o front informou.
    conta: str | None = None
    provider: str
    provider_ready: bool
    tools_ready: bool


def sse(event: str, data: dict[str, Any]) -> str:
    """Formata um evento no protocolo SSE (`event:` + `data:` + linha em branco)."""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
