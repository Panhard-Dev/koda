"""Cliente do Windsurf pela API Connect (`web-backend.windsurf.com`).

O caminho antigo — `LanguageServerService/GetChatMessage` no `apiServerUrl` da conta —
responde **404 page not found**: esse serviço só existe no binário local do Windsurf, não
no servidor. O servidor fala `ApiServerService`, com Connect/protobuf, e a identidade vem
de `SeatManagementService/GetCurrentUser` (chave `devin-synthetic-apikey$…`, conta e org).

O protocolo é o mesmo que o app do Windsurf usa: metadados no campo 1, a mensagem no
campo 3, o `uid` do modelo nos campos 14 e 21. A resposta é uma sequência de quadros
protobuf; o texto vem no campo 3, o raciocínio no 9 e o motivo de parada no 5.
"""

from __future__ import annotations

import json
import re
import secrets
import threading
import time
import uuid
from collections.abc import AsyncIterator, Iterator
from typing import Any

import httpx

from .providers.base import ProviderError, TransientProviderError

HOST = "https://web-backend.windsurf.com"
PERFIL = "/exa.seat_management_pb.SeatManagementService/GetCurrentUser"
CATALOGO = "/exa.api_server_pb.ApiServerService/GetCascadeModelConfigsForSite"
CAMINHO = "/exa.api_server_pb.ApiServerService/GetChatMessage"
VERSAO = "2.0.67"
MAX_QUADRO = 8 * 1024 * 1024

#: Identidade (chave, conta, org) por conta logada — dura 10 min, como no app.
_IDENTIDADES: dict[str, tuple[dict[str, str], float]] = {}
_TRAVA = threading.Lock()


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


def _campo_numero(numero: int, valor: int) -> bytes:
    return _varint(numero * 8) + _varint(valor)


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


def _primeiro(dados: bytes, numero: int, tipo: int = 2) -> Any:
    for atual, atual_tipo, valor in _campos(dados):
        if atual == numero and atual_tipo == tipo:
            return valor
    return None


def _texto(conteudo: Any) -> str:
    if isinstance(conteudo, str):
        return conteudo
    if isinstance(conteudo, list):
        return "\n".join(str(item.get("text") or "") for item in conteudo
                         if isinstance(item, dict) and item.get("text"))
    return "" if conteudo is None else str(conteudo)


def _quadro(payload: bytes) -> bytes:
    return b"\0" + len(payload).to_bytes(4, "big") + payload


def _textos(dados: bytes) -> Iterator[str]:
    """Todo texto legível dentro de uma mensagem protobuf, inclusive nos campos aninhados."""
    try:
        decodificado = dados.decode("utf-8")
    except UnicodeDecodeError:
        decodificado = ""
    if decodificado and all(c.isprintable() or c in "\r\n\t" for c in decodificado):
        yield decodificado
    try:
        campos = list(_campos(dados))
    except (ProviderError, IndexError):
        return
    for _, tipo, valor in campos:
        if tipo == 2 and isinstance(valor, bytes):
            yield from _textos(valor)


def _sessao(conta: dict[str, Any]) -> tuple[str, str]:
    especificos = conta.get("specific") or {}
    sessao = str(especificos.get("apiKey") or conta.get("access") or "")
    if not sessao:
        raise ProviderError("a conta Windsurf não tem credencial")
    return sessao, str(especificos.get("firebaseIdToken") or "")


def _cabecalhos(identidade: dict[str, str], *, fluxo: bool = True) -> dict[str, str]:
    """Cabeçalhos do Connect. Unário (perfil, catálogo) usa `application/proto`;
    só o chat é stream (`application/connect+proto`) — trocar os dois dá HTTP 415."""
    tipo = "application/connect+proto" if fluxo else "application/proto"
    cabecalhos = {
        "accept": tipo,
        "content-type": tipo,
        "connect-protocol-version": "1",
        "user-agent": f"windsurf/{VERSAO}",
        "origin": "https://windsurf.com",
        "referer": "https://windsurf.com/",
        # Nas chamadas unárias o servidor autentica pelo **token de sessão**; a chave
        # sintética só vale dentro do corpo. Trocar os dois devolve 401.
        "X-Auth-Token": identidade["chave"] if fluxo else identidade["sessao"],
        "X-Devin-Session-Token": identidade["sessao"],
    }
    if identidade.get("auth1"):
        cabecalhos["x-devin-auth1-token"] = identidade["auth1"]
    if identidade.get("conta"):
        cabecalhos["x-devin-account-id"] = identidade["conta"]
    if identidade.get("org"):
        cabecalhos["x-devin-primary-org-id"] = identidade["org"]
    return cabecalhos


