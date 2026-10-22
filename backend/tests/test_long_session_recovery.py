"""Regressões offline para retomada e diagnóstico de conversas longas."""

import json
import tempfile
import unittest
from pathlib import Path

import httpx

from app.agent.contexto import (
    LIMITE_RESUMO_ACUMULADO,
    compactar_historico,
    compactar_turnos,
    resumo_acumulado,
    tokens_do_historico,
)
from app.agent.loop import restricoes_do_pedido
from app.config import Settings
from app.db import Database
from app.providers.base import ChatOptions, ChatTurn
from app.providers.openai_compat import HostProvider, OpenAICompatibleProvider, conteudo_do_turno
from app.repository import append_message, ensure_conversation, mensagens_da_conversa, salvar_resumo
from app.routers.chat import _prepare, _registrar_passo_do_stream, _turns
from app.schemas import ChatRequest, Message, ToolStepOut


class LongSessionRecovery(unittest.IsolatedAsyncioTestCase):
    def test_resume_restores_original_task_even_after_summary_covers_it(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Database(Path(directory) / "chat.sqlite")
            db.initialize()
            original = "Leia o anexo em 35 blocos. Não use shell nem busca."
            with db.connect() as conn:
                conversation = ensure_conversation(conn, None, original, 1)
                append_message(conn, conversation, Message(
                    id="u", role="user", text=original, at=1,
                ))
                append_message(conn, conversation, Message(
                    id="a", role="assistant", text="Bloco 11 lido", at=2,
                    incompleto=True,
                    steps=[ToolStepOut(
                        name="read_attachment", arguments={"id": "anexo-1", "inicio": 1501,
                                                           "limite": 150}, output="ok", ok=True,
                    )],
                ))
                # Até a resposta com a chamada pode ter saído do contexto vivo.
                salvar_resumo(conn, conversation, "resumo antigo", 2)
            _, turns, _, _, _ = _prepare(
                db, None, ChatRequest(resume=True, conversation_id=conversation), 3
            )
            recovered = turns[-1].text
            self.assertIn(original, recovered)
            self.assertIn('"inicio": 1501', recovered)
            self.assertIn("read_attachment", recovered)
            self.assertIn("começa em 1651", recovered)
            self.assertNotIn("estado atual do disco", recovered)

    def test_disconnect_keeps_completed_tool_call_for_resume(self):
        passos = []
        chamadas = {}
        publico = _registrar_passo_do_stream("tool_call", {
            "id": "call-1", "name": "read_attachment",
            "arguments": {"id": "anexo", "inicio": 901, "limite": 75},
            "_raw_arguments": '{"id":"anexo","inicio":901,"limite":75}',
            "_provider_extra": {"signature": "opaque"},
        }, passos, chamadas, 5)
        resultado = _registrar_passo_do_stream("tool_result", {
            "id": "call-1", "name": "read_attachment", "output": "123456789",
            "duration_ms": 4, "ok": True,
        }, passos, chamadas, 5)

        self.assertNotIn("_provider_extra", publico)
        self.assertEqual(resultado["output"], "12345")
        self.assertEqual(len(passos), 1)
        self.assertEqual(passos[0].call_id, "call-1")
        self.assertEqual(passos[0].arguments["inicio"], 901)
        self.assertEqual(passos[0].raw_arguments, '{"id":"anexo","inicio":901,"limite":75}')
        self.assertEqual(passos[0].extra, {"signature": "opaque"})

    def test_no_search_command_keeps_attachment_reader(self):
        pedido = [{"role": "user", "content": (
            "Leia o anexo completo. Não use comando de busca. "
            "Responda apenas com o marcador final."
        )}]
        proibidas, sem_ferramentas = restricoes_do_pedido(pedido)
        self.assertFalse(sem_ferramentas)
        self.assertIn("shell", proibidas)
        self.assertNotIn("read_attachment", proibidas)

        proibidas, sem_ferramentas = restricoes_do_pedido([{
            "role": "user", "content": "Responda apenas sem usar nenhuma ferramenta."
        }])
        self.assertTrue(sem_ferramentas)

    def test_database_roundtrip_keeps_private_provider_state(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Database(Path(directory) / "chat.sqlite")
            db.initialize()
            with db.connect() as conn:
                conversation = ensure_conversation(conn, None, "analisar projeto", 1)
                append_message(conn, conversation, Message(
                    id="u", role="user", text="analisar projeto", at=1,
                ))
                append_message(conn, conversation, Message(
                    id="a", role="assistant", text="li o arquivo", at=2,
                    reasoning_content="raciocínio original do provedor",
                    steps=[ToolStepOut(
                        name="read_file", arguments={"path": "a.mq5"}, output="ok",
                        call_id="call_1", raw_arguments='{"path":"a.mq5"}',
                        extra={"extra_content": {"signature": "abc"}},
                    )],
                ))
            with db.connect() as conn:
                messages = mensagens_da_conversa(conn, conversation)
            self.assertEqual(messages[-1].reasoning_content, "raciocínio original do provedor")
            self.assertEqual(messages[-1].steps[0].extra,
                             {"extra_content": {"signature": "abc"}})
            self.assertNotIn("reasoning_content", messages[-1].model_dump())
            self.assertNotIn("extra", messages[-1].steps[0].model_dump())

            turns, _ = _turns(messages)
            assistant = next(turn for turn in turns if turn.role == "assistant")
            self.assertEqual(assistant.reasoning_content, "raciocínio original do provedor")
            self.assertEqual(assistant.chamadas[0]["extra_content"], {"signature": "abc"})
            self.assertEqual(conteudo_do_turno(assistant, incluir_raciocinio=True)["reasoning_content"],
                             "raciocínio original do provedor")

    async def test_provider_error_keeps_complete_body(self):
        detail = json.dumps({"error": {"code": "invalid_request", "message": "tool mismatch",
                                        "details": "diagnostic " + "x" * 500}})
        provider = OpenAICompatibleProvider(
            Settings(_env_file=None), base_url="http://offline.invalid/v1", model="test"
        )
        provider._cliente_http = httpx.AsyncClient(
            transport=httpx.MockTransport(lambda request: httpx.Response(400, text=detail))
        )
        self.addAsyncCleanup(provider._cliente_http.aclose)
        with self.assertRaisesRegex(Exception, "tool mismatch") as caught:
            [piece async for piece in provider.step_streaming([], [])]
        self.assertIn("diagnostic " + "x" * 500, str(caught.exception))

    def test_host_legacy_turn_gets_empty_reasoning_only_with_tools(self):
        host = HostProvider(Settings(_env_file=None))
        messages = [{"role": "assistant", "content": "resposta antiga"}]
        prepared = host._historico_para_pedido(messages, [{"type": "function"}])
        self.assertEqual(prepared[0]["reasoning_content"], "")
        self.assertNotIn("reasoning_content", messages[0])
        self.assertEqual(host._historico_para_pedido(messages, []), messages)
        error = host._erro(400, '{"error":{"message":"signature mismatch","detail":"abc"}}',
                           {"messages": messages})
        self.assertIn('"detail":"abc"', str(error))
        self.assertIn("1 mensagem", str(error))

    def test_compacts_near_sixty_percent_without_orphaned_tools(self):
        history = [{"role": "system", "content": "sistema"},
                   {"role": "user", "content": "escrever código"}]
        for index in range(16):
            history.append({"role": "assistant", "content": None,
                            "reasoning_content": "pensamento " + str(index),
                            "tool_calls": [{"id": f"call_{index}", "type": "function",
                                            "function": {"name": "read_file", "arguments": "{}"}}]})
            history.append({"role": "tool", "tool_call_id": f"call_{index}",
                            "content": "x" * 3000})
        budget = 20_000
        self.assertLess(tokens_do_historico(history), budget)
        before, after = compactar_historico(history, budget)
        self.assertLess(after, before)
        calls = {call["id"] for message in history
                 for call in message.get("tool_calls", [])}
        self.assertTrue(all(message.get("tool_call_id") in calls for message in history
                            if message.get("role") == "tool"))

        # Mesmo com janela anunciada de 1M, o teto local compacta antes de ~64k.
        large = [{"role": "system", "content": "s"},
                 {"role": "user", "content": "tarefa"},
                 {"role": "assistant", "content": None,
                  "tool_calls": [{"id": "old", "type": "function",
                                  "function": {"name": "read_file", "arguments": "{}"}}]},
                 {"role": "tool", "tool_call_id": "old", "content": "x" * 160_000},
                 {"role": "assistant", "content": "resposta"}]
        before, after = compactar_historico(large, 1_000_000)
        self.assertLess(after, before)

        turns = [ChatTurn(role="user", text="tarefa antiga")]
        for index in range(12):
            turns.extend([
                ChatTurn(role="assistant", text="", chamadas=[{"id": f"c{index}"}]),
                ChatTurn(role="tool", text="x" * 200, chamada_id=f"c{index}"),
            ])
        turns.append(ChatTurn(role="user", text="tarefa atual"))
        _, kept, removed = compactar_turnos(turns, 800, inteiros=100)
        self.assertGreater(removed, 0)
        self.assertNotEqual(kept[0].role, "tool")
        self.assertEqual(kept[-1].text, "tarefa atual")

    def test_persisted_summary_stays_bounded_across_many_compactions(self):
        summary = "decisão inicial: usar MQL5"
        for index in range(40):
            summary = resumo_acumulado(summary, f"passo {index}: " + "x" * 500)
        self.assertLessEqual(len(summary), LIMITE_RESUMO_ACUMULADO)
        self.assertIn("decisão inicial: usar MQL5", summary)
        self.assertIn("passo 39:", summary)


if __name__ == "__main__":
    unittest.main()
