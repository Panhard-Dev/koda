"""Contrato dos providers de resposta.

A interface chama só isso: qualquer coisa que produza pedaços de texto em streaming serve
como provider. Hoje são **dois** — o `host` (o serviço de modelos oficial) e o `local`, que
responde offline quando o serviço não está no ar. Não há provider de terceiro.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from ..identidade import NOME, regras


class ProviderError(RuntimeError):
    """Falha ao falar com o provedor, já com uma mensagem que dá para mostrar na tela."""


class TransientProviderError(ProviderError):
    """Vale a pena tentar de novo: cota (429), 5xx, timeout, resposta vazia."""

    def __init__(self, message: str, retry_after_s: float | None = None):
        super().__init__(message)
        self.retry_after_s = retry_after_s


@dataclass(slots=True)
class ChatTurn:
    role: str  # 'user' | 'assistant' | 'system' | 'tool'
    text: str
    #: Imagens que vão **junto** deste turno, como `data:` URLs (`data:image/png;base64,…`).
    #:
    #: Ficam no turno e não no texto porque imagem não é texto: quem as leva ao modelo é o
    #: campo `image_url` do pedido. O turno do usuário carrega o que ele anexou; o turno
    #: `tool` carrega o que a **ferramenta** devolveu como imagem — os quadros de um vídeo
    #: analisado, por exemplo. Vazio (o caso normal) manda o pedido exatamente como antes:
    #: `content` continua sendo uma string.
    imagens: list[str] = field(default_factory=list)
    #: As **chamadas de ferramenta** deste turno (`assistant`), no formato do provedor.
    #:
    #: Um turno do assistente que usou ferramenta volta ao modelo com as chamadas, e cada
    #: resultado volta como um turno `tool` que aponta para elas. Sem isto o histórico chega
    #: só com texto: o modelo vê as próprias falas **sem** as chamadas e aprende com elas a
    #: narrar em vez de chamar — defeito que só aparecia depois de alguns pedidos na mesma
    #: conversa, porque é a repetição do exemplo ruim que ensina.
    chamadas: list[dict[str, Any]] = field(default_factory=list)
    #: A qual chamada este turno responde (`tool`) — casa com `chamadas[i]["id"]`.
    chamada_id: str | None = None
    #: Eco interno para provedores que exigem o raciocínio no próximo pedido.
    reasoning_content: str | None = None


@dataclass(slots=True)
class ChatOptions:
    model: str
    reasoning: bool = True
    web: bool = False
    project: str | None = None
    attachments: list[str] = field(default_factory=list)
    #: As imagens desta conversa foram anexadas ao contexto (modelo que enxerga imagem)?
    #: Muda só o que o prompt de sistema diz sobre os anexos — sem isto ele mandaria o
    #: modelo chamar `read_attachment` para uma imagem que já está na frente dele.
    visao_ativa: bool = False
    #: Nome com que o assistente se identifica (o host injeta uma persona própria).
    assistente: str = NOME
    #: Quem está logado (`Nome (email)`), quando há conta. `None` = não fala de identidade.
    conta: str | None = None
    #: Esforço de raciocínio escolhido no seletor (`None` = o botão Reasoning decide).
    effort: str | None = None
    #: Resumo do histórico antigo, quando a conversa não cabe mais inteira no contexto.
    #: Vai no prompt de sistema — é contexto de fundo, não uma fala de ninguém.
    resumo: str = ""
    visuals: bool = True
    interactive_ui: bool = True


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
    #: Marca de controle no fim do stream quando o **raciocínio** virou laço e o provedor
    #: cortou a leitura (ver `StepResult.repetiu`). Existe separada de `truncated` porque o
    #: caminho de texto puro não recebe `StepResult` nenhum — e o alô ao modelo sai daqui.
    repetiu: bool = False
    #: O `usage` que o provedor manda no fim do stream, num pedaço **sem texto**.
    #:
    #: Existe porque o caminho de texto puro (`chat.py::_texto`) não recebe `StepResult`
    #: nenhum: o `stream()` só devolve `Piece`, e o bloco de `usage` era descartado junto
    #: com os chunks sem `choices`. Resultado: a ficha ficava sem contador de tokens sempre
    #: que as ferramentas estavam desligadas. Vai como marcador de rodapé (`text=""`).
    usage: dict[str, int] | None = None


@runtime_checkable
class Provider(Protocol):
    name: str
    #: O provider consegue atender? Existe porque um provider já podia estar sem chave (o
    #: caminho OpenAI-compatible, que saiu do produto). **Hoje os dois que restam são sempre
    #: prontos** — o host porque quem valida o id é ele, o local porque não depende de nada —
    #: então a guarda não dispara. Fica no contrato porque é ele que a interface lê
    #: (`provider_ready` no health), e porque um provider que precise de credencial volta a
    #: cair aqui em vez de falhar no meio da conversa.
    ready: bool

    def stream(self, turns: list[ChatTurn], options: ChatOptions) -> AsyncIterator[Piece]:
        """Produz o raciocínio e o texto da resposta em pedaços, na ordem."""
        ...


from .presentation import BLOCOS_VISUAIS, UI_GENERATIVA

#: **UI generativa (`koda-ui`)** — a porta para além dos formatos fixos.
#:
#: Os blocos visuais acima cobrem 21 formas previsíveis. Quando o pedido é uma
#: **interface** — contador, simulador, editor, calculadora, painel — nenhum dos 21 serve,
#: e aí a IA **descreve** a tela com a mini-linguagem `koda-ui` e o Koda **desenha**.
#:
#: É Generative UI: a IA compõe, não programa. Os componentes são fechados (`box`,
#: `button`, `slider`, `grid`, `chart`, `title`, `texto`), o estado é `useState` de
#: verdade, e a lógica é aritmética simples. Sem HTML, sem JavaScript arbitrário — o
#: texto que a IA manda é dado, e o Koda interpreta com um parser próprio, sem `eval`.

#: O nome de cada bloco, para a instrução acima e para quem for ler o código.

#: O idioma — e ele vai **por último**, de propósito.
#:
#: Instrução no começo de um prompt longo perde para o que vem depois: o "responda em
#: português do Brasil" estava na segunda linha e não bastou. Os modelos pequenos do host
#: (o free tier é o que se usa aqui) derrapam no meio da frase — já saiu resposta em
#: português com caractere chinês, palavra coreana e frase russa enfiada no meio, e a
#: explicação era sobre blocos de interface. O que chega por último é o que a amostragem
#: respeita, então a regra fecha o prompt.
#:
#: Não lista idiomas de propósito: citar "chinês, coreano, russo" aumenta a chance de eles
#: aparecerem — modelo pequeno puxa do que está escrito por perto. "Outro alfabeto" cobre
#: todos, e a saída para o termo técnico em inglês está dita, para ele não travar.
IDIOMA = (
    "**Idioma: português do Brasil, do começo ao fim.** Nenhuma palavra de outro idioma e "
    "nenhum caractere de outro alfabeto no meio do texto. Nome técnico em inglês é aceitável "
    "quando é o nome da coisa (`commit`, `pull request`, `deploy`). Se faltar a palavra em "
    "português, diga com as palavras que você tem — trocar de idioma no meio da frase é "
    "erro, não estilo."
)


def system_prompt(options: ChatOptions) -> str:
    """Instrução base enviada aos provedores reais."""
    parts: list[str] = [
        "Você é o Koda, um assistente de programação dentro de uma interface de chat.",
        "Responda em português do Brasil, direto ao ponto, com blocos de código quando ajudar.",
    ]
    if options.project:
        parts.append(f"O contexto de código ativo é o projeto {options.project}.")
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
        if options.visao_ativa:
            parts.append(
                "Nesta conversa há anexos do usuário: "
                + ", ".join(options.attachments)
                + ". Os arquivos NÃO estão na pasta de trabalho. As **imagens** já estão "
                "anexadas ao turno em que foram enviadas: você as enxerga, então descreva e "
                "responda sobre elas direto, sem chamar ferramenta. Para texto, código ou "
                "pdf, use a ferramenta `read_attachment` com o id que aparece no bloco "
                "«[anexos desta mensagem]». Não tente abrir o anexo com `read_file` pelo "
                "nome — ele não está no workspace."
            )
        else:
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
    if options.visuals:
        parts.append(BLOCOS_VISUAIS)
    if options.interactive_ui:
        parts.append(UI_GENERATIVA)
    # A identidade vence a persona que o host injeta na conversa (ver `app/identidade.py`).
    parts.append(regras(options.assistente))
    # E o idioma fecha o prompt. Ver o comentário de `IDIOMA`: instrução no começo de um
    # prompt longo perde para o que vem depois, e o modelo derrapa no meio da resposta.
    parts.append(IDIOMA)
    return " ".join(parts)
