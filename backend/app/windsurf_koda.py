"""Cliente gRPC-Web de conversação do Windsurf."""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import AsyncIterator, Iterator
from typing import Any
from urllib.parse import unquote, urlparse

import httpx

from .providers.base import ProviderError, TransientProviderError


CAMINHO = "/exa.language_server_pb.LanguageServerService/GetChatMessage"
MAX_QUADRO = 8 * 1024 * 1024


def _varint(valor: int) -> bytes:
    if valor < 0:
        raise ValueError("varint não pode ser negativo")
    saida = bytearray()
    while valor >= 128:
        saida.append((valor & 127) | 128)
        valor >>= 7
    saida.append(valor)
    return bytes(saida)


def _campo(numero: int, valor: bytes | str) -> bytes:
    dados = valor.encode("utf-8") if isinstance(valor, str) else valor
    return _varint(numero * 8 + 2) + _varint(len(dados)) + dados


def _ler_varint(dados: bytes, pos: int) -> tuple[int, int]:
    valor = 0
    for deslocamento in range(0, 70, 7):
        if pos >= len(dados):
            raise ProviderError("varint Windsurf incompleto")
        byte = dados[pos]
        pos += 1
        valor |= (byte & 127) << deslocamento
        if not byte & 128:
            return valor, pos
    raise ProviderError("varint Windsurf grande demais")


def _campos(dados: bytes) -> Iterator[tuple[int, int, bytes | int]]:
    pos = 0
    while pos < len(dados):
        tag, pos = _ler_varint(dados, pos)
        numero, tipo = tag >> 3, tag & 7
        if numero == 0:
            raise ProviderError("campo protobuf Windsurf inválido")
        if tipo == 0:
            valor, pos = _ler_varint(dados, pos)
        elif tipo == 2:
            tamanho, pos = _ler_varint(dados, pos)
            if pos + tamanho > len(dados):
                raise ProviderError("campo protobuf Windsurf incompleto")
            valor = dados[pos:pos + tamanho]
            pos += tamanho
        elif tipo in {1, 5}:
            tamanho = 8 if tipo == 1 else 4
            if pos + tamanho > len(dados):
                raise ProviderError("campo protobuf Windsurf incompleto")
            valor = dados[pos:pos + tamanho]
            pos += tamanho
        else:
            raise ProviderError(f"tipo protobuf Windsurf desconhecido: {tipo}")
        yield numero, tipo, valor


def _modelo(modelo: str) -> str:
    especiais = {
        "claude-opus-4.5-thinking": "MODEL_CLAUDE_4_5_OPUS_THINKING",
        "claude-opus-4.5": "MODEL_CLAUDE_4_5_OPUS", "claude-sonnet-4.5-thinking": "MODEL_PRIVATE_3",
        "claude-sonnet-4.5": "MODEL_PRIVATE_2", "claude-haiku-4.5": "MODEL_PRIVATE_11",
        "gpt-4.1": "MODEL_CHAT_GPT_4_1_2025_04_14", "gpt-4o": "MODEL_CHAT_GPT_4O_2024_08_06",
        "gemini-2.5-pro": "MODEL_GOOGLE_GEMINI_2_5_PRO", "claude-opus-4.7-review": "opus-4-7-review",
    }
    if modelo in especiais:
        return especiais[modelo]
    if modelo.startswith("gpt-5.2"):
        return "MODEL_GPT_5_2_" + (modelo.removeprefix("gpt-5.2-").upper() if modelo != "gpt-5.2" else "MEDIUM")
    if modelo.startswith("gemini-3.0-flash"):
        nivel = modelo.removeprefix("gemini-3.0-flash-").upper() if modelo != "gemini-3.0-flash" else "HIGH"
        return "MODEL_GOOGLE_GEMINI_3_0_FLASH_" + nivel
    if modelo == "gemini-3.1-pro":
        return "gemini-3-1-pro-high"
    if modelo in {"gpt-5.5", "gpt-5.4", "gpt-5.3-codex"}:
        return modelo.replace(".", "-") + "-medium"
    if modelo.startswith(("swe-", "claude-opus-4.7-", "claude-opus-4.6", "claude-sonnet-4.6",
                          "gpt-5.5-", "gpt-5.4-", "gpt-5.3-codex-", "gemini-3.1-pro-", "kimi-k2.", "glm-5.1")):
        convertido = modelo.replace(".", "-")
        return convertido.removesuffix("-fast") + "-priority" if convertido.endswith("-fast") and convertido.startswith("gpt-") else convertido
    return modelo


def _texto(conteudo: Any) -> str:
    if isinstance(conteudo, str):
        return conteudo
    if isinstance(conteudo, list):
        return "\n".join(str(item.get("text") or "") for item in conteudo if isinstance(item, dict) and item.get("text"))
    return "" if conteudo is None else str(conteudo)


def _pedido(token: str, modelo: str, mensagens: list[dict[str, Any]]) -> bytes:
    sessao = str(uuid.uuid4())
    metadata = b"".join(_campo(i, valor) for i, valor in enumerate(
        (token, "windsurf", "3.14.0", "3.14.0", sessao, "en-US"), start=1))
    corpo = _campo(1, metadata) + _campo(2, str(uuid.uuid4())) + _campo(3, _campo(1, _modelo(modelo)))
    for mensagem in mensagens:
        role = str(mensagem.get("role") or "user")
        texto = _texto(mensagem.get("content"))
        registro = _campo(1, role) + _campo(2, texto)
        if mensagem.get("tool_call_id"):
            registro += _campo(3, str(mensagem["tool_call_id"]))
        corpo += _campo(4, registro)
    return b"\x00" + len(corpo).to_bytes(4, "big") + corpo


