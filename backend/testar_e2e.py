# -*- coding: utf-8 -*-
"""Teste de ponta a ponta pelo HTTP: koda (8787) -> host (21128) -> ferramenta -> volta.

Le o stream SSE de verdade e confere os eventos. Cria conversas no banco do koda, entao
e para rodar a mao, nao no pytest.
"""
import json
import sys
import time

import httpx

BASE = "http://127.0.0.1:8787"


def eventos(texto: str) -> list[tuple[str, dict]]:
    saida: list[tuple[str, dict]] = []
    nome = None
    for linha in texto.splitlines():
        if linha.startswith("event:"):
            nome = linha.split(":", 1)[1].strip()
        elif linha.startswith("data:"):
            try:
                saida.append((nome or "message", json.loads(linha.split(":", 1)[1].strip())))
            except json.JSONDecodeError:
                pass
    return saida


def conversa(rotulo: str, payload: dict, timeout: float = 180.0) -> list[tuple[str, dict]]:
    print("=" * 90)
    print(rotulo)
    print("=" * 90)
    print("pedido:", json.dumps(payload, ensure_ascii=False)[:180])
    t = time.perf_counter()
    with httpx.Client(timeout=timeout) as c:
        r = c.post(f"{BASE}/api/chat", json=payload)
    dt = time.perf_counter() - t
    print(f"HTTP {r.status_code} em {dt:.1f}s")
    if r.status_code != 200:
        print("corpo:", r.text[:400])
        return []
    evs = eventos(r.text)
    tipos: dict[str, int] = {}
    for nome, _ in evs:
        tipos[nome] = tipos.get(nome, 0) + 1
    print("eventos:", tipos)

    for nome, dados in evs:
        if nome == "tool_call":
            print(f"  [tool_call]   {dados.get('name')} {json.dumps(dados.get('arguments'), ensure_ascii=False)[:110]}")
        elif nome == "tool_result":
            print(f"  [tool_result] ok={dados.get('ok')} {str(dados.get('output'))[:120]!r}")
        elif nome == "done":
            print(f"  [done] passos={dados.get('steps')} completou={dados.get('completed')} modelo={dados.get('usage', {}).get('model')}")
        elif nome == "error":
            print(f"  [error] {dados.get('message')}")

    texto = "".join(d.get("text", "") for n, d in evs if n == "delta")
    print("resposta:", texto.strip()[:260] or "(vazia)")
    print()
    return evs


falhas = 0


def checa(condicao: bool, descricao: str) -> None:
    global falhas
    print(f"  {'ok   ' if condicao else 'FALHA'} {descricao}")
    if not condicao:
        falhas += 1


# 1) texto puro, em streaming, sem ferramenta
evs = conversa(
    "1) streaming simples (tools=false)",
    {"text": "Responda em uma frase curta: o que e um indice de banco de dados?",
     "model": "liz-nano", "tools": False, "tz_offset_minutes": -180},
)
if evs:
    tipos = [n for n, _ in evs]
    checa(tipos[0] == "start", "comeca com 'start'")
    checa(tipos[-1] == "done", "termina com 'done'")
    checa("delta" in tipos, "teve deltas de texto")
    checa("error" not in tipos, "sem evento de erro")

# 2) agente com ferramenta: precisa listar arquivos de verdade
evs = conversa(
    "2) agente com ferramenta (tools=true)",
    {"text": "Liste os arquivos da raiz do projeto usando a ferramenta list_dir e me diga quantos sao.",
     "model": "liz-nano", "tools": True, "tz_offset_minutes": -180},
)
if evs:
    tipos = [n for n, _ in evs]
    checa("tool_call" in tipos, "chamou alguma ferramenta")
    checa("tool_result" in tipos, "a ferramenta devolveu resultado")
    resultados = [d for n, d in evs if n == "tool_result"]
    checa(all(d.get("ok") for d in resultados), "todos os tool_result com ok=True")
    checa("done" in tipos, "terminou com 'done'")
    done = next((d for n, d in evs if n == "done"), {})
    checa(done.get("completed") is True, "a tarefa foi concluida")

# 3) outro modelo do catalogo, para provar que o id chega ao host
evs = conversa(
    "3) modelo diferente (koda-1)",
    {"text": "Diga apenas: modelo koda respondendo.",
     "model": "koda-1", "tools": False, "tz_offset_minutes": -180},
)
if evs:
    checa(any(n == "done" for n, _ in evs), "respondeu com o modelo koda-1")
    checa(not any(n == "error" for n, _ in evs), "sem erro no koda-1")

# 4) id invalido: o host tem que recusar com mensagem clara, nao estourar
evs = conversa(
    "4) id invalido (nao deve derrubar nada)",
    {"text": "oi", "model": "modelo-que-nao-existe", "tools": False, "tz_offset_minutes": -180},
)
if evs:
    tipos = [n for n, _ in evs]
    checa("done" in tipos or "error" in tipos, "respondeu ou avisou o erro, sem travar")

print("=" * 90)
print("falhas:", falhas)
sys.exit(1 if falhas else 0)
