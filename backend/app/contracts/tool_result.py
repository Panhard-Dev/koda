"""Estado de execução é separado da apresentação textual da ferramenta."""
from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True, slots=True)
class ToolResult:
    output: str
    status: Literal["success", "failed", "blocked", "timed_out", "cancelled"]
    executed: bool
    exit_code: int | None = None

    @property
    def ok(self) -> bool:
        return self.executed and self.status == "success"
