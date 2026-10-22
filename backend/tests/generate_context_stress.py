"""Gera um anexo sintético variado para ensaios de leitura e compactação.

Uso: python backend/tests/generate_context_stress.py CAMINHO [--tokens 1100000]
O arquivo não contém dados pessoais nem instruções para o agente.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def linha(numero: int) -> str:
    chave = hashlib.sha256(f"koda-stress-{numero}".encode()).hexdigest()[:16]
    modulo = numero % 8
    if modulo == 0:
        return json.dumps({"ts": f"2026-10-21T{numero % 24:02}:{numero % 60:02}:00Z",
                           "level": "INFO", "component": "agent.loop", "step": numero,
                           "request_id": chave, "status": "tool_result_saved"}, ensure_ascii=False)
    if modulo == 1:
        return f"@@ -{numero},2 +{numero},2 @@ arquivo_{numero % 97}.mq5 | -double risco = {numero % 9}.0; +double risco = {numero % 9}.5; // revisão {chave}"
    if modulo == 2:
        return f"void OnTick_{numero % 101}() {{ double preco = SymbolInfoDouble(_Symbol, SYMBOL_BID); if(preco > {numero % 1000}) Print(\"sinal {chave}\"); }}"
    if modulo == 3:
        return f"DECISAO-{numero:06}: validar stop loss e spread antes de abrir ordem; arquivo=Expert_{numero % 211}.mq5; ticket={chave}; estado=pendente"
    if modulo == 4:
        return f"{numero},EURUSD,{1 + (numero % 10000) / 10000:.4f},{(numero * 7) % 17},BUY,{chave},latencia_ms={(numero * 13) % 997}"
    if modulo == 5:
        return f"Traceback simulado #{numero}: agent -> read_attachment -> compactar_historico -> provider.step; correlation={chave}; retry={numero % 3}"
    if modulo == 6:
        return json.dumps({"event": "tool_call", "id": f"call_{numero}",
                           "name": "read_file", "args": {"path": f"src/mod_{numero % 113}.py",
                           "start": numero, "limit": 25}, "signature": chave}, ensure_ascii=False)
    return f"TODO-{numero:06} [ ] conferir teste de regressão, atualizar relatório e preservar contexto do projeto; referência={chave}; prioridade={numero % 5}"


def gerar(destino: Path, tokens: int) -> tuple[int, int]:
    destino.parent.mkdir(parents=True, exist_ok=True)
    alvo = int(tokens * 3.5)
    tamanho = 0
    numero = 0
    with destino.open("w", encoding="utf-8", newline="\n") as arquivo:
        while tamanho < alvo:
            numero += 1
            registro = f"{numero:07} | {linha(numero)}\n"
            arquivo.write(registro)
            tamanho += len(registro)
        arquivo.write(f"MARCADOR_FINAL: KODA-MISTO-{numero:07}-OK\n")
    return numero, destino.stat().st_size


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("destino", type=Path)
    parser.add_argument("--tokens", type=int, default=1_100_000)
    args = parser.parse_args()
    linhas, bytes_gravados = gerar(args.destino, args.tokens)
    print(f"{linhas} linhas variadas; {bytes_gravados} bytes; {args.destino}")
