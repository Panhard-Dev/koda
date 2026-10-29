"""O Qoder falado direto pelo Koda — assinatura COSY, catálogo e conversa.

Aqui mora o que antes era delegado ao gateway: o pedido vai assinado por `qoder_cosy`, com o
token da conta que o Koda guardou, e a resposta volta pelo SSE do `agent_chat_generation`.

**A fila.** Os modelos free do Qoder entram numa fila (`code 10605`, `isQueued`). O cliente
oficial espera e reenvia com `request_id`/`chat_record_id` novos — é o que `_com_fila` faz. Sem
isso a primeira resposta é sempre «na fila», e pareceria que o modelo não funciona.
"""

from __future__ import annotations

import json
import time
import uuid
from collections.abc import Iterator
from typing import Any

import httpx

from . import oauth_login, qoder_cosy
from .config import Settings

BASE = "https://api3.qoder.sh"
USERINFO = "https://openapi.qoder.sh/api/v1/userinfo"
MODELOS = "/algo/api/v2/model/list?Encode=1"
CHAT = (
    "/algo/api/v2/service/pro/sse/agent_chat_generation"
    "?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1"
)
FILA = "/algo/api/v2/service/ask/queue/status"
SISTEMA = "You are a Qoder agent. Use the instructions below and the tools available to you to assist the user."
#: Quanto esperar quando o Qoder diz que o pedido está na fila (o cliente usa 30 s).
ESPERA_FILA_S = 5
TENTATIVAS_FILA = 2


def conta(settings: Settings) -> dict[str, Any] | None:
    """A conta do Qoder no formato que a assinatura pede (uid, nome, e-mail, token, máquina)."""
    dado = oauth_login.guardado(settings, "qoder")
    if not dado or not dado.get("access"):
        return None
    token = str(dado["access"])
    uid = dado.get("conta") or ""
    nome = ""
    email = dado.get("conta") or ""
    try:
        with httpx.Client(timeout=15) as cliente:
            resposta = cliente.get(USERINFO, headers={"authorization": f"Bearer {token}"})
            if resposta.status_code < 400:
                info = resposta.json()
                uid = str(info.get("id") or uid)
                nome = str(info.get("name") or "")
                email = str(info.get("email") or email)
    except (httpx.HTTPError, ValueError):
        pass
    if not uid:
        return None
    return {
        "uid": uid,
        "name": nome,
        "email": email,
        "access": token,
        "machineId": dado.get("escopo") or "",
    }


def modelos(settings: Settings) -> dict[str, Any] | None:
    """O catálogo real da conta, assinado. `None` quando não há conta ou o Qoder recusa."""
    dados = conta(settings)
    if dados is None:
        return None
    url = BASE + MODELOS
    try:
        with httpx.Client(timeout=20) as cliente:
            resposta = cliente.get(url, headers=qoder_cosy.cabecalhos(url, dados, ""))
            if resposta.status_code >= 400:
                return None
            lista = resposta.json().get("chat") or []
    except (httpx.HTTPError, ValueError):
        return None
    itens = [item for item in lista if isinstance(item, dict) and item.get("key")]
    if not itens:
        return None
    return {
        "modelos": [str(item["key"]) for item in itens],
        "nomes": {str(item["key"]): str(item.get("display_name") or item["key"]) for item in itens},
        "detalhes": {str(item["key"]): item for item in itens},
        "fonte": "API do Qoder (conta)",
        "motivo": "",
    }


def _corpo(modelo: dict[str, Any], mensagens: list[dict[str, Any]], pensa: bool) -> dict[str, Any]:
    pedido = str(uuid.uuid4())
    tarefa = str(uuid.uuid4())
    sistema = {"type": "text", "text": SISTEMA}
    return {
        "request_id": pedido,
        "request_set_id": tarefa,
        "chat_record_id": pedido,
        "session_id": str(uuid.uuid4()),
        "parameters": {"enable_thinking": bool(pensa), "max_tokens": 8192},
        "business": {
            "product": "app",
            "version": qoder_cosy.COSY_VERSION,
            "type": "agent",
            "id": tarefa,
            "name": "koda",
            "begin_at": int(time.time() * 1000),
            "stage": "start",
        },
        "agent_id": "agent_common",
        "task_id": "common",
        "session_type": "app",
        "model_config": modelo.get("config"),
        "system": [sistema],
        "messages": [{"role": "system", "content": [sistema]}, *mensagens],
    }


def _evento(linha: str) -> dict[str, Any] | None:
    """Uma linha do SSE do Qoder como dicionário (`data:{...}` com `body` em JSON)."""
    if not linha.startswith("data:"):
        return None
    carga = linha[5:].strip()
    if not carga:
        return None
    try:
        evento = json.loads(carga)
    except ValueError:
        return None
    corpo = evento.get("body") if isinstance(evento, dict) else None
    if isinstance(corpo, str):
        try:
            return json.loads(corpo)
        except ValueError:
            return None
    return evento if isinstance(evento, dict) else None


