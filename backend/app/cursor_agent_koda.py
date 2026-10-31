"""Protocolo do agente Cursor e ponte de ferramentas do Koda."""
from __future__ import annotations

import asyncio
import base64
import json
import shutil
import struct
import subprocess
import uuid
from collections import defaultdict
from pathlib import Path
from typing import Any, AsyncIterator

from .cursor_koda import _descomprimir, _headers, _inteiro, _texto
from .koda_tool_protocol import _sse
from .providers.base import ProviderError, TransientProviderError
from .windsurf_koda import LeitorGrpcWeb, _campo, _campos


def _fields(dados: bytes) -> dict[int, list[Any]]:
    out: dict[int, list[Any]] = defaultdict(list)
    for numero, _, valor in _campos(dados):
        out[numero].append(valor)
    return out


def _primeiro(campos: dict[int, list[Any]], numero: int, padrao: Any = b"") -> Any:
    return (campos.get(numero) or [padrao])[0]


def _string(campos: dict[int, list[Any]], numero: int) -> str:
    return bytes(_primeiro(campos, numero)).decode("utf-8")


def _valor(valor: Any) -> bytes:
    if valor is None: return _inteiro(1, 0)
    if isinstance(valor, bool): return _inteiro(4, int(valor))
    if isinstance(valor, (int, float)): return bytes([17]) + struct.pack("<d", float(valor))
    if isinstance(valor, str): return _campo(3, valor)
    if isinstance(valor, list): return _campo(6, b"".join(_campo(1, _valor(v)) for v in valor))
    if isinstance(valor, dict): return _campo(5, b"".join(_campo(1, _campo(1, str(k)) + _campo(2, _valor(v))) for k, v in valor.items()))
    raise ProviderError("esquema de ferramenta Cursor inválido")


def _ler_valor(dados: bytes, nivel: int = 0) -> Any:
    if nivel > 20: raise ProviderError("argumentos Cursor são profundos demais")
    campos = _fields(dados)
    if 1 in campos: return None
    if 4 in campos: return bool(_primeiro(campos, 4))
    if 2 in campos: return struct.unpack("<d", bytes(_primeiro(campos, 2)))[0]
    if 3 in campos: return _string(campos, 3)
    if 5 in campos:
        saida = {}
        for entrada in _fields(bytes(_primeiro(campos, 5))).get(1, []):
            par = _fields(bytes(entrada)); nome = _string(par, 1)
            if nome: saida[nome] = _ler_valor(bytes(_primeiro(par, 2)), nivel + 1)
        return saida
    if 6 in campos:
        return [_ler_valor(bytes(v), nivel + 1) for v in _fields(bytes(_primeiro(campos, 6))).get(1, [])]
    return None


def _quadro(dados: bytes) -> bytes:
    return b"\0" + len(dados).to_bytes(4, "big") + dados


