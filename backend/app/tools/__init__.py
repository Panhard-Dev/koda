"""Ferramentas locais do Koda (catálogo + loop agentic).

Portado do projeto TOOLS do usuário: mesma lista de ferramentas, mesmas mensagens de
erro, agora rodando dentro do backend e narrando cada passo por SSE.
"""

from . import ferramentas
from .loop import (
    PROMPT_FERRAMENTAS,
    Resultado,
    StepResult,
    ToolCall,
    ToolStep,
    executar,
)

__all__ = [
    "PROMPT_FERRAMENTAS",
    "Resultado",
    "StepResult",
    "ToolCall",
    "ToolStep",
    "executar",
    "ferramentas",
]
