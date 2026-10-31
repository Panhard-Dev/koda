"""Conversa simples do Cursor via Connect; o modo agente tem protocolo separado."""

from __future__ import annotations

import base64
import hashlib
import json
import platform
import time
import uuid
import zlib
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from typing import Any

import httpx

from .providers.base import ProviderError, TransientProviderError
from .windsurf_koda import LeitorGrpcWeb, _campo, _campos, _varint
from .koda_tool_protocol import _sse


URL = "https://api2.cursor.sh/aiserver.v1.ChatService/StreamUnifiedChatWithTools"
_MAX_DECOMPRIMIDO = 8 * 1024 * 1024


def _inteiro(numero: int, valor: int) -> bytes:
    return _varint(numero * 8) + _varint(valor)


def _texto(conteudo: Any) -> str:
    if isinstance(conteudo, str):
        return conteudo
    if isinstance(conteudo, list):
        if any(isinstance(item, dict) and item.get("type") == "image_url" for item in conteudo):
            raise ProviderError("o modo simples do Cursor ainda não aceita anexos de imagem")
        return "\n".join(str(item.get("text") or "") for item in conteudo if isinstance(item, dict) and item.get("type") == "text")
    return ""


def _pedido(modelo: str, mensagens: list[dict[str, Any]]) -> bytes:
    if not modelo or len(modelo) > 256:
        raise ProviderError("modelo Cursor inválido")
    instrucoes: list[str] = []
    turnos: list[tuple[int, str, str]] = []
    for mensagem in mensagens:
        role = mensagem.get("role") or "user"
        texto = _texto(mensagem.get("content"))
        if mensagem.get("tool_calls"):
            texto += "\nChamadas anteriores: " + json.dumps(mensagem["tool_calls"], ensure_ascii=False)
        if not texto.strip():
            continue
        if role in {"system", "developer"}:
            instrucoes.append(texto)
        else:
            turnos.append((2 if role == "assistant" else 1, texto, str(uuid.uuid4())))
    if not turnos:
        raise ProviderError("a pergunta para o Cursor está vazia")
    if sum(len(texto) for _, texto, _ in turnos) + sum(map(len, instrucoes)) > 200000:
        raise ProviderError("o contexto é grande demais para o Cursor")
    pedido = b""
    for role, texto, ident in turnos:
        pedido += _campo(1, _campo(1, texto) + _inteiro(2, role) + _campo(13, ident) + _inteiro(29, 0) + _inteiro(47, 1))
    pedido += _inteiro(2, 1) + _campo(3, _campo(1, "\n\n".join(instrucoes)) if instrucoes else b"")
    pedido += _inteiro(4, 1) + _campo(5, _campo(1, modelo) + _campo(4, b"")) + _campo(8, b"")
    config = _campo(1, "cursor\\aisettings") + _campo(3, b"") + _campo(6, _campo(1, b"") + _campo(2, b""))
    pedido += _inteiro(13, 1) + _campo(15, config + _inteiro(8, 1) + _inteiro(9, 1)) + _inteiro(19, 1)
    pedido += _campo(23, str(uuid.uuid4()))
    metadata = _campo(1, platform.system().lower()) + _campo(2, platform.machine().lower()) + _campo(5, datetime.now(timezone.utc).isoformat())
    pedido += _campo(26, metadata) + _inteiro(27, 0)
    for role, _, ident in turnos:
        pedido += _campo(30, _campo(1, ident) + _inteiro(3, role))
    pedido += _inteiro(35, 0) + _inteiro(38, 0) + _inteiro(46, 1) + _campo(47, b"")
    pedido += _inteiro(48, 1) + _inteiro(49, 0) + _inteiro(51, 0) + _inteiro(53, 1) + _campo(54, "Ask")
    corpo = _campo(1, pedido)
    return b"\0" + len(corpo).to_bytes(4, "big") + corpo


def _identidade(conta: dict[str, Any]) -> tuple[str, str]:
    token = str(conta.get("access") or "").strip()
    if "::" in token:
        token = token.split("::", 1)[1]
    if not token or "\r" in token or "\n" in token:
        raise ProviderError("a conta Cursor não tem um token válido")
    machine = str((conta.get("specific") or {}).get("machineId") or hashlib.sha256((token + "machineId").encode()).hexdigest())
    if len(machine) > 256 or "\r" in machine or "\n" in machine:
        raise ProviderError("o identificador da conta Cursor é inválido")
    return token, machine


