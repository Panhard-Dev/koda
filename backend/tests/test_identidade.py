"""Testes da identidade do assistente.

Os textos têm a **forma exata** do que chegava: apresentação com o nome do assistente e de
quem o "criou", às vezes colada na frente de resposta de tarefa — foi assim que o vazamento
apareceu nas conversas gravadas. Os nomes do criador são placeholders; os dos assistentes
são os do catálogo, que é o que o filtro precisa reconhecer.
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from app import identidade
from app.config import Settings
from app.identidade import FiltroIdentidade, limpar_identidade, regras, remover_intro
from app.providers import base as base_mod
from app.providers import openai_compat
from app.providers.base import ChatOptions, ChatTurn, system_prompt
from app.routers.chat import _turns
from app.schemas import Message

AMOSTRAS = [
    "oii, eu sou a Koda, criada pela Fulano Labs! 💜\n\nComo posso te ajudar hoje?",
    "Oii, tudo ótimo! Me chamo Layze, criada pela Fulano Labs — como posso te ajudar? 😊",
    "oii! Eu sou a Koda, criada pela Fulano Labs. 😊\n\nComo posso te ajudar hoje?",
    "Sou a Koda, criada pela Fulano Labs.",
    "Olá! Eu sou a Layze, uma IA criada pela Fulano Labs, e estou aqui para ajudar.",
    "Oii! Meu nome é Koda, fui criado pela Fulano Labs. No que posso ajudar?",
]


# --------------------------------------------------------------- corte puro


@pytest.mark.parametrize("texto", AMOSTRAS)
def test_apresentacao_sai_do_comeco(texto: str) -> None:
    limpo = remover_intro(texto)
    assert "Fulano Labs" not in limpo
    assert "criada" not in limpo.lower()
    assert "sou a Koda" not in limpo
    assert "me chamo Layze" not in limpo


def test_resposta_de_tarefa_fica_intacta_depois_do_corte() -> None:
    """Apresentação colada na frente do trabalho de verdade."""
    texto = (
        "oii, eu sou a Koda, criada pela Fulano Labs! 💜\n\n"
        "Fui dar uma olhadinha lá no caminho `C:\\recorte\\site` e olha o que achei:\n\n"
        "Tem **1 arquivo** lá dentro:\n- `hello word.html`\n\n"
        "Quer que eu abra ele pra ver o conteúdo?"
    )
    limpo = remover_intro(texto)
    assert limpo.startswith("Fui dar uma olhadinha")
    assert "hello word.html" in limpo
    assert "Fulano" not in limpo


def test_resposta_vazia_sai_com_a_identidade_do_app() -> None:
    assert limpar_identidade("Sou a Koda, criada pela Fulano Labs.").startswith("Sou o Koda")


def test_pergunta_de_python_nao_e_tocada() -> None:
    texto = (
        "Python é uma linguagem de programação de alto nível, interpretada e de tipagem "
        "dinâmica, amplamente usada por sua sintaxe simples e legível."
    )
    assert remover_intro(texto) == texto


def test_falar_de_si_no_meio_da_resposta_e_conteudo() -> None:
    """Corte só na cabeça: no meio, falar de si é resposta, não vazamento."""
    texto = (
        "Para explicar isso, imagine um assistente. Sou um exemplo: eu respondo sem "
        "inventar comandos. Fui criada para ajudar com código."
    )
    assert remover_intro(texto) == texto


def test_quem_foi_criado_sem_nome_de_assistente_nao_conta() -> None:
    texto = "Sou um modelo de linguagem criado por pesquisadores de várias universidades."
    assert remover_intro(texto) == texto


def test_travessao_separa_apresentacao_de_resposta() -> None:
    limpo = remover_intro("Me chamo Layze, criada pela Fulano Labs — como posso te ajudar? 😊")
    assert limpo.startswith("como posso te ajudar?")


# --------------------------------------------------------------- filtro (streaming)


def test_filtro_tira_a_apresentacao_pedaco_a_pedaco() -> None:
    """A apresentação pode vir cortada no meio de um pedaço — é o caso normal."""
    texto = "oii, eu sou a Koda, criada pela Fulano Labs! 💜\n\nTotal: 7 arquivos."
    filtro = FiltroIdentidade()
    saida = "".join(filtro.push(letra) for letra in texto) + filtro.fechar()
    assert "Fulano" not in saida
    assert "Total: 7 arquivos." in saida
    assert filtro.descartou is True


def test_filtro_nao_atrasa_resposta_normal() -> None:
    filtro = FiltroIdentidade()
    assert filtro.push("Claro! ") != ""
    assert filtro.push("Vou listar os arquivos.") == "Vou listar os arquivos."
    assert filtro.fechar() == ""
    assert filtro.descartou is False


def test_filtro_segura_so_a_saudacao_ate_decidir() -> None:
    """`oii!` sozinho pode ser a deixa da apresentação: vale segurar."""
    filtro = FiltroIdentidade()
    assert filtro.push("oii! ") == ""
    assert filtro.push("Eu sou a Koda, criada pela ") == ""
    assert filtro.push("Fulano Labs. 😊\n\n") == ""
    assert filtro.descartou is True
    assert filtro.fechar() == "Sou o Koda, o assistente de código deste app. Como posso ajudar?"


def test_filtro_solta_a_saudacao_quando_nao_vem_apresentacao() -> None:
    filtro = FiltroIdentidade()
    assert filtro.push("oi! ") == ""
    saida = filtro.push("Quer que eu abra a pasta do projeto?") + filtro.fechar()
    assert saida.startswith("oi! ")
    assert "abra a pasta" in saida


def test_filtro_solta_tudo_quando_a_cabeca_nao_e_apresentacao() -> None:
    filtro = FiltroIdentidade()
    # Sem fim de frase e grande: decide e libera.
    saida = filtro.push("x" * identidade.LIMITE_CABECA) + filtro.fechar()
    assert saida == "x" * identidade.LIMITE_CABECA


# --------------------------------------------------------------- prompt


def test_regras_pedem_identidade_propria_sem_criador() -> None:
    texto = regras("Koda")
    assert "Koda" in texto
    assert "criador" in texto
    assert "Liz" not in texto


def test_system_prompt_do_modo_texto_leva_as_regras() -> None:
    texto = system_prompt(ChatOptions(model="liz-nano"))
    assert "Sua identidade nesta conversa" in texto
    assert "Fulano Labs" not in texto


def test_system_prompt_usa_o_nome_configurado() -> None:
    texto = system_prompt(ChatOptions(model="liz-nano", assistente="Layze"))
    assert "Sua identidade nesta conversa é Layze" in texto


def test_nome_do_assistente_vem_da_configuracao() -> None:
    assert Settings().assistente == "Koda"
    assert Settings(assistente="Liz").assistente == "Liz"
    assert base_mod.NOME == identidade.NOME


# --------------------------------------------------------------- histórico


def test_historico_reenviado_perde_a_apresentacao() -> None:
    """O modelo repete a apresentação porque ela está no histórico dele mesmo."""
    mensagens = [
        Message(id="1", role="user", text="oi", at=0),
        Message(
            id="2",
            role="assistant",
            text="oii, eu sou a Koda, criada pela Fulano Labs! 💜\n\nComo posso ajudar?",
            at=0,
        ),
        Message(id="3", role="user", text="liste src", at=0),
    ]
    turns = _turns(mensagens)
    assert [turn.role for turn in turns] == ["user", "assistant", "user"]
    assert "Fulano Labs" not in " ".join(turn.text for turn in turns)


def test_mensagem_que_era_so_apresentacao_sai_do_historico() -> None:
    mensagens = [
        Message(id="1", role="user", text="oi", at=0),
        Message(id="2", role="assistant", text="Sou a Koda, criada pela Fulano Labs.", at=0),
        Message(id="3", role="user", text="e aí?", at=0),
    ]
    turns = _turns(mensagens)
    assert [turn.role for turn in turns] == ["user", "user"]


# --------------------------------------------------------------- provider

CORPO_SSE = "".join(
    linha
    for pedaco in [
        "oii, eu sou a ",
        "Liz, criada pela Liz ",
        "AI Studio! 💜\n\n",
        "Achei **1 arquivo**: `hello word.html`.",
    ]
    for linha in (
        "data: " + json.dumps({"choices": [{"delta": {"content": pedaco}}]}) + "\n\n",
    )
) + "data: [DONE]\n\n"


def test_stream_do_provider_nunca_manda_a_apresentacao(monkeypatch: pytest.MonkeyPatch) -> None:
    """A limpeza tem que estar no caminho por onde o texto sai — não só na função."""
    recebido: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        recebido.append(request)
        return httpx.Response(200, content=CORPO_SSE.encode())

    class ClienteFalso(httpx.AsyncClient):
        def __init__(self, **kwargs: object) -> None:
            kwargs["transport"] = httpx.MockTransport(handler)
            super().__init__(**kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(openai_compat.httpx, "AsyncClient", ClienteFalso)

    settings = Settings(provider="gemini", gemini_proxy_url="http://host-falso/v1")
    engine = openai_compat.GeminiProxyProvider(settings)

    async def cenario() -> str:
        pedacos: list[str] = []
        async for piece in engine.stream(
            [ChatTurn(role="user", text="o que tem na pasta?")],
            ChatOptions(model="liz-4", reasoning=False),
        ):
            if not piece.reasoning:
                pedacos.append(piece.text)
        return "".join(pedacos)

    saida = asyncio.run(cenario())
    assert recebido, "o provider não chamou o host"
    assert "Liz" not in saida
    assert saida.startswith("Achei **1 arquivo**")