def _pedido(modelo: str, mensagens: list[dict[str, Any]], tools: list[dict[str, Any]]) -> bytes:
    if not modelo or not mensagens: raise ProviderError("pedido Cursor vazio")
    sistema = []
    conversa = []
    for msg in mensagens:
        texto = _texto(msg.get("content"))
        if msg.get("tool_calls"): texto += "\nChamadas: " + json.dumps(msg["tool_calls"], ensure_ascii=False)
        if msg.get("role") == "tool": texto = f"Resultado {msg.get('tool_call_id') or ''}: {texto}"
        if not texto.strip(): continue
        if msg.get("role") in {"system", "developer"}: sistema.append(texto)
        else: conversa.append((msg.get("role"), texto))
    if not conversa: raise ProviderError("pedido Cursor vazio")
    historico = b""
    for papel, texto in conversa[:-1]:
        registro = _campo(1, texto)
        historico += _campo(1, _campo(2 if papel == "assistant" else 1, _campo(1, _campo(1, registro))))
    atual = "\n\n".join([*sistema, conversa[-1][1]])
    mensagem = _campo(1, atual) + _campo(2, str(uuid.uuid4())) + _campo(3, b"") + _inteiro(4, 1)
    acao = _campo(1, mensagem) + (_campo(7, historico) if historico else b"")
    definicoes = b""
    for item in tools:
        funcao = item.get("function") or item
        nome = str(funcao.get("name") or "")
        if not nome: raise ProviderError("ferramenta Cursor sem nome")
        definicao = _campo(1, nome) + _campo(2, str(funcao.get("description") or ""))
        definicao += _campo(3, _valor(funcao.get("parameters") or {})) + _campo(4, "koda") + _campo(5, nome)
        definicoes += _campo(1, definicao)
    detalhes = _campo(1, modelo) + _campo(3, modelo) + _campo(4, modelo)
    requisicao = _campo(1, b"") + _campo(2, _campo(1, acao)) + _campo(3, detalhes)
    if definicoes: requisicao += _campo(4, definicoes)
    requisicao += _campo(9, _campo(1, modelo) + _inteiro(7, 1))
    return _quadro(_campo(1, requisicao))


def _exec_reply(execucao: dict[int, list[Any]], campo: int, conteudo: bytes) -> bytes:
    dados = _inteiro(1, int(_primeiro(execucao, 1, 0))) + _campo(15, _string(execucao, 15)) + _campo(campo, conteudo)
    return _quadro(_campo(2, dados))


def _evento(payload: bytes, permitidas: set[str]) -> tuple[list[dict[str, Any]], list[bytes], bool]:
    eventos, respostas, terminou = [], [], False
    mensagem = _fields(payload)
    if 1 in mensagem:
        update = _fields(bytes(_primeiro(mensagem, 1)))
        for numero, tipo in ((1, "content"), (4, "reasoning_content")):
            if numero in update:
                texto = _string(_fields(bytes(_primeiro(update, numero))), 1)
                if texto: eventos.append({tipo: texto})
        terminou = 14 in update
    if 4 in mensagem:
        kv = _fields(bytes(_primeiro(mensagem, 4))); ident = int(_primeiro(kv, 1, 0))
        campo = 2 if 2 in kv else 3 if 3 in kv else 0
        if campo:
            corpo = _inteiro(1, ident) + _campo(campo, _campo(1, b"") if campo == 2 else b"")
            if 4 in kv: corpo += _campo(4, bytes(_primeiro(kv, 4)))
            respostas.append(_quadro(_campo(3, corpo)))
    if 2 in mensagem:
        execucao = _fields(bytes(_primeiro(mensagem, 2)))
        if 10 in execucao:
            respostas.append(_exec_reply(execucao, 10, _campo(1, _campo(1, b""))))
        elif 11 in execucao:
            mcp = _fields(bytes(_primeiro(execucao, 11))); nome = _string(mcp, 5) or _string(mcp, 1)
            if nome not in permitidas: raise ProviderError("Cursor pediu uma ferramenta não disponível")
            argumentos = {}
            for entrada in mcp.get(2, []):
                par = _fields(bytes(entrada)); chave = _string(par, 1)
                if chave: argumentos[chave] = _ler_valor(bytes(_primeiro(par, 2)))
            chamada = {"index": 0, "id": _string(mcp, 3) or f"call_{uuid.uuid4().hex}", "type": "function",
                       "function": {"name": nome, "arguments": json.dumps(argumentos, ensure_ascii=False)}}
            eventos.append({"tool_calls": [chamada]}); terminou = True
        else:
            variante = next((n for n in execucao if n not in {1, 15}), 0)
            if variante not in {2, 3, 4, 5, 7, 8, 9, 16, 20, 23}:
                raise ProviderError("Cursor solicitou uma operação da IDE não suportada")
            recusa = b"" if variante == 9 else _campo(2, _campo(2, "Use as ferramentas fornecidas pelo Koda."))
            respostas.append(_exec_reply(execucao, variante, recusa))
    return eventos, respostas, terminou


