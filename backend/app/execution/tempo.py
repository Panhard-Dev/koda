"""Prazos e cancelamento da execução.

`execution/` é folha: este módulo não importa camada nenhuma do projeto. Os dois
`ContextVar` são o prazo da tarefa e o pedido de cancelamento, que a camada de ferramentas
instala antes de chamar a execução.
"""

from __future__ import annotations

import time
from contextvars import ContextVar
from threading import Event

import httpx

_PRAZO_DA_FERRAMENTA: ContextVar[float | None] = ContextVar(
    "prazo_da_ferramenta", default=None
)
_CANCELAMENTO_DA_FERRAMENTA: ContextVar[Event | None] = ContextVar(
    "cancelamento_da_ferramenta", default=None
)


def _restante_da_ferramenta() -> float | None:
    prazo = _PRAZO_DA_FERRAMENTA.get()
    return None if prazo is None else prazo - time.monotonic()


def _verificar_cancelamento() -> None:
    evento = _CANCELAMENTO_DA_FERRAMENTA.get()
    if evento is not None and evento.is_set():
        raise InterruptedError("a pessoa cancelou a tarefa")


def _timeout_da_ferramenta(padrao: float) -> float:
    restante = _restante_da_ferramenta()
    return padrao if restante is None else max(0.05, min(padrao, restante))


def _timeout_httpx(padrao: float) -> httpx.Timeout:
    return httpx.Timeout(_timeout_da_ferramenta(padrao))
