"""Async OpenAI-compatible streaming text client; no SDK dependency.

Supports Chat Completions and Responses text streaming. It does not execute
model-requested tools. The backend itself does not authenticate users.
"""
import asyncio
import json
import os
import ssl
from urllib.parse import urlsplit
from dataclasses import dataclass

DEFAULT_BASE_URL = "http://127.0.0.1:3425/v1"
DEFAULT_MODEL = "workbuddy-ai/hy3"
_MAX_FRAME = 8 * 1024 * 1024


class ModelError(Exception):
    pass


@dataclass
class ModelResult:
    text: str
    tool_calls: list[dict]


def model_settings(model=None):
    base = os.environ.get("KODA_MOTOR_MODEL_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
    model = model or os.environ.get("KODA_MOTOR_MODEL", DEFAULT_MODEL)
    api = os.environ.get("KODA_MOTOR_MODEL_API", "chat")
    if not isinstance(model, str) or not model.strip():
        raise ModelError("nome de modelo ausente")
    if api not in ("chat", "responses"):
        raise ModelError("KODA_MOTOR_MODEL_API deve ser chat ou responses")
    return base, model, api


async def _body(reader, headers):
    transfer = headers.get("transfer-encoding", "").lower()
    if "chunked" in transfer:
        while True:
            line = await reader.readline()
            try:
                length = int(line.split(b";", 1)[0].strip(), 16)
            except ValueError as error:
                raise ModelError("resposta HTTP chunked inválida") from error
            if length < 0 or length > _MAX_FRAME:
                raise ModelError("bloco HTTP excede o limite")
            if length == 0:
                while line := await reader.readline():
                    if line in (b"\r\n", b"\n"):
                        break
                return
            data = await reader.readexactly(length)
            if await reader.readexactly(2) != b"\r\n":
                raise ModelError("delimitador HTTP inválido")
            yield data
    elif "content-length" in headers:
        try:
            remaining = int(headers["content-length"])
        except ValueError as error:
            raise ModelError("Content-Length inválido") from error
        if remaining < 0:
            raise ModelError("Content-Length inválido")
        while remaining:
            data = await reader.read(min(65536, remaining))
            if not data:
                raise ModelError("resposta HTTP incompleta")
            remaining -= len(data)
            yield data
    else:
        while data := await reader.read(65536):
            yield data


def _chat_text(message):
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(part.get("text", "") for part in content
                       if isinstance(part, dict) and isinstance(part.get("text"), str))
    return ""


def _validate_calls(calls):
    if not isinstance(calls, list) or len(calls) > 32:
        raise ModelError("lista de ferramentas inválida")
    seen = set()
    for call in calls:
        if not isinstance(call, dict) or call.get("type") != "function":
            raise ModelError("chamada de ferramenta inválida")
        function = call.get("function")
        call_id = call.get("id")
        if (not isinstance(call_id, str) or not call_id or call_id in seen or
            not isinstance(function, dict) or not isinstance(function.get("name"), str) or
            not function["name"] or not isinstance(function.get("arguments"), str) or
            len(function["arguments"].encode("utf-8")) > 1024 * 1024):
            raise ModelError("chamada de ferramenta incompleta")
        seen.add(call_id)
    return calls


async def stream_text(messages, model, on_delta, tools=None):
    base, model, api = model_settings(model)
    url = urlsplit(base)
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ModelError("URL base do provedor inválida")
    try:
        port = url.port or (443 if url.scheme == "https" else 80)
    except ValueError as error:
        raise ModelError("porta do provedor inválida") from error
    path = url.path.rstrip("/") + ("/chat/completions" if api == "chat" else "/responses")
    if not path.startswith("/") or any(c in path for c in "\r\n "):
        raise ModelError("caminho do provedor inválido")
    if api == "chat":
        payload = {"model": model, "messages": messages, "stream": True}
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
    else:
        payload = {"model": model, "input": messages, "stream": True, "store": False}
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    key = os.environ.get("KODA_MOTOR_MODEL_API_KEY")
    if key and ("\r" in key or "\n" in key):
        raise ModelError("chave do provedor inválida")
    host = url.hostname.encode("idna").decode("ascii")
    if ":" in host:
        host = f"[{host}]"
    host_header = f"{host}:{port}"
    headers = [f"POST {path} HTTP/1.1", f"Host: {host_header}", "Content-Type: application/json",
               "Accept: text/event-stream, application/json", "Accept-Encoding: identity",
               f"Content-Length: {len(body)}", "Connection: close"]
    if key:
        headers.append(f"Authorization: Bearer {key}")
    try:
        async with asyncio.timeout(180):
            reader, writer = await asyncio.open_connection(url.hostname, port, ssl=ssl.create_default_context() if url.scheme == "https" else None)
            try:
                writer.write(("\r\n".join(headers) + "\r\n\r\n").encode("ascii") + body)
                await writer.drain()
                status = await reader.readline()
                parts = status.split()
                if len(parts) < 2 or not parts[1].isdigit():
                    raise ModelError("resposta HTTP inválida")
                status_code = int(parts[1])
                response_headers = {}
                for _ in range(100):
                    line = await reader.readline()
                    if line in (b"\r\n", b"\n"):
                        break
                    if not line or b":" not in line:
                        raise ModelError("cabeçalhos HTTP inválidos")
                    name, value = line.split(b":", 1)
                    response_headers[name.decode("ascii").lower()] = value.decode("latin-1").strip()
                else:
                    raise ModelError("cabeçalhos HTTP excessivos")
                if not 200 <= status_code < 300:
                    raise ModelError(f"provedor retornou HTTP {status_code}")
                if "text/event-stream" not in response_headers.get("content-type", "").lower():
                    buffer = bytearray()
                    async for chunk in _body(reader, response_headers):
                        buffer.extend(chunk)
                        if len(buffer) > _MAX_FRAME:
                            raise ModelError("resposta do modelo excede o limite")
                    try:
                        result = json.loads(buffer)
                        if api == "chat":
                            choice = result["choices"][0]
                            if choice.get("finish_reason") not in (None, "stop", "tool_calls"):
                                raise ModelError("provedor não concluiu a resposta")
                            message = choice["message"]
                            text = _chat_text(message)
                            tool_calls = message.get("tool_calls") or []
                        else:
                            if result.get("status") != "completed":
                                raise ModelError("provedor não concluiu a resposta")
                            tool_calls = []
                            text = "".join(part.get("text", "") for item in result.get("output", [])
                                           if item.get("type") == "message" for part in item.get("content", [])
                                           if part.get("type") == "output_text")
                    except (ValueError, KeyError, IndexError, TypeError, AttributeError) as error:
                        raise ModelError("resposta JSON do modelo inválida") from error
                    if not text and not tool_calls:
                        raise ModelError("provedor retornou resposta sem texto")
                    if text:
                        await on_delta(text)
                    return ModelResult(text, _validate_calls(tool_calls))
                pending = b""
                data_lines = []
                completed = False
                saw_text = False
                text_parts = []
                tool_parts = {}
                async def event():
                    nonlocal completed, saw_text
                    if not data_lines:
                        return
                    payload = b"\n".join(data_lines)
                    data_lines.clear()
                    if payload == b"[DONE]":
                        completed = True
                        return
                    try:
                        obj = json.loads(payload)
                        if not isinstance(obj, dict):
                            raise ValueError
                        if "error" in obj or obj.get("type") in ("error", "response.failed", "response.incomplete"):
                            raise ModelError("provedor informou falha no turno")
                        if api == "chat":
                            for choice in obj.get("choices", []):
                                if choice.get("index", 0) != 0:
                                    continue
                                delta = choice.get("delta") or {}
                                if delta.get("function_call"):
                                    raise ModelError("chamadas de função legadas não suportadas")
                                for fragment in delta.get("tool_calls") or []:
                                    index = fragment.get("index")
                                    if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < 32:
                                        raise ModelError("índice de ferramenta inválido")
                                    call = tool_parts.setdefault(index, {"id": "", "type": "function", "function": {"name": "", "arguments": ""}})
                                    for field in ("id",):
                                        if fragment.get(field):
                                            call[field] += fragment[field]
                                    function = fragment.get("function") or {}
                                    for field in ("name", "arguments"):
                                        if function.get(field):
                                            call["function"][field] += function[field]
                                    if len(call["function"]["arguments"].encode("utf-8")) > 1024 * 1024:
                                        raise ModelError("argumentos da ferramenta excedem o limite")
                                text = _chat_text(delta)
                                if text:
                                    saw_text = True
                                    text_parts.append(text)
                                    await on_delta(text)
                                reason = choice.get("finish_reason")
                                if reason in ("stop", "tool_calls"):
                                    completed = True
                                elif reason is not None:
                                    raise ModelError(f"provedor terminou com estado {reason}")
                        else:
                            kind = obj.get("type")
                            if kind == "response.output_text.delta":
                                text = obj.get("delta")
                                if isinstance(text, str) and text:
                                    saw_text = True
                                    text_parts.append(text)
                                    await on_delta(text)
                            elif kind == "response.output_item.added" and (obj.get("item") or {}).get("type") == "function_call":
                                raise ModelError("chamadas de ferramentas ainda não implementadas")
                            elif kind == "response.completed":
                                completed = (obj.get("response") or {}).get("status") == "completed"
                                if not completed:
                                    raise ModelError("provedor não concluiu a resposta")
                    except (ValueError, TypeError, AttributeError) as error:
                        raise ModelError("evento de modelo inválido") from error
                async for chunk in _body(reader, response_headers):
                    pending += chunk
                    if len(pending) > _MAX_FRAME:
                        raise ModelError("evento do modelo excede o limite")
                    while b"\n" in pending:
                        line, pending = pending.split(b"\n", 1)
                        line = line.removesuffix(b"\r")
                        if not line:
                            await event()
                        elif line.startswith(b"data:"):
                            data_lines.append(line[5:].removeprefix(b" "))
                            if sum(map(len, data_lines)) > _MAX_FRAME:
                                raise ModelError("evento do modelo excede o limite")
                if pending.startswith(b"data:"):
                    data_lines.append(pending[5:].removeprefix(b" "))
                await event()
                calls = _validate_calls([tool_parts[index] for index in sorted(tool_parts)])
                if not completed or (not saw_text and not calls):
                    raise ModelError("resposta do modelo incompleta ou sem texto")
                return ModelResult("".join(text_parts), calls)
            finally:
                writer.close()
                await writer.wait_closed()
    except (OSError, asyncio.IncompleteReadError, TimeoutError) as error:
        raise ModelError(f"falha de conexão com provedor: {type(error).__name__}") from error
