"""Transporte do Zed com conversão dos protocolos dos modelos hospedados."""

from __future__ import annotations

import hashlib
import json
import re
import threading
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any

import httpx

from .providers.base import ProviderError, TransientProviderError


BASE = "https://cloud.zed.dev"
_TOKEN_CACHE: dict[str, tuple[str, float]] = {}
_MODEL_CACHE: dict[str, tuple[list[dict[str, Any]], float]] = {}
_TRAVA = threading.Lock()


def _identificador(valor: Any) -> str:
    if isinstance(valor, str):
        return valor
    if isinstance(valor, list) and valor:
        return str(valor[0])
    if isinstance(valor, dict):
        return str(valor.get("id") or "")
    return str(valor or "")


def _chave(conta: dict[str, Any]) -> str:
    especificos = conta.get("specific") or {}
    bruto = "\0".join(str(x or "") for x in (conta.get("access"), especificos.get("userId"),
                                               especificos.get("organizationId")))
    return hashlib.sha256(bruto.encode("utf-8")).hexdigest()


def _auth_usuario(conta: dict[str, Any]) -> dict[str, str]:
    especificos = conta.get("specific") or {}
    usuario = str(especificos.get("userId") or "")
    token = str(conta.get("access") or especificos.get("apiKey") or "")
    if not usuario or not token:
        raise ProviderError("a conta Zed não tem usuário ou token; conecte-a novamente")
    headers = {"authorization": f"{usuario} {token}", "accept": "application/json"}
    if especificos.get("systemId"):
        headers["x-zed-system-id"] = str(especificos["systemId"])
    return headers


async def _token(cliente: httpx.AsyncClient, conta: dict[str, Any], *, renovar: bool = False) -> str:
    chave = _chave(conta)
    with _TRAVA:
        cache = _TOKEN_CACHE.get(chave)
    if not renovar and cache and cache[1] > time.monotonic():
        return cache[0]
    headers = _auth_usuario(conta)
    especificos = conta.get("specific") or {}
    organizacao = _identificador(especificos.get("organizationId") or especificos.get("defaultOrganizationId"))
    if not organizacao:
        resposta = await cliente.get(f"{BASE}/client/users/me", headers=headers)
        if resposta.status_code >= 400:
            raise ProviderError(f"Zed não conseguiu consultar a conta (HTTP {resposta.status_code})")
        usuario = resposta.json()
        if not isinstance(usuario, dict):
            raise ProviderError("Zed devolveu informações de conta inválidas")
        organizacao = _identificador(usuario.get("default_organization_id") or usuario.get("defaultOrganizationId"))
        if not organizacao:
            opcoes = usuario.get("organizations") or []
            if isinstance(opcoes, list):
                opcoes = [x for x in opcoes if isinstance(x, dict)]
                escolhido = next((x for x in opcoes if x.get("is_personal")), opcoes[0] if opcoes else {})
                organizacao = _identificador(escolhido.get("id"))
    if not organizacao:
        raise ProviderError("a conta Zed não tem organização selecionada")
    resposta = await cliente.post(f"{BASE}/client/llm_tokens", headers=headers, json={"organization_id": organizacao})
    if resposta.status_code >= 400:
        raise ProviderError(f"Zed recusou o token de modelos (HTTP {resposta.status_code})")
    dados = resposta.json()
    valor = dados.get("token") if isinstance(dados, dict) else None
    if isinstance(valor, list):
        valor = valor[0] if valor else None
    elif isinstance(valor, dict):
        valor = valor.get("value")
    if not isinstance(valor, str) or not valor:
        raise ProviderError("Zed não devolveu token de modelos")
    with _TRAVA:
        _TOKEN_CACHE[chave] = (valor, time.monotonic() + 50 * 60)
    return valor


def _token_expirado(resposta: Any) -> bool:
    return (resposta.status_code == 401 or "x-zed-expired-token" in resposta.headers
            or "x-zed-outdated-token" in resposta.headers)


