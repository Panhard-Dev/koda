"""Régua do plano e dados padrão da conta.

Só o **nome** do plano mora aqui agora. Os tetos de mensagens (20/dia, 100/semana, 300/mês)
saíram: a tela de Uso passou a mostrar **tempo gasto e tokens**, sem comparar com teto — e um
teto de mensagens que não é o que se cobra é um número que confunde mais do que informa.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Plan:
    name: str


PLAN = Plan(name="Free")

ACCOUNT_DEFAULTS = {
    # Sem nome de fábrica: quem dá nome à conta é o painel, no login. Se este campo
    # aparecer vazio na tela, é porque o nome ainda não chegou — melhor vazio que o
    # nome de outra pessoa.
    "name": "",
    "plan": PLAN.name,
    "phone": None,
    "google": 0,
    "email": None,
}
