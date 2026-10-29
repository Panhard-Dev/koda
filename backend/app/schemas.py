"""Modelos de entrada e saída da API."""

from __future__ import annotations

import json
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

Role = Literal["user", "assistant"]


Effort = Literal["auto", "minimal", "low", "medium", "high", "xhigh", "max"]
"""Esforço de raciocínio escolhido no seletor ao lado do modelo.

`auto` (padrão) deixa o botão Reasoning decidir; os outros valores vão como
`reasoning_effort` para o provedor. Sem `none` de propósito: o host recusa esse valor em
parte do catálogo (ver `providers/openai_compat.py`).

`xhigh` e `max` entraram em 10/10/2026. O host publica os **sete** níveis para 6 dos 8
modelos e o `NIVEIS_ESFORCO` daqui já os conhecia — só a API e o menu paravam em `high`,
e o topo do catálogo ficava inalcançável pela interface. Modelo que não aceita o nível
(o `layze-2` recusa `max`) é **arredondado** por `esforco_valido`, não recusado.
"""

MAX_TEXTO = 100_000
"""Teto do texto de uma mensagem.

Quem usa o Koda cola arquivo, log e trecho de código na caixa de mensagem, e um paste
grande não pode ser recusado pelo próprio serviço local — era o que acontecia com o teto
antigo de 8 mil caracteres: voltava um `422` de validação e a tela mostrava só o número.
O que passar dos 100 mil é conversa que nenhum provedor aguenta; aí quem responde é o
provedor, com uma frase que dá para ler.
"""


class AttachmentInfo(BaseModel):
    """Um anexo da conversa, como a interface o conhece depois do upload.

    O conteúdo **não** aparece aqui — quem lê é a ferramenta `read_attachment`, no backend.
    O que trafega é o `id` (o que o chat devolve em `ChatRequest.attachments`), o nome, o
    tipo e o tamanho. O caminho no store nunca sai do servidor.
    """

    id: str
    nome: str
    tipo: str
    tamanho: int


class ChatRequest(BaseModel):
    """O que o prompt box envia ao apertar Enter."""

    text: str = Field(default="", max_length=MAX_TEXTO)
    model: str = "liz-4"
    reasoning: bool = True
    effort: Effort = "auto"
    web: bool = False
    project: str | None = None
    """Pasta completa do projeto escolhido no prompt box (o nome antigo não vai mais)."""
    project_path: str | None = None
    attachments: list[str] = Field(default_factory=list)
    """Ids dos anexos desta mensagem (vindos de `POST /api/attachments`).

    **Não** são nomes de arquivo: o conteúdo do anexo nunca passa por aqui. O backend
    resolve cada id no store e a ferramenta `read_attachment` é quem lê o conteúdo. Mandar
    o nome não serve — `read_file` só enxerga o workspace, e o anexo não está lá.
    """
    conversation_id: str | None = None
    approved_plan_id: str | None = Field(default=None, max_length=64)
    """Ferramentas nesta mensagem: `None` segue a configuração do servidor."""
    tools: bool | None = None
    """Teto de passos do modo agente (o padrão vem da configuração)."""
    max_steps: int | None = Field(default=None, ge=0, le=10_000)
    """0/None usam o orçamento do servidor; um valor positivo pode reduzir esse orçamento."""
    """Fuso do cliente em minutos (como `Date.getTimezoneOffset()`), para o uso contar no dia local."""
    tz_offset_minutes: int = 0

    resume: bool = False
    """Retomar a tarefa da conversa, sem mensagem nova.

    É o clique no botão Retomar do cartão de "tarefa não concluída". A rodada anterior
    parou no meio e a pessoa quer que o agente siga de onde parou: o backend continua do
    histórico que já existe e **não** grava turno de usuário nenhum — era esse o defeito da
    versão antiga, que mandava `text: "continue"` e criava uma bolha de pessoa na tela.

    Exige `conversation_id` e dispensa `text`.
    """

    livre: bool = False
    """A rodada roda **livre**: nenhuma ação pede permissão antes de acontecer.

    É o que a aba Subs pede. Ela não tem cartão de permissão, e um pedido sem cartão deixaria
    o agente **parado para sempre** esperando uma resposta que ninguém tem onde dar — pior do
    que a pergunta que o cartão existe para fazer.

    Vale só para esta rodada: o modo guardado (`approvals.modo`) não muda, e o chat de baixo
    continua seguindo o dele.

    Quem pode pedir isto é a **interface**, que fala com o backend com o token da execução.
    O código que o agente roda não tem esse token (ver `seguranca.py`), então ele não tem
    como se autorizar sozinho por aqui — que é exatamente o achado que a porteira de
    permissão existe para fechar.
    """

    @model_validator(mode="after")
    def _exige_conteudo(self) -> ChatRequest:
        """Limpa o texto e exige **alguma** coisa: ou uma mensagem, ou um anexo.

        Texto vazio **com** anexo é válido de propósito: quem manda só o arquivo não está
        mandando mensagem vazia. Antes, `text` tinha `min_length=1` e esse caso voltava
        `422` — a interface liberava o envio e o backend recusava.

        Retomar (`resume`) também dispensa o texto: não há mensagem nova para exigir — a
        tarefa é a mesma de antes, continuada de onde parou.
        """
        self.text = self.text.strip()
        if not self.resume and not self.text and not self.attachments:
            raise ValueError("a mensagem não pode ficar vazia")
        return self


