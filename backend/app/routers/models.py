"""GET /api/models — quais modelos o provedor atual aceita.

O seletor da interface mostra o catálogo da casa (Liz/Koda) mais o que vier daqui: quando
é o serviço que responde, são os modelos que ele realmente tem — e o `name` que ele publica
é o rótulo preferido, para o seletor não inventar espaçamento em cima do id.

A lista sai **do maior para o menor**. O serviço não publica tamanho em lugar nenhum, então
o peso é derivado do próprio nome: o tier (`nano` < `mini` < sem tier < `pro` < `max`) e,
dentro do tier, a geração. Modelo novo se encaixa sozinho na regra, sem lista fixa.

Sem `hint`: o seletor mostra só o nome do modelo. O antigo "serviço local" que aparecia
embaixo de cada linha era ruído — o usuário já sabe de onde vem o catálogo.
"""

from __future__ import annotations

import asyncio
from collections import Counter

import httpx
from fastapi import APIRouter, Request

from ..deps import provider
from ..providers import ComTeto, HostProvider
from ..schemas import ModelInfo

router = APIRouter(tags=["models"])

#: Sufixos que não servem para conversa (geração de imagem, áudio).
FORA_DO_CHAT = ("-image", "-tts", "embedding")

#: Nome legível de "liz-3.5-flash-lite" -> "Liz 3.5 Flash Lite".
BONITO = {
    "flash": "Flash",
    "pro": "Pro",
    "lite": "Lite",
    "latest": "Latest",
    "preview": "Preview",
    "image": "Image",
    "tts": "TTS",
}

#: Tamanho por palavra do nome. Quem não estiver aqui fica no tier do meio — é o caso de
#: "liz-4", que é grande pela geração e não por um adjetivo de tier.
TIERS = {"nano": 1, "mini": 2, "flash": 3, "pro": 5, "max": 6}
TIER_PADRAO = 4


def rotulo(modelo: str) -> str:
    partes = [BONITO.get(pedaço, pedaço.capitalize()) for pedaço in modelo.split("-")]
    return " ".join(partes)


def peso(identificador: str) -> tuple[int, float]:
    """Tamanho do modelo a partir do nome: (tier, geração).

    `liz-4` → (4, 4.0) · `liz-3-flash` → (3, 3.0) · `liz-mini-2` → (2, 2.0) ·
    `liz-mini-1-3` → (2, 1.0) · `liz-nano` → (1, 0.0). Ordenando isso de forma decrescente,
    o maior vem primeiro.
    """
    partes = identificador.lower().split("-")[1:]
    tier = TIER_PADRAO
    for parte in partes:
        if parte in TIERS:
            tier = TIERS[parte]
            break
    geracao = 0.0
    for parte in partes:
        try:
            geracao = float(parte)
        except ValueError:
            continue
        break
    return (tier, geracao)


def catalogo(dados: dict, janela: int | None = None) -> list[ModelInfo]:
    """Traduz a resposta `/models` do host para o que o seletor usa.

    O host já manda o nome de exibição em `name` ("Liz Nano", "Koda 1"), então ele manda:
    `rotulo()` só entra quando o `name` falta, para não transformar "liz-3-flash" em algo
    pior do que o próprio host escolheu chamar.

    O id do provedor pode vir com namespace (`vendor/model`), e o seletor mostra o nome curto.
    Encurtar **sempre** funde dois modelos quando dois fornecedores publicam o mesmo nome: o
    usuário escolhe um e o pedido sai com o id do outro, sem ninguém perceber. Então o curto
    vale só enquanto for único — colidiu, os dois ficam com o **id integral**, que é o que o
    host aceita de volta.
    """
    entradas = [
        (str(item.get("id", "")), item)
        for item in dados.get("data") or []
        if isinstance(item, dict)
    ]
    curtos = Counter(bruto.split("/")[-1] for bruto, _ in entradas)

    itens: list[ModelInfo] = []
    for bruto, item in entradas:
        curto = bruto.split("/")[-1]
        identificador = bruto if curtos[curto] > 1 else curto
        if not identificador or any(marca in identificador for marca in FORA_DO_CHAT):
            continue
        nome = str(item.get("name") or "").strip()
        itens.append(
            ModelInfo(
                value=identificador,
                label=nome or rotulo(identificador),
                janela=janela,
            )
        )
    itens.sort(key=lambda item: peso(item.value), reverse=True)
    return itens


async def _do_host(engine: HostProvider, janela: int | None = None) -> list[ModelInfo]:
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(3.0)) as client:
            # A chave do host vai também aqui: sem ela o catálogo volta 401 e o seletor
            # aparece vazio, mesmo com o host no ar.
            resposta = await client.get(f"{engine.base_url}/models", headers=engine.headers())
            resposta.raise_for_status()
            dados = resposta.json()
    except (httpx.HTTPError, ValueError):
        return []
    return catalogo(dados if isinstance(dados, dict) else {}, janela)


#: Quanto esperar do host no teste de cada modelo.
#:
#: Curto de propósito: o teste é uma sonda de existência, não uma conversa. E ele roda em
#: paralelo, então este é o teto de **toda** a lista, não de cada modelo.
TEMPO_DO_TESTE_S = 6.0


