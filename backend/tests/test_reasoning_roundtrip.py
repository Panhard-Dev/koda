"""Regressão offline do HTTP 400 na continuação com ferramentas.

O cliente recebia `reasoning_content` do provedor e o descartava ao montar o turno do
assistente; o segundo passo da rodada voltava sem o campo e era recusado por quem exige o
raciocínio original. Nada aqui fala com a rede: o transporte é simulado e nenhuma
ferramenta de verdade é executada.
"""
import json
import unittest

import httpx

from app.agent.loop import _mensagem_assistente
from app.agent.contexto import compactar_historico, tokens_de_mensagem
from app.config import Settings
from app.contracts.turn import StepResult
from app.providers.openai_compat import OpenAICompatibleProvider


REASON = "synthetic reasoning, not a real conversation"
CALLS = [
    {"index": i, "id": f"call_{i}", "type": "function",
     "function": {"name": f"read_{i}", "arguments": "{}"},
     "extra_content": {"synthetic_signature": f"signature_{i}"}}
    for i in range(2)
]


def sse(deltas):
    chunks = ["data: " + json.dumps({"choices": [{"delta": d}]}) for d in deltas]
    chunks += ['data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
               "data: [DONE]"]
    return "\n\n".join(chunks) + "\n\n"


class ReasoningRoundTrip(unittest.IsolatedAsyncioTestCase):
    async def provider(self, handler):
        provider = OpenAICompatibleProvider(
            Settings(_env_file=None), base_url="http://offline.invalid/v1", model="test"
        )
        provider._cliente_http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.addAsyncCleanup(provider._cliente_http.aclose)
        return provider

    async def test_two_steps_preserve_reasoning_and_two_tool_pairs(self):
        requests = []

        def upstream(request):
            body = json.loads(request.content)
            requests.append(body)
            if len(requests) == 1:
                return httpx.Response(200, text=sse([
                    {"reasoning_content": REASON[:10]},
                    {"reasoning_content": REASON[10:]}, {"tool_calls": CALLS},
                ]))
            assistant = body["messages"][1]
            # Model an upstream that requires its reasoning to be echoed verbatim.
            if assistant.get("reasoning_content") != REASON:
                return httpx.Response(400, json={"error": {"code": "invalid_request"}})
            self.assertEqual([x["id"] for x in assistant["tool_calls"]],
                             ["call_0", "call_1"])
            for i, call in enumerate(assistant["tool_calls"]):
                self.assertEqual(call["extra_content"], CALLS[i]["extra_content"])
            self.assertEqual([m["tool_call_id"] for m in body["messages"][2:]],
                             ["call_0", "call_1"])
            return httpx.Response(200, text=sse([{"content": "verified"}]))

        provider = await self.provider(upstream)
        history = [{"role": "user", "content": "Synthetic read-only test"}]
        pieces = [p async for p in provider.step_streaming(history, [{"type": "function"}])]
        result = pieces[-1]
        self.assertEqual("".join(p.text for p in pieces[:-1] if p.reasoning), REASON)
        history.append(_mensagem_assistente(result))
        history += [{"role": "tool", "tool_call_id": c.id, "content": "read-only result"}
                    for c in result.calls]
        second = [p async for p in provider.step_streaming(history, [])]
        self.assertEqual(second[-1].text, "verified")
        self.assertEqual(len(requests), 2)

    async def test_nonstreaming_keeps_reasoning(self):
        def upstream(request):
            return httpx.Response(200, json={"choices": [{"message": {
                "content": None, "reasoning_content": REASON, "tool_calls": CALLS},
                "finish_reason": "tool_calls"}]})
        result = await (await self.provider(upstream)).step([], [])
        self.assertEqual(_mensagem_assistente(result).get("reasoning_content"), REASON)

    async def test_streaming_empty_reasoning_is_distinct_from_absent(self):
        for delta, expected in [({"reasoning_content": ""}, True), ({"content": "ok"}, False)]:
            with self.subTest(delta=delta):
                provider = await self.provider(lambda request: httpx.Response(200, text=sse([delta])))
                result = [p async for p in provider.step_streaming([], [])][-1]
                self.assertEqual("reasoning_content" in _mensagem_assistente(result), expected)

    def test_legacy_results_do_not_invent_reasoning(self):
        self.assertEqual(_mensagem_assistente(StepResult(text="ok")),
                         {"role": "assistant", "content": "ok"})

    def test_replayed_reasoning_is_counted_in_context_budget(self):
        plain = {"role": "assistant", "content": "ok"}
        with_reasoning = {**plain, "reasoning_content": "x" * 4000}
        self.assertGreater(tokens_de_mensagem(with_reasoning), tokens_de_mensagem(plain) + 500)

    def test_compaction_keeps_reasoning_and_tool_pairing(self):
        """Compactar não pode cortar o raciocínio nem separar chamada de resultado.

        O raciocínio não é `content`, e a compactação só mexe em `content` — mas essa
        garantia não estava sendo verificada por ninguém, e quebrá-la traria o mesmo 400 de
        volta no meio de uma conversa longa, que é exatamente quando ninguém reproduz.
        """
        resultado_grande = "x" * 20_000
        esperado = {f"call_{i}": f"raciocínio {i}" for i in range(6)}
        # Dois orçamentos: um que só encolhe o conteúdo antigo e outro que já tira o miolo.
        for orcamento in (30_000, 5_000):
            with self.subTest(orcamento=orcamento):
                historico: list[dict] = [
                    {"role": "system", "content": "sistema"},
                    {"role": "user", "content": "tarefa"},
                ]
                for i in range(6):
                    historico.append(
                        {
                            "role": "assistant",
                            "content": None,
                            "reasoning_content": esperado[f"call_{i}"],
                            "tool_calls": [
                                {
                                    "id": f"call_{i}",
                                    "type": "function",
                                    "function": {"name": "read_file", "arguments": "{}"},
                                }
                            ],
                        }
                    )
                    historico.append(
                        {"role": "tool", "tool_call_id": f"call_{i}", "content": resultado_grande}
                    )
                historico.append({"role": "assistant", "content": "pronto"})

                antes, depois = compactar_historico(historico, orcamento)
                self.assertLess(depois, antes, "o histórico não encolheu")

                chamadas = {
                    chamada["id"] for item in historico for chamada in (item.get("tool_calls") or [])
                }
                for mensagem in historico:
                    if mensagem.get("role") == "tool":
                        # Resultado órfão é 400 na certa: o host casa pelo `tool_call_id`.
                        self.assertIn(mensagem["tool_call_id"], chamadas)
                    for chamada in mensagem.get("tool_calls") or []:
                        self.assertEqual(
                            mensagem.get("reasoning_content"),
                            esperado[chamada["id"]],
                            "a compactação mexeu no raciocínio de uma chamada que sobreviveu",
                        )

    async def test_nonstring_reasoning_is_not_replayed(self):
        def upstream(request):
            return httpx.Response(200, json={"choices": [{"message": {
                "content": "ok", "reasoning_content": {"invalid": True}}}]})
        result = await (await self.provider(upstream)).step([], [])
        self.assertNotIn("reasoning_content", _mensagem_assistente(result))


if __name__ == "__main__":
    unittest.main()
