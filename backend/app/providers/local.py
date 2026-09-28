"""Provider local: responde sem modelo nenhum, digitando aos poucos.

É o que entra quando a credencial da conta não está valendo — ninguém logado, sessão
vencida, ou o serviço de modelos recusando quem falou. A resposta existe para o app não
ficar mudo, e diz na cara o que está acontecendo: quem lê precisa saber que **não** é um
modelo de verdade, e o que fazer para voltar a ele. Nada aqui fala em chave de API: o app
não tem chave, quem autoriza é a conta (ver `app/host_auth.py`).
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from .. import host_auth
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

    def _explicacao(self) -> str:
        """Por que esta resposta não é de um modelo, e o que fazer a respeito.

        Com sessão guardada no backend, a credencial chegou e o serviço de modelos é quem
        recusou (sessão expirada ou revogada); sem sessão, ninguém está logado. As duas
        situações se resolvem do mesmo jeito — entrar de novo —, mas o texto diz qual é,
        porque é isso que evita a pessoa procurar o problema no lugar errado.
        """
        if host_auth.atual() is None:
            return (
                "Sou o servidor local do Koda: você não está conectado à sua conta, então "
                "esta resposta foi gerada aqui na máquina — sem modelo de verdade e sem "
                "ferramentas. Entre na sua conta para falar com os modelos do Koda."
            )
        return (
            "Sou o servidor local do Koda: a sessão da sua conta não está valendo para o "
            "serviço de modelos, então esta resposta foi gerada aqui na máquina — sem "
            "modelo de verdade e sem ferramentas. Saia da conta e entre de novo para "
            "voltar aos modelos do Koda."
        )

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
        blocks = [self._explicacao(), f"Recebi: “{last_user}”."]
        if options.attachments:
            blocks.append("Anexos recebidos: " + ", ".join(options.attachments) + ".")
        blocks.append(settings_line)
        return "\n\n".join(part for part in blocks if part)

    async def stream(self, turns: list[ChatTurn], options: ChatOptions) -> AsyncIterator[Piece]:
        for index, word in enumerate(self._reply(turns, options).split(" ")):
            yield Piece(word if index == 0 else f" {word}")
            if self.delay:
                await asyncio.sleep(self.delay)
