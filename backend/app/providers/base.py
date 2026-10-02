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
    #: Quem está logado (`Nome (email)`), quando há conta. `None` = não fala de identidade.
    conta: str | None = None
    #: Esforço de raciocínio escolhido no seletor (`None` = o botão Reasoning decide).
    effort: str | None = None
    #: Resumo do histórico antigo, quando a conversa não cabe mais inteira no contexto.
    #: Vai no prompt de sistema — é contexto de fundo, não uma fala de ninguém.
    resumo: str = ""


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
    #: Marca de controle no fim do stream quando o provedor fechou com `finish_reason=length`.
    truncated: bool = False


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
        parts.append(
            "Pense passo a passo antes de concluir, sem narrar o raciocínio inteiro. "
            "Pense em português do Brasil: o rascunho antes da resposta aparece na tela de "
            "quem está acompanhando, e rascunho em inglês no meio de uma conversa em "
            "português é vazamento de bastidor, não conteúdo."
        )
    if options.web:
        parts.append(
            "A busca na Web está ativada: pesquise pelo `web_search` do Bing. Em pedidos "
            "de pesquisa ampla, faça pelo menos três buscas com formulações diferentes e "
            "leia páginas de pelo menos três domínios independentes antes de concluir. "
            "Nunca pesquise, abra ou baixe conteúdo da Wikipedia, Wikimedia ou projetos "
            "irmãos; escolha fontes independentes."
        )
    else:
        parts.append(
            "A busca na Web está desativada nesta mensagem: não afirme que pesquisou nem "
            "use ferramentas de busca, leitura ou download da Web."
        )
    if options.resumo:
        parts.append(options.resumo)
    if options.attachments:
        parts.append(
            "Nesta conversa há anexos do usuário: "
            + ", ".join(options.attachments)
            + ". O conteúdo deles NÃO está na pasta de trabalho: para ler, use a ferramenta "
            "`read_attachment` com o id que aparece no bloco «[anexos desta mensagem]». "
            "Não tente abrir o anexo com `read_file` pelo nome — ele não está no workspace."
        )
    # Quem está do outro lado. Sem isto o assistente responde "não tenho acesso aos dados
    # da sua conta" — tecnicamente verdade, e uma péssima primeira impressão para quem
    # acabou de entrar. O e-mail é o da conta no painel, e vai só para o provedor da
    # conversa; nada é gravado aqui.
    if options.conta:
        parts.append(
            f"Quem está falando com você está logado como {options.conta}: trate a pessoa "
            "pelo nome quando fizer sentido e não pergunte quem ela é nem peça o e-mail."
        )
    # A identidade vai por último: é a instrução que precisa vencer a persona que o host
    # injeta na conversa (ver `app/identidade.py`).
    parts.append(regras(options.assistente))
    return " ".join(parts)