async def linhas(settings: Any, conta: dict[str, Any], modelo: str,
                 mensagens: list[dict[str, Any]], tools: list[dict[str, Any]]) -> AsyncIterator[str]:
    caminho = Path(__file__).with_name("cursor_canal_koda.mjs")
    node_path = getattr(settings, "node_path", None)
    node = str(node_path) if node_path and Path(node_path).is_file() else shutil.which("node")
    if not node or not caminho.is_file():
        raise ProviderError("o agente Cursor precisa do runtime Node do Koda")
    quadro = _pedido(modelo, mensagens, tools)
    permitidas = {str((item.get("function") or item).get("name") or "") for item in tools}
    try:
        processo = await asyncio.create_subprocess_exec(
            node, str(caminho), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, limit=16 * 1024 * 1024,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except OSError as erro:
        raise ProviderError("não consegui iniciar o canal do Cursor") from erro
    leitor = LeitorGrpcWeb()
    recebeu = False
    finalizado = False
    ferramentas = False

    async def enviar(dado: dict[str, Any]) -> None:
        if processo.stdin is None: raise ProviderError("canal Cursor indisponível")
        processo.stdin.write((json.dumps(dado, ensure_ascii=False) + "\n").encode("utf-8"))
        await processo.stdin.drain()

    try:
        await enviar({"tipo": "iniciar", "headers": _headers(conta), "frame": base64.b64encode(quadro).decode("ascii")})
        assert processo.stdout is not None
        while not finalizado:
            linha = await asyncio.wait_for(processo.stdout.readline(), timeout=180)
            if not linha: break
            dado = json.loads(linha)
            tipo = dado.get("tipo") if isinstance(dado, dict) else None
            if tipo == "erro": raise TransientProviderError(str(dado.get("detalhe") or "falha no Cursor")[:200])
            if tipo == "status" and dado.get("status") != 200:
                raise ProviderError(f"Cursor recusou a conversa (HTTP {dado.get('status')})")
            if tipo == "fim": break
            if tipo != "dados": continue
            bloco = base64.b64decode(dado.get("dados") or "", validate=True)
            for flags, conteudo in leitor.receber(bloco):
                if flags & ~3: raise ProviderError("Cursor devolveu um quadro desconhecido")
                if flags & 1: conteudo = _descomprimir(conteudo)
                if flags & 2:
                    fim = json.loads(conteudo or b"{}")
                    if isinstance(fim, dict) and fim.get("error"): raise ProviderError("Cursor interrompeu a conversa")
                    finalizado = True
                    break
                eventos, respostas, terminou = _evento(conteudo, permitidas)
                for resposta in respostas:
                    await enviar({"tipo": "quadro", "frame": base64.b64encode(resposta).decode("ascii")})
                for evento in eventos:
                    recebeu = True
                    ferramentas |= "tool_calls" in evento
                    yield _sse(evento)
                if terminou:
                    finalizado = True
                    break
        if not recebeu: raise ProviderError("Cursor encerrou a resposta sem conteúdo")
        yield _sse(motivo="tool_calls" if ferramentas else "stop" if finalizado else "length")
        yield "data: [DONE]"
    except asyncio.TimeoutError as erro:
        raise TransientProviderError("Cursor demorou para responder") from erro
    except (ValueError, UnicodeDecodeError, struct.error, BrokenPipeError) as erro:
        raise ProviderError("Cursor devolveu uma resposta inválida") from erro
    finally:
        if processo.returncode is None:
            try:
                await enviar({"tipo": "fechar"})
                await asyncio.wait_for(processo.wait(), timeout=3)
            except (BrokenPipeError, ConnectionResetError, asyncio.TimeoutError, ProviderError):
                if processo.returncode is None:
                    processo.terminate()
                    await processo.wait()