class ToolStepOut(BaseModel):
    """Uma ferramenta que o modelo chamou, com o que ela devolveu."""

    extra: dict[str, Any] | None = Field(default=None, exclude=True, repr=False)
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    output: str = ""
    duration_ms: int = 0
    call_id: str = ""
    ok: bool = True
    executed: bool = False
    status: str = "blocked"
    """A chamada como o modelo a escreveu, em texto (ver `contracts.turn.ToolStep`)."""
    raw_arguments: str = ""
    """De qual servidor MCP e de qual ferramenta é o passo (`{"servidor", "ferramenta"}`).

    Vazio nas ferramentas do Koda. É o **recurso acionado** que a interface mostra: o nome
    que o modelo vê é normalizado (`eco_server`), e mostrar esse nome na conversa seria
    mostrar um nome que não existe no `mcps.json`.
    """
    mcp: dict[str, str] | None = None
    #: Estado opaco usado apenas ao reconstruir a chamada; nunca exposto à interface.
    extra: dict[str, Any] | None = Field(default=None, exclude=True)


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
    verification: dict[str, Any] = Field(default_factory=dict)
    #: Dado interno do provedor, sem exposição pela API da conversa.
    reasoning_content: str | None = Field(default=None, exclude=True, repr=False)
    attachments: list[AttachmentInfo] = Field(default_factory=list)
    """Os anexos da mensagem, com os metadados que a tela mostra (nome, tipo, tamanho).

    Guardar os metadados junto da mensagem é o que faz a bolha mostrar o **nome** ao
    reabrir a conversa — e o que permite ao histórico remontar o bloco de anexos sem
    consultar o store. O conteúdo continua só no store, alcançável por `read_attachment`.
    """
    model: str | None = None
    elapsed_ms: int | None = None
    tokens: int | None = None
    """
    O que a resposta **escreveu**, somando os passos do agente (`completion_tokens`).

    É o tamanho da resposta, não o custo dela. O custo seria a soma de `total_tokens` — e aí
    o mesmo contexto entra uma vez por passo (cada passo reenvia o histórico inteiro), o que
    dava um número de aparência absurda na ficha. Para o custo, ver o log do provedor.

    `None` quando o provedor não conta (servidor local, provedor sem `usage`): a ficha da
    resposta simplesmente não mostra o uso, em vez de mostrar um zero mentiroso.
    """
    tokens_total: int | None = None
    """
    O **custo** da resposta, em tokens: a soma de `total_tokens` dos passos.

    É o número grande — cada passo reenvia o contexto inteiro, e é isso que o provedor cobra.
    Ele não aparece como «tamanho» na ficha (para isso existe `tokens`), mas é dele que sai a
    conta das **moedas**: é a única medida que corresponde ao que a resposta custou de verdade.

    `None` nas mensagens gravadas antes desta coluna existir, e quando o provedor não conta.
    """
    contexto: int | None = None
    """
    Tamanho do contexto no **último passo** da resposta, em tokens de entrada.

    É o número que o provedor contou do que foi enviado (`prompt_tokens`), não uma
    estimativa — é ele que o medidor de contexto ao lado do modelo mostra. `None` quando o
    provedor não conta.
    """
    at: int
    steps: list[ToolStepOut] = Field(default_factory=list)
    """Ferramentas chamadas nesta resposta (vazio fora do modo agente)."""
    todos: list[TodoItem] = Field(default_factory=list)
    """Lista de tarefas da resposta, quando o agente montou uma (tarefa grande)."""
    incompleto: bool = False
    """A rodada parou antes de terminar o que foi pedido.

    Fica **gravado** junto da mensagem de propósito: o cartão de «tarefa não concluída» tem
    de voltar quando a conversa é reaberta. Antes ele vivia só na tela, e reabrir mostrava um
    plano com um item «em andamento» e nada rodando — sem dizer que a tarefa tinha parado
    nem oferecer o Retomar.
    """
    motivo: str | None = None
    """O **código** do motivo (`loop.PARADA_*`), não a frase — quem traduz é a tela."""
    pendentes: list[str] = Field(default_factory=list)
    """Itens do plano que ficaram em aberto, com o nome que o próprio agente deu."""
    executou: int = 0
    """Quantas ferramentas rodaram de verdade: separa «nada foi executado» de «parte está no
    disco»."""
    retomavel: bool = True
    """Dá para continuar de onde parou? Falso só quando o mesmo pedido não caberia de novo."""


