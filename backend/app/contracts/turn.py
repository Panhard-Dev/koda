"""Contratos do turno — o que o provedor entrega e o agente consome.

`contracts/` é compartilhado, não é camada: `providers/` **produz** `StepResult` e
`agent/` **consome**; se estes tipos morassem no laço, o provedor importaria para cima e a
regra de direção (ver `tests/test_arquitetura.py`) nasceria quebrada.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

@dataclass(slots=True)
class ToolCall:
    """Uma chamada pedida pelo modelo."""

    id: str
    name: str
    arguments: dict[str, Any]
    raw_arguments: str = "{}"
    #: O que o provedor mandou junto da chamada e espera receber **de volta**, sem que o Koda
    #: entenda o que é. Hoje é o `extra_content` — o `google.thought_signature` do Gemini 3,
    #: que a Vertex exige no histórico e responde 400 quando falta. Guardar o envelope e
    #: ecoá-lo inteiro é o certo: interpretar um campo opaco é o que quebra na próxima versão
    #: dele. `None` quando não veio nada além dos campos que o Koda já trata.
    extra: dict[str, Any] | None = None

    def para_mensagem(self) -> dict[str, Any]:
        """Formato OpenAI, com os argumentos intactos (o proxy casa pelo id).

        O envelope opaco volta **como veio**: é o que faz um gateway que exige o campo (a
        assinatura do Gemini, por exemplo) continuar aceitando a conversa no segundo passo.
        """
        mensagem: dict[str, Any] = {
            "id": self.id,
            "type": "function",
            "function": {"name": self.name, "arguments": self.raw_arguments or "{}"},
        }
        if self.extra:
            mensagem.update(self.extra)
        return mensagem
@dataclass(slots=True)
class StepResult:
    """Um passo do modelo: texto e/ou pedidos de ferramenta."""

    text: str = ""
    calls: list[ToolCall] = field(default_factory=list)
    usage: dict[str, int] = field(default_factory=dict)
    #: O provedor cortou a resposta no teto de tokens (`finish_reason: "length"`)? O loop usa
    #: isso para avisar em vez de aceitar um JSON de argumentos pela metade como se fosse
    #: uma chamada válida.
    truncado: bool = False
@dataclass(slots=True)
class ToolStep:
    """Passo de ferramenta, o que fica gravado junto da mensagem."""

    name: str
    arguments: dict[str, Any]
    output: str
    duration_ms: int
    call_id: str = ""
    ok: bool = True
    #: A chamada **como o modelo a escreveu**, em texto. `arguments` é essa mesma chamada já
    #: desserializada, e é ela que a ferramenta recebe. Este campo existe para os casos em que
    #: não há o que desserializar: JSON cortado no meio (`finish_reason: "length"`) chega como
    #: `{}`, e o passo ficava sem nenhum registro do que o modelo tinha mandado — quem
    #: depurava via só "caminho vazio" e ia procurar o erro na ferramenta.
    raw_arguments: str = ""
    #: De qual servidor MCP e de qual ferramenta é este passo (`{"servidor", "ferramenta"}`).
    #: Vazio nas ferramentas do Koda. Vai gravado junto da mensagem porque a conversa é
    #: reaberta depois, e sem isto o nome normalizado (`eco_server`) seria tudo o que a tela
    #: teria para mostrar — um nome que não existe no `mcps.json`.
    mcp: dict[str, str] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "arguments": self.arguments,
            "output": self.output,
            "duration_ms": self.duration_ms,
            "call_id": self.call_id,
            "ok": self.ok,
            "raw_arguments": self.raw_arguments,
            "mcp": self.mcp,
        }


def texto_do_conteudo(conteudo: Any) -> str:
    """O texto de um `content` que pode ser string **ou** lista de partes (visão).

    Com imagem, o `content` do turno é `[{type: text}, {type: image_url}, …]`. Passar essa
    lista por `str()` (como se fazia antes) devolveria o `repr` com o base64 inteiro dentro
    — a conta de tokens sairia errada e o corte de contexto escreveria lixo na conversa.
    Aqui só o que é texto conta; a imagem é medida por `TOKENS_POR_IMAGEM`.
    """
    if isinstance(conteudo, list):
        return " ".join(
            str(parte.get("text") or "")
            for parte in conteudo
            if isinstance(parte, dict) and parte.get("type") == "text"
        )
    return str(conteudo or "")
