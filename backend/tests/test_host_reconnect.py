"""Regressões para reconexão real do host durante um passo do agente."""

import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

from app.agent.loop import _com_tentativas
from app.config import Settings
from app.contracts.turn import StepResult
from app.providers import ComTeto, HostProvider, host_boot
from app.providers.base import Piece, TransientProviderError
from app.providers.openai_compat import OpenAICompatibleProvider, _retry_after_segundos


class HostReconnect(unittest.IsolatedAsyncioTestCase):
    async def test_fallback_on_rate_limit_and_reuse_after_partial_stream(self):
        settings = Settings(_env_file=None)
        modelo = HostProvider(settings)
        chamadas = []

        async def step(provedor, *_args):
            chamadas.append(provedor.base_url)
            if provedor is modelo:
                raise TransientProviderError("HTTP 429")
            return StepResult(text="reserva respondeu")

        with patch.object(OpenAICompatibleProvider, "step", step):
            resposta = await modelo.step([], [])
            self.assertEqual(resposta.text, "reserva respondeu")
            self.assertEqual(chamadas, [modelo.base_url, modelo._fallback.base_url])
            chamadas.clear()
            await modelo.step([], [])
            self.assertEqual(chamadas, [modelo._fallback.base_url])

    async def test_partial_stream_switches_host_on_next_attempt(self):
        settings = Settings(_env_file=None)
        modelo = HostProvider(settings)
        chamadas = []

        async def stream(provedor, *_args):
            chamadas.append(provedor.base_url)
            if provedor is modelo:
                yield Piece("parcial")
                raise TransientProviderError("conexão caiu")
            yield Piece("resposta completa")

        with patch.object(OpenAICompatibleProvider, "step_streaming", stream):
            with self.assertRaises(TransientProviderError):
                _ = [pedaco async for pedaco in modelo.step_streaming([], [])]
            resposta = [pedaco async for pedaco in modelo.step_streaming([], [])]
        self.assertEqual([pedaco.text for pedaco in resposta], ["resposta completa"])
        self.assertEqual(chamadas, [modelo.base_url, modelo._fallback.base_url])

    def test_retry_after_from_host_is_bounded(self):
        self.assertEqual(_retry_after_segundos("15"), 15.0)
        self.assertIsNone(_retry_after_segundos("-1"))
        self.assertIsNone(_retry_after_segundos("999999"))
        self.assertIsNone(_retry_after_segundos("inválido"))

    async def test_rate_limit_waits_for_provider_and_then_succeeds(self):
        class RateLimited:
            chamadas = 0

            async def step_streaming(self, *_args):
                self.chamadas += 1
                if self.chamadas == 1:
                    raise TransientProviderError("HTTP 429", retry_after_s=15)
                yield StepResult(text="respondeu")

        eventos = []

        async def emitir(nome, dados):
            eventos.append((nome, dados))

        modelo = RateLimited()
        with patch("app.agent.loop._esperar", return_value=True) as esperar:
            resultado = await _com_tentativas(
                modelo, [], [], emitir, numero=1, tentativas=2, espera_final=0,
            )
        self.assertEqual(resultado.text, "respondeu")
        self.assertEqual(modelo.chamadas, 2)
        esperar.assert_awaited_once_with(15.0, None)
        self.assertTrue(any(nome == "aviso" for nome, _ in eventos))

    async def test_partial_step_is_buffered_and_retried_after_reconnect(self):
        class FlakyHost:
            tentativas = 0
            reconexoes = 0

            async def step_streaming(self, *_args):
                self.tentativas += 1
                if self.tentativas == 1:
                    yield Piece("texto parcial que não deve aparecer")
                    raise TransientProviderError("conexão caiu")
                yield Piece("resposta completa")
                yield StepResult(text="resposta completa")

            async def reconectar(self, erro):
                self.reconexoes += 1
                self.asserted_error = str(erro)
                return True

        modelo = FlakyHost()
        eventos = []

        async def emitir(nome, dados):
            eventos.append((nome, dados))

        estado = {"mostrou": False}
        with patch("app.agent.loop._esperar", return_value=True):
            resultado = await _com_tentativas(
                modelo,
                historico=[],
                tools=[],
                emit=emitir,
                numero=1,
                tentativas=2,
                espera_final=0,
                estado=estado,
            )

        deltas = [dados["text"] for nome, dados in eventos if nome == "delta"]
        avisos = [dados for nome, dados in eventos if nome == "aviso"]
        self.assertEqual(resultado.text, "resposta completa")
        self.assertEqual(deltas, ["resposta completa"])
        self.assertEqual(modelo.reconexoes, 1)
        self.assertEqual(modelo.asserted_error, "conexão caiu")
        self.assertEqual(len(avisos), 1)
        self.assertEqual(avisos[0]["tentativa"], 2)

    async def test_host_provider_restarts_only_for_transport_errors(self):
        settings = Settings(_env_file=None)
        modelo = ComTeto(HostProvider(settings))
        try:
            raise httpx.ReadError("socket fechado")
        except httpx.ReadError as causa:
            try:
                raise TransientProviderError("erro de comunicação") from causa
            except TransientProviderError as erro:
                with (
                    patch.object(host_boot, "dono_e_o_shell", return_value=False),
                    patch.object(host_boot, "subir", return_value=True) as subir,
                    patch("app.providers.host_disponivel", side_effect=[False, True]) as sondar,
                ):
                    self.assertTrue(await modelo.reconectar(erro))

        subir.assert_called_once_with(settings)
        self.assertEqual(sondar.call_count, 2)

    async def test_http_rate_limit_does_not_start_another_host(self):
        settings = Settings(_env_file=None)
        modelo = ComTeto(HostProvider(settings))
        with patch.object(host_boot, "subir") as subir:
            self.assertFalse(
                await modelo.reconectar(TransientProviderError("HTTP 429: tente depois"))
            )
        subir.assert_not_called()

    def test_does_not_launch_a_second_host_on_an_occupied_local_port(self):
        settings = Settings(_env_file=None)
        with (
            patch.object(host_boot, "dono_e_o_shell", return_value=False),
            patch.object(host_boot, "_host_local", return_value="127.0.0.1"),
            patch.object(host_boot, "_porta_respondendo", return_value=True),
            patch.object(host_boot, "_ultima_tentativa", 0.0),
            patch.object(host_boot, "_processo", None),
            patch.object(host_boot.subprocess, "Popen") as iniciar,
        ):
            self.assertFalse(host_boot.subir(settings))

        iniciar.assert_not_called()

    def test_dead_backend_owned_process_can_restart_inside_the_cooldown(self):
        class Parado:
            def poll(self):
                return 1

        class Novo:
            def poll(self):
                return None

        settings = Settings(_env_file=None)
        with (
            patch.object(host_boot, "dono_e_o_shell", return_value=False),
            patch.object(host_boot, "_host_local", return_value="127.0.0.1"),
            patch.object(host_boot, "_porta_respondendo", return_value=False),
            patch.object(host_boot, "_binario", return_value=Path("c-host.exe")),
            patch.object(host_boot, "_processo", Parado()),
            patch.object(host_boot, "_ultima_tentativa", 99.0),
            patch.object(host_boot.time, "monotonic", return_value=100.0),
            patch.object(host_boot.subprocess, "Popen", return_value=Novo()) as iniciar,
        ):
            self.assertTrue(host_boot.subir(settings))

        iniciar.assert_called_once()


if __name__ == "__main__":
    unittest.main()
