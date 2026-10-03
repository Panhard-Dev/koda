"""Política do Koda: o que pode e o que não pode.

Esta camada **decide** — não executa e não conhece o laço do agente. Ela importa `tools/`
(para saber o que é uma ferramenta) e **nada acima disso**: a direção dos imports é
verificada por `tests/test_arquitetura.py`.

- `guards.py` — a porteira do despacho: só o que a rodada ofereceu pode ser chamado.
- `approvals.py` — os modos (manual/default/auto/livre) e as regras «sempre/nunca».
"""