def _headers(conta: dict[str, Any]) -> dict[str, str]:
    token, machine = _identidade(conta)
    timestamp = int(time.time() / 1000)
    valores = [(timestamp >> (deslocamento % 32)) & 255 for deslocamento in (40, 32, 24, 16, 8, 0)]
    anterior = 165
    for i, valor in enumerate(valores):
        anterior = ((valor ^ anterior) + i) & 255
        valores[i] = anterior
    checksum = base64.urlsafe_b64encode(bytes(valores)).decode("ascii").rstrip("=") + machine
    return {"authorization": f"Bearer {token}", "content-type": "application/connect+proto",
            "connect-accept-encoding": "gzip", "connect-protocol-version": "1", "user-agent": "connect-es/1.6.1",
            "x-client-key": hashlib.sha256(token.encode()).hexdigest(), "x-cursor-checksum": checksum,
            "x-cursor-client-version": "3.12.17", "x-cursor-client-type": "ide", "x-cursor-client-device-type": "desktop",
            "x-cursor-client-os": {"Windows": "windows", "Darwin": "macos"}.get(platform.system(), "linux"),
            "x-cursor-client-arch": "aarch64" if platform.machine().lower() in {"arm64", "aarch64"} else "x64",
            "x-cursor-config-version": str(uuid.uuid4()), "x-ghost-mode": "true", "x-request-id": str(uuid.uuid4()),
            "x-session-id": str(uuid.uuid5(uuid.NAMESPACE_DNS, token))}


def _descomprimir(dados: bytes) -> bytes:
    for wbits in (31, 15, -15):
        try:
            obj = zlib.decompressobj(wbits)
            resultado = obj.decompress(dados, _MAX_DECOMPRIMIDO + 1)
            if len(resultado) > _MAX_DECOMPRIMIDO or obj.unconsumed_tail:
                raise ProviderError("resposta Cursor comprimida é grande demais")
            if obj.eof:
                return resultado
        except zlib.error:
            continue
    raise ProviderError("resposta Cursor comprimida inválida")


def _decodificar(dados: bytes) -> tuple[str, str]:
    texto = ""
    pensamento = ""
    try:
        for numero, tipo, valor in _campos(dados):
            if numero != 2 or tipo != 2 or not isinstance(valor, bytes):
                continue
            for interno, tipo_interno, conteudo in _campos(valor):
                if tipo_interno != 2 or not isinstance(conteudo, bytes):
                    continue
                if interno == 1:
                    texto += conteudo.decode("utf-8")
                elif interno == 25:
                    for campo, tipo_campo, parte in _campos(conteudo):
                        if campo == 1 and tipo_campo == 2 and isinstance(parte, bytes):
                            pensamento += parte.decode("utf-8")
    except (UnicodeDecodeError, ProviderError) as erro:
        raise ProviderError("Cursor devolveu uma resposta protobuf inválida") from erro
    return texto, pensamento


async def linhas(conta: dict[str, Any], modelo: str, mensagens: list[dict[str, Any]]) -> AsyncIterator[str]:
    leitor = LeitorGrpcWeb()
    terminou = False
    recebeu = False
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=20.0), follow_redirects=False) as cliente:
            async with cliente.stream("POST", URL, headers=_headers(conta), content=_pedido(modelo, mensagens)) as resposta:
                if resposta.status_code == 429:
                    raise TransientProviderError("a conta Cursor está sem cota agora")
                if resposta.status_code >= 400:
                    raise ProviderError(f"Cursor recusou a conversa (HTTP {resposta.status_code})")
                async for bloco in resposta.aiter_bytes():
                    for flags, quadro in leitor.receber(bloco):
                        if flags & ~3:
                            raise ProviderError("Cursor devolveu um quadro desconhecido")
                        if flags & 1:
                            quadro = _descomprimir(quadro)
                        if flags & 2:
                            try:
                                fim = json.loads(quadro or b"{}")
                            except ValueError as erro:
                                raise ProviderError("Cursor devolveu um encerramento inválido") from erro
                            if isinstance(fim, dict) and fim.get("error"):
                                raise ProviderError("Cursor interrompeu a conversa")
                            terminou = True
                            continue
                        texto, pensamento = _decodificar(quadro)
                        if pensamento:
                            yield _sse({"reasoning_content": pensamento})
                        if texto:
                            recebeu = True
                            yield _sse({"content": texto})
                leitor.terminar()
    except httpx.HTTPError as erro:
        raise TransientProviderError(f"não consegui falar com o Cursor: {erro}") from erro
    if not recebeu:
        raise ProviderError("Cursor encerrou a resposta sem conteúdo")
    yield _sse(motivo="stop" if terminou else "length")
    yield "data: [DONE]"
