#!/usr/bin/env python
"""Diagnóstico: o modo da rodada fica preso no primeiro turno da conversa?

Reproduz a sequência do dono — conversa → planejamento → execução — no **mesmo** histórico
acumulado, e imprime, para cada turno: a classificação, o catálogo oferecido e o aviso que o
modelo recebe no prompt de sistema.

Uso: .venv/Scripts/python.exe diagnostico-conversa-ferramentas.py
"""

from __future__ import annotations

import asyncio
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.agent import loop as laco  # noqa: E402
from app.contracts.turn import StepResult  # noqa: E402
from app.tools import registry  # noqa: E402


class ModeloFalso:
    """Só devolve texto — o que interessa aqui é o catálogo que o laço oferece."""

    name = "falso"
    ready = True

    def __init__(self) -> None:
        self.catalogos: list[list[str]] = []
        self.sistemas: list[str] = []

    async def step(self, messages, tools, model: str = "") -> StepResult:
        self.catalogos.append([item["function"]["name"] for item in tools])
        self.sistemas.append(str(messages[0].get("content", "")))
        return StepResult(text="Ok, entendi.")


TURNOS = [
    "oi, tudo bem? o que você sabe fazer?",
    "faz um plano pra refatorar o app.py",
    "agora execute o plano",
    "beleza, obrigado!",
    "edite o arquivo app.py e troque a função ola por oi",
]

#: O que o dono espera de cada turno.
ESPERADO = {
    0: "resposta",
    1: "codigo (ou resposta — é plano, não execução)",
    2: "codigo  <-- o caso do bug",
    3: "resposta",
    4: "codigo",
}


def main() -> int:
    tmp = tempfile.TemporaryDirectory(prefix="koda-diag-")
    workspace = Path(tmp.name)
    (workspace / "app.py").write_text("def ola():\n    return 'oi'\n", encoding="utf-8")

    historico: list[dict] = [{"role": "system", "content": "Você é o Koda."}]
    falhas = 0

    print("=" * 78)
    print("MODO DA RODADA, TURNO A TURNO (mesmo histórico acumulado)")
    print("=" * 78)

    for indice, pedido in enumerate(TURNOS):
        historico.append({"role": "user", "content": pedido})

        modo = laco.classificar_pedido(historico)
        proibidas, sem_ferramentas = laco.restricoes_do_pedido(historico)
        #: O que a régua do dono espera: pedido que toca o projeto tem de virar código.
        espera_codigo = indice in (2, 4)

        modelo = ModeloFalso()
        eventos: list[tuple[str, dict]] = []

        async def emit(nome: str, dados: dict) -> None:
            eventos.append((nome, dados))

        resultado = asyncio.run(
            laco.executar(
                modelo,
                [dict(item) for item in historico],
                workspace=workspace,
                max_steps=2,
                emit=emit,
                timeout_s=20,
                tool_call_timeout_s=10,
            )
        )

        oferecidas = modelo.catalogos[0] if modelo.catalogos else []
        sistema = modelo.sistemas[0] if modelo.sistemas else ""
        avisou_sem_ferramenta = "NÃO HÁ FERRAMENTA NENHUMA" in sistema
        avisou_resposta = "RODADA É DE RESPOSTA" in sistema

        veredito = "codigo" if modo == laco.MODO_CODIGO else "resposta"
        bateu = (veredito == "codigo") == espera_codigo
        if not bateu:
            falhas += 1

        print(f"\n--- turno {indice + 1}: {pedido!r}")
        print(f"    classificacao : {veredito}   (esperado: {ESPERADO[indice]})")
        print(f"    catalogo      : {len(oferecidas)} ferramenta(s)")
        if len(oferecidas) <= 6:
            print(f"    quais         : {', '.join(sorted(oferecidas))}")
        print(f"    tem shell/edit: {'shell' in oferecidas}/{'edit_file' in oferecidas}")
        print(f"    aviso no system: sem-ferramenta={avisou_sem_ferramenta} resposta={avisou_resposta}")
        if not bateu:
            print(f"    >>> DIVERGE do esperado")

        historico.append({"role": "assistant", "content": resultado.texto})

    print("\n" + "=" * 78)
    print(f"{falhas} divergencia(s)" if falhas else "TUDO COMO O DONO ESPERA")
    print("=" * 78)
    tmp.cleanup()
    return 1 if falhas else 0


if __name__ == "__main__":
    raise SystemExit(main())