async def _catalogo(cliente: httpx.AsyncClient, conta: dict[str, Any]) -> list[dict[str, Any]]:
    chave = _chave(conta)
    with _TRAVA:
        cache = _MODEL_CACHE.get(chave)
    if cache and cache[1] > time.monotonic():
        return cache[0]
    for tentativa in range(2):
        token = await _token(cliente, conta, renovar=tentativa > 0)
        resposta = await cliente.get(f"{BASE}/models", headers={"authorization": f"Bearer {token}",
                                                                  "accept": "application/json", "x-zed-client-supports-x-ai": "true"})
        if tentativa == 0 and _token_expirado(resposta):
            continue
        if resposta.status_code >= 400:
            raise ProviderError(f"Zed não conseguiu listar modelos (HTTP {resposta.status_code})")
        dados = resposta.json()
        modelos = dados.get("models") if isinstance(dados, dict) else None
        if not isinstance(modelos, list):
            raise ProviderError("Zed devolveu catálogo inválido")
        modelos = [x for x in modelos if isinstance(x, dict) and _identificador(x.get("id")) and not x.get("is_disabled")]
        with _TRAVA:
            _MODEL_CACHE[chave] = (modelos, time.monotonic() + 3600)
        return modelos
    raise ProviderError("Zed recusou o token de modelos")


async def modelos(conta: dict[str, Any]) -> list[dict[str, Any]]:
    try:
        async with httpx.AsyncClient(timeout=30) as cliente:
            modelos_brutos = await _catalogo(cliente, conta)
        return [{"id": _identificador(item.get("id")),
                 "name": str(item.get("display_name") or item.get("displayName") or _identificador(item.get("id")))}
                for item in modelos_brutos]
    except (httpx.HTTPError, ValueError) as erro:
        raise ProviderError("não consegui consultar os modelos do Zed") from erro


def _provedor(valor: Any, modelo: str) -> str:
    nome = str(valor or "").lower().replace("-", "_")
    if nome in {"anthropic", "open_ai", "google", "x_ai"}:
        return nome
    if nome == "openai":
        return "open_ai"
    if nome in {"gemini"}:
        return "google"
    if nome == "xai":
        return "x_ai"
    nome = modelo.lower()
    return "anthropic" if "claude" in nome else "google" if "gemini" in nome else "x_ai" if "grok" in nome else "open_ai"


def _texto(valor: Any) -> str:
    if isinstance(valor, str):
        return valor
    if isinstance(valor, list):
        return "\n".join(str(item.get("text") or "") for item in valor if isinstance(item, dict) and item.get("text"))
    return "" if valor is None else str(valor)


