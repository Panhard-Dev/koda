"""GET /api/models — quais modelos o provedor atual aceita.

O seletor da interface mostra o catálogo do gateway mais o que vier daqui: quando é o
gateway que responde, são os modelos que ele realmente tem — e o `display_name` (ou o
`name`, no c-host antigo) que ele publica é o rótulo preferido, para o seletor não inventar
espaçamento em cima do id.

A lista sai **do maior para o menor**. O serviço não publica tamanho em lugar nenhum, então
o peso é derivado do próprio nome: o tier (`nano` < `mini` < sem tier < `pro` < `max`) e,
dentro do tier, a geração. Modelo novo se encaixa sozinho na regra, sem lista fixa.

Sem `hint`: o seletor mostra só o nome do modelo. O antigo "serviço local" que aparecia
embaixo de cada linha era ruído — o usuário já sabe de onde vem o catálogo.
"""

from __future__ import annotations

from collections import Counter

import httpx
from fastapi import APIRouter, Request

from ..deps import provider
from ..providers import ComTeto, HostProvider
from ..schemas import ModelInfo

router = APIRouter(tags=["models"])

#: Sufixos que não servem para conversa (geração de imagem, áudio).
FORA_DO_CHAT = ("-image", "-tts", "embedding")

#: Modelos que o gateway ainda publica mas o app **não oferece** no seletor.
#:
#: O gateway é ofuscado e continua anunciando o Haiku 5.5; filtrar aqui é o que tira o
#: modelo do mapa sem mexer no host. A comparação vale para o id curto e para o integral,
#: porque o host pode publicar com namespace (`vendor/claude-haiku-5.5`).
#:
#: **Só vale para o catálogo do gateway** (`HostProvider`). Provedor logado tem catálogo
#: próprio — o do Accio, por exemplo, continua com o Haiku 5.5 — e não passa por aqui.
FORA_DO_MAPA = frozenset({"claude-haiku-5.5"})

#: Nome legível de "qwen-3.8-flash" -> "Qwen 3.8 Flash".
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
#: um id sem adjetivo de tier, como "algum-modelo-5.5".
TIERS = {"nano": 1, "mini": 2, "flash": 3, "pro": 5, "super": 5, "max": 6}
TIER_PADRAO = 4


def rotulo(modelo: str) -> str:
    partes = [BONITO.get(pedaço, pedaço.capitalize()) for pedaço in modelo.split("-")]
    return " ".join(partes)


def peso(identificador: str) -> tuple[int, float]:
    """Tamanho do modelo a partir do nome: (tier, geração).

    `glm-5.3-flash` → (3, 5.3) · `qwen-3.8-flash` → (3, 3.8) ·
    `qwen-3.8-flash-legacy` → (3, 3.8). Ordenando isso de forma decrescente, o maior vem
    primeiro.

    **A ordem que a pessoa vê no seletor também não é esta.** Ela é explícita e mora no
    front, em `ORDEM_DE_FORCA` (`src/models.tsx`): GLM, Qwen, Qwen Legacy. Aqui continua
    valendo só como desempate estável da lista que o backend devolve; o front reordena por
    `forcaDoModelo` antes de desenhar.
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

    O host manda o nome de exibição em `display_name` (o gateway novo) ou em `name` (o
    c-host antigo), então ele manda: `rotulo()` só entra quando os dois faltam, para não
    transformar "glm-5.3-flash" em algo pior do que o próprio host escolheu chamar.

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
        if identificador in FORA_DO_MAPA or curto in FORA_DO_MAPA:
            continue
        nome = str(item.get("display_name") or item.get("name") or "").strip()
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


@router.get("/models/testados", response_model=list[ModelInfo])
async def models_testados(request: Request) -> list[ModelInfo]:
    """Rota legada: leitura do catálogo, sem chamadas pagas de conversa."""
    return await models(request)


@router.get("/models", response_model=list[ModelInfo])
async def models(request: Request) -> list[ModelInfo]:
    """O catálogo é o **do host**, e nada mais.

    Antes, com outro provedor no ar (uma chave de OpenAI no `.env`, por exemplo), o modelo
    configurado naquela máquina aparecia no seletor como "Outros → qwen/3.7-plus · provedor
    atual" — e a lista ficava diferente em cada PC. O dono foi explícito: o seletor mostra
    **sempre** o que o c-host publica, nunca o que existe na máquina de quem instalou.

    Lista vazia não deixa o seletor vazio: a interface cai na lista da casa (GLM, Qwen),
    que é a mesma em qualquer PC.
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
