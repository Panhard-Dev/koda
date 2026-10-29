"""Feedback do orquestrador é controle, nunca fala atribuída à pessoa."""
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ControlEvent:
    text: str

    def to_message(self) -> dict[str, str]:
        return {"role": "system", "content": "[Controle do orquestrador]\n" + self.text}


class ControlHistory(list[dict[str, Any]]):
    @staticmethod
    def _control(message: dict[str, Any]) -> dict[str, Any]:
        if message.get("role") == "user":
            return ControlEvent(str(message.get("content", ""))).to_message()
        return message

    def append(self, message: dict[str, Any]) -> None:
        # As falas reais já chegam pelo construtor; append é exclusivo do loop.
        super().append(self._control(message))

    def extend(self, messages) -> None:
        super().extend(self._control(message) for message in messages)

    def insert(self, index: int, message: dict[str, Any]) -> None:
        super().insert(index, self._control(message))

    def __iadd__(self, messages):
        self.extend(messages)
        return self