def _anthropic(modelo: str, mensagens: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
    from .providers.conta import _ferramenta_anthropic

    instrucoes = "\n\n".join(_texto(m.get("content")) for m in mensagens if m.get("role") in {"system", "developer"}).strip()
    turnos: list[dict[str, Any]] = []

    def adicionar(role: str, blocos: list[dict[str, Any]]) -> None:
        if turnos and turnos[-1]["role"] == role:
            turnos[-1]["content"].extend(blocos)
        else:
            turnos.append({"role": role, "content": blocos})

    for mensagem in mensagens:
        role = mensagem.get("role")
        if role in {"system", "developer"}:
            continue
        if role == "tool":
            adicionar("user", [{"type": "tool_result", "tool_use_id": str(mensagem.get("tool_call_id") or ""),
                                 "content": _texto(mensagem.get("content")), "is_error": bool(mensagem.get("is_error"))}])
            continue
        blocos: list[dict[str, Any]] = []
        if role == "assistant":
            for chamada in mensagem.get("tool_calls") or []:
                pensamento = chamada.get("_koda_zed_thinking")
                if isinstance(pensamento, list):
                    blocos.extend(x for x in pensamento if isinstance(x, dict))
                    break
        conteudo = mensagem.get("content")
        if isinstance(conteudo, str) and conteudo:
            blocos.append({"type": "text", "text": conteudo})
        elif isinstance(conteudo, list):
            for item in conteudo:
                if not isinstance(item, dict):
                    continue
                if item.get("type") == "text" and item.get("text"):
                    blocos.append({"type": "text", "text": str(item["text"])})
                elif item.get("type") == "image_url":
                    imagem = item.get("image_url") or {}
                    url = imagem.get("url") if isinstance(imagem, dict) else imagem
                    achado = re.fullmatch(r"data:(image/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)", str(url or ""))
                    if not achado:
                        raise ProviderError("o Zed precisa da imagem em formato base64")
                    blocos.append({"type": "image", "source": {"type": "base64", "media_type": achado.group(1), "data": achado.group(2)}})
        for chamada in mensagem.get("tool_calls") or []:
            funcao = chamada.get("function") or {}
            try:
                entrada = json.loads(funcao.get("arguments") or "{}")
            except (TypeError, ValueError) as erro:
                raise ProviderError("argumentos inválidos no histórico do Zed") from erro
            if not isinstance(entrada, dict):
                raise ProviderError("argumentos de ferramenta do Zed precisam ser um objeto")
            blocos.append({"type": "tool_use", "id": str(chamada.get("id") or ""),
                           "name": str(funcao.get("name") or ""), "input": entrada})
        if blocos:
            adicionar("assistant" if role == "assistant" else "user", blocos)
    corpo: dict[str, Any] = {"model": modelo, "messages": turnos, "max_tokens": 8192, "stream": True}
    if instrucoes:
        corpo["system"] = instrucoes
    if tools:
        corpo["tools"] = [_ferramenta_anthropic(t) for t in tools]
    return corpo


def _responses(modelo: str, mensagens: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
    from .providers.conta import _entrada_responses, _ferramenta_responses

    entradas: list[dict[str, Any]] = []
    for mensagem in mensagens:
        if mensagem.get("role") == "developer":
            continue
        if mensagem.get("role") == "assistant" and mensagem.get("tool_calls") and mensagem.get("content"):
            entradas.append({"type": "message", "role": "assistant", "content": [
                {"type": "output_text", "text": _texto(mensagem["content"])}]})
        entradas.extend(_entrada_responses([mensagem]))
    instrucoes = "\n\n".join(_texto(m.get("content")) for m in mensagens if m.get("role") in {"system", "developer"}).strip()
    corpo: dict[str, Any] = {"model": modelo, "input": entradas, "stream": True, "store": False}
    if instrucoes:
        corpo["instructions"] = instrucoes
    if tools:
        corpo["tools"] = [_ferramenta_responses(t) for t in tools]
    return corpo


def _google(mensagens: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
    instrucoes = "\n\n".join(_texto(m.get("content")) for m in mensagens if m.get("role") in {"system", "developer"}).strip()
    conteudos: list[dict[str, Any]] = []
    chamadas_conhecidas: dict[str, str] = {}

    def adicionar(role: str, partes: list[dict[str, Any]]) -> None:
        if not partes:
            return
        if conteudos and conteudos[-1]["role"] == role:
            conteudos[-1]["parts"].extend(partes)
        else:
            conteudos.append({"role": role, "parts": partes})

    for mensagem in mensagens:
        role = mensagem.get("role")
        if role in {"system", "developer"}:
            continue
        partes: list[dict[str, Any]] = []
        if role == "tool":
            identificador = str(mensagem.get("tool_call_id") or "")
            nome = chamadas_conhecidas.get(identificador) or str(mensagem.get("name") or "tool")
            partes.append({"functionResponse": {"id": identificador, "name": nome,
                           "response": {"result": _texto(mensagem.get("content"))}}})
        else:
            texto = _texto(mensagem.get("content"))
            if texto:
                partes.append({"text": texto})
            if isinstance(mensagem.get("content"), list):
                for item in mensagem["content"]:
                    if not isinstance(item, dict) or item.get("type") != "image_url":
                        continue
                    imagem = item.get("image_url") or {}
                    url = imagem.get("url") if isinstance(imagem, dict) else imagem
                    achado = re.fullmatch(r"data:(image/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)", str(url or ""))
                    if not achado:
                        raise ProviderError("o Zed precisa da imagem em formato base64")
                    partes.append({"inlineData": {"mimeType": achado.group(1), "data": achado.group(2)}})
            for chamada in mensagem.get("tool_calls") or []:
                funcao = chamada.get("function") or {}
                try:
                    argumentos = json.loads(funcao.get("arguments") or "{}")
                except (TypeError, ValueError) as erro:
                    raise ProviderError("argumentos inválidos no histórico do Zed") from erro
                if not isinstance(argumentos, dict):
                    raise ProviderError("argumentos de ferramenta do Zed precisam ser um objeto")
                identificador = str(chamada.get("id") or "")
                nome = str(funcao.get("name") or "")
                chamadas_conhecidas[identificador] = nome
                parte: dict[str, Any] = {"functionCall": {"id": identificador, "name": nome, "args": argumentos}}
                assinatura = ((chamada.get("extra_content") or {}).get("google") or {}).get("thought_signature")
                if assinatura:
                    parte["thoughtSignature"] = assinatura
                partes.append(parte)
        adicionar("model" if role == "assistant" else "user", partes)
    corpo: dict[str, Any] = {"contents": conteudos, "generationConfig": {"maxOutputTokens": 8192}}
    if instrucoes:
        corpo["systemInstruction"] = {"role": "user", "parts": [{"text": instrucoes}]}
    if tools:
        funcoes = []
        for item in tools:
            funcao = item.get("function") or item
            if funcao.get("name"):
                funcoes.append({"name": str(funcao["name"]), "description": str(funcao.get("description") or ""),
                                "parameters": funcao.get("parameters") or {"type": "object", "properties": {}}})
        if funcoes:
            corpo["tools"] = [{"functionDeclarations": funcoes}]
    return corpo


def _corpo(provedor: str, modelo: str, mensagens: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
    if provedor == "anthropic":
        request = _anthropic(modelo, mensagens, tools)
    elif provedor == "google":
        request = _google(mensagens, tools)
    elif provedor == "open_ai":
        request = _responses(modelo, mensagens, tools)
    else:
        request = {"model": modelo, "messages": mensagens, "tools": tools, "stream": True}
    return {"thread_id": str(uuid.uuid4()), "prompt_id": str(uuid.uuid4()), "provider": provedor,
            "model": modelo, "provider_request": request}


def _sse(delta: dict[str, Any] | None = None, *, motivo: str | None = None, uso: dict[str, int] | None = None) -> str:
    evento: dict[str, Any] = {"choices": [{"index": 0, "delta": delta or {}, "finish_reason": motivo}]}
    if uso:
        evento["usage"] = uso
    return "data: " + json.dumps(evento, ensure_ascii=False)


class Conversor:
    """Converte os eventos originais em um único formato de fluxo do Koda."""

    def __init__(self, provedor: str) -> None:
        self.provedor = provedor
        self.uso: dict[str, int] = {}
        self.motivo = ""
        self.saida = False
        self.calls: dict[str, dict[str, Any]] = {}
        self.blocos: dict[int, dict[str, Any]] = {}
        self.pensamentos: list[dict[str, Any]] = []
        self._google_vistos: set[str] = set()

    def _texto(self, texto: Any, *, pensamento: bool = False) -> list[str]:
        if not isinstance(texto, str) or not texto:
            return []
        self.saida = True
        return [_sse({"reasoning_content" if pensamento else "content": texto})]

    def receber(self, evento: dict[str, Any]) -> list[str]:
        if evento.get("error"):
            raise ProviderError(f"Zed interrompeu a resposta: {str(evento['error'])[:300]}")
        if self.provedor == "anthropic":
            return self._anthropic(evento)
        if self.provedor == "open_ai":
            return self._responses(evento)
        if self.provedor == "google":
            return self._google(evento)
        escolhas = evento.get("choices") or []
        if escolhas:
            self.saida = self.saida or any(bool((e.get("delta") or {}).get("content") or
                                                   (e.get("delta") or {}).get("tool_calls")) for e in escolhas)
            self.motivo = str(escolhas[0].get("finish_reason") or self.motivo)
        if isinstance(evento.get("usage"), dict):
            self.uso = {"prompt_tokens": int(evento["usage"].get("prompt_tokens") or 0),
                        "completion_tokens": int(evento["usage"].get("completion_tokens") or 0)}
        return ["data: " + json.dumps(evento, ensure_ascii=False)] if escolhas else []

    def _anthropic(self, evento: dict[str, Any]) -> list[str]:
        tipo = evento.get("type")
        saida: list[str] = []
        if tipo == "message_start":
            uso = (evento.get("message") or {}).get("usage") or {}
            self.uso["prompt_tokens"] = int(uso.get("input_tokens") or 0)
        elif tipo == "content_block_start":
            indice = int(evento.get("index") or 0)
            bloco = evento.get("content_block") or {}
            if bloco.get("type") == "tool_use":
                posicao = len(self.calls)
                identificador = str(bloco.get("id") or f"call_{posicao}")
                self.calls[str(indice)] = {"index": posicao, "id": identificador}
                self.saida = True
                inicial = bloco.get("input")
                argumentos = json.dumps(inicial, ensure_ascii=False) if isinstance(inicial, dict) and inicial else ""
                saida.append(_sse({"tool_calls": [{"index": posicao, "id": identificador, "type": "function",
                                                   "function": {"name": str(bloco.get("name") or ""), "arguments": argumentos}}]}))
            elif bloco.get("type") == "thinking":
                self.blocos[indice] = {"type": "thinking", "thinking": str(bloco.get("thinking") or ""),
                                       "signature": str(bloco.get("signature") or "")}
                saida += self._texto(bloco.get("thinking"), pensamento=True)
            elif bloco.get("type") == "redacted_thinking":
                self.pensamentos.append(bloco)
            elif bloco.get("type") == "text":
                saida += self._texto(bloco.get("text"))
        elif tipo == "content_block_delta":
            indice = int(evento.get("index") or 0)
            delta = evento.get("delta") or {}
            if delta.get("type") == "text_delta":
                saida += self._texto(delta.get("text"))
            elif delta.get("type") == "thinking_delta":
                texto = str(delta.get("thinking") or "")
                self.blocos.setdefault(indice, {"type": "thinking", "thinking": "", "signature": ""})["thinking"] += texto
                saida += self._texto(texto, pensamento=True)
            elif delta.get("type") == "signature_delta":
                self.blocos.setdefault(indice, {"type": "thinking", "thinking": "", "signature": ""})["signature"] += str(delta.get("signature") or "")
            elif delta.get("type") == "input_json_delta" and str(indice) in self.calls:
                chamada = self.calls[str(indice)]
                saida.append(_sse({"tool_calls": [{"index": chamada["index"], "function": {"arguments": str(delta.get("partial_json") or "")}}]}))
        elif tipo == "content_block_stop":
            bloco = self.blocos.pop(int(evento.get("index") or 0), None)
            if bloco and bloco.get("signature"):
                self.pensamentos.append(bloco)
        elif tipo == "message_delta":
            delta = evento.get("delta") or {}
            self.motivo = str(delta.get("stop_reason") or self.motivo)
            uso = evento.get("usage") or {}
            if uso.get("output_tokens") is not None:
                self.uso["completion_tokens"] = int(uso["output_tokens"])
        return saida

    def _responses(self, evento: dict[str, Any]) -> list[str]:
        tipo = evento.get("type")
        if tipo == "response.output_text.delta":
            return self._texto(evento.get("delta"))
        if tipo == "response.reasoning_summary_text.delta":
            return self._texto(evento.get("delta"), pensamento=True)
        if tipo == "response.failed":
            detalhe = (evento.get("response") or {}).get("error") or {}
            if not isinstance(detalhe, dict):
                detalhe = {"message": str(detalhe)}
            raise ProviderError(f"Zed interrompeu a resposta: {detalhe.get('message') or 'sem detalhe'}")
        if tipo == "response.output_item.added":
            item = evento.get("item") or {}
            if item.get("type") == "function_call":
                chave = str(item.get("id") or item.get("call_id") or "")
                posicao = len(self.calls)
                identificador = str(item.get("call_id") or chave)
                self.calls[chave] = {"index": posicao, "id": identificador, "args": bool(item.get("arguments"))}
                self.saida = True
                return [_sse({"tool_calls": [{"index": posicao, "id": identificador, "type": "function",
                                              "function": {"name": str(item.get("name") or ""),
                                                           "arguments": str(item.get("arguments") or "")}}]})]
        if tipo == "response.function_call_arguments.delta":
            chave = str(evento.get("item_id") or "")
            chamada = self.calls.get(chave)
            if chamada is not None:
                chamada["args"] = True
                return [_sse({"tool_calls": [{"index": chamada["index"], "function": {"arguments": str(evento.get("delta") or "")}}]})]
        if tipo == "response.output_item.done":
            item = evento.get("item") or {}
            chamada = self.calls.get(str(item.get("id") or item.get("call_id") or ""))
            if chamada and not chamada.get("args") and item.get("arguments"):
                chamada["args"] = True
                return [_sse({"tool_calls": [{"index": chamada["index"], "function": {"arguments": str(item["arguments"])}}]})]
        if tipo in {"response.completed", "response.incomplete"}:
            resposta = evento.get("response") or {}
            usage = resposta.get("usage") or {}
            self.uso = {"prompt_tokens": int(usage.get("input_tokens") or 0),
                        "completion_tokens": int(usage.get("output_tokens") or 0)}
            self.motivo = "length" if tipo == "response.incomplete" else "tool_calls" if self.calls else "stop"
        return []

    def _google(self, evento: dict[str, Any]) -> list[str]:
        saida: list[str] = []
        usage = evento.get("usageMetadata") or evento.get("usage_metadata") or {}
        if usage:
            self.uso = {"prompt_tokens": int(usage.get("promptTokenCount") or 0),
                        "completion_tokens": int(usage.get("candidatesTokenCount") or 0)}
        for candidato in evento.get("candidates") or []:
            motivo = str(candidato.get("finishReason") or "")
            if motivo:
                self.motivo = "length" if motivo == "MAX_TOKENS" else "stop" if motivo == "STOP" else motivo.lower()
            for parte in (candidato.get("content") or {}).get("parts") or []:
                if parte.get("text"):
                    saida += self._texto(parte["text"], pensamento=bool(parte.get("thought")))
                funcao = parte.get("functionCall") or parte.get("function_call")
                if not isinstance(funcao, dict) or not funcao.get("name"):
                    continue
                identificador = str(funcao.get("id") or f"call_{uuid.uuid4().hex}")
                if identificador in self._google_vistos:
                    continue
                self._google_vistos.add(identificador)
                posicao = len(self.calls)
                self.calls[identificador] = {"index": posicao, "id": identificador}
                chamada: dict[str, Any] = {"index": posicao, "id": identificador, "type": "function",
                                            "function": {"name": str(funcao["name"]),
                                                         "arguments": json.dumps(funcao.get("args") or {}, ensure_ascii=False)}}
                assinatura = parte.get("thoughtSignature") or parte.get("thought_signature")
                if assinatura:
                    chamada["extra_content"] = {"google": {"thought_signature": assinatura}}
                self.saida = True
                saida.append(_sse({"tool_calls": [chamada]}))
        return saida

    def terminar(self) -> list[str]:
        if not self.saida:
            raise ProviderError("Zed encerrou a resposta sem conteúdo")
        motivo = self.motivo.lower().replace("-", "_")
        if motivo in {"safety", "blocked", "recitation", "refusal", "malformed_function_call"}:
            raise ProviderError(f"Zed não concluiu a resposta: {motivo}")
        saida = []
        if self.provedor == "anthropic" and self.pensamentos and self.calls:
            primeira = next(iter(self.calls.values()))
            saida.append(_sse({"tool_calls": [{"index": primeira["index"], "_koda_zed_thinking": self.pensamentos}]}))
        final = "length" if motivo in {"max_tokens", "max_output_tokens", "length"} else "tool_calls" if self.calls or motivo == "tool_calls" else "stop"
        saida.append(_sse(motivo=final, uso=self.uso))
        saida.append("data: [DONE]")
        return saida


async def linhas(conta: dict[str, Any], modelo: str, mensagens: list[dict[str, Any]],
                 tools: list[dict[str, Any]]) -> AsyncIterator[str]:
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=20.0)) as cliente:
            try:
                catalogo = await _catalogo(cliente, conta)
                achado = next((item for item in catalogo if _identificador(item.get("id")) == modelo), {})
            except ProviderError:
                achado = {}
            provedor = _provedor(achado.get("provider"), modelo)
            corpo = _corpo(provedor, modelo, mensagens, tools)
            for tentativa in range(2):
                token = await _token(cliente, conta, renovar=tentativa > 0)
                headers = {"authorization": f"Bearer {token}", "content-type": "application/json",
                           "accept": "application/x-ndjson, text/event-stream, */*", "user-agent": "Koda/0.8.0",
                           "x-zed-version": "0.200.0", "x-zed-client-supports-status-messages": "true",
                           "x-zed-client-supports-stream-ended-request-completion-status": "true"}
                async with cliente.stream("POST", f"{BASE}/completions", headers=headers, json=corpo) as resposta:
                    if tentativa == 0 and _token_expirado(resposta):
                        await resposta.aread()
                        continue
                    if resposta.status_code == 429:
                        raise TransientProviderError("a conta Zed está sem cota agora")
                    if resposta.status_code >= 400:
                        detalhe = (await resposta.aread()).decode("utf-8", "replace")
                        raise ProviderError(f"Zed respondeu HTTP {resposta.status_code}: {detalhe[:300]}")
                    conversor = Conversor(provedor)
                    async for linha in resposta.aiter_lines():
                        linha = linha.strip()
                        if not linha or linha.startswith(":"):
                            continue
                        if linha.startswith("data:"):
                            linha = linha[5:].strip()
                        if linha == "[DONE]":
                            break
                        try:
                            item = json.loads(linha)
                        except ValueError:
                            continue
                        if not isinstance(item, dict):
                            continue
                        status = item.get("status")
                        if status:
                            tipo = status if isinstance(status, str) else next(iter(status), "") if isinstance(status, dict) else ""
                            if tipo == "failed":
                                detalhe = status.get("failed") if isinstance(status, dict) else {}
                                raise ProviderError(f"Zed interrompeu a resposta: {str(detalhe or 'falha do serviço')[:300]}")
                            if tipo == "stream_ended":
                                break
                            continue
                        evento = item.get("event", item)
                        if isinstance(evento, dict):
                            for pedaco in conversor.receber(evento):
                                yield pedaco
                    for pedaco in conversor.terminar():
                        yield pedaco
                    return
            raise ProviderError("Zed recusou o token de modelos")
    except (httpx.HTTPError, ValueError) as erro:
        raise TransientProviderError(f"não consegui falar com o Zed: {erro}") from erro
