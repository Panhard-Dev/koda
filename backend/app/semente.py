"""O que o app precisa ter no `data/` na primeira execução.

O app instalado nasce com o `data/` só com o banco: não tem `mcps.json`, não tem skill
nenhuma. O que o produto **entrega de fábrica** é montado aqui — os padrões ficam ao lado do
código (`backend/app/`, que é a pasta que o instalador copia) e são escritos no `data/` **só
quando o arquivo não existe**.

Nunca passar por cima é a regra, e não um detalhe: `data/` é onde a pessoa mexe pela tela.
Semear a cada abertura desfaria a configuração dela — quem apagou um servidor da lista
veria ele voltar no dia seguinte.

As **skills** não passam por aqui. Elas não são um arquivo de configuração: são pastas com
`SKILL.md` e um catálogo (`skills/skills.json`) que diz quais viajam. Quem lê isso é
`skills.listar` — copiar o conteúdo para dentro de um JSON duplicaria o texto e o faria
envelhecer em dois lugares.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

#: A lista de servidores MCP que o Koda traz, na pasta `mcp/` do projeto — a mesma que o
#: instalador copia. Achada pelo lugar deste arquivo (`<koda>/backend/app/`), então a conta
#: `../../mcp` vale em dev e no instalado, sem variável de ambiente.
PADRAO_MCPS = Path(__file__).resolve().parent.parent.parent / "mcp" / "mcps.json"


def _log(mensagem: str) -> None:
    """Vai para o `stdout` do backend, que o lançador grava em arquivo.

    É por aqui que se descobre, na máquina de quem instalou, por que o app subiu sem MCP —
    sem isto, um `mcps.json` que não deu para escrever viraria "o Painel Dev não tem
    ferramenta nenhuma" e ninguém saberia o motivo.
    """
    print(f"[koda] {mensagem}", flush=True)


def semear(dados: Path) -> list[str]:
    """Escreve os padrões que faltam em `dados`. Devolve o nome do que foi criado.

    `dados` é a pasta ao lado do banco (`settings.database_path.parent`) — a mesma que o
    gerenciador de MCP e a tela usam.
    """
    feitos: list[str] = []
    if semear_mcps(dados):
        feitos.append("mcps.json")
    return feitos


def semear_mcps(dados: Path) -> bool:
    """Cria `data/mcps.json` a partir do padrão, se ainda não existir."""
    destino = dados / "mcps.json"
    if destino.exists():
        return False
    if not PADRAO_MCPS.is_file():
        _log(f"sem lista padrão de MCP em {PADRAO_MCPS} — o app fica sem servidor MCP")
        return False
    # O padrão é lido antes de ser copiado: um JSON quebrado no instalador viraria uma lista
    # vazia silenciosa, e "não tem MCP" é indistinguível de "o arquivo está torto" na tela.
    try:
        itens = json.loads(PADRAO_MCPS.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        _log(f"a lista padrão de MCP está ilegível ({exc}) — não semeei nada")
        return False
    if not isinstance(itens, list) or not itens:
        _log("a lista padrão de MCP está vazia — não semeei nada")
        return False
    try:
        destino.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(PADRAO_MCPS, destino)
    except OSError as exc:
        _log(f"não consegui escrever {destino}: {exc}")
        return False
    nomes = ", ".join(str(item.get("name", "?")) for item in itens if isinstance(item, dict))
    _log(f"{destino.name} criado com {len(itens)} servidor(es): {nomes}")
    return True