def _esperar_fila(
    dados: dict[str, Any],
    pedido: dict[str, Any],
    limite_s: float = 4.0,
) -> bool:
    """Fica na fila do Qoder até ela liberar. `True` quando pode reenviar.

    O Qoder responde `10605` com `isQueued` e um `queueType`; o cliente oficial então consulta
    `/api/v2/service/ask/queue/status` (assinado, sem corpo) até `isQueued` virar falso. Sem
    esse passo, todo pedido aos modelos free volta «na fila» para sempre.
    """
    inicio = time.time()
    consulta = {"requestSetId": pedido.get("requestSetId"), "modelKey": pedido.get("modelKey")}
    if pedido.get("queueType"):
        consulta["queueType"] = pedido["queueType"]
    url = BASE + FILA + "?" + "&".join(f"{chave}={valor}" for chave, valor in consulta.items() if valor)
    cabecalhos = qoder_cosy.cabecalhos(url, dados, "")
    cabecalhos.pop("Content-Type", None)
    if pedido.get("requestId"):
        cabecalhos["X-Request-ID"] = str(pedido["requestId"])
    if pedido.get("sessionId"):
        cabecalhos["X-Session-ID"] = str(pedido["sessionId"])

    while time.time() - inicio < limite_s:
        time.sleep(3)
        try:
            with httpx.Client(timeout=20) as cliente:
                resposta = cliente.get(url, headers=cabecalhos)
                if resposta.status_code == 404:
                    return False
                if resposta.status_code >= 400:
                    continue
                estado = resposta.json()
        except (httpx.HTTPError, ValueError):
            continue
        if isinstance(estado, dict) and estado.get("isQueued") is False:
            espera = estado.get("retryAfterSeconds") or 0
            if isinstance(espera, (int, float)) and espera > 0:
                time.sleep(min(float(espera), 15))
            return True
    return False


def _na_fila(texto: str) -> bool:
    return "10605" in texto or "isQueued" in texto


def _info_da_fila(evento: dict[str, Any]) -> dict[str, Any]:
    """O que o aviso de fila traz (modelKey, queueType, retryAfterSeconds)."""
    if evento.get("isQueued") or evento.get("queueType"):
        return evento
    mensagem = evento.get("message")
    if isinstance(mensagem, str):
        try:
            interno = json.loads(mensagem)
        except ValueError:
            return {}
        if isinstance(interno, dict):
            if isinstance(interno.get("message"), str):
                try:
                    interno = {**interno, **json.loads(interno["message"])}
                except ValueError:
                    pass
            return interno
    return {}


def _evento_na_fila(evento: dict[str, Any]) -> bool:
    """O Qoder avisa a fila num evento 403 cujo `message` é outro JSON com `isQueued`."""
    if evento.get("isQueued"):
        return True
    if str(evento.get("code")) == "10605":
        return True
    mensagem = evento.get("message")
    if isinstance(mensagem, str) and _na_fila(mensagem):
        return True
    return False


def _texto(pedaco: Any) -> str:
    """Todo texto que o evento carrega, sem depender do nome exato do campo."""
    if isinstance(pedaco, str):
        return pedaco
    if isinstance(pedaco, dict):
        saida = ""
        for chave, valor in pedaco.items():
            if chave in {"content", "text", "delta", "answer", "result"} and isinstance(valor, str):
                saida += valor
            elif isinstance(valor, (dict, list)):
                saida += _texto(valor)
        return saida
    if isinstance(pedaco, list):
        return "".join(_texto(item) for item in pedaco)
    return ""


def conversar(
    settings: Settings,
    chave_do_modelo: str,
    mensagens: list[dict[str, Any]],
    *,
    pensa: bool = True,
) -> Iterator[str]:
    """Conversa pelo Qoder, em pedaços de texto. Levanta `RuntimeError` com o motivo real."""
    dados = conta(settings)
    if dados is None:
        raise RuntimeError("entre no Qoder primeiro — a conversa usa o token da conta")
    catalogo = modelos(settings) or {}
    modelo = (catalogo.get("detalhes") or {}).get(chave_do_modelo) or {"key": chave_do_modelo, "source": "system"}
    url = BASE + CHAT

    for tentativa in range(TENTATIVAS_FILA):
        corpo = _corpo(modelo, mensagens, pensa)
        fio = qoder_cosy.codificar_corpo(json.dumps(corpo, separators=(",", ":"), ensure_ascii=False))
        cabecalhos = qoder_cosy.cabecalhos(
            url, dados, fio, chat=True,
            modelo={"key": str(modelo.get("key") or chave_do_modelo), "source": str(modelo.get("source") or "system")},
        )
        na_fila = False
        info: dict[str, Any] = {}
        try:
            with httpx.Client(timeout=180) as cliente:
                with cliente.stream("POST", url, headers=cabecalhos, content=fio) as resposta:
                    if resposta.status_code >= 400:
                        texto = resposta.read().decode("utf-8", "replace")
                        if _na_fila(texto):
                            na_fila = True
                        else:
                            raise RuntimeError(f"o Qoder recusou ({resposta.status_code}): {texto[:300]}")
                    else:
                        for linha in resposta.iter_lines():
                            evento = _evento(linha)
                            if evento is None:
                                continue
                            if _evento_na_fila(evento):
                                na_fila = True
                                info = _info_da_fila(evento)
                                break
                            pedaco = _texto(evento.get("data") or evento.get("content") or evento)
                            if pedaco:
                                yield pedaco
        except httpx.HTTPError as erro:
            # O Qoder fecha o stream da fila sem terminar o corpo — isso é «na fila», não
            # «conexão caiu», e é o que o cliente oficial também trata como espera.
            if not na_fila:
                na_fila = True
                if tentativa + 1 >= TENTATIVAS_FILA:
                    raise RuntimeError(f"o Qoder cortou a resposta: {erro}") from erro
        if not na_fila:
            return
        if tentativa + 1 < TENTATIVAS_FILA:
            pedido = {
                "requestSetId": corpo.get("request_set_id"),
                "requestId": corpo.get("request_id"),
                "sessionId": corpo.get("session_id"),
                "modelKey": info.get("modelKey") or chave_do_modelo,
                "queueType": info.get("queueType"),
            }
            if not _esperar_fila(dados, pedido):
                time.sleep(ESPERA_FILA_S)
    raise RuntimeError(
        "o Qoder pôs o pedido na fila (conta no plano lite) — não é o Koda: tente de novo em "
        "alguns segundos, ou use um modelo do host enquanto isso"
    )
