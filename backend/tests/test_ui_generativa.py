"""A UI gerada só aparece ao vivo depois de validada pelo interpretador fechado."""

from __future__ import annotations

import unittest
from dataclasses import dataclass
from typing import Any

from app.ui_generativa import FiltroKodaUI, bloco_aguenta, filtrar_stream, rebaixar_koda_ui


class UiGenerativaStreamTests(unittest.TestCase):
    def test_supported_block_is_held_until_closing_fence(self):
        filtro = FiltroKodaUI()
        bloco = (
            "```koda-ui\n"
            "{@body const [count, setCount] = DIL.useState(0)}\n"
            "<button onClick={() => setCount(count + 1)}>Mais</button>\n"
            "```"
        )

        self.assertEqual(filtro.alimentar("Texto antes. " + bloco[:-3]), "Texto antes. ")
        final = filtro.alimentar("``` e depois.")
        self.assertIn("```koda-ui", final)
        self.assertTrue(final.endswith(" e depois."))

    def test_opening_fence_can_be_split_across_stream_pieces(self):
        filtro = FiltroKodaUI()
        self.assertEqual(filtro.alimentar("Antes ```koda-"), "Antes ")
        self.assertEqual(filtro.alimentar("ui\n<box><title>ok</title></box>"), "")
        final = filtro.alimentar("```")
        self.assertIn("```koda-ui", final)

    def test_unsupported_event_is_reclassified_before_live_output(self):
        bloco = "```koda-ui\n<button onClick={() => { if (x) setX(1); }}>Ok</button>\n```"
        self.assertFalse(bloco_aguenta(bloco))
        filtro = FiltroKodaUI()
        self.assertEqual(filtro.alimentar(bloco[:-3]), "")
        self.assertIn("```js", filtro.alimentar("```"))

    def test_unsupported_expression_patterns_are_reclassified(self):
        for expressao in ("nome.trim()", "tarefas.indexOf(item)", "$item.texto", "!tarefa.feita"):
            with self.subTest(expressao=expressao):
                texto, rebaixados = rebaixar_koda_ui(f"```koda-ui\n{expressao}\n```")
                self.assertEqual(rebaixados, 1)
                self.assertIn("```js", texto)

    def test_closed_evaluator_builtins_remain_live_ui(self):
        bloco = (
            "```koda-ui\n"
            "{@body const [tarefas, setTarefas] = DIL.useList([])}\n"
            "{@body const [novo, setNovo] = DIL.useState(\"\")}\n"
            '<button onClick={() => setTarefas([...tarefas, {id: Date.now(), texto: novo}]) + setNovo("")}>Adicionar</button>\n'
            "<stat rotulo=\"Pendentes\" valor={String(tarefas.length)} />\n"
            "```"
        )
        texto, rebaixados = rebaixar_koda_ui(bloco)
        self.assertEqual(rebaixados, 0)
        self.assertIn("```koda-ui", texto)


@dataclass
class Peca:
    text: str
    reasoning: bool = False
    truncated: bool = False
    repetiu: bool = False
    usage: Any = None


class UiGenerativaAsyncStreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_async_filter_never_emits_unsupported_live_ui(self):
        async def origem():
            yield Peca("antes ")
            yield Peca("```koda-ui\n<button onClick={() => { if (x) setX(1); }}>Ok</button>\n")
            yield Peca("``` depois")

        emitido = []
        async for peca in filtrar_stream(origem()):
            emitido.append(peca.text)
        texto = "".join(emitido)
        self.assertIn("antes ", texto)
        self.assertIn("```js", texto)
        self.assertNotIn("```koda-ui", texto)
        self.assertTrue(texto.endswith(" depois"))

    def test_truncated_block_is_never_shown_as_ui(self):
        filtro = FiltroKodaUI()
        self.assertEqual(filtro.alimentar("```koda-ui\n<box><title>parcial"), "")
        self.assertIn("```js", filtro.finalizar())


if __name__ == "__main__":
    unittest.main()
