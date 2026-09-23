"""Provider local: responde sem chave nenhuma, digitando aos poucos.

É o que entra quando não há provedor configurado, para o app continuar funcionando de
ponta a ponta — e para deixar explícito, na própria resposta, que não é um modelo real.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from ..config import Settings
from .base import ChatOptions, ChatTurn, Piece

#: Nomes de exibição dos modelos, para a resposta offline ficar legível.
#: É só rótulo: quem serve os modelos de verdade é o serviço.
MODEL_LABELS = {
    "liz-nano": "Liz Nano",
    "liz-4": "Liz 4",
    "liz-3-flash": "Liz 3 Flash",
    "liz-mini-1-3": "Liz Mini 1.3",
    "liz-mini-2": "Liz Mini 2",
    "koda-1": "Koda 1",
    "layze-2": "Layze 2",
}


class LocalProvider:
    name = "local"
    ready = True

    def __init__(self, settings: Settings) -> None:
        self.delay = max(0, settings.local_stream_delay_ms) / 1000

    def _reply(self, turns: list[ChatTurn], options: ChatOptions) -> str:
        last_user = next((turn.text for turn in reversed(turns) if turn.role == "user"), "")
        parts = [
            f"Modelo: {MODEL_LABELS.get(options.model, options.model)}",
            "Reasoning ativado" if options.reasoning else "Reasoning desativado",
            "busca na Web ativada" if options.web else "sem busca na Web",
        ]
        if options.project:
            parts.append(f"projeto {options.project}")
        settings_line = " · ".join(parts)
        blocks = [
            "Sou o backend local do Koda: não há provedor de modelo configurado, então esta "
            "resposta é gerada aqui no servidor Python, sem sair da máquina.",
            f"Recebi: “{last_user}”.",
        ]
        if options.attachments:
            blocks.append("Anexos recebidos: " + ", ".join(options.attachments) + ".")
        blocks.append(settings_line)
        blocks.append(
            "Já é real nesta build: a conversa inteira é gravada em SQLite, o histórico "
            "sobrevive ao reload e as cotas de uso saem dessas mensagens. Para respostas de "
            "um modelo de verdade, preencha OPENAI_API_KEY (ou aponte OPENAI_BASE_URL para o "
            "Ollama) no backend/.env e reinicie o servidor."
        )
        return "\n\n".join(part for part in blocks if part)

    async def stream(self, turns: list[ChatTurn], options: ChatOptions) -> AsyncIterator[Piece]:
        for index, word in enumerate(self._reply(turns, options).split(" ")):
            yield Piece(word if index == 0 else f" {word}")
            if self.delay:
                await asyncio.sleep(self.delay)