async def _identidade(cliente: httpx.AsyncClient, conta: dict[str, Any]) -> dict[str, str]:
    """Chave sintética, conta e org — o que o servidor exige em cada pedido."""
    chave_cache = str(conta.get("id") or conta.get("conta") or "")
    with _TRAVA:
        guardado = _IDENTIDADES.get(chave_cache)
    if guardado and guardado[1] > time.monotonic():
        return guardado[0]

    sessao, auth1 = _sessao(conta)
    corpo = (_campo(1, sessao) + _campo_numero(2, 1)
             + _campo_numero(3, 1) + _campo_numero(4, 1))
    try:
        resposta = await cliente.post(
            HOST + PERFIL, content=corpo,
            headers={
                "accept": "application/proto", "content-type": "application/proto",
                "connect-protocol-version": "1", "user-agent": f"windsurf/{VERSAO}",
                "X-Auth-Token": sessao, "X-Devin-Session-Token": sessao,
            },
        )
    except httpx.HTTPError as erro:
        raise TransientProviderError(f"não consegui falar com o Windsurf: {erro}") from erro
    if resposta.status_code == 401:
        raise ProviderError("a sessão do Windsurf expirou; entre de novo")
    if resposta.status_code >= 400:
        raise ProviderError(f"Windsurf recusou a sessão (HTTP {resposta.status_code})")

    dados = resposta.content
    # A chave vem aninhada em campos protobuf e tem caracteres fora de `[\w.-]`; o jeito
    # certo é descer os campos e ler o texto inteiro de cada um.
    chave = next((texto for texto in _textos(dados)
                  if texto.startswith("devin-synthetic-apikey$")), "")
    identidade = {
        "sessao": sessao,
        "auth1": auth1,
        "chave": chave or sessao,
        "conta": (re.search(rb"account-[0-9a-f]{8,}", dados) or [b""])[0].decode(),
        "org": (re.search(rb"org-[0-9a-f]{8,}", dados) or [b""])[0].decode(),
    }
    with _TRAVA:
        _IDENTIDADES[chave_cache] = (identidade, time.monotonic() + 600)
    return identidade


async def modelos(conta: dict[str, Any]) -> list[dict[str, Any]]:
    """Os modelos que a conta pode usar — o catálogo tem 900, mas só os habilitados valem."""
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=20.0)) as cliente:
            identidade = await _identidade(cliente, conta)
            corpo = (_campo(1, identidade["chave"]) + _campo(2, "windsurf")
                     + _campo(3, VERSAO) + _campo(4, VERSAO))
            resposta = await cliente.post(
                HOST + CATALOGO, content=corpo, headers=_cabecalhos(identidade, fluxo=False),
            )
    except httpx.HTTPError as erro:
        raise TransientProviderError(f"não consegui falar com o Windsurf: {erro}") from erro
    if resposta.status_code >= 400:
        raise ProviderError(f"Windsurf recusou o catálogo (HTTP {resposta.status_code})")
    saida: list[dict[str, Any]] = []
    for numero, tipo, valor in _campos(resposta.content):
        if numero != 1 or tipo != 2 or not isinstance(valor, bytes):
            continue
        rotulo = _primeiro(valor, 1)
        uid = _primeiro(valor, 22)
        if not isinstance(uid, bytes) or not uid:
            continue
        if int(_primeiro(valor, 4, 0) or 0):
            continue  # desabilitado para esta conta
        identificador = uid.decode("utf-8", "replace")
        nome = rotulo.decode("utf-8", "replace") if isinstance(rotulo, bytes) else identificador
        saida.append({"id": identificador, "name": nome or identificador})
    return saida


def _pedido(identidade: dict[str, str], modelo: str, mensagens: list[dict[str, Any]]) -> bytes:
    sessao = str(uuid.uuid4())
    ultima = ""
    for mensagem in reversed(mensagens):
        if str(mensagem.get("role") or "") == "user":
            ultima = _texto(mensagem.get("content"))
            break
    metadados = b"".join((
        _campo(1, "windsurf"), _campo(2, VERSAO), _campo(3, identidade["chave"]),
        _campo(4, "en"), _campo(5, "linux"), _campo(7, VERSAO), _campo(8, "x86_64"),
        _campo_numero(9, secrets.randbits(47)), _campo(10, sessao), _campo(12, "windsurf"),
        _campo(13, f"windsurf/{VERSAO}"), _campo(14, "https://windsurf.com/"),
        _campo_numero(15, 0), _campo(20, identidade.get("conta", "")),
        _campo(22, identidade.get("org", "")), _campo(26, "Free"),
        _campo(32, identidade.get("org", "")),
    ))
    # A conversa vai inteira nos campos 3/4; o campo 2 é o texto do último pedido e o
    # campo 14/21 é o `uid` do modelo escolhido no catálogo.
    corpo = _campo(1, metadados) + _campo(2, ultima)
    for mensagem in mensagens:
        papel = str(mensagem.get("role") or "user")
        registro = (_campo(1, str(uuid.uuid4()))
                    + _campo_numero(2, 1 if papel == "user" else 2)
                    + _campo(3, _texto(mensagem.get("content"))))
        corpo += _campo(3, registro)
    corpo += (_campo_numero(7, 1) + _campo(14, modelo) + _campo_numero(18, 2)
              + _campo(21, modelo) + _campo(28, sessao))
    return _quadro(corpo)