class ConversationSummary(BaseModel):
    id: str
    title: str
    preview: str
    message_count: int
    updated_at: int


class Conversation(ConversationSummary):
    messages: list[Message]


class UsageWindow(BaseModel):
    """
    O que a pessoa gastou numa janela — em tempo e em tokens.

    **Sem teto.** A tela mostra o uso; comparar com um limite de *mensagens* deixou de fazer
    sentido quando o plano passou a ser medido em horas e moedas. Um teto que não é o que se
    cobra é um número que confunde mais do que informa.
    """

    tempo_ms: int
    """
    Quanto tempo o agente **trabalhou** na janela (soma de `elapsed_ms`).

    É a «hora» do plano: conversa parada na tela não consome nada, só resposta conta. Mensagem
    de pessoa não entra — ela não tem `elapsed_ms`.
    """

    tokens_por_modelo: dict[str, int]
    """
    Tokens **cobrados** por modelo (soma de `tokens_total`).

    Fica em tokens, e não em moedas, de propósito: a tabela que transforma token em moeda é uma
    decisão de produto e mora num lugar só (`src/custo.ts`). O servidor ter uma segunda cópia
    dela seria a garantia de que um dia os dois números divergem.

    Por **modelo** e não num total porque o preço é por modelo: somar tokens de modelos
    diferentes e aplicar um preço só daria um número errado em qualquer conta com dois modelos.
    """


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
    status: int | None = None
    """
    O código HTTP que o modelo **devolveu de verdade** quando o Koda o testou.

    `200` = o modelo respondeu; `400` = o host disse que ele não está disponível. `None` =
    não foi testado (ou o teste não conseguiu falar com o host), e aí o seletor não escreve
    nem status nem mentira nenhuma ao lado do nome.

    É o número cru, e não um booleano, porque o seletor mostra o código ao lado do modelo
    («Liz 4 - 400»): quem olha a lista vê a prova do que aconteceu, e não um ícone genérico
    que não diz se o problema foi o modelo, a chave ou o host.
    """


class AgenteInfo(BaseModel):
    """Um sub-agente, do jeito que a seção Agentes mostra e que o `@` lista."""

    nome: str
    prompt: str = ""
    """As skills que ele pode carregar. Vazio = nenhuma — agente novo não herda poder."""
    skills: list[str] = Field(default_factory=list)
    """Os servidores MCP que ele pode usar. Vazio = nenhum."""
    mcps: list[str] = Field(default_factory=list)
    """Modelo dele, quando valer um diferente do principal. Vazio = o que o principal mandar."""
    modelo: str = ""


class AgenteInput(BaseModel):
    """O que a tela manda ao criar ou editar um sub-agente.

    O nome é o identificador: salvar com um nome que já existe **substitui** aquele agente.
    É editar, e não duplicar — quem quer outro agente dá outro nome.
    """

    nome: str = Field(min_length=1, max_length=60)
    prompt: str = Field(default="", max_length=20_000)
    skills: list[str] = Field(default_factory=list, max_length=40)
    mcps: list[str] = Field(default_factory=list, max_length=40)
    modelo: str = Field(default="", max_length=80)


class SkillInfo(BaseModel):
    """Uma skill instalada, do jeito que a seção Skills mostra."""

    name: str
    description: str
    """`projeto` = no workspace (o agente lê o arquivo); `global` = da máquina;
    `cadastrada` = criada na própria tela e guardada pelo Koda (entra no prompt inteira)."""
    scope: Literal["projeto", "global", "cadastrada"]
    """Caminho do SKILL.md — relativo ao workspace quando for do projeto; vazio quando for
    cadastrada (ela não é uma pasta em disco)."""
    path: str
    """Desligada, a skill sai do prompt do agente (o arquivo continua em disco)."""
    enabled: bool = True


