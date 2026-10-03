"""E2E das três pendências: cadastrar skill, cadastrar MCP e a IA usando a skill.

Fala com o backend local de verdade (127.0.0.1:8787), que por sua vez usa o host de
produção em 65104. Sem dublê em lugar nenhum.

Uso: python e2e_skills_mcp.py
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8787"
TOKEN = "koda-teste-e2e"
SKILL = "Selo Koda"
MCP = "filesystem-e2e"


def chamar(metodo: str, caminho: str, corpo: dict | None = None) -> tuple[int, object]:
    dados = json.dumps(corpo).encode("utf-8") if corpo is not None else None
    pedido = urllib.request.Request(
        BASE + caminho,
        data=dados,
        method=metodo,
        headers={
            "authorization": f"Bearer {TOKEN}",
            "content-type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(pedido, timeout=30) as resposta:
            texto = resposta.read().decode("utf-8")
            return resposta.status, (json.loads(texto) if texto else None)
    except urllib.error.HTTPError as erro:
        texto = erro.read().decode("utf-8")
        try:
            return erro.code, json.loads(texto)
        except ValueError:
            return erro.code, texto


def chat(texto: str) -> dict:
    """Manda uma mensagem e devolve o texto que o modelo escreveu, lendo o SSE."""
    pedido = urllib.request.Request(
        BASE + "/api/chat",
        data=json.dumps({"text": texto, "model": "liz-4", "tz_offset_minutes": 0}).encode(),
        method="POST",
        headers={"authorization": f"Bearer {TOKEN}", "content-type": "application/json"},
    )
    pedacos: list[str] = []
    conversa = None
    with urllib.request.urlopen(pedido, timeout=180) as resposta:
        evento = ""
        for crua in resposta:
            linha = crua.decode("utf-8").rstrip("\n")
            if linha.startswith("event:"):
                evento = linha.split(":", 1)[1].strip()
            elif linha.startswith("data:"):
                dados = json.loads(linha.split(":", 1)[1].strip())
                if evento == "start":
                    conversa = dados.get("conversation_id")
                elif evento == "delta":
                    pedacos.append(str(dados.get("text", "")))
    return {"texto": "".join(pedacos), "conversa": conversa}


def secao(titulo: str) -> None:
    print(f"\n{'=' * 70}\n{titulo}\n{'=' * 70}")


falhas: list[str] = []


def checar(condicao: bool, frase: str) -> None:
    print(("  OK   " if condicao else "  FALHA") + f" — {frase}")
    if not condicao:
        falhas.append(frase)


# --------------------------------------------------------------- 1. cadastrar skill
secao("1) CADASTRAR SKILL (POST /api/skills)")

status, corpo = chamar(
    "POST",
    "/api/skills",
    {
        "name": SKILL,
        "description": "Marca toda resposta com o selo de skill ativa (skill de diagnóstico).",
        "action": (
            "Comece TODA resposta com a linha exata 'SKILL ATIVA: Selo Koda' e só depois "
            "responda o que foi pedido."
        ),
    },
)
print(f"  POST /api/skills -> {status} {json.dumps(corpo, ensure_ascii=False)[:200]}")
checar(status == 201, "cadastro respondeu 201")
checar(isinstance(corpo, dict) and corpo.get("scope") == "cadastrada", "scope = cadastrada")
checar(isinstance(corpo, dict) and corpo.get("enabled") is True, "nasceu ativa")

status, lista = chamar("GET", "/api/skills")
nomes = [item["name"] for item in lista]
print(f"  GET /api/skills -> {len(nomes)} skills: {nomes}")
checar(SKILL in nomes, "a skill nova aparece na lista existente")
checar(nomes and nomes[0] == SKILL, "a cadastrada vem primeiro na lista")

# validação de campo obrigatório (pela rota, não só pela tela)
status_vazio, _ = chamar("POST", "/api/skills", {"name": "  ", "description": "d", "action": "a"})
checar(status_vazio == 422, f"campo obrigatório vazio é recusado pela rota (422, veio {status_vazio})")
status_dup, _ = chamar("POST", "/api/skills", {"name": SKILL, "description": "d", "action": "a"})
checar(status_dup == 409, f"nome repetido é recusado (409, veio {status_dup})")

# --------------------------------------------------------------- 2. cadastrar MCP
secao("2) CADASTRAR MCP (POST /api/mcps)")

status, corpo = chamar(
    "POST",
    "/api/mcps",
    {
        "name": MCP,
        "command": "npx",
        "params": "-y @modelcontextprotocol/server-filesystem C:/tmp",
        "description": "Servidor de teste cadastrado pela tela.",
    },
)
print(f"  POST /api/mcps -> {status} {json.dumps(corpo, ensure_ascii=False)[:200]}")
checar(status == 201, "cadastro respondeu 201")
checar(isinstance(corpo, dict) and corpo.get("command") == "npx", "comando gravado")
checar(
    isinstance(corpo, dict) and corpo.get("params", "").startswith("-y @modelcontextprotocol"),
    "parâmetros gravados",
)

status, lista = chamar("GET", "/api/mcps")
nomes = [item["name"] for item in lista]
print(f"  GET /api/mcps -> {len(nomes)} servidores: {nomes}")
checar(MCP in nomes, "o servidor novo aparece na lista existente")

status_vazio, _ = chamar("POST", "/api/mcps", {"name": "x", "command": "   "})
checar(status_vazio == 422, f"comando vazio é recusado pela rota (422, veio {status_vazio})")
status_dup, _ = chamar("POST", "/api/mcps", {"name": MCP, "command": "outro"})
checar(status_dup == 409, f"nome repetido é recusado (409, veio {status_dup})")

# --------------------------------------------------------------- 3. a IA usando a skill
secao("3) A IA USANDO A SKILL (POST /api/chat, modelo liz-4 no host de produção)")

resultado = chat("Em uma frase, o que é um loop for em Python?")
print(f"  conversa: {resultado['conversa']}")
print(f"  resposta do modelo:\n    {resultado['texto'][:400]!r}")
checar(
    "SKILL ATIVA: Selo Koda" in resultado["texto"],
    "o modelo aplicou a skill cadastrada (selo presente na resposta)",
)

# Desligada, a skill sai do prompt — e o selo some.
chamar("POST", f"/api/skills/{urllib.parse.quote(SKILL)}/toggle")
resultado2 = chat("Em uma frase, o que é um loop for em Python?")
print(f"  com a skill DESLIGADA, resposta:\n    {resultado2['texto'][:300]!r}")
checar(
    "SKILL ATIVA: Selo Koda" not in resultado2["texto"],
    "com a skill desligada, o selo some (prova de que o efeito veio da skill)",
)

# Limpa as conversas de teste, para o histórico de quem usa não ficar com elas.
for conversa in (resultado["conversa"], resultado2["conversa"]):
    if conversa:
        chamar("DELETE", f"/api/conversations/{conversa}")
print("  conversas de teste apagadas")

secao("RESULTADO")
if falhas:
    print(f"  {len(falhas)} FALHA(S):")
    for item in falhas:
        print(f"    - {item}")
else:
    print("  TODAS AS CHECAGENS PASSARAM")
