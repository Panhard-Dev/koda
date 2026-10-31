"""Exercita respostas do AgentService sem conectar a contas externas."""
import asyncio
import base64
import json
from types import SimpleNamespace

import pytest

from app import cursor_agent_koda as cursor
from app.providers.base import ProviderError


def test_cursor_reconhece_chamada_mcp_e_filtra_nomes():
    # ServerMessage.exec_request.mcp: nome=ler, call_id=c1, argumentos={"id": 2}.
    payload = bytes.fromhex('121c5a1a0a036c6572120f0a02696412091100000000000000401a026331')
    eventos, respostas, terminou = cursor._evento(payload, {"ler"})
    assert terminou and not respostas
    chamada = eventos[0]["tool_calls"][0]
    assert chamada["function"]["name"] == "ler"
    assert json.loads(chamada["function"]["arguments"]) == {"id": 2}
    with pytest.raises(ProviderError, match="não disponível"):
        cursor._evento(payload, {"outra"})


def test_cursor_canal_entrega_texto_e_fim(monkeypatch):
    payload = bytes.fromhex('0a080a040a026f6b7200')
    quadro = b'\0' + len(payload).to_bytes(4, 'big') + payload
    eventos = [
        {"tipo": "status", "status": 200},
        {"tipo": "dados", "dados": base64.b64encode(quadro).decode()},
    ]
    class Entrada:
        def __init__(self): self.itens = []
        def write(self, dados): self.itens.append(json.loads(dados))
        async def drain(self): pass
    class Saida:
        async def readline(self):
            return (json.dumps(eventos.pop(0)) + '\n').encode() if eventos else b''
    class Processo:
        returncode = None
        def __init__(self): self.stdin, self.stdout = Entrada(), Saida()
        async def wait(self): self.returncode = 0
        def terminate(self): self.returncode = 0
    processo = Processo()
    async def iniciar(*_args, **_kwargs): return processo
    monkeypatch.setattr(cursor.asyncio, 'create_subprocess_exec', iniciar)
    monkeypatch.setattr(cursor.shutil, 'which', lambda _nome: 'node')
    async def executar():
        return [linha async for linha in cursor.linhas(SimpleNamespace(), {"access": "token"}, "modelo", [{"role": "user", "content": "oi"}], [])]
    linhas = asyncio.run(executar())
    assert '"content": "ok"' in linhas[0]
    assert '"finish_reason": "stop"' in linhas[1]
    assert processo.stdin.itens[0]['tipo'] == 'iniciar'
