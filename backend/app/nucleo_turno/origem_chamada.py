"""Port parcial de ToolCall::direct_source e tool_log_payload do router.rs."""
from dataclasses import dataclass


@dataclass(frozen=True, repr=False)
class Chamada:
    namespace: str | None
    nome: str
    id: str
    argumentos_cifrados: tuple[str, ...] | None = None

    def __repr__(self):
        return f'Chamada(namespace={self.namespace!r}, nome={self.nome!r}, id={self.id!r})'

    def origem(self):
        if (self.namespace == 'collaboration' and self.nome in {'spawn_agent', 'send_message', 'followup_task'}
                and self.argumentos_cifrados == ()):
            return 'mensagem_direta_texto'
        return 'direta'

    def texto_log(self, log_preparado: str):
        if self.origem() == 'mensagem_direta_texto':
            return '[plaintext arguments]'
        return log_preparado
