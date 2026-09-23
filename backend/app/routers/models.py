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

import httpx
from fastapi import APIRouter, Request

from ..deps import provider
from ..providers import GeminiProxyProvider
from ..schemas import ModelInfo

router = APIRouter(tags=["models"])

#: Sufixos que não servem para conversa (geração de imagem, áudio).
FORA_DO_CHAT = ("-image", "-tts", "embedding")

#: Nome legível de "gemini-3.5-flash-lite" -> "Gemini 3.5 Flash Lite".
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


def catalogo(dados: dict) -> list[ModelInfo]:
    """Traduz a resposta `/models` do host para o que o seletor usa.

    O host já manda o nome de exibição em `name` ("Liz Nano", "Koda 1"), então ele manda:
    `rotulo()` só entra quando o `name` falta, para não transformar "liz-3-flash" em algo
    pior do que o próprio host escolheu chamar.
    """
    itens: list[ModelInfo] = []
    for item in dados.get("data") or []:
        identificador = str(item.get("id", "")).split("/")[-1]
        if not identificador or any(marca in identificador for marca in FORA_DO_CHAT):
            continue
        nome = str(item.get("name") or "").strip()
        itens.append(
            ModelInfo(
                value=identificador,
                label=nome or rotulo(identificador),
            )
        )
    itens.sort(key=lambda item: peso(item.value), reverse=True)
    return itens


async def _do_proxy(engine: GeminiProxyProvider) -> list[ModelInfo]:
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(3.0)) as client:
            resposta = await client.get(f"{engine.base_url}/models")
            resposta.raise_for_status()
            dados = resposta.json()
    except (httpx.HTTPError, ValueError):
        return []
    return catalogo(dados if isinstance(dados, dict) else {})


@router.get("/models", response_model=list[ModelInfo])
async def models(request: Request) -> list[ModelInfo]:
    """Lista vazia quando o provedor é o local (que não é um modelo)."""
    engine = provider(request)
    if isinstance(engine, GeminiProxyProvider):
        return await _do_proxy(engine)
    nome = getattr(engine, "model", None)
    return [ModelInfo(value=nome, label=nome, hint="provedor atual")] if nome else []
