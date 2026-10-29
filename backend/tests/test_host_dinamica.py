"""A senha dinâmica do dia: entrega pelo painel, leitura, expiração, credencial."""

import json
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import httpx

from app import host_auth, host_dinamica
from app.config import Settings

PAINEL = "https://painel.exemplo.test"


def _resposta(status: int, corpo: dict | None = None) -> httpx.Response:
    return httpx.Response(status, json=corpo or {})


def _documento(senha: str, daqui_a_horas: float = 24.0) -> dict:
    return {
        "formato": "koda-host-dinamica-v1",
        "senha": senha,
        "girada": "2026-10-23",
        "validade": (datetime.now(timezone.utc) + timedelta(hours=daqui_a_horas)).isoformat(),
    }


class SenhaDinamica(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.raiz = Path(self._tmp.name)
        self.arquivo = self.raiz / "koda-host-dinamica.json"
        self.settings = Settings(
            database_path=self.raiz / "koda.db",
            dynamic_key_file=self.arquivo,
            cloud_url=PAINEL,
        )
        # O módulo guarda estado entre testes (espera e cache de leitura).
        host_dinamica._ultima_busca = 0.0
        host_dinamica._cache.clear()
        self.addCleanup(host_dinamica._cache.clear)
        self.addCleanup(host_auth.limpar)

    # -- leitura -----------------------------------------------------------

    def test_vigente_le_a_senha_do_arquivo(self) -> None:
        self.arquivo.write_text(json.dumps(_documento("SENHA-DO-DIA")), encoding="utf-8")
        self.assertEqual(host_dinamica.vigente(self.settings), "SENHA-DO-DIA")

    def test_vigente_recusa_expirada(self) -> None:
        self.arquivo.write_text(
            json.dumps(_documento("SENHA-DE-ONTEM", daqui_a_horas=-1)), encoding="utf-8"
        )
        self.assertIsNone(host_dinamica.vigente(self.settings))

    def test_vigente_sem_arquivo(self) -> None:
        self.assertIsNone(host_dinamica.vigente(self.settings))

    def test_credencial_prefere_a_senha_dinamica(self) -> None:
        host_auth.definir("TOKEN-DE-SESSAO")
        self.assertEqual(host_auth.credencial(self.settings), "TOKEN-DE-SESSAO")

        self.arquivo.write_text(json.dumps(_documento("SENHA-DO-DIA")), encoding="utf-8")
        # Com a senha do dia em mãos, é ela que vai no Authorization: o host
        # autoriza sem falar com o painel.
        self.assertEqual(host_auth.credencial(self.settings), "SENHA-DO-DIA")

        host_dinamica.esquecer(self.settings)
        self.assertEqual(host_auth.credencial(self.settings), "TOKEN-DE-SESSAO")

    # -- entrega pelo painel ------------------------------------------------

    def test_atualizar_grava_o_json_do_painel(self) -> None:
        with patch.object(host_dinamica.httpx, "get",
                          return_value=_resposta(200, _documento("SENHA-NOVA"))) as pedido:
            self.assertTrue(host_dinamica.atualizar(self.settings, "TOKEN"))
        url, kwargs = pedido.call_args[0][0], pedido.call_args[1]
        self.assertEqual(url, PAINEL + "/api/host/senha-dinamica")
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer TOKEN")
        gravado = json.loads(self.arquivo.read_text(encoding="utf-8"))
        self.assertEqual(gravado["senha"], "SENHA-NOVA")
        self.assertEqual(gravado["girada"], "2026-10-23")
        self.assertEqual(host_dinamica.vigente(self.settings), "SENHA-NOVA")

    def test_atualizar_respeita_a_espera(self) -> None:
        with patch.object(host_dinamica.httpx, "get",
                          return_value=_resposta(200, _documento("SENHA-NOVA"))) as pedido:
            self.assertTrue(host_dinamica.atualizar(self.settings, "TOKEN"))
            # Segunda chamada dentro da janela: nem sai para a rede.
            self.assertFalse(host_dinamica.atualizar(self.settings, "TOKEN"))
        self.assertEqual(pedido.call_count, 1)

    def test_atualizar_falha_em_silencio(self) -> None:
        for cenario in (
            _resposta(401),
            _resposta(500),
        ):
            with patch.object(host_dinamica.httpx, "get", return_value=cenario):
                self.assertFalse(host_dinamica.atualizar(self.settings, "TOKEN"))
            self.assertFalse(self.arquivo.exists())
        with patch.object(host_dinamica.httpx, "get", side_effect=httpx.HTTPError("rede")):
            self.assertFalse(host_dinamica.atualizar(self.settings, "TOKEN"))

    def test_atualizar_sem_sessao_nao_busca(self) -> None:
        with patch.object(host_dinamica.httpx, "get") as pedido:
            self.assertFalse(host_dinamica.atualizar(self.settings, "  "))
        pedido.assert_not_called()

    def test_esquecer_apaga_a_senha(self) -> None:
        self.arquivo.write_text(json.dumps(_documento("SENHA-DO-DIA")), encoding="utf-8")
        host_dinamica.esquecer(self.settings)
        self.assertFalse(self.arquivo.exists())
        self.assertIsNone(host_dinamica.vigente(self.settings))

    def test_garantir_so_busca_com_gente_logada(self) -> None:
        with patch.object(host_dinamica, "atualizar", return_value=False) as atualizar:
            host_dinamica.garantir(self.settings)
            atualizar.assert_not_called()
            host_auth.definir("TOKEN")
            host_dinamica.garantir(self.settings)
            atualizar.assert_called_once_with(self.settings, "TOKEN")

    def test_caminho_cai_ao_lado_do_binario_do_host(self) -> None:
        # Sem KODA_DYNAMIC_KEY_FILE, o JSON mora ao lado do c-host.exe — o mesmo
        # lugar que o host procura quando o ambiente não diz nada. É o que faz
        # um app instalado funcionar sem launcher novo.
        from app.providers import host_boot

        binario = self.raiz / "host" / "c-host.exe"
        settings = Settings(database_path=self.raiz / "koda.db", cloud_url=PAINEL)
        host_dinamica._binario_resolvido = False
        self.addCleanup(setattr, host_dinamica, "_binario_resolvido", False)
        with patch.object(host_boot, "_binario", return_value=binario):
            self.assertEqual(host_dinamica.caminho(settings), binario.parent / "koda-host-dinamica.json")
