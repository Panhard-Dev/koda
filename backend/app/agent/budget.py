"""Orçamento compartilhado pela tarefa, incluindo retries e subagentes."""
from contextvars import ContextVar
from dataclasses import dataclass, field
from functools import wraps
from threading import Lock
import time


class BudgetExhausted(RuntimeError):
    pass


@dataclass
class TaskBudget:
    models: int
    tools: int
    deadline: float
    output_limit: int = 20 * 1024 * 1024
    model_calls: int = 0
    tool_calls: int = 0
    output_bytes: int = 0
    _lock: Lock = field(default_factory=Lock, repr=False)

    def claim_model(self) -> None:
        with self._lock:
            if (time.monotonic() >= self.deadline or self.model_calls >= self.models
                    or self.output_bytes >= self.output_limit):
                raise BudgetExhausted('orçamento compartilhado da tarefa atingido')
            self.model_calls += 1

    def claim_tool(self) -> bool:
        with self._lock:
            if (time.monotonic() >= self.deadline or self.tool_calls >= self.tools
                    or self.output_bytes >= self.output_limit):
                return False
            self.tool_calls += 1
            return True

    def record_output(self, text: str) -> None:
        with self._lock:
            self.output_bytes += len(text.encode('utf-8'))


current: ContextVar[TaskBudget | None] = ContextVar('execution_budget', default=None)


def task_budget(function):
    @wraps(function)
    async def wrapped(*args, **kwargs):
        inherited = current.get()
        budget = inherited or TaskBudget(
            models=max(1, kwargs.get('max_steps') or 500),
            tools=max(1, kwargs.get('max_tool_calls') or 1000),
            deadline=time.monotonic() + max(1, kwargs.get('timeout_s') or 7200))
        binding = current.set(budget)
        try:
            return await function(*args, **kwargs)
        finally:
            current.reset(binding)
    return wrapped
