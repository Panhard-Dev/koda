"""Permissão antes de mexer na máquina.

São quatro modos, escolhidos no prompt box:

- **manual** — pergunta antes de rodar comando, escrever/editar, apagar ou sair da pasta
  do projeto;
- **default** — deixa passar o trabalho comum (escrever arquivo dentro da pasta) e
  pergunta no que é difícil de desfazer: comando, exclusão, mexer fora da pasta;
- **auto** — não pergunta nada; as ferramentas de arquivo continuam no projeto;
- **livre** — não pergunta nada e libera as ferramentas de arquivo fora do projeto.

Ferramenta de **servidor externo** (MCP) pergunta em manual e em default. O Koda não sabe o
que ela faz — roda no processo do servidor, e o que ela pode fazer é o que o servidor
decidir —, então não há como classificá-la como «só leitura»: quem decide é a pessoa, com a
descrição que o próprio servidor publicou na mão (`ferramentas._acao_de_mcp`). Em auto e em
livre ela passa como todo o resto: são os modos em que a pessoa já dispensou a pergunta.

O shell executa comandos reais do usuário do sistema em todos os modos. Auto e Livre
dispensam a aprovação desses comandos; escolher Livre também amplia o escopo das
ferramentas de arquivo.

Quem decide *o que* uma ferramenta é mora em `tools/ferramentas.py` (`classificar`): aqui
fica só a política — o que o modo pergunta e o que a pessoa já respondeu para sempre.

**Onde isto mora:** em `policy/`, desde a 0.6.3. A camada decide; não executa e não conhece
o laço do agente.
"""

from __future__ import annotations

import sqlite3
import time

from ..repository import new_id

MODOS = ("manual", "default", "auto", "livre")

#: Os tipos de ação que podem exigir permissão.
KINDS = ("comando", "escrita", "exclusao", "fora_da_pasta", "ferramenta_externa")

#: O que cada modo pergunta antes de fazer.
#:
#: `ferramenta_externa` (MCP) entra em **manual** e **default** — não há como saber o que
#: uma ferramenta de fora faz, e «difícil de desfazer» é exatamente o caso dela. Fica de
#: fora de **auto** e **livre**, que são os modos em que a pessoa já disse que não quer
#: pergunta nenhuma (é o mesmo `PERGUNTA` que faz o `chat.py` passar `aprovar=None`).
PERGUNTA: dict[str, set[str]] = {
    "manual": {"comando", "escrita", "exclusao", "fora_da_pasta", "ferramenta_externa"},
    "default": {"comando", "exclusao", "fora_da_pasta", "ferramenta_externa"},
    "auto": set(),
    "livre": set(),
}

#: Escopo genérico: vale para qualquer alvo daquele tipo de ação.
QUALQUER = "*"

#: Quanto tempo o agente espera por uma resposta antes de considerar «não».
ESPERA_MAXIMA_S = 600

ROTULO = {
    "comando": "comando na máquina",
    "escrita": "escrita de arquivo",
    "exclusao": "exclusão de arquivo",
    "fora_da_pasta": "arquivo fora da pasta do projeto",
    "ferramenta_externa": "ferramenta de servidor externo (MCP)",
}


def modo(conn: sqlite3.Connection) -> str:
    linha = conn.execute("SELECT approval_mode FROM app_settings WHERE id = 1").fetchone()
    valor = str(linha["approval_mode"]) if linha is not None else "default"
    return valor if valor in MODOS else "default"


def definir_modo(conn: sqlite3.Connection, novo: str) -> str:
    if novo not in MODOS:
        raise ValueError(f"modo desconhecido: {novo}")
    conn.execute(
        "INSERT INTO app_settings (id, approval_mode) VALUES (1, ?)"
        " ON CONFLICT(id) DO UPDATE SET approval_mode = excluded.approval_mode",
        (novo,),
    )
    return novo


def regras(conn: sqlite3.Connection) -> list[dict[str, object]]:
    linhas = conn.execute(
        "SELECT * FROM approval_rules ORDER BY created_at DESC"
    ).fetchall()
    return [
        {
            "id": row["id"],
            "kind": row["kind"],
            "escopo": row["scope"],
            "decisao": row["decision"],
            "rotulo": ROTULO.get(str(row["kind"]), str(row["kind"])),
            "criado_em": row["created_at"],
        }
        for row in linhas
    ]


def lembrar(conn: sqlite3.Connection, kind: str, escopo: str, decisao: str) -> None:
    """Grava «sempre permitir» / «nunca permitir» para um tipo de ação e um alvo."""
    if decisao not in ("sempre", "nunca") or kind not in KINDS:
        raise ValueError("decisão ou tipo de ação inválido")
    alvo = (escopo or QUALQUER).strip() or QUALQUER
    conn.execute(
        "INSERT INTO approval_rules (id, kind, scope, decision, created_at)"
        " VALUES (?, ?, ?, ?, ?)"
        " ON CONFLICT DO NOTHING",
        (new_id(), kind, alvo, decisao, int(time.time() * 1000)),
    )
    # O mesmo alvo não pode valer as duas coisas: a resposta nova manda.
    conn.execute(
        "DELETE FROM approval_rules WHERE kind = ? AND scope = ? AND decision != ?",
        (kind, alvo, decisao),
    )


def esquecer(conn: sqlite3.Connection, regra_id: str) -> bool:
    cursor = conn.execute("DELETE FROM approval_rules WHERE id = ?", (regra_id,))
    return cursor.rowcount > 0


def limpar(conn: sqlite3.Connection) -> int:
    cursor = conn.execute("DELETE FROM approval_rules")
    return cursor.rowcount


def regra(conn: sqlite3.Connection, kind: str, escopo: str) -> str | None:
    """Decisão já tomada para esta ação: a do alvo exato vence a genérica."""
    for alvo in ((escopo or "").strip(), QUALQUER):
        linha = conn.execute(
            "SELECT decision FROM approval_rules WHERE kind = ? AND scope = ?",
            (kind, alvo),
        ).fetchone()
        if linha is not None:
            return str(linha["decision"])
    return None


def kinds_relevantes(info: dict[str, object], modo_atual: str) -> list[str]:
    """Tipos de ação desta chamada que o modo atual manda perguntar."""
    pede = PERGUNTA.get(modo_atual, set())
    return [str(kind) for kind in info.get("kinds", []) if str(kind) in pede]  # type: ignore[union-attr]


def resolver(conn: sqlite3.Connection, info: dict[str, object], modo_atual: str) -> str:
    """O que fazer com esta ação: `seguir`, `perguntar`, `sempre` ou `nunca`.

    Um «nunca» já dado vence qualquer «sempre»: negar é mais seguro do que permitir
    quando a chamada cai em duas regras ao mesmo tempo.
    """
    relevantes = kinds_relevantes(info, modo_atual)
    if not relevantes:
        return "seguir"

    escopos = info.get("escopos", {})
    decisoes = {
        kind: regra(conn, kind, str(escopos.get(kind, "")))  # type: ignore[union-attr]
        for kind in relevantes
    }
    if "nunca" in decisoes.values():
        return "nunca"
    if all(valor == "sempre" for valor in decisoes.values()):
        return "sempre"
    return "perguntar"


def lembrar_tudo(conn: sqlite3.Connection, info: dict[str, object], decisao: str) -> None:
    """Grava a resposta de «sempre/nunca» para cada tipo de ação envolvido."""
    escopos = info.get("escopos", {})
    for kind in info.get("kinds", []):  # type: ignore[union-attr]
        lembrar(conn, str(kind), str(escopos.get(str(kind), QUALQUER)), decisao)  # type: ignore[union-attr]
