"""Melhorar o rascunho do prompt — o botão da folha no composer.

A pessoa escreve um rascunho, clica na folha, escolhe o modo, e o texto volta
reescrito. É uma chamada de **texto puro** — `engine.stream`, sem ferramentas e sem
gravar conversa: reescrita no histórico sujaria a conversa com um texto que nunca foi
enviado. Quem responde é o provider de pé (o host, quando a conta está logada), com o
modelo que a interface mandou — a pessoa não escolhe provedor aqui, só o modelo no
seletor do composer.

## Os modos (o dono pediu cada um por um motivo)

- `criar` — a Ideia é solta; o prompt inteiro nasce daí.
- `base` — o rascunho tem base boa; melhora pra cima mantendo o que foi escrito.
- `fala` — a base e a estrutura já valem; só a forma de falar fica melhor.
- `estrutura` — a ideia é boa mas está sem separação; organiza em tarefas.
- `grafia` — só acentos e pontuação, mais nada.

## Duas regras que o dono cobrou depois da primeira versão

1. **A validação é só a necessária.** A primeira versão fazia o modelo listar
   verificação genérica de site inteiro (console, mobile, fluxo de compra…) num pedido
   que não tinha nada a ver com isso. Agora a validação cobre só o que **este** pedido
   precisa, e pode citar os recursos que existem na máquina — MCPs, skills e subs
   ativos, que o front manda na lista — quando fizerem sentido.
2. **Vários pedidos viram tarefas separadas.** Quem manda «conserta o botão da foto» e
   «resolve o 404» no mesmo texto recebia uma sopa onde os assuntos se misturavam. O
   prompt agora separa em tarefas numeradas, cada uma inteira.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Request

from ..deps import provider
from ..providers import ChatOptions, ChatTurn, ProviderError
from ..schemas import MelhorarPromptRequest, MelhorarPromptResponse

router = APIRouter(prefix="/prompt", tags=["prompt"])

#: Os modos aceitos. Nome curto porque viaja no JSON a cada clique.
ModoDoPrompt = Literal["criar", "base", "fala", "estrutura", "grafia"]

#: O que um prompt completo tem, na ordem. Guia de **conteúdo** — o formato é o
#: modelo que decide (o dono reprovou a primeira versão, que impunha os títulos
#: OBJETIVO/CONTEXTO/INSTRUÇÕES/VALIDAÇÃO na saída e fazia o modelo *descrever* a
#: reescrita em vez de escrever o prompt).
GUIA_DE_CONTEUDO = """Um prompt melhor contém, na ordem:
1. o objetivo — o que deve ser feito, numa frase;
2. o contexto — o que importa saber sobre o projeto, o ambiente e o motivo; complete com o que estiver implícito no rascunho e diga o que ainda falta saber, sem inventar fatos;
3. as instruções — os passos em ordem, com detalhe suficiente para executar sem perguntar de novo;
4. a validação — só o que for preciso verificar **para este pedido**. Não liste verificação genérica de tudo que um site ou projeto poderia ter: se o pedido é um botão torto, validar o botão, não o carrinho de compras inteiro."""

#: Vários pedidos no mesmo texto viram tarefas separadas — cada uma inteira.
TAREFAS = """Se o rascunho tiver mais de um pedido diferente, separe em tarefas numeradas (Tarefa 1, Tarefa 2, ...), cada uma com seu objetivo, contexto, instruções e validação próprios, sem misturar os assuntos num texto só. Se for um pedido só, escreva o prompt inteiro de uma vez."""

#:Texto corrido, do jeito que a pessoa escreveria — sem etiqueta nem comentário.
FORMATO = """Escreva em texto corrido e natural — o prompt final que a própria pessoa enviaria, não uma descrição dele. Sem títulos de seção, sem etiquetas e sem comentários: devolva somente o prompt. Você decide como escrever e organizar (frases, parágrafos ou lista), o que ficar mais natural para o pedido."""

#: Os recursos que existem na máquina, para a validação poder citá-los.
RECURSOS = """Você pode citar na validação os recursos que existem nesta máquina, quando fizerem sentido para o pedido: {lista}. Não invente recurso que não esteja nesta lista — e não cite recurso nenhum se o pedido não pedir verificação."""

REGRA = """Regras: preserve a intenção de quem escreveu; não acrescente exigência nova; não invente fatos; não execute nem responda o pedido — reescreva o prompt, nada mais."""

#: A instrução de cada modo: o que muda é o trabalho que o modelo faz, não as regras.
A_POR_MODO: dict[str, str] = {
    "criar": "Abaixo vai uma ideia solta, do jeito que veio à cabeça de quem escreveu. Escreva um prompt completo a partir dela, em português do Brasil.",
    "base": "Abaixo vai um rascunho de prompt escrito por uma pessoa. Reescreva-o como um prompt melhor, em português do Brasil, mantendo a base do que foi escrito.",
    "fala": "Abaixo vai um texto de prompt escrito por uma pessoa. Melhore só a fala — clareza, ordem e pontuação. Não mude o pedido, não acrescente exigência e não reestruture: se o texto já estiver separado, mantenha a separação.",
    "estrutura": "Abaixo vem um rascunho cuja ideia é boa mas está sem separação. Organize-o em tarefas separadas e bem estruturadas, sem reescrever o conteúdo além do necessário para organizar.",
    "grafia": "Abaixo vem um texto. Corrija somente acentos, pontuação e capitalização. Não mude palavras, não reordene nada e não acrescente conteúdo: devolva o mesmo texto, só grafado certo.",
}

#: Modos que reescrevem o pedido inteiro — levam o guia de conteúdo e a separação
#: por tarefas. `fala` mexe na forma (o guia atrapalharia), `grafia` não mexe em nada.
RECHEIO: dict[str, tuple[str, ...]] = {
    "criar": (GUIA_DE_CONTEUDO, TAREFAS, FORMATO, REGRA),
    "base": (GUIA_DE_CONTEUDO, TAREFAS, FORMATO, REGRA),
    "fala": (FORMATO, REGRA),
    "estrutura": (TAREFAS, GUIA_DE_CONTEUDO, FORMATO, REGRA),
    "grafia": (),
}


def receita(modo: str, mcps: list[str], skills: list[str], subs: list[str]) -> str:
    """A instrução completa deste pedido: o modo + o que vale para todos eles."""
    partes: list[str] = [A_POR_MODO.get(modo, A_POR_MODO["base"])]
    partes.extend(RECHEIO.get(modo, RECHEIO["base"]))

    disponiveis: list[str] = []
    if mcps:
        disponiveis.append("MCPs: " + ", ".join(mcps))
    if skills:
        disponiveis.append("skills: " + ", ".join(skills))
    if subs:
        disponiveis.append("subs: " + ", ".join(subs))
    if disponiveis:
        partes.append(RECURSOS.format(lista="; ".join(disponiveis)))
    return "\n\n".join(partes)


@router.post("/melhorar", response_model=MelhorarPromptResponse)
async def melhorar(
    payload: MelhorarPromptRequest, request: Request
) -> MelhorarPromptResponse:
    texto = payload.text.strip()
    if not texto:
        raise HTTPException(status_code=422, detail="Não há texto para melhorar.")

    engine = provider(request)
    modelo = (
        engine.resolve_model(payload.model)
        if hasattr(engine, "resolve_model")
        else payload.model
    )

    # O rascunho vem depois de um `---`, para o modelo saber onde a instrução acaba e
    # o texto começa.
    turns = [
        ChatTurn(
            role="user",
            text=f"{receita(payload.modo, payload.mcps, payload.skills, payload.subs)}\n\n---\n\n{texto}",
        )
    ]
    # `reasoning=False` de propósito: reescrever texto não precisa de minutos de
    # pensamento — a resposta tem de voltar rápida para a caixa. Sem anexos e sem
    # projeto: o rascunho é autocontido.
    options = ChatOptions(model=modelo, reasoning=False)

    partes: list[str] = []
    try:
        async for piece in engine.stream(turns, options):
            # Rodapé (`usage`) e marcas de controle não são texto; raciocínio também
            # não entra — só a reescrita interessa.
            if piece.usage is not None or piece.truncated or piece.repetiu:
                continue
            if piece.reasoning:
                continue
            partes.append(piece.text)
    except ProviderError as erro:
        # A mensagem do ProviderError já é mostrável (é o contrato dele) — o 502 só
        # diz ao front que a culpa foi do provedor, não do pedido.
        raise HTTPException(status_code=502, detail=str(erro)) from erro

    pronto = "".join(partes).strip()
    if not pronto:
        raise HTTPException(
            status_code=502,
            detail="O provedor não devolveu texto para melhorar o prompt.",
        )
    return MelhorarPromptResponse(prompt=pronto)