class SkillCreate(BaseModel):
    """O que a tela manda ao cadastrar uma skill nova.

    Os três campos são obrigatórios: sem nome não há como listar, sem descrição o agente
    não sabe quando usar, e sem a ação a skill não faz nada. A validação de vazio é aqui
    (e não só na tela) para que a rota recuse sozinha, sem depender do cliente.
    """

    name: str
    description: str
    """O que a skill manda o agente fazer — o miolo das instruções."""
    action: str

    @field_validator("name", "description", "action")
    @classmethod
    def _nao_vazio(cls, valor: str) -> str:
        limpo = valor.strip()
        if not limpo:
            raise ValueError("campo obrigatório")
        return limpo


class McpInfo(BaseModel):
    """Um servidor MCP configurado, do jeito que o submenu MCPs mostra."""

    name: str
    description: str = ""
    """Comando (stdio) ou URL (endpoint) do servidor."""
    command: str = ""
    """Parâmetros extras do comando, como digitados."""
    params: str = ""
    enabled: bool = True
    """O servidor está no ar **agora** — o handshake MCP já respondeu.

    É estado de execução, não configuração: um servidor ligado mas que não subiu aparece
    com `conectado: false` e o motivo em `erro`. Antes, a lista só sabia dizer "ligado",
    e um comando errado parecia um servidor funcionando.
    """
    conectado: bool = False
    """Por que não conectou, quando não conectou (o que o servidor disse no `stderr`)."""
    erro: str | None = None
    """Quantas ferramentas o servidor publicou no `tools/list`."""
    ferramentas: int = 0
    """Este servidor já tem **alguma** credencial guardada (o login da Store foi feito)?

    Só o sim/não, nunca o valor — é o que a tela precisa para mostrar «Entrar» ou
    «Ativar», e vazar o token do Supabase para a interface seria trocar a segurança por
    uma conveniência de tela.
    """
    credencial: bool = False


class McpCreate(BaseModel):
    """O que a tela manda ao cadastrar um servidor MCP.

    Nome e comando são obrigatórios — sem os dois não há o que conectar. Os parâmetros são
    opcionais, porque muito servidor sobe sem nenhum.
    """

    name: str
    command: str
    params: str = ""
    description: str = ""

    @field_validator("name", "command")
    @classmethod
    def _nao_vazio(cls, valor: str) -> str:
        limpo = valor.strip()
        if not limpo:
            raise ValueError("campo obrigatório")
        return limpo


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


class HealthMinimo(BaseModel):
    """O que `/api/health` responde **sem token**.

    É de propósito que caiba em duas linhas: o launcher e a interface só precisam saber que
    existe alguém atendendo e de que versão. Workspace, caminho do banco e a lista de
    ferramentas do agente descrevem a máquina de quem instalou — isso fica no
    `/api/health/detalhado`, que exige o token da execução.
    """

    status: Literal["ok"] = "ok"
    version: str


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

ModoPermissao = Literal["plan", "manual", "default", "auto", "livre"]


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
    """Modo de permissão em vigor (manual / default / auto / livre)."""
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


class MelhorarPromptRequest(BaseModel):
    """O que a folha do composer manda: o rascunho, o modo e o que existe na máquina."""

    text: str = Field(default="", max_length=MAX_TEXTO)
    model: str = "liz-4"
    #: Como melhorar: `criar` (do zero), `base` (mantendo), `fala` (só a escrita),
    #: `estrutura` (separar em tarefas) ou `grafia` (acentos e pontuação).
    modo: Literal["criar", "base", "fala", "estrutura", "grafia"] = "base"
    #: Nomes dos recursos que a validação pode citar (só os ativos). Vazio = a
    #: receita não fala de recurso nenhum.
    mcps: list[str] = Field(default_factory=list, max_length=30)
    skills: list[str] = Field(default_factory=list, max_length=60)
    subs: list[str] = Field(default_factory=list, max_length=30)


class MelhorarPromptResponse(BaseModel):
    """O prompt reescrito, pronto para voltar para a caixa de texto."""

    prompt: str


def sse(event: str, data: dict[str, Any]) -> str:
    """Formata um evento no protocolo SSE (`event:` + `data:` + linha em branco)."""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
