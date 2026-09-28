"""Régua do plano e dados padrão da conta.

Estes números são os mesmos que a interface mostra em Uso — quando mudarem aqui,
mude `src/plan.ts` também para a tela continuar coerente.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Plan:
    name: str
    daily_messages: int
    weekly_messages: int
    monthly_messages: int


PLAN = Plan(name="Free", daily_messages=20, weekly_messages=100, monthly_messages=300)

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