class LeitorGrpcWeb:
    def __init__(self) -> None:
        self._buffer = bytearray()

    def receber(self, bloco: bytes) -> list[tuple[int, bytes]]:
        self._buffer.extend(bloco)
        saida: list[tuple[int, bytes]] = []
        while len(self._buffer) >= 5:
            tipo = self._buffer[0]
            tamanho = int.from_bytes(self._buffer[1:5], "big")
            if tamanho > MAX_QUADRO:
                raise ProviderError("quadro gRPC-Web do Windsurf grande demais")
            if len(self._buffer) < tamanho + 5:
                break
            saida.append((tipo, bytes(self._buffer[5:5 + tamanho])))
            del self._buffer[:5 + tamanho]
        return saida

    def terminar(self) -> None:
        if self._buffer:
            raise ProviderError("Windsurf interrompeu um quadro gRPC-Web no meio")


def _decodificar(dados: bytes) -> tuple[str, Any]:
    for numero, tipo, valor in _campos(dados):
        if tipo != 2 or not isinstance(valor, bytes):
            continue
        if numero in {1, 4}:
            for campo, tipo_interno, texto in _campos(valor):
                if campo == 1 and tipo_interno == 2 and isinstance(texto, bytes):
                    try:
                        return ("texto" if numero == 1 else "erro"), texto.decode("utf-8")
                    except UnicodeDecodeError as erro:
                        raise ProviderError("texto Windsurf inválido") from erro
        if numero == 3:
            for campo, tipo_interno, uso in _campos(valor):
                if campo == 1 and tipo_interno == 2 and isinstance(uso, bytes):
                    contadores = {numero_uso: valor_uso for numero_uso, tipo_uso, valor_uso in _campos(uso) if tipo_uso == 0}
                    return "fim", {"prompt_tokens": int(contadores.get(1, 0)), "completion_tokens": int(contadores.get(2, 0))}
            return "fim", {}
    return "outro", None


def _url(conta: dict[str, Any]) -> str:
    base = str((conta.get("specific") or {}).get("apiServerUrl") or "https://server.codeium.com").rstrip("/")
    partes = urlparse(base)
    dominio = (partes.hostname or "").lower()
    try:
        porta = partes.port
    except ValueError as erro:
        raise ProviderError("endereço do Windsurf inválido") from erro
    if (partes.scheme != "https" or partes.username or partes.password or partes.query or partes.fragment or porta not in (None, 443)
            or not any(dominio == base_permitida or dominio.endswith("." + base_permitida)
                       for base_permitida in ("windsurf.com", "codeium.com"))):
        raise ProviderError("endereço do Windsurf inválido")
    return base + CAMINHO


def _sse(delta: dict[str, Any] | None = None, *, motivo: str | None = None, usage: dict[str, int] | None = None) -> str:
    evento: dict[str, Any] = {"choices": [{"index": 0, "delta": delta or {}, "finish_reason": motivo}]}
    if usage:
        evento["usage"] = usage
    return "data: " + json.dumps(evento, ensure_ascii=False)


async def linhas(conta: dict[str, Any], modelo: str, mensagens: list[dict[str, Any]]) -> AsyncIterator[str]:
    token = str((conta.get("specific") or {}).get("apiKey") or conta.get("access") or "")
    if not token:
        raise ProviderError("a conta Windsurf não tem credencial")
    url = _url(conta)
    headers = {"authorization": f"Bearer {token}", "content-type": "application/grpc-web+proto",
               "accept": "application/grpc-web+proto", "user-agent": "windsurf/3.14.0", "x-grpc-web": "1"}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=20.0)) as cliente:
            async with cliente.stream("POST", url, headers=headers, content=_pedido(token, modelo, mensagens)) as resposta:
                if resposta.status_code == 429:
                    raise TransientProviderError("a conta Windsurf está sem cota agora")
                if resposta.status_code >= 400:
                    detalhe = (await resposta.aread()).decode("utf-8", "replace")
                    raise ProviderError(f"Windsurf respondeu HTTP {resposta.status_code}: {detalhe[:300]}")
                leitor = LeitorGrpcWeb()
                texto = False
                uso: dict[str, int] = {}
                async for bloco in resposta.aiter_bytes():
                    for flag, quadro in leitor.receber(bloco):
                        if flag == 128:
                            trailer = quadro.decode("utf-8", "replace")
                            estado = re.search(r"(?:^|\r?\n)grpc-status:\s*(\d+)", trailer, re.IGNORECASE)
                            if estado and estado.group(1) != "0":
                                msg = re.search(r"(?:^|\r?\n)grpc-message:\s*([^\r\n]*)", trailer, re.IGNORECASE)
                                raise ProviderError(f"Windsurf interrompeu a resposta: {unquote(msg.group(1)) if msg else estado.group(1)}")
                        elif flag == 0:
                            tipo, dado = _decodificar(quadro)
                            if tipo == "texto" and dado:
                                texto = True
                                yield _sse({"content": dado})
                            elif tipo == "erro":
                                raise ProviderError(f"Windsurf interrompeu a resposta: {dado}")
                            elif tipo == "fim":
                                uso = dado
                        else:
                            raise ProviderError("compressão gRPC-Web do Windsurf não suportada")
                leitor.terminar()
                if not texto:
                    raise ProviderError("Windsurf encerrou a resposta sem conteúdo")
                yield _sse(motivo="stop", usage=uso)
                yield "data: [DONE]"
    except httpx.HTTPError as erro:
        raise TransientProviderError(f"não consegui falar com o Windsurf: {erro}") from erro