def _sse(delta: dict[str, Any] | None = None, *, motivo: str | None = None,
         usage: dict[str, int] | None = None) -> str:
    evento: dict[str, Any] = {"choices": [{"index": 0, "delta": delta or {}, "finish_reason": motivo}]}
    if usage:
        evento["usage"] = usage
    return "data: " + json.dumps(evento, ensure_ascii=False)


def _erro_do_trailer(payload: bytes) -> str:
    texto = payload.decode("utf-8", "replace").strip()
    if not texto:
        return ""
    try:
        dados = json.loads(texto)
    except ValueError:
        return texto[:300]
    erro = dados.get("error") if isinstance(dados, dict) else None
    if isinstance(erro, dict):
        mensagem = str(erro.get("message") or erro.get("code") or "").strip()
        codigo = str(erro.get("code") or "")
        return f"{mensagem} ({codigo})" if mensagem and codigo else (mensagem or codigo)
    return texto[:300]


async def linhas(
    conta: dict[str, Any],
    modelo: str,
    mensagens: list[dict[str, Any]],
    ferramentas: list[dict[str, Any]] | None = None,
) -> AsyncIterator[str]:
    """Entrega eventos no formato OpenAI a partir do stream Connect do Windsurf.

    `ferramentas` é aceito para o contrato do laço, mas o protocolo Connect do Windsurf
    não expõe o esquema de ferramentas de forma verificável — o adaptador não as envia.
    """
    del ferramentas
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=20.0)) as cliente:
            identidade = await _identidade(cliente, conta)
            cabecalhos = _cabecalhos(identidade)
            async with cliente.stream(
                "POST", HOST + CAMINHO, headers=cabecalhos,
                content=_pedido(identidade, modelo, mensagens),
            ) as resposta:
                if resposta.status_code == 401:
                    raise ProviderError("a sessão do Windsurf expirou; entre de novo")
                if resposta.status_code == 429:
                    raise TransientProviderError("a conta Windsurf está sem cota agora")
                if resposta.status_code >= 400:
                    detalhe = (await resposta.aread()).decode("utf-8", "replace")
                    raise ProviderError(f"Windsurf respondeu HTTP {resposta.status_code}: {detalhe[:300]}")
                buffer = bytearray()
                texto = False
                motivo = ""
                uso: dict[str, int] = {}
                async for bloco in resposta.aiter_bytes():
                    buffer.extend(bloco)
                    # Os quadros chegam fatiados pela rede: só consome o que está inteiro.
                    while len(buffer) >= 5:
                        tamanho = int.from_bytes(buffer[1:5], "big")
                        if tamanho > MAX_QUADRO:
                            raise ProviderError("quadro Windsurf grande demais")
                        if len(buffer) < tamanho + 5:
                            break
                        flag = buffer[0]
                        quadro = bytes(buffer[5:5 + tamanho])
                        del buffer[:5 + tamanho]
                        if flag in {2, 128}:
                            erro = _erro_do_trailer(quadro)
                            if erro:
                                if "unauthenticated" in erro:
                                    # O catálogo e o perfil aceitam a sessão, mas o chat remoto
                                    # só reconhece a chave que o **app** do Windsurf gera; a
                                    # chave sintética (`devin-synthetic-apikey$…`) que a conta
                                    # guarda vale apenas para o servidor local do editor.
                                    raise ProviderError(
                                        "a conta Windsurf não autoriza conversa pela API remota "
                                        "(a chave da conta só vale no app do Windsurf); "
                                        "use o Windsurf instalado ou outro provedor"
                                    )
                                raise ProviderError(f"Windsurf interrompeu a resposta: {erro}")
                            continue
                        if flag != 0:
                            raise ProviderError("compressão Windsurf não suportada")
                        delta = _primeiro(quadro, 3)
                        pensamento = _primeiro(quadro, 9)
                        parada = _primeiro(quadro, 5, 0)
                        if isinstance(pensamento, bytes) and pensamento:
                            yield _sse({"reasoning_content": pensamento.decode("utf-8", "replace")})
                        if isinstance(delta, bytes) and delta:
                            texto = True
                            yield _sse({"content": delta.decode("utf-8", "replace")})
                        if parada is not None and int(parada):
                            motivo = "stop"
                        if isinstance(_primeiro(quadro, 8), bytes):
                            uso = _uso(_primeiro(quadro, 8))
                if not texto:
                    raise ProviderError("Windsurf encerrou a resposta sem conteúdo")
                yield _sse(motivo=motivo or "stop", usage=uso)
                yield "data: [DONE]"
    except httpx.HTTPError as erro:
        raise TransientProviderError(f"não consegui falar com o Windsurf: {erro}") from erro


def _uso(dados: Any) -> dict[str, int]:
    if not isinstance(dados, bytes):
        return {}
    contadores = {numero: valor for numero, tipo, valor in _campos(dados) if tipo == 0}
    return {"prompt_tokens": int(contadores.get(1, 0)),
            "completion_tokens": int(contadores.get(2, 0))}