async def _testar_modelo(
    client: httpx.AsyncClient, engine: HostProvider, modelo: str
) -> tuple[str, int | None]:
    """Pergunta ao host, por um modelo só, se ele ainda atende ali.

    O corpo é o menor pedido possível (`max_tokens=1`): o que interessa é o **código**, não
    a resposta. `200` = o modelo está vivo; `400` = o modelo saiu do catálogo do host, e é o
    que faz a interface tirá-lo do seletor.

    Devolve `(modelo, status)`, com `None` quando o teste não chegou a uma resposta HTTP —
    host fora do ar, tempo estourado, corpo que não era JSON, credencial que estourou na
    hora de montar o cabeçalho. `None` **não** é 400: um host calado não prova que o modelo
    sumiu, e riscar o modelo por causa de uma queda seria esconder da pessoa justamente o
    que ela pode usar quando o host voltar.
    """
    try:
        resposta = await client.post(
            f"{engine.base_url}/chat/completions",
            headers=engine.headers(),
            json={
                "model": modelo,
                "messages": [{"role": "user", "content": "oi"}],
                "max_tokens": 1,
            },
        )
    except Exception:
        # `Exception`, e não só `httpx.HTTPError`: o teste de um modelo não pode derrubar a
        # lista inteira. `engine.headers()` lê a sessão da conta na hora, e uma credencial
        # que explodiu ali não é erro de httpx — sem esta rede, um modelo problemático
        # apagava o seletor todo em vez de aparecer como «não testado».
        return modelo, None
    # O código cru, e não uma decisão aqui: quem escolhe o que fazer com ele é a interface.
    # O caso que interessa é o 400 com «model "x" is not available on this host» — o modelo
    # saiu do catálogo do host e não há por que oferecê-lo. Os demais (500, 429, 401) também
    # chegam à tela, mas como código ao lado do nome, não como remoção.
    return modelo, resposta.status_code


@router.get("/models/testados", response_model=list[ModelInfo])
async def models_testados(request: Request) -> list[ModelInfo]:
    """O catálogo do host, cada modelo com o código que ele devolveu de verdade.

    Existe porque o `/models` do host publica o catálogo **dele**, e esse catálogo pode
    anunciar um modelo que o host já não atende: o `liz-4` saiu do ar e continuou aparecendo
    no seletor, onde só dava 400 até alguém recarregar o app. Aqui cada modelo é testado de
    propósito, e o seletor passa a mostrar o que **responde**, com a prova ao lado do nome
    («Liz 4 - 400», «Koda 1 - 200»).

    Os testes rodam em paralelo: numa lista de dez modelos, um a um com o teto de seis
    segundos faria o seletor esperar um minuto para aparecer.

    Se o catálogo não vier (host fora do ar), a resposta é vazia e o seletor cai na lista da
    casa, como antes — não há o que testar.
    """
    engine = provider(request)
    janela = request.app.state.settings.contexto_tokens or None
    if isinstance(engine, ComTeto):
        engine = engine.desembrulhar()
    if not isinstance(engine, HostProvider):
        return []

    itens = await _do_host(engine, janela)
    if not itens:
        return []

    async with httpx.AsyncClient(timeout=httpx.Timeout(TEMPO_DO_TESTE_S)) as client:
        resultados = await asyncio.gather(
            *(_testar_modelo(client, engine, item.value) for item in itens),
            # Um modelo que explodiu não leva a lista junto: vira «não testado» e os outros
            # saem com o código deles. Sem isto, uma falha qualquer devolvia 500 e o seletor
            # ficava vazio — que é o defeito de antes por outro caminho.
            return_exceptions=True,
        )
    # `gather` devolve na ordem dos argumentos, que é a ordem de `itens`.
    for item, bruto in zip(itens, resultados, strict=True):
        item.status = None if isinstance(bruto, BaseException) else bruto[1]
    return itens


@router.get("/models", response_model=list[ModelInfo])
async def models(request: Request) -> list[ModelInfo]:
    """O catálogo é o **do host**, e nada mais.

    Antes, com outro provedor no ar (uma chave de OpenAI no `.env`, por exemplo), o modelo
    configurado naquela máquina aparecia no seletor como "Outros → qwen/3.7-plus · provedor
    atual" — e a lista ficava diferente em cada PC. O dono foi explícito: o seletor mostra
    **sempre** o que o c-host publica, nunca o que existe na máquina de quem instalou.

    Lista vazia não deixa o seletor vazio: a interface cai na lista da casa (Liz, Koda,
    Layze), que é a mesma em qualquer PC.
    """
    engine = provider(request)
    janela = request.app.state.settings.contexto_tokens or None
    # O provider vem embrulhado no teto de requisições (`ComTeto`), e `isinstance` não
    # atravessa o `__getattr__` do invólucro: sem desembrulhar, isto aqui era sempre
    # falso e o seletor caía na lista da casa mesmo com o host publicando o catálogo.
    if isinstance(engine, ComTeto):
        engine = engine.desembrulhar()
    if not isinstance(engine, HostProvider):
        return []
    return await _do_host(engine, janela)
