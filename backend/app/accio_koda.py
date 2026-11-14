"""O Accio falado direto pelo Koda — login, contas e conversa no mesmo lugar.

O Accio desktop não publica uma API OpenAI. Ele fala um protocolo próprio (ADK/SSE) com o
gateway `phoenix-gw.alibaba.com`, manda o token no **corpo** do pedido e identifica o
aparelho por um `utdid`. Este módulo traduz o que o Koda já sabe — mensagens, ferramentas,
raciocínio — para esse protocolo, como `qoder_koda` e `kiro_koda` fazem com os seus.

O login é do `oauth_login.py`; aqui ficam só os endereços, o catálogo e a conversa.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import secrets
import time
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote, urlparse

import httpx

#: O gateway do Accio. É o mesmo endereço que o app desktop usa; não há proxy no meio.
BASE = "https://phoenix-gw.alibaba.com/api"
LOGIN = "https://www.accio.com/login"
APP_VERSION = "0.37.1"
APP_KEY = "35336201"
CLIENT_ID = "accio-work"
BX_VERSION = "pc_1.0.70.3061_0"
CAMINHO_DO_RETORNO = "/auth/callback"

#: O catálogo que o Accio aceita hoje — espelho da tabela `baseCatalog` do `accio-proxy`
#: (`app/internal/gateway/server.go`), conferida em 03/11/2026. A chave é o id que o Koda
#: mostra; `codigo` é o identificador que vai no pedido.
#:
#: Este catálogo é **separado do gateway** (`host/gateway-local`): o Claude Haiku 5.5 saiu do
#: seletor da casa a pedido do dono, mas continua aqui — é o Accio quem o serve, e os dois
#: catálogos não se misturam.
MODELOS: dict[str, dict[str, Any]] = {
    "auto": {
        "codigo": "auto",
        "nome": "Auto",
        "raciocina": False,
        "esforcos": [],
        "esforco_padrao": "",
        "multiplicador": 0,
    },
    "gpt-6-astra": {
        "codigo": "1Helix-G6aS8tR2qN7m",
        "nome": "GPT 6 Astra",
        "raciocina": True,
        "esforcos": ["low", "medium", "high", "xhigh", "max"],
        "esforco_padrao": "high",
        "multiplicador": 3.5,
    },
    "gpt-6-sol": {
        "codigo": "1Helix-G6So7pW3xN9q",
        "nome": "GPT 6 Sol",
        "raciocina": True,
        "esforcos": ["low", "medium", "high"],
        "esforco_padrao": "high",
        "multiplicador": 0.7,
    },
    "gpt-6-luna": {
        "codigo": "1Helix-G6Lu8nK4qR2m",
        "nome": "GPT 6 Luna",
        "raciocina": True,
        "esforcos": ["low", "medium", "high"],
        "esforco_padrao": "high",
        "multiplicador": 0.04,
    },
    "gpt-5.6-sol": {
        "codigo": "1Helix-B3jR3WN1dY6s",
        "nome": "GPT 5.6 Sol",
        "raciocina": True,
        "esforcos": ["low", "medium", "high"],
        "esforco_padrao": "high",
        "multiplicador": 2.2,
    },
    "gpt-5.6-terra": {
        "codigo": "1Helix-B33T3WN1dY6s",
        "nome": "GPT 5.6 Terra",
        "raciocina": True,
        "esforcos": ["low", "medium", "high"],
        "esforco_padrao": "high",
        "multiplicador": 0.88,
    },
    "gpt-5.6-luna": {
        "codigo": "1Helix-3EjR3WN1dY6s",
        "nome": "GPT 5.6 Luna",
        "raciocina": True,
        "esforcos": ["low", "medium", "high"],
        "esforco_padrao": "high",
        "multiplicador": 0.09,
    },
    "gpt-5.5": {
        "codigo": "1Helix-B3jR8wN1dY6s",
        "nome": "GPT 5.5",
        "raciocina": True,
        "esforcos": ["low", "high"],
        "esforco_padrao": "low",
        "multiplicador": 1.8,
    },
    "grok-4.6": {
        "codigo": "1Helix-G46W8nP2qR6m",
        "nome": "Grok 4.6",
        "raciocina": False,
        "esforcos": [],
        "esforco_padrao": "",
        "multiplicador": 0.5,
    },
    "claude-opus-5.5": {
        "codigo": "1Orbit-Q55pN8xR6cP2m",
        "nome": "Claude Opus 5.5",
        "raciocina": True,
        "esforcos": ["low", "medium", "high", "xhigh", "max"],
        "esforco_padrao": "medium",
        "multiplicador": 1.33,
    },
    "claude-opus-5": {
        "codigo": "1Orbit-Q5pN8xR6cP2m",
        "nome": "Claude Opus 5",
        "raciocina": True,
        "esforcos": ["low", "medium", "high", "xhigh", "max"],
        "esforco_padrao": "high",
        "multiplicador": 2.8,
    },
    "claude-opus-4.8": {
        "codigo": "1Orbit-Q2XN3xR6cP2m",
        "nome": "Claude Opus 4.8",
        "raciocina": True,
        "esforcos": ["low", "medium", "high", "max"],
        "esforco_padrao": "low",
        "multiplicador": 1.7,
    },
    "claude-opus-4.7": {
        "codigo": "1Orbit-Q7hN2R6cP2m",
        "nome": "Claude Opus 4.7",
        "raciocina": True,
        "esforcos": ["low", "medium", "high", "max"],
        "esforco_padrao": "low",
        "multiplicador": 1.65,
    },
    "claude-sonnet-5": {
        "codigo": "1Orbit-I93F4tK8bW1f",
        "nome": "Claude Sonnet 5",
        "raciocina": True,
        "esforcos": ["low", "medium", "high", "xhigh", "max"],
        "esforco_padrao": "high",
        "multiplicador": 0.7,
    },
    "claude-sonnet-4.6": {
        "codigo": "1Orbit-I9eY7YK8bW1f",
        "nome": "Claude Sonnet 4.6",
        "raciocina": True,
        "esforcos": ["low", "medium", "high", "max"],
        "esforco_padrao": "low",
        "multiplicador": 1.0,
    },
    "claude-haiku-5.5": {
        "codigo": "1Orbit-H55aN8xR6cP2m",
        "nome": "Claude Haiku 5.5",
        "raciocina": True,
        "esforcos": ["low", "medium", "high", "xhigh", "max"],
        "esforco_padrao": "max",
        "multiplicador": 0.03,
    },
    "claude-haiku-4.5": {
        "codigo": "1Orbit-I93V4tK8bW1f",
        "nome": "Claude Haiku 4.5",
        "raciocina": True,
        "esforcos": ["low", "medium", "high", "xhigh", "max"],
        "esforco_padrao": "medium",
        "multiplicador": 0.35,
    },
    "claude-fable-5.1": {
        "codigo": "1Orbit-F51W8nP2qR6m",
        "nome": "Claude Fable 5.1",
        "raciocina": True,
        "esforcos": ["low", "medium", "high", "max"],
        "esforco_padrao": "high",
        "multiplicador": 3.5,
    },
    "claude-fable-5": {
        "codigo": "1Orbit-Q2XN3dX6cP2m",
        "nome": "Claude Fable 5",
        "raciocina": True,
        "esforcos": ["low", "medium", "high", "max"],
        "esforco_padrao": "high",
        "multiplicador": 3.5,
    },
    "gemini-4-argon": {
        "codigo": "1Nexus-utXDaAethymI",
        "nome": "Gemini 4 Argon",
        "raciocina": False,
        "esforcos": [],
        "esforco_padrao": "",
        "multiplicador": 0.7,
    },
    "gemini-3.8-flash": {
        "codigo": "1Nexus-R8HF9qK7we1s",
        "nome": "Gemini 3.8 Flash",
        "raciocina": True,
        "esforcos": ["low", "high"],
        "esforco_padrao": "high",
        "multiplicador": 0.25,
    },
    "gemini-3.7-flash": {
        "codigo": "1Nexus-R7GF8qJ6vd8p",
        "nome": "Gemini 3.7 Flash",
        "raciocina": True,
        "esforcos": ["low", "high"],
        "esforco_padrao": "high",
        "multiplicador": 0.25,
    },
    "gemini-3.5-flash": {
        "codigo": "1Nexus-R3wF8qJ5vc7o",
        "nome": "Gemini 3.5 Flash",
        "raciocina": True,
        "esforcos": ["low", "high"],
        "esforco_padrao": "high",
        "multiplicador": 0.4,
    },
    "gemini-3-flash": {
        "codigo": "1Nexus-R36W8qJ5vB6h",
        "nome": "Gemini 3 Flash",
        "raciocina": True,
        "esforcos": ["low", "high"],
        "esforco_padrao": "low",
        "multiplicador": 0.13,
    },
    "gemini-3.1-pro": {
        "codigo": "1Nexus-W5rQ9fG1iC7o",
        "nome": "Gemini 3.1 Pro",
        "raciocina": True,
        "esforcos": ["low", "high"],
        "esforco_padrao": "low",
        "multiplicador": 0.55,
    },
    "deepseek-v4-flash": {
        "codigo": "1Nova-Q3xM8vJ1rH6z",
        "nome": "DeepSeek V4 Flash",
        "raciocina": False,
        "esforcos": [],
        "esforco_padrao": "",
        "multiplicador": 0.09,
    },
    "deepseek-v4-pro": {
        "codigo": "1Nova-bW7yT4kL9pN2",
        "nome": "DeepSeek V4 Pro",
        "raciocina": False,
        "esforcos": [],
        "esforco_padrao": "",
        "multiplicador": 0.34,
    },
    "glm-5.3": {
        "codigo": "1Chronos-L53W8nP2qR6m",
        "nome": "GLM 5.3",
        "raciocina": False,
        "esforcos": [],
        "esforco_padrao": "",
        "multiplicador": 0.16,
    },
    "glm-5.3-flash": {
        "codigo": "1Chronos-F53X9nQ3rT8w",
        "nome": "GLM 5.3 Flash",
        "raciocina": False,
        "esforcos": [],
        "esforco_padrao": "",
        "multiplicador": 0.03,
    },
    "glm-5.2": {
        "codigo": "1Chronos-G5p2V9sA2mK7",
        "nome": "GLM 5.2",
        "raciocina": False,
        "esforcos": [],
        "esforco_padrao": "",
        "multiplicador": 0.16,
    },
    "glm-5.1": {
        "codigo": "1Chronos-dX3cV9sA2mK7",
        "nome": "GLM 5.1",
        "raciocina": False,
        "esforcos": [],
        "esforco_padrao": "",
        "multiplicador": 0.12,
    },
    "qwen-3.8-flash": {
        "codigo": "1Drift-F8hS3mK7pL6I",
        "nome": "Qwen 3.8 Flash",
        "raciocina": False,
        "esforcos": [],
        "esforco_padrao": "",
        "multiplicador": 0.03,
    },
    "qwen-3.8-flash-legacy": {
        "codigo": "1Drift-F8hS3mK7pL2n",
        "nome": "Qwen 3.8 Flash (Legacy)",
        "raciocina": False,
        "esforcos": [],
        "esforco_padrao": "",
        "multiplicador": 0.03,
    },
    "qwen-3.8-flash-plus": {
        "codigo": "1Drift-F8hS9mK7pL2n",
        "nome": "Qwen 3.8 Flash+",
        "raciocina": False,
        "esforcos": [],
        "esforco_padrao": "",
        "multiplicador": 0.04,
    },
    "qwen-3.8-max": {
        "codigo": "1Drift-T3TB6WS9a23w",
        "nome": "Qwen 3.8 Max",
        "raciocina": False,
        "esforcos": [],
        "esforco_padrao": "",
        "multiplicador": 0.44,
    },
    "qwen-3.8-max-plus": {
        "codigo": "1Drift-T3T9WWS9a23w",
        "nome": "Qwen 3.8 Max+",
        "raciocina": False,
        "esforcos": [],
        "esforco_padrao": "",
        "multiplicador": 0.56,
    },
    "qwen-3.8-27b": {
        "codigo": "1Drift-N8kP2Q7wR5mX",
        "nome": "Qwen 3.8 27B",
        "raciocina": False,
        "esforcos": [],
        "esforco_padrao": "",
        "multiplicador": 0.13,
    },
    "qwen-3.7-max": {
        "codigo": "1Drift-T2nB5kS9a23w",
        "nome": "Qwen 3.7 Max",
        "raciocina": False,
        "esforcos": [],
        "esforco_padrao": "",
        "multiplicador": 0.22,
    },
    "qwen-3.7-plus": {
        "codigo": "2Drift-V4jL6sd3yE8d",
        "nome": "Qwen 3.7 Plus",
        "raciocina": False,
        "esforcos": [],
        "esforco_padrao": "",
        "multiplicador": 0.05,
    },
    "qwen-3.5-a3b": {
        "codigo": "1Drift-A3bM5nK8pQ2w",
        "nome": "Qwen 3.5 A3B",
        "raciocina": False,
        "esforcos": [],
        "esforco_padrao": "",
        "multiplicador": 0.13,
    },
    "kimi-k2.6": {
        "codigo": "1Synapse-G5aJ8wL1dV4s",
        "nome": "Kimi K2.6",
        "raciocina": False,
        "esforcos": [],
        "esforco_padrao": "",
        "multiplicador": 0.14,
    },
    "minimax-m3": {
        "codigo": "1Zenith-M27hS2SR5xQ2p",
        "nome": "MiniMax M3",
        "raciocina": False,
        "esforcos": [],
        "esforco_padrao": "",
        "multiplicador": 0.08,
    },
}

_POR_CODIGO = {item["codigo"].lower(): chave for chave, item in MODELOS.items()}


def modelo(nome: str) -> tuple[str, dict[str, Any]] | None:
    """Acha o modelo pelo id do Koda ou pelo código do Accio."""
    limpo = str(nome or "").strip()
    if limpo.lower().startswith("accio/"):
        limpo = limpo[6:]
    if limpo in MODELOS:
        return limpo, MODELOS[limpo]
    chave = _POR_CODIGO.get(limpo.lower())
    return (chave, MODELOS[chave]) if chave else None


def catalogo() -> dict[str, Any]:
    """O catálogo estático, no formato que `provedores.modelos()` devolve."""
    return {
        "modelos": list(MODELOS),
        "nomes": {chave: item["nome"] for chave, item in MODELOS.items()},
        "esforcos": {chave: list(item["esforcos"]) for chave, item in MODELOS.items()},
        # Multiplicador oficial de uso — o «0,03x» a «3,5x» do Accio. Diz quantos créditos
        # cada modelo consome por uso; o front mostra ao lado do nome.
        "multiplos": {chave: item["multiplicador"] for chave, item in MODELOS.items()},
        "fonte": "catálogo do Accio",
        "motivo": "",
    }


def esforcos(nome: str) -> list[str]:
    achado = modelo(nome)
    return list(achado[1]["esforcos"]) if achado else []


def _codificar(valor: str) -> str:
    return quote(str(valor), safe="")


def _md5(valor: str) -> str:
    return hashlib.md5(valor.encode("utf-8")).hexdigest()  # noqa: S324 — é a assinatura do gateway, não segurança


def _utdid(conta: dict[str, Any]) -> str:
    """O id de aparelho que o Accio espera.

    Nas contas novas ele nasce no login e fica em `specific`. Para uma conta antiga que não
    tenha o campo, o id é derivado do id da conta: estável entre reinícios e sem inventar
    estado novo no banco.
    """
    guardado = str((conta.get("specific") or {}).get("utdid") or "").strip()
    if guardado:
        return guardado
    base = str(conta.get("id") or conta.get("conta") or "koda")
    return hashlib.sha256(base.encode("utf-8")).hexdigest()[:32]


def _device_headers(alvo: str) -> dict[str, str]:
    partes = urlparse(alvo)
    api = f"{partes.netloc}{partes.path}"
    return {
        "pctb-x-sgext": _codificar("win_reserve"),
        "pctb-x-pv": _codificar("6.3"),
        "pctb-x-api": _codificar(api),
        "pctb-x-apiver": _codificar("1.0"),
        "pctb-x-t": _codificar(str(int(time.time()))),
        "pctb-x-appkey": _codificar(APP_KEY),
        "x-bx-env": _codificar("web"),
        "pctb-x-bx-version": _codificar(BX_VERSION),
    }


def _chat_headers(utdid: str) -> dict[str, str]:
    return {
        "content-type": "application/json",
        "accept": "text/event-stream",
        "utdid": utdid,
        "version": APP_VERSION,
        "appKey": APP_KEY,
        "x-deploy-target": "desktop",
        "x-accio-route-region": "SG",
        "x-package-region": "SG",
        "user-agent": "node",
    }


def _desktop_headers(utdid: str) -> dict[str, str]:
    return {
        "content-type": "application/json",
        "x-language": "pt",
        "x-locale": "pt-BR",
        "x-platform": "pc-win",
        "x-utdid": utdid,
        "x-app-version": APP_VERSION,
        "x-os": "win32",
        "x-deploy-target": "desktop",
        "x-source": "ACCIO_DESKTOP",
        "x-cna": "",
        "x-package-region": "GLOBAL",
    }


def cabecalhos(conta: dict[str, Any], alvo: str) -> dict[str, str]:
    return {**_chat_headers(_utdid(conta)), **_device_headers(alvo)}


def url(request_id: str) -> str:
    return f"{BASE}/adk/llm/generateContent?sg_k={_md5(request_id)}"


def _texto(conteudo: Any) -> str:
    if isinstance(conteudo, str):
        return conteudo
    if isinstance(conteudo, list):
        return "".join(
            str(item.get("text") or "")
            for item in conteudo
            if isinstance(item, dict) and item.get("type") == "text"
        )
    return ""


def _imagem(valor: str) -> dict[str, str] | None:
    """`data:image/png;base64,…` → o `inlineData` que o Accio entende."""
    if not isinstance(valor, str) or not valor.startswith("data:"):
        return None
    cabeca, _, dados = valor.partition(",")
    if ";base64" not in cabeca or not dados:
        return None
    return {"mimeType": cabeca[5:].replace(";base64", ""), "data": dados}


def _partes(mensagem: dict[str, Any]) -> list[dict[str, Any]]:
    partes: list[dict[str, Any]] = []
    raciocinio = mensagem.get("reasoning_content")
    if isinstance(raciocinio, str) and raciocinio.strip():
        partes.append({"text": raciocinio, "thought": True})

    conteudo = mensagem.get("content")
    if isinstance(conteudo, list):
        for pedaco in conteudo:
            if not isinstance(pedaco, dict):
                continue
            if pedaco.get("type") == "text" and pedaco.get("text"):
                partes.append({"text": str(pedaco["text"]), "thought": False})
            elif pedaco.get("type") == "image_url":
                imagem = (pedaco.get("image_url") or {}).get("url")
                inline = _imagem(str(imagem or ""))
                if inline:
                    partes.append({"inlineData": inline, "thought": False})
    else:
        texto = _texto(conteudo)
        if texto:
            partes.append({"text": texto, "thought": False})

    for chamada in mensagem.get("tool_calls") or []:
        if not isinstance(chamada, dict):
            continue
        funcao = chamada.get("function") or {}
        if not funcao.get("name"):
            continue
        partes.append({
            "functionCall": {
                "id": chamada.get("id") or f"call_{secrets.token_hex(8)}",
                "name": funcao["name"],
                "argsJson": funcao.get("arguments") or "{}",
            }
        })

    if mensagem.get("role") == "tool":
        resposta = {"result": _texto(conteudo)}
        parte: dict[str, Any] = {
            "id": mensagem.get("tool_call_id") or "",
            "responseJson": json.dumps(resposta, ensure_ascii=False),
        }
        if mensagem.get("name"):
            parte["name"] = mensagem["name"]
        partes.append({"functionResponse": parte})
    return partes


def _ferramentas(lista: Any) -> list[dict[str, Any]]:
    saida: list[dict[str, Any]] = []
    for item in lista or []:
        if not isinstance(item, dict):
            continue
        funcao = item.get("function")
        if not isinstance(funcao, dict):
            funcao = item
        if not funcao.get("name"):
            continue
        saida.append({
            "name": funcao["name"],
            "description": funcao.get("description") or "",
            "parameters_json": json.dumps(funcao.get("parameters") or {}, ensure_ascii=False),
        })
    return saida


def _esforco(achado: dict[str, Any], esforco: str | None) -> str | None:
    if not achado.get("raciocina"):
        return None
    nivel = str(esforco or "").strip().lower()
    if nivel in {"", "auto"}:
        nivel = str(achado.get("esforco_padrao") or "max")
    if nivel == "none":
        return None
    if nivel == "minimal":
        nivel = "low"
    if nivel not in achado.get("esforcos", []):
        nivel = str(achado.get("esforco_padrao") or "max")
    return nivel


def corpo(
    nome_modelo: str,
    mensagens: list[dict[str, Any]],
    token: str,
    *,
    ferramentas: list[dict[str, Any]] | None = None,
    raciocinio: bool = True,
    esforco: str | None = None,
    max_tokens: int | None = None,
) -> dict[str, Any]:
    """O pedido no dialeto do Accio: `contents` + `systemInstruction` + ferramentas."""
    achado = modelo(nome_modelo)
    codigo = achado[1]["codigo"] if achado else str(nome_modelo or "")
    request_id = f"req-{secrets.token_hex(12)}"
    conteudos: list[dict[str, Any]] = []
    sistema = ""

    for mensagem in mensagens:
        if not isinstance(mensagem, dict):
            continue
        papel = str(mensagem.get("role") or "user")
        if papel in {"system", "developer"}:
            texto = _texto(mensagem.get("content"))
            if texto:
                sistema += ("\n\n" if sistema else "") + texto
            continue
        if papel == "assistant":
            papel = "model"
        if papel == "tool":
            papel = "user"
        partes = _partes(mensagem)
        if partes:
            conteudos.append({"role": papel, "parts": partes})

    pedido: dict[str, Any] = {
        "model": codigo,
        "incremental": True,
        "requestId": request_id,
        "userRequestId": request_id,
        "messageId": f"msg-{secrets.token_hex(12)}",
        "conversationId": f"conv-{secrets.token_hex(12)}",
        "sessionKey": f"sess-{secrets.token_hex(12)}",
        "contents": conteudos,
        "properties": {"normalized_response": "true"},
        "token": token,
        "empid": "",
        "tenant": "",
        "iaiTag": "phoenix-desktop",
    }
    if sistema:
        pedido["systemInstruction"] = sistema
    if raciocinio and achado:
        nivel = _esforco(achado[1], esforco)
        if nivel:
            pedido["reasoningEffort"] = nivel
    if max_tokens:
        pedido["maxOutputTokens"] = int(max_tokens)
    if ferramentas:
        pedido["tools"] = _ferramentas(ferramentas)
    return pedido


async def ler(resposta: httpx.Response) -> AsyncIterator[dict[str, Any]]:
    """Traduz o SSE do Accio em eventos simples.

    Um evento é um dicionário com **uma** destas chaves: `texto`, `raciocinio`, `chamada`,
    `usage`, `fim` ou `erro`. Quem chama decide o que fazer com cada um — assim o mesmo
    leitor serve ao texto puro e ao passo com ferramentas.
    """
    async for linha in resposta.aiter_lines():
        bruto = linha.strip()
        if not bruto.startswith("data:"):
            continue
        carga = bruto[5:].strip()
        if not carga:
            continue
        if carga == "[DONE]":
            yield {"fim": True}
            return
        if carga[:1] == "<":
            yield {"erro": "o Accio devolveu uma página HTML em vez do stream"}
            return
        try:
            quadro = json.loads(carga)
        except ValueError:
            continue
        if not isinstance(quadro, dict):
            continue
        codigo = quadro.get("error_code") or quadro.get("errorCode")
        if codigo:
            motivo = quadro.get("error_message") or quadro.get("errorMessage") or ""
            yield {"erro": f"{codigo}: {motivo}".strip()}
            return

        conteudo = (
            quadro.get("content")
            or (quadro.get("candidate") or {}).get("content")
            or (quadro.get("payload") or {}).get("content")
        )
        uso = quadro.get("usage_metadata") or (quadro.get("payload") or {}).get("usage_metadata")
        if isinstance(uso, dict):
            yield {
                "usage": {
                    "prompt_tokens": int(uso.get("prompt_token_count") or 0),
                    "completion_tokens": int(uso.get("candidates_token_count") or 0),
                }
            }

        if isinstance(conteudo, dict) and isinstance(conteudo.get("parts"), list):
            for parte in conteudo["parts"]:
                if not isinstance(parte, dict):
                    continue
                chamada = parte.get("functionCall") or parte.get("function_call")
                if isinstance(chamada, dict) and chamada.get("name"):
                    yield {
                        "chamada": {
                            "id": chamada.get("id") or f"call_{secrets.token_hex(8)}",
                            "name": chamada["name"],
                            "args": chamada.get("argsJson") or chamada.get("args_json") or "{}",
                        }
                    }
                elif parte.get("thought"):
                    if parte.get("text"):
                        yield {"raciocinio": str(parte["text"])}
                elif parte.get("text"):
                    yield {"texto": str(parte["text"])}

        if quadro.get("turnComplete") or quadro.get("turn_complete"):
            yield {"fim": True}
            return


def identidade(bruto: Any, token: str) -> str:
    """O nome da conta que o Accio devolveu — e-mail, login ou id, nessa ordem.

    O Accio nem sempre manda um e-mail no token. O que ele manda é um `userId`; nesse caso o
    rótulo vira `123@accio.local` — um e-mail de mentira, mas legível e estável. Sem nada,
    sobra um rótulo derivado do token, também estável e sem inventar e-mail.
    """
    achado = ""

    def procurar(valor: Any) -> None:
        nonlocal achado
        if achado or not isinstance(valor, dict):
            return
        for chave, item in valor.items():
            baixa = str(chave).lower()
            if not achado and isinstance(item, str) and item:
                if "email" in baixa or baixa in {"loginid", "loginname", "account"}:
                    achado = item
                elif baixa in {"userid", "uid", "user_id"}:
                    achado = item
            elif not achado and isinstance(item, (int, float)) and not isinstance(item, bool):
                if baixa in {"userid", "uid", "user_id"}:
                    achado = str(int(item))
            if not achado:
                procurar(item)
            if achado:
                return

    procurar(bruto)
    if achado:
        return achado if "@" in achado else f"{achado}@accio.local"
    resumo = hashlib.sha256(str(token).encode("utf-8")).hexdigest()[:12]
    return f"oauth-{resumo}@accio.local"


def _iso(valor: Any) -> str | None:
    try:
        segundos = float(valor)
    except (TypeError, ValueError):
        return None
    if segundos <= 0:
        return None
    if segundos >= 1_000_000_000_000:
        segundos /= 1000
    try:
        return datetime.fromtimestamp(segundos, tz=timezone.utc).isoformat()
    except (OverflowError, OSError, ValueError):
        return None


def renovar(conta: dict[str, Any]) -> dict[str, Any] | None:
    """Renova o token no endpoint do Accio. `None` quando o refresh não vale mais."""
    refresh = str(conta.get("refresh") or "").strip()
    if not refresh:
        return None
    utdid = _utdid(conta)
    try:
        with httpx.Client(timeout=30) as cliente:
            resposta = cliente.post(
                f"{BASE}/auth/refresh_token",
                headers=_desktop_headers(utdid),
                json={
                    "utdid": utdid,
                    "version": APP_VERSION,
                    "accessToken": conta.get("access") or "",
                    "refreshToken": refresh,
                },
            )
            if resposta.status_code >= 400:
                return None
            bruto = resposta.json()
    except (httpx.HTTPError, ValueError):
        return None
    if not isinstance(bruto, dict) or bruto.get("success") is False:
        return None
    dados = bruto.get("data")
    if not isinstance(dados, dict):
        dados = bruto
    acesso = dados.get("accessToken")
    if not acesso:
        return None
    return {
        "access": acesso,
        "refresh": dados.get("refreshToken") or refresh,
        "expiraEm": _iso(dados.get("expiresAt")),
    }


def _inteiro(valor: Any) -> int:
    try:
        return int(float(valor))
    except (TypeError, ValueError):
        return 0


def creditos(conta: dict[str, Any]) -> dict[str, Any] | None:
    """O saldo da conta no Accio. `None` quando o endpoint não respondeu."""
    utdid = _utdid(conta)
    parametros = {
        "accessToken": conta.get("access") or "",
        "subscripType": "INDIVIDUAL",
        "utdid": utdid,
        "version": APP_VERSION,
    }
    try:
        with httpx.Client(timeout=10) as cliente:
            resposta = cliente.get(
                f"{BASE}/entitlement/currentSubscription",
                params=parametros,
                headers=_desktop_headers(utdid),
            )
            if resposta.status_code >= 400:
                return None
            bruto = resposta.json()
    except (httpx.HTTPError, ValueError):
        return None
    if not isinstance(bruto, dict) or bruto.get("success") is False:
        return None
    dados = bruto.get("data")
    if not isinstance(dados, dict):
        dados = bruto
    total = _inteiro(dados.get("total") or dados.get("totalCredits") or dados.get("creditTotal"))
    restante = _inteiro(
        dados.get("remaining") or dados.get("remainingCredits") or dados.get("creditRemaining")
    )
    usado = _inteiro(dados.get("used") or dados.get("usedCredits"))
    if not usado and total > 0:
        usado = total - restante
    return {
        "total": total,
        "remaining": restante,
        "used": usado,
        "plano": str(dados.get("planName") or dados.get("planType") or dados.get("plan") or ""),
    }


async def aquecer(conta: dict[str, Any]) -> None:
    """O «warm device» do Accio: três toques no feature flag, com 4 s entre eles.

    É o que o painel do proxy faz quando o gateway responde 555. Sem isto, o primeiro pedido
    depois de um tempo parado pode ser recusado mesmo com a conta boa.
    """
    alvo = f"{BASE}/tool/featureFlag/evaluate"
    cabecalhos_ = {**_chat_headers(_utdid(conta)), **_device_headers(alvo)}
    for _ in range(3):
        try:
            async with httpx.AsyncClient(timeout=20) as cliente:
                resposta = await cliente.post(alvo, headers=cabecalhos_, content=b"{}")
                await resposta.aread()
                if resposta.status_code != 200:
                    return
        except httpx.HTTPError:
            return
        await asyncio.sleep(4)
