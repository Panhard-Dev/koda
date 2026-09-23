"""Testes do catálogo de ferramentas e do loop agentic.

Nada aqui toca a rede: o modelo é um dublê que devolve as `tool_calls` que o teste
escolher, e as ferramentas rodam numa pasta temporária.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
from dataclasses import replace
from pathlib import Path

import httpx
import pytest

from app.providers.base import ProviderError, TransientProviderError
from app.tools import ferramentas
from app.tools import loop as loop_mod
from app.tools.loop import StepResult, ToolCall, executar


@pytest.fixture()
def pasta(tmp_path: Path) -> Path:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.py").write_text(
        "def ola():\n    return 'oi'\n", encoding="utf-8"
    )
    (tmp_path / "README.md").write_text("# projeto de teste\n", encoding="utf-8")
    return tmp_path


# --------------------------------------------------------------- catálogo


def test_catalogo_tem_as_ferramentas_do_projeto():
    nomes = {item["function"]["name"] for item in ferramentas.DEFINICOES}
    esperadas = {
        "code_interpreter",
        "shell",
        "terminal",
        "read_file",
        "write_file",
        "edit_file",
        "str_replace_editor",
        "list_dir",
        "delete_file",
        "search_codebase",
        "vector_search",
        "grep",
        "regex_search",
        "get_problems",
        "linter",
        "web_search",
        "url_reader",
        "browser",
        "git_status",
        "git_diff",
        "git_log",
        "git_commit",
    }
    assert nomes == esperadas
    assert len(ferramentas.DEFINICOES) == 22


def test_catalogo_respeita_as_negadas():
    nomes = {item["function"]["name"] for item in ferramentas.catalogo({"shell", "terminal"})}
    assert "shell" not in nomes and "terminal" not in nomes
    assert "read_file" in nomes


def test_ferramenta_negada_nao_executa(pasta: Path):
    saida = ferramentas.executar("shell", {"comando": "echo oi"}, pasta, {"shell"})
    assert saida.startswith("ERRO")
    assert "KODA_TOOLS_DENY" in saida


# --------------------------------------------------------------- arquivos


def test_escreve_le_lista_e_apaga(pasta: Path):
    assert "ok" in ferramentas.executar(
        "write_file", {"caminho": "notas/a.md", "conteudo": "linha um"}, pasta
    )
    assert ferramentas.executar("read_file", {"caminho": "notas/a.md"}, pasta) == "linha um"
    listagem = ferramentas.executar("list_dir", {"caminho": "notas"}, pasta)
    assert "a.md" in listagem
    assert "apagado" in ferramentas.executar("delete_file", {"caminho": "notas/a.md"}, pasta)


def test_edit_file_exige_trecho_unico(pasta: Path):
    ferramentas.executar("write_file", {"caminho": "a.txt", "conteudo": "x x"}, pasta)
    ambiguo = ferramentas.executar(
        "edit_file", {"caminho": "a.txt", "old_string": "x", "new_string": "y"}, pasta
    )
    assert "2 vezes" in ambiguo
    assert "substituição aplicada" in ferramentas.executar(
        "edit_file", {"caminho": "a.txt", "old_string": "x x", "new_string": "y z"}, pasta
    )
    assert ferramentas.executar("read_file", {"caminho": "a.txt"}, pasta) == "y z"


def test_caminho_relativo_sai_da_pasta_de_trabalho(pasta: Path):
    """O caminho é resolvido a partir da pasta de trabalho, não do cwd do processo."""
    ferramentas.executar("write_file", {"caminho": "dentro.txt", "conteudo": "ok"}, pasta)
    assert (pasta / "dentro.txt").read_text(encoding="utf-8") == "ok"


def test_read_file_inexistente_avisa(pasta: Path):
    assert "não encontrado" in ferramentas.executar("read_file", {"caminho": "nada.txt"}, pasta)


# ------------------------------------------- confinamento na pasta de trabalho


def test_leitura_fora_da_pasta_de_trabalho_e_recusada(pasta: Path):
    fora = pasta.parent / "segredo.txt"
    fora.write_text("conteudo secreto", encoding="utf-8")

    saida = ferramentas.executar("read_file", {"caminho": str(fora)}, pasta)

    assert "fora da pasta de trabalho" in saida
    assert "conteudo secreto" not in saida


def test_escrita_fora_da_pasta_de_trabalho_e_recusada(pasta: Path):
    alvo = pasta.parent / "invasao.txt"

    saida = ferramentas.executar("write_file", {"caminho": str(alvo), "conteudo": "x"}, pasta)

    assert "fora da pasta de trabalho" in saida
    assert not alvo.exists()


def test_dois_pontos_para_sair_da_pasta_e_recusado(pasta: Path):
    """O `..` resolve para fora e cai na mesma checagem do caminho absoluto."""
    saida = ferramentas.executar("list_dir", {"caminho": ".."}, pasta)
    assert "fora da pasta de trabalho" in saida


def test_apagar_fora_da_pasta_de_trabalho_e_recusado(pasta: Path):
    alvo = pasta.parent / "intocavel.txt"
    alvo.write_text("fica", encoding="utf-8")

    saida = ferramentas.executar("delete_file", {"caminho": str(alvo)}, pasta)

    assert "fora da pasta de trabalho" in saida
    assert alvo.exists()


def test_linter_fora_da_pasta_de_trabalho_e_recusado(pasta: Path):
    fora = pasta.parent / "solto.py"
    fora.write_text("x = 1\n", encoding="utf-8")
    assert "fora da pasta de trabalho" in ferramentas.executar(
        "linter", {"caminho": str(fora)}, pasta
    )


def test_acesso_livre_libera_caminho_de_fora(pasta: Path):
    fora = pasta.parent / "liberado.txt"
    fora.write_text("pode ler", encoding="utf-8")

    saida = ferramentas.executar(
        "read_file", {"caminho": str(fora)}, pasta, acesso_livre=True
    )

    assert saida == "pode ler"


def test_dentro_da_pasta_continua_funcionando(pasta: Path):
    assert ferramentas.executar("list_dir", {"caminho": "."}, pasta).count("\n") >= 1
    assert ferramentas.executar("read_file", {"caminho": "README.md"}, pasta).startswith(
        "# projeto"
    )


# --------------------------------------------------------------- busca


def test_search_codebase_e_regex(pasta: Path):
    achado = ferramentas.executar("search_codebase", {"termo": "ola"}, pasta)
    assert f"src{os.sep}app.py:1" in achado
    regex = ferramentas.executar("grep", {"padrao": "def\\s+\\w+"}, pasta)
    assert "app.py" in regex


def test_linter_em_arquivo_quebrado(pasta: Path):
    (pasta / "quebrado.py").write_text("def x(:\n", encoding="utf-8")
    assert "syntax" in ferramentas.executar("get_problems", {"caminho": "quebrado.py"}, pasta).lower()


# --------------------------------------------------------------- execução


def test_code_interpreter_roda_fora_do_projeto(pasta: Path):
    saida = ferramentas.executar("code_interpreter", {"codigo": "print(6 * 7)"}, pasta)
    assert "42" in saida
    # Nada de arquivo temporário sobrando na pasta de trabalho.
    assert not list(pasta.glob(".code_interpreter*"))


def test_shell_roda_na_pasta_de_trabalho(pasta: Path):
    saida = ferramentas.executar("shell", {"comando": "echo teste"}, pasta)
    assert "exit code: 0" in saida and "teste" in saida


# --------------------------------------------------------------- web


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:8000/x",
        "http://127.0.0.1:21128/v1/models",
        "http://192.168.0.10/",
        "file:///c:/windows/win.ini",
        "ftp://exemplo.com/arquivo",
    ],
)
def test_url_privada_ou_invalida_e_bloqueada(url: str):
    assert ferramentas.host_publico(url) is False


def test_url_publica_e_aceita():
    assert ferramentas.host_publico("https://example.com/") is True


def test_browser_recusa_endereco_local(pasta: Path):
    saida = ferramentas.executar("browser", {"url": "http://127.0.0.1:8787/api/health"}, pasta)
    assert "apenas URLs" in saida


# ------------------------------------------------- redirect do url_reader


class RespostaSalto:
    """Resposta de um salto: status, `Location` e corpo."""

    def __init__(self, status: int, location: str | None, texto: str = "") -> None:
        self.status_code = status
        self.headers = {"location": location} if location else {}
        self.text = texto
        self.url = "https://exemplo.com/"

    @property
    def is_redirect(self) -> bool:
        return 300 <= self.status_code < 400 and "location" in self.headers


class ClienteFalso:
    """Devolve um salto por chamada, na ordem em que foram declarados."""

    def __init__(self, saltos: list[RespostaSalto]) -> None:
        self._saltos = saltos
        self._i = 0
        self.pedidos: list[str] = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def get(self, url: str) -> RespostaSalto:
        self.pedidos.append(url)
        resposta = self._saltos[min(self._i, len(self._saltos) - 1)]
        self._i += 1
        return resposta


def _sem_dns(monkeypatch, privados: tuple[str, ...] = ("127.0.0.1", "169.254.169.254")):
    """Troca a checagem de host por uma que não faz DNS: o teste é do redirect."""
    monkeypatch.setattr(
        ferramentas, "host_publico", lambda url: not any(p in url for p in privados)
    )


def test_url_reader_bloqueia_redirect_para_host_privado(monkeypatch):
    _sem_dns(monkeypatch)
    cliente = ClienteFalso([RespostaSalto(302, "http://127.0.0.1:8787/api/health")])
    monkeypatch.setattr(ferramentas.httpx, "Client", lambda **_kw: cliente)

    saida = ferramentas._web_ler("https://exemplo.com/encurtador")

    assert "Redirecionamento bloqueado" in saida
    assert "127.0.0.1" in saida
    # Não seguiu: parou no primeiro salto.
    assert cliente.pedidos == ["https://exemplo.com/encurtador"]


def test_url_reader_bloqueia_redirect_para_o_metadata_da_nuvem(monkeypatch):
    _sem_dns(monkeypatch)
    monkeypatch.setattr(
        ferramentas.httpx,
        "Client",
        lambda **_kw: ClienteFalso([RespostaSalto(301, "http://169.254.169.254/latest/meta-data/")]),
    )

    assert "Redirecionamento bloqueado" in ferramentas._web_ler("https://exemplo.com/x")


def test_url_reader_segue_redirect_publico_e_le_o_destino(monkeypatch):
    _sem_dns(monkeypatch)
    cliente = ClienteFalso(
        [
            RespostaSalto(302, "https://exemplo.com/destino"),
            RespostaSalto(200, None, "<p>Cheguei no destino</p>"),
        ]
    )
    monkeypatch.setattr(ferramentas.httpx, "Client", lambda **_kw: cliente)

    saida = ferramentas._web_ler("https://exemplo.com/curto")

    assert "Cheguei no destino" in saida and "HTTP 200" in saida
    assert cliente.pedidos == ["https://exemplo.com/curto", "https://exemplo.com/destino"]


def test_url_reader_desiste_em_ciclo_de_redirects(monkeypatch):
    _sem_dns(monkeypatch)
    # Sempre 302 para um host público: o limite de saltos é quem para isso.
    monkeypatch.setattr(
        ferramentas.httpx,
        "Client",
        lambda **_kw: ClienteFalso([RespostaSalto(302, "https://exemplo.com/proximo")]),
    )

    saida = ferramentas._web_ler("https://exemplo.com/loop")

    assert "ciclo" in saida


def test_url_reader_resolve_location_relativo(monkeypatch):
    _sem_dns(monkeypatch)
    cliente = ClienteFalso(
        [
            RespostaSalto(302, "/outra-pagina"),
            RespostaSalto(200, None, "<p>relativo</p>"),
        ]
    )
    monkeypatch.setattr(ferramentas.httpx, "Client", lambda **_kw: cliente)

    ferramentas._web_ler("https://exemplo.com/base")

    assert cliente.pedidos[1] == "https://exemplo.com/outra-pagina"


def test_web_buscar_usa_so_o_bing(monkeypatch):
    """A busca na web tem uma fonte só; se alguém adicionar outra, este teste cai."""
    chamadas: list[str] = []

    def falso(consulta: str) -> str:
        chamadas.append(consulta)
        return "1. Do Bing\n   https://b.example"

    monkeypatch.setattr(ferramentas, "_busca_bing", falso)

    assert "Do Bing" in ferramentas._web_buscar("qualquer coisa")
    assert chamadas == ["qualquer coisa"]


def test_web_buscar_consulta_vazia():
    assert ferramentas._web_buscar("   ") == "ERRO: consulta vazia"


def test_web_buscar_sem_resultado_avisa(monkeypatch):
    monkeypatch.setattr(ferramentas, "_busca_bing", lambda _c: "")
    assert ferramentas._web_buscar("qualquer") == "(sem resultados)"


def test_web_buscar_bing_fora_do_ar_nao_estoura(monkeypatch):
    def caiu(_consulta: str) -> str:
        raise httpx.ConnectError("sem rota até o Bing")

    monkeypatch.setattr(ferramentas, "_busca_bing", caiu)

    saida = ferramentas._web_buscar("qualquer")
    assert saida.startswith("ERRO: o Bing não respondeu")


class RespostaFalsa:
    """Imita o que o `httpx.get` devolve, sem tocar a rede."""

    def __init__(self, texto: str = "") -> None:
        self.text = texto


def test_busca_bing_le_titulo_url_e_snippet(monkeypatch):
    alvo = "https://exemplo.com/materia"
    codificado = base64.urlsafe_b64encode(alvo.encode()).decode()
    html_falso = f"""
    <li class="b_algo">
      <h2><a href="https://www.bing.com/ck/a?u=a1{codificado}&ntb=1">Cota&#231;&#227;o de hoje</a></h2>
      <p>O d&#243;lar fechou em alta.</p>
    </li>
    <li class="b_algo">
      <h2><a href="https://exemplo.com/sem-snippet">Só título</a></h2>
    </li>
    """

    monkeypatch.setattr(ferramentas.httpx, "get", lambda *_a, **_k: RespostaFalsa(html_falso))

    saida = ferramentas._busca_bing("cotacao")

    assert "Cotação de hoje" in saida  # entidades desfeitas
    assert alvo in saida  # wrapper do Bing desfeito
    assert "O dólar fechou em alta." in saida
    assert "Só título" in saida
    assert "bing.com/ck/a" not in saida


def test_executar_web_search_vai_para_o_bing(pasta: Path, monkeypatch):
    visto: dict[str, object] = {}

    def falso(consulta: str) -> str:
        visto["consulta"] = consulta
        return "1. Do Bing\n   https://b.example"

    monkeypatch.setattr(ferramentas, "_web_buscar", falso)

    assert "Do Bing" in ferramentas.executar("web_search", {"consulta": "teste"}, pasta)
    assert visto == {"consulta": "teste"}


def test_nao_sobrou_nenhuma_outra_fonte_de_busca():
    """Trava de regressão: SearXNG e DuckDuckGo saíram do módulo de vez."""
    assert not hasattr(ferramentas, "_busca_searxng")
    assert not hasattr(ferramentas, "_busca_ddg")
    assert not hasattr(ferramentas, "TEMPO_SEARXNG")


def test_url_do_bing_base64url_e_decodificada():
    """O payload do Bing usa base64url (`_`, `-`); o `b64decode` comum quebrava nele."""
    alvo = "https://www.google.com/?hl=esp"
    codificado = base64.urlsafe_b64encode(alvo.encode()).decode()
    href = f"https://www.bing.com/ck/a?!&&p=abc&u=a1{codificado}&ntb=1"

    assert ferramentas._decodificar_url_bing(href) == alvo


def test_url_do_bing_sem_wrapper_fica_como_esta():
    assert ferramentas._decodificar_url_bing("https://exemplo.com/x") == "https://exemplo.com/x"


def test_entidades_html_sao_desfeitas():
    assert ferramentas._limpar_texto("D&#243;lar &amp; cota&#231;&#227;o") == "Dólar & cotação"
    assert ferramentas._limpar_texto("<b>negrito</b>   com  espaços") == "negrito com espaços"


# --------------------------------------------------------------- loop


class ModeloFalso:
    """Devolve passos pré-programados, guardando o que recebeu."""

    name = "falso"
    ready = True

    def __init__(self, passos: list[StepResult], delay: float = 0) -> None:
        self._passos = list(passos)
        self.delay = delay
        self.recebido: list[list[dict[str, object]]] = []
        self.ferramentas_vistas: list[int] = []

    async def step(self, messages, tools, model: str = ""):
        if self.delay:
            await asyncio.sleep(self.delay)
        self.recebido.append([dict(item) for item in messages])
        self.ferramentas_vistas.append(len(tools))
        if not self._passos:
            return StepResult(text="acabou")
        return self._passos.pop(0)


def rodar(loop, **kwargs):
    eventos: list[tuple[str, dict]] = []

    async def emit(evento, dados):
        eventos.append((evento, dados))

    resultado = asyncio.run(loop(**kwargs, emit=emit))
    return resultado, eventos


def test_loop_executa_ferramenta_e_volta_com_resposta(pasta: Path):
    modelo = ModeloFalso(
        [
            StepResult(
                calls=[
                    ToolCall(
                        id="call_1",
                        name="write_file",
                        arguments={"caminho": "gerado.txt", "conteudo": "conteudo real"},
                        raw_arguments=json.dumps(
                            {"caminho": "gerado.txt", "conteudo": "conteudo real"}
                        ),
                    )
                ],
                usage={"total_tokens": 10},
            ),
            StepResult(text="Pronto: criei gerado.txt.", usage={"total_tokens": 5}),
        ]
    )

    resultado, eventos = rodar(
        executar,
        modelo=modelo,
        mensagens=[{"role": "user", "content": "crie gerado.txt"}],
        workspace=pasta,
        max_steps=5,
    )

    nomes = [evento for evento, _ in eventos]
    assert nomes == ["tool_call", "tool_result", "delta"]
    assert resultado.completou is True
    assert resultado.texto == "Pronto: criei gerado.txt."
    assert resultado.uso["total_tokens"] == 15
    assert (pasta / "gerado.txt").read_text(encoding="utf-8") == "conteudo real"

    # O resultado da ferramenta volta para o modelo e a chamada é ecoada como veio.
    segundo = modelo.recebido[1]
    assert segundo[1]["role"] == "assistant"
    assert segundo[1]["tool_calls"] == [
        {
            "id": "call_1",
            "type": "function",
            "function": {
                "name": "write_file",
                "arguments": '{"caminho": "gerado.txt", "conteudo": "conteudo real"}',
            },
        }
    ]
    assert segundo[2]["role"] == "tool"
    assert segundo[2]["tool_call_id"] == "call_1"
    assert "gravados em" in str(segundo[2]["content"])

    # O evento de resultado carrega o que a ferramenta devolveu.
    dados = dict(eventos[1][1])
    assert dados["name"] == "write_file" and dados["ok"] is True
    assert "gravados" in str(dados["output"])


def test_loop_para_no_limite_de_passos(pasta: Path):
    passo = StepResult(
        calls=[
            ToolCall(
                id="call_x",
                name="list_dir",
                arguments={"caminho": "."},
                raw_arguments='{"caminho": "."}',
            )
        ]
    )
    modelo = ModeloFalso([replace(passo) for _ in range(10)])

    resultado, eventos = rodar(
        executar,
        modelo=modelo,
        mensagens=[{"role": "user", "content": "liste tudo"}],
        workspace=pasta,
        max_steps=3,
    )

    assert resultado.completou is False
    assert "3 passos" in resultado.texto
    assert len([1 for nome, _ in eventos if nome == "tool_call"]) == 3


def test_loop_pede_continuacao_quando_resposta_vem_vazia(pasta: Path):
    modelo = ModeloFalso([StepResult(), StepResult(text="Agora sim.")])

    resultado, _ = rodar(
        executar,
        modelo=modelo,
        mensagens=[{"role": "user", "content": "oi"}],
        workspace=pasta,
        max_steps=4,
    )

    assert resultado.texto == "Agora sim."
    # O modelo recebeu o empurrão de continuação em vez de o loop morrer.
    assert "vazia" in str(modelo.recebido[1][-1]["content"])


def test_loop_desiste_quando_o_provedor_so_responde_vazio(pasta: Path):
    """Sem teto de respostas vazias, um provedor quebrado queima a tarefa em silêncio."""
    modelo = ModeloFalso([StepResult() for _ in range(10)])

    resultado, eventos = rodar(
        executar,
        modelo=modelo,
        mensagens=[{"role": "user", "content": "oi"}],
        workspace=pasta,
        max_steps=9,
    )

    assert resultado.completou is False
    assert "vazio" in resultado.texto
    # Parou no terceiro vazio em vez de gastar os nove passos.
    assert len(modelo.recebido) == 3
    assert sum(1 for nome, _ in eventos if nome == "delta") == 2


def test_loop_respeita_o_orcamento_de_tempo(pasta: Path):
    passo = StepResult(
        calls=[
            ToolCall(
                id="call_x",
                name="list_dir",
                arguments={"caminho": "."},
                raw_arguments='{"caminho": "."}',
            )
        ]
    )
    # Cada passo demora mais que metade do orçamento: o loop tem que parar antes dos dez.
    modelo = ModeloFalso([replace(passo) for _ in range(10)], delay=0.03)

    resultado, _ = rodar(
        executar,
        modelo=modelo,
        mensagens=[{"role": "user", "content": "liste"}],
        workspace=pasta,
        max_steps=10,
        timeout_s=0.05,
    )

    assert resultado.completou is False
    assert "tempo" in resultado.texto
    assert len(modelo.recebido) < 10


def test_loop_ignora_ferramenta_negada(pasta: Path):
    modelo = ModeloFalso(
        [
            StepResult(
                calls=[
                    ToolCall(
                        id="call_1",
                        name="shell",
                        arguments={"comando": "echo perigo"},
                        raw_arguments='{"comando": "echo perigo"}',
                    )
                ]
            ),
            StepResult(text="não consegui rodar"),
        ]
    )

    _, eventos = rodar(
        executar,
        modelo=modelo,
        mensagens=[{"role": "user", "content": "rode"}],
        workspace=pasta,
        max_steps=3,
        negadas={"shell"},
    )

    assert [nome for nome, _ in eventos] == ["tool_call", "tool_result", "delta"]
    assert "KODA_TOOLS_DENY" in str(eventos[1][1]["output"])
    assert eventos[1][1]["ok"] is False
    assert modelo.ferramentas_vistas[0] == 21


# --------------------------------------------------------------- falha do provedor


class ModeloInstavel:
    """Falha as primeiras tentativas e depois responde, contando o que recebeu."""

    name = "instavel"
    ready = True

    def __init__(
        self, falhas: int, erro: Exception, resposta: str = "Terminei.", perfis: list[str] | None = None
    ) -> None:
        self.falhas = falhas
        self.erro = erro
        self.resposta = resposta
        self.perfis = list(perfis or [])
        self.chamadas = 0
        self.rotacoes = 0
        self.recebido: list[list[dict]] = []

    async def step(self, messages, tools, model: str = ""):
        self.chamadas += 1
        self.recebido.append([dict(item) for item in messages])
        if self.chamadas <= self.falhas:
            raise self.erro
        return StepResult(text=self.resposta)

    async def rotate(self) -> str | None:
        if not self.perfis:
            return None
        self.rotacoes += 1
        return self.perfis.pop(0)


def test_passo_repetido_quando_o_provedor_falha(pasta: Path, monkeypatch):
    """Erro de cota não é erro da tarefa: o passo é reenviado com o mesmo histórico."""
    monkeypatch.setattr(loop_mod, "ESPERA_BASE", 0)
    modelo = ModeloInstavel(2, TransientProviderError("o proxy respondeu 429: cota"))

    resultado, eventos = rodar(
        executar,
        modelo=modelo,
        mensagens=[{"role": "user", "content": "liste"}],
        workspace=pasta,
        max_steps=4,
    )

    assert modelo.chamadas == 3
    assert resultado.completou is True
    assert resultado.texto == "Terminei."
    # O reenvio leva o histórico já construído: o modelo retoma de onde parou.
    assert modelo.recebido[1] == modelo.recebido[0] == modelo.recebido[2]
    assert sum(
        1
        for nome, dados in eventos
        if nome == "delta" and "tentando de novo" in str(dados.get("text"))
    ) == 2


def test_ferramenta_ja_executada_sobrevive_ao_reenvio(pasta: Path, monkeypatch):
    """O que a tarefa já fez continua no contexto depois de uma falha no meio."""
    monkeypatch.setattr(loop_mod, "ESPERA_BASE", 0)

    class ModeloComFalhaNoMeio:
        name = "instavel"
        ready = True

        def __init__(self) -> None:
            self.chamadas = 0
            self.reenvio: list[dict] = []

        async def step(self, messages, tools, model: str = ""):
            self.chamadas += 1
            if self.chamadas == 1:
                return StepResult(
                    calls=[
                        ToolCall(
                            id="call_1",
                            name="write_file",
                            arguments={"caminho": "feito.txt", "conteudo": "conteudo real"},
                            raw_arguments='{"caminho": "feito.txt", "conteudo": "conteudo real"}',
                        )
                    ]
                )
            if self.chamadas == 2:
                self.reenvio = [dict(item) for item in messages]
                raise TransientProviderError("o proxy respondeu 502")
            return StepResult(text="Pronto: criei feito.txt.")

    modelo = ModeloComFalhaNoMeio()
    resultado, _ = rodar(
        executar,
        modelo=modelo,
        mensagens=[{"role": "user", "content": "crie feito.txt"}],
        workspace=pasta,
        max_steps=4,
    )

    assert resultado.completou is True
    assert (pasta / "feito.txt").read_text(encoding="utf-8") == "conteudo real"
    # No reenvio, o resultado da ferramenta já está no histórico — nada se perdeu.
    papeis = [item["role"] for item in modelo.reenvio]
    assert papeis == ["user", "assistant", "tool"]
    assert "gravados em" in str(modelo.reenvio[2]["content"])


def test_erro_fatal_ganha_uma_chance_em_outra_conta(pasta: Path, monkeypatch):
    """400 do upstream não mata a tarefa se o proxy tem outra conta para atender."""
    monkeypatch.setattr(loop_mod, "ESPERA_BASE", 0)
    modelo = ModeloInstavel(
        1, ProviderError("o proxy respondeu 400: AI Studio recusou"), perfis=["3"]
    )

    resultado, eventos = rodar(
        executar,
        modelo=modelo,
        mensagens=[{"role": "user", "content": "liste"}],
        workspace=pasta,
        max_steps=4,
    )

    assert modelo.rotacoes == 1
    assert modelo.chamadas == 2
    assert resultado.completou is True
    narrado = " ".join(str(dados.get("text")) for nome, dados in eventos if nome == "delta")
    assert "conta 3" in narrado


def test_erro_fatal_sem_outra_conta_nao_insiste(pasta: Path, monkeypatch):
    monkeypatch.setattr(loop_mod, "ESPERA_BASE", 0)
    modelo = ModeloInstavel(3, ProviderError("o proxy respondeu 400: AI Studio recusou"))

    resultado, eventos = rodar(
        executar,
        modelo=modelo,
        mensagens=[{"role": "user", "content": "liste"}],
        workspace=pasta,
        max_steps=4,
    )

    assert modelo.chamadas == 1
    assert resultado.completou is False
    assert "erro do provedor no passo 1" in str(eventos[-1][1].get("text", ""))


def test_ultima_cartada_depois_das_tentativas(pasta: Path, monkeypatch):
    """Esgotou o backoff? Ainda espera o cooldown e tenta uma vez mais."""
    monkeypatch.setattr(loop_mod, "ESPERA_BASE", 0)
    modelo = ModeloInstavel(3, TransientProviderError("o proxy respondeu 500: sem conta"))

    resultado, _ = rodar(
        executar,
        modelo=modelo,
        mensagens=[{"role": "user", "content": "liste"}],
        workspace=pasta,
        max_steps=4,
        espera_final=0.01,
    )

    assert modelo.chamadas == 4
    assert resultado.completou is True


def test_sem_cartada_final_desiste_apos_as_tentativas(pasta: Path, monkeypatch):
    monkeypatch.setattr(loop_mod, "ESPERA_BASE", 0)
    modelo = ModeloInstavel(9, TransientProviderError("o proxy respondeu 500: sem conta"))

    resultado, _ = rodar(
        executar,
        modelo=modelo,
        mensagens=[{"role": "user", "content": "liste"}],
        workspace=pasta,
        max_steps=4,
        tentativas=2,
    )

    assert modelo.chamadas == 2
    assert resultado.completou is False
    assert "não consegui falar com o provedor" in resultado.texto


# ------------------------------------------------------------------- git


def test_git_recusa_repo_de_outro_projeto(pasta: Path, monkeypatch):
    """A pasta de trabalho dentro de outro repositório: o commit sairia no projeto errado."""
    monkeypatch.setattr(ferramentas, "_raiz_git", lambda _w: str(pasta.parent))

    saida = ferramentas.executar("git_commit", {"mensagem": "x"}, pasta)

    assert "outro repositório git" in saida
    assert "git init" in saida


def test_git_recusa_quando_nao_ha_repositorio(pasta: Path, monkeypatch):
    monkeypatch.setattr(ferramentas, "_raiz_git", lambda _w: None)

    saida = ferramentas.executar("git_status", {}, pasta)

    assert "não é um repositório git" in saida
    assert "git init" in saida


def test_git_passa_quando_a_raiz_e_a_propria_pasta_de_trabalho(pasta: Path, monkeypatch):
    monkeypatch.setattr(ferramentas, "_raiz_git", lambda _w: str(pasta))
    monkeypatch.setattr(
        ferramentas, "_rodar_lista", lambda *_a, **_k: "exit code: 0\n--- stdout ---\nmain"
    )

    assert "main" in ferramentas.executar("git_status", {}, pasta)
