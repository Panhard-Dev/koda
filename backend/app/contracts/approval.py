"""Identidade e prazo da decisão que desbloqueia uma chamada já em espera."""
from dataclasses import dataclass
import time


@dataclass(frozen=True, slots=True)
class PendingApproval:
    owner: str
    window: str
    conversation_id: str
    task_id: str
    tool_call_id: str
    expires_at: float

    def permits(self, owner: str, window: str) -> bool:
        return (self.owner == owner and self.window == window
                and time.monotonic() < self.expires_at)
