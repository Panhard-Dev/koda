"""Guarda de despacho de ferramenta: a porteira que o catálogo não é.

**Portado do Koda.** Origem: `koda-agent-main/koda_cli/plugins.py`
(`set_thread_tool_whitelist`, `clear_thread_tool_whitelist`,
`_get_pre_tool_call_directive_details` e `_resolve_block_from_details`) e o uso em
`agent/side_question.py`, onde a pergunta lateral roda com

    set_thread_tool_whitelist(set(), deny_msg_fmt=(
        "Side question (/btw) denied tool call: {tool_name}. "
        "Tools are disabled here — answer directly from the conversation context."))

— **lista vazia nega toda chamada no despacho**, e o texto da negação vira o resultado da
ferramenta. O comentário de lá diz o essencial: *"denies every tool call at dispatch"*.

O que se copia é o **mecanismo**, não a lista de nomes: uma *whitelist* consultada **antes**
de a ferramenta rodar, com **fail-closed** (se a própria guarda falhar, nega) e uma
mensagem que o modelo recebe **no lugar da saída**.

Por que isto existe, se o Koda já tira a ferramenta do catálogo: tirar do catálogo é um
**pedido** — funciona enquanto o modelo coopera. A guarda é **imposição**: o modelo que
chama assim mesmo recebe "negado", e não o conteúdo da máquina. Era exatamente por aí que
um pedido com proibição explícita de acesso local terminava com acesso local.

Diferença de propósito em relação ao Koda: lá a lista é um `threading.local`, porque o
despacho acontece na mesma thread. No Koda o laço roda em asyncio e a ferramenta em outra
thread (`asyncio.to_thread`), então a lista vai como **valor explícito da rodada** — ela é
lida antes do despacho, que é onde a decisão acontece, então o efeito é o mesmo e não há
estado ambiente para vazar de uma rodada para a outra.

**Onde isto mora:** em `policy/`, desde a 0.6.3 — é **decisão**, não execução. A ponte
A ponte `app/tools/guardas.py` morreu na 0.6.3, quando o laço virou `app/agent/loop.py`.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..tools import ferramentas
from ..tools import registry

#: O que o modelo recebe quando chama uma ferramenta que a rodada não ofereceu.
#:
#: Diz três coisas, e as três importam: que foi negado, que **não é para insistir** (senão
#: o modelo troca de ferramenta e chega no mesmo lugar) e o que fazer no lugar — responder
#: com o que sabe, ou dizer que não tem acesso.
RECUSA_PADRAO = (
    "NEGADO: a ferramenta {tool_name} não está disponível nesta rodada — a pessoa "
    "restringiu o que pode ser usado. Não insista, não tente outra ferramenta para o mesmo "
    "fim e não peça permissão: responda com o que você já sabe e, quando não souber, diga "
    "que não tem acesso em vez de estimar."
)


@dataclass(frozen=True, slots=True)
class Guarda:
    """O que pode ser chamado nesta rodada.

    `permitidas` é o **catálogo que foi oferecido ao modelo** — a lista nasce da mesma
    decisão que monta as ferramentas da rodada, então "não ofereci" e "não deixo chamar"
    nunca divergem. `None` desliga a guarda (nenhuma restrição nesta rodada).
    """

    permitidas: frozenset[str] | None = None
    mensagem: str = RECUSA_PADRAO

    def nega(self, nome: str) -> str | None:
        """A mensagem de recusa, ou `None` quando a chamada pode seguir.

        **Fail-closed:** nome vazio, guarda quebrada ou comparação que estoure terminam em
        recusa. Uma guarda que falha aberta é pior do que não existir — ela dá a impressão
        de que a restrição está valendo.
        """
        if self.permitidas is None:
            return None
        try:
            canonico = registry.canonico(nome)
            if not canonico or canonico not in self.permitidas:
                return self.mensagem.format(tool_name=nome or "(sem nome)")
            return None
        except Exception:  # noqa: BLE001 — fail-closed, ver docstring
            return self.mensagem.format(tool_name=nome or "(sem nome)")

    def permite(self, nome: str) -> bool:
        return self.nega(nome) is None


def do_catalogo(tools: list[dict[str, object]], mensagem: str = RECUSA_PADRAO) -> Guarda:
    """A guarda da rodada a partir do catálogo que vai ao modelo.

    Catálogo vazio (a pessoa pediu resposta pura, sem ferramenta nenhuma) devolve uma
    guarda que **nega tudo** — o mesmo caso do `/btw` do Koda.
    """
    nomes = frozenset(
        str((item.get("function") or {}).get("name", ""))  # type: ignore[union-attr]
        for item in tools
    )
    return Guarda(permitidas=frozenset(nome for nome in nomes if nome), mensagem=mensagem)


#: Sem restrição nenhuma: tudo passa. É o padrão de quem não passou pelo despacho.
SEM_RESTRICAO = Guarda()
