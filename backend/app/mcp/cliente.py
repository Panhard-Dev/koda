"""Cliente MCP sobre **stdio**: conversa JSON-RPC 2.0 com um servidor MCP.

O protocolo MCP (Model Context Protocol) tem duas partes que interessam aqui, e as duas
são a mesma coisa vista de dois lados:

- o **transporte** stdio: o servidor é um processo; o cliente escreve um objeto JSON por
  linha no `stdin` dele e lê um objeto JSON por linha do `stdout`. Nada de `Content-Length`
  como no LSP — o MCP usa JSON delimitado por `\\n`.
- o **protocolo**: `tools/list` e `tools/call`, com paginação por cursor.

Este módulo é só isso: um servidor, um processo, uma conversa. Quem junta vários e monta o
catálogo é o `manager`.

**Duas gerações do protocolo.** O MCP mudou de forma em `2026-07-28`: virou **stateless**. O
`initialize`/`initialized` saiu, e a versão, o cliente e as capacidades passam a viajar em
**cada requisição**, em `_meta`. A geração anterior (`2024-11-05`) é a que a maioria dos
servidores publicados fala hoje. Este cliente fala as duas: tenta o handshake e, se o
servidor responder que não conhece o método, segue pelo caminho stateless. Um servidor que
só fala a geração nova **não** aparece como conectado por engano — o caminho é escolhido por
uma resposta dele, não por adivinhação nossa.

**Por que síncrono.** A execução de ferramenta no Koda já roda numa thread (`asyncio.to_thread`
no laço). Um cliente assíncrono aqui só acrescentaria uma camada para o mesmo resultado, e
pior: o timeout teria de ser cooperativo com o laço de eventos, que não é quem está esperando.

**Fail-closed no handshake.** Um servidor que sobe mas não responde ao handshake, ou que
responde lixo, entra em estado de erro e **não** publica ferramenta nenhuma — melhor não
oferecer do que oferecer uma ferramenta que vai estourar na hora de chamar.
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
import time
import unicodedata
from dataclasses import dataclass, field
from typing import Any

from ..execution.processo import _sem_janela

#: As revisões do protocolo que este cliente sabe falar, da mais nova para a mais antiga.
#: `2026-07-28` é a stateless (metadados por requisição, sem `initialize`); `2024-11-05` é a
#: geração com handshake, que é o que a maioria dos servidores publicados fala.
GERACOES = ("2026-07-28", "2024-11-05")

#: A revisão que vai no `initialize`. É a mais antiga da lista de propósito: o servidor que
#: só fala a stateless recusa o método e aí nós seguimos pelo caminho novo; o que fala a
#: antiga aceita e negocia.
PROTOCOLO = GERACOES[-1]

#: As chaves de `_meta` da geração stateless. O prefixo é da especificação — não é nosso.
META_VERSAO = "io.modelcontextprotocol/protocolVersion"
META_CLIENTE = "io.modelcontextprotocol/clientInfo"
META_CAPACIDADES = "io.modelcontextprotocol/clientCapabilities"

#: O código JSON-RPC de "método não encontrado". É o que diz que o servidor não tem
#: `initialize` — ou seja, que ele é da geração stateless.
METODO_NAO_ENCONTRADO = -32601

#: Teto de uma linha de resposta. Um `tools/list` de servidor grande passa de 100 KB; 8 MB
#: é folga suficiente e ainda impede que uma linha corrompida coma a memória do processo.
MAX_LINHA = 8 * 1024 * 1024

#: Quantas páginas de `tools/list` seguir antes de desistir. O cursor é opaco e vem do
#: servidor; sem teto, um servidor que devolve o mesmo cursor para sempre prenderia a
#: subida do app num laço. 200 páginas cobrem qualquer catálogo real com folga.
MAX_PAGINAS = 200

#: Quanto esperar por cada resposta do servidor. O handshake e o `tools/list` são rápidos
#: (o servidor já está subindo); uma chamada de ferramenta pode demorar de verdade, e quem
#: decide esse teto é o `tempo_limite` da chamada, não esta constante.
TEMPO_PADRAO_S = 30.0

#: Quantas linhas de `stderr` guardar para diagnóstico. O erro de um servidor MCP costuma
#: sair aqui (stack trace de Node, `command not found`), e é o que a tela mostra quando o
#: servidor não conecta — sem isso, "não conectou" não diz nada.
MAX_ERRO_LINHAS = 40


class ErroMCP(Exception):
    """Falha do servidor ou do protocolo. A mensagem é o que vai para a tela.

    `codigo` é o código JSON-RPC, quando veio um. Quem chama precisa dele para distinguir
    "o servidor não conhece este método" (que é o sinal de qual geração ele fala) de uma
    falha qualquer.
    """

    def __init__(self, mensagem: str, codigo: int | None = None) -> None:
        super().__init__(mensagem)
        self.codigo = codigo


def _cliente_info() -> dict[str, str]:
    """Como o Koda se identifica para o servidor (no `initialize` e em cada `_meta`)."""
    from .. import __version__

    return {"name": "koda", "version": __version__}


def versao_suportada(versao: Any) -> bool:
    """O servidor respondeu uma revisão do protocolo que este cliente fala?

    Comparação **exata**, de propósito. No MCP a data *é* o número da versão, e não há
    relação de ordem entre revisões: aceitar "a mais nova que eu conheço" seria adivinhar
    que as regras não mudaram. É por isso que `9999-99-99` não passa — e a recusa tem de
    dizer qual versão veio e quais são faladas aqui.
    """
    return isinstance(versao, str) and versao.strip() in GERACOES


def dividir(texto: str) -> list[str]:
    """Separa comando + parâmetros em argumentos, **sem** destruir caminhos do Windows.

    `shlex.split` no modo POSIX come os `\\` de `C:\\Users\\...` e o servidor não sobe; no
    modo não-POSIX ele deixa as aspas nos pedaços. Aqui as duas coisas são tratadas: as
    aspas delimitam, e a barra invertida é literal (o Windows já aceita `/` em caminho, e
    quem digita `\\` está falando de um caminho de verdade, não de um escape).
    """
    partes: list[str] = []
    atual: list[str] = []
    aspa: str | None = None
    for caractere in texto:
        if aspa is not None:
            if caractere == aspa:
                aspa = None
            else:
                atual.append(caractere)
            continue
        if caractere in ('"', "'"):
            aspa = caractere
        elif caractere.isspace():
            if atual:
                partes.append("".join(atual))
                atual = []
        else:
            atual.append(caractere)
    if atual:
        partes.append("".join(atual))
    return partes


@dataclass
class FerramentaMCP:
    """Uma ferramenta publicada pelo servidor, como o `tools/list` a descreve."""

    nome: str
    descricao: str
    esquema: dict[str, Any] = field(default_factory=dict)


class ServidorMCP:
    """Um servidor MCP rodando como processo, com a conversa JSON-RPC por cima do stdio.

    O ciclo de vida é curto e explícito: `abrir()` sobe e faz o handshake, `ferramentas()`
    lista o que ele oferece, `chamar()` executa uma, `fechar()` derruba. Qualquer falha
    guarda o motivo em `erro` — quem chamou lê dali para explicar na tela, em vez de receber
    uma exceção sem contexto.
    """

    def __init__(self, nome: str, comando: str, params: str = "", tempo_s: float = TEMPO_PADRAO_S):
        self.nome = nome
        self.comando = comando
        self.params = params
        self.tempo_s = tempo_s
        self.erro: str | None = None
        self._processo: subprocess.Popen[str] | None = None
        self._proximo_id = 1
        self._trava = threading.Lock()
        self._esperando: dict[int, queue.Queue[dict[str, Any]]] = {}
        self._leitor: threading.Thread | None = None
        self._erro_linhas: list[str] = []
        self._erro_thread: threading.Thread | None = None
        self._ferramentas: list[FerramentaMCP] = []
        self._protocolo = PROTOCOLO
        #: A geração stateless (`2026-07-28`): sem `initialize`, com `_meta` em cada pedido.
        self._stateless = False
        #: Quantas vezes o servidor avisou que a lista mudou, e quantas dessas já foram
        #: lidas. A diferença entra na propriedade `desatualizado`, que o gerenciador consulta.
        #: É contador e não booleano porque o aviso pode chegar **no meio** de uma listagem — e
        #: aí ele fala de uma lista mais nova do que a que acabou de ser lida.
        self._avisos = 0
        self._avisos_lidos = 0
        #: Quando o cache desta listagem deixa de valer, pelo `ttlMs` do servidor. `None`
        #: quando ele não diz — e aí a lista só é refeita quando ele avisa.
        self._expira_em: float | None = None
        #: Ids dos `subscriptions/listen` abertos. A resposta deles só chega quando o fluxo
        #: fecha, então não podem ser esperados como um pedido comum.
        self._escutas: set[int] = set()
        #: O servidor aceitou avisar de mudança na lista? (`notifications/subscriptions/
        #: acknowledged`). Só vale no stateless, que é onde a escuta precisa ser pedida.
        self.escutando_lista = False
        #: Por que a última listagem ficou **incompleta**, quando ficou. Vai para o `status()`
        #: do gerenciador: lista parcial apresentada como completa é pior do que lista parcial
        #: com o motivo escrito.
        self.incompleto: str | None = None

    @property
    def desatualizado(self) -> bool:
        """O cache da lista não vale mais: o servidor avisou, ou o TTL que ele deu venceu."""
        if self._avisos != self._avisos_lidos:
            return True
        return self._expira_em is not None and time.monotonic() >= self._expira_em

    def aviso_tratado(self) -> None:
        """Dá os avisos pendentes por tratados, mesmo sem ter conseguido listar.

        Quem chama é o gerenciador, quando a listagem falhou. Sem isto `desatualizado` ficaria
        de pé para sempre e cada rodada tentaria de novo o `tools/list` de um servidor que não
        responde.
        """
        self._avisos_lidos = self._avisos

    # ------------------------------------------------------------ ciclo de vida

    @property
    def vivo(self) -> bool:
        return self._processo is not None and self._processo.poll() is None

    def abrir(self) -> bool:
        """Sobe o processo e faz o handshake. Devolve `True` quando o servidor está pronto."""
        if self.vivo:
            return True
        argv = [self.comando, *dividir(self.params)]
        try:
            self._processo = subprocess.Popen(
                argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                cwd=os.getcwd(),
                # `shell=False` de propósito: o comando é uma lista, e o servidor MCP é um
                # processo — passar por shell abriria injeção de comando a partir do
                # cadastro da tela.
                shell=False,
                # Sem isto, cada servidor (node.exe) abria uma **janela de console própria**
                # quando o app roda empacotado: o `CREATE_NO_WINDOW` que o Rust usa para
                # criar o backend **não** se propaga aos netos. Mesmo helper do resto do
                # backend, para não haver dois jeitos de esconder janela.
                **_sem_janela(),
            )
        except (OSError, ValueError) as exc:
            self.erro = f"não foi possível iniciar '{self.comando}': {exc}"
            self._processo = None
            return False

        self._erro_linhas.clear()
        self._leitor = threading.Thread(target=self._ler_stdout, daemon=True)
        self._leitor.start()
        self._erro_thread = threading.Thread(target=self._ler_stderr, daemon=True)
        self._erro_thread.start()

        try:
            resultado = self._pedir(
                "initialize",
                {
                    "protocolVersion": PROTOCOLO,
                    "capabilities": {},
                    "clientInfo": _cliente_info(),
                },
            )
        except ErroMCP as exc:
            # "Método não encontrado" em `initialize` é a assinatura da geração stateless: o
            # servidor não tem handshake nenhum. Qualquer outro erro é falha de verdade.
            if exc.codigo == METODO_NAO_ENCONTRADO:
                return self._abrir_stateless()
            self.erro = self.com_saida(str(exc))
            self.fechar()
            return False

        negociado = resultado.get("protocolVersion") if isinstance(resultado, dict) else None
        if not versao_suportada(negociado):
            # Aceitar qualquer coisa que o servidor devolvesse foi o defeito: um `9999-99-99`
            # entrava como conectado e o app passava a falar um protocolo que não conhece.
            self.erro = (
                f"o servidor MCP '{self.nome}' respondeu a versão de protocolo "
                f"{negociado!r}, que o Koda não fala (ele fala {' e '.join(GERACOES)})"
            )
            self.fechar()
            return False
        self._protocolo = str(negociado)
        # Notificação obrigatória: sem ela o servidor não considera a sessão inicializada e
        # recusa `tools/list` em vários servidores.
        self._notificar("notifications/initialized", {})
        self.erro = None
        return True

    def _abrir_stateless(self) -> bool:
        """O caminho da geração `2026-07-28`: não há handshake.

        Não há o que negociar — a versão vai em `_meta` a cada pedido. Então aqui só se marca
        a geração. A **prova** de que o servidor é mesmo desta geração (e não um quebrado que
        recusou tudo) vem do `tools/list`, que quem conecta faz logo depois; se ele não
        responder, a conexão falha lá, com o motivo.
        """
        self._stateless = True
        self._protocolo = GERACOES[0]
        # Sem sessão, ninguém avisa de nada por conta própria: o aviso de lista mudada tem de
        # ser **pedido** (`subscriptions/listen`). Se o servidor não aceitar, quem segura a
        # lista em dia é o `ttlMs` que ele devolver na listagem.
        self.escutar_mudancas()
        self.erro = None
        return True

    def fechar(self) -> None:
        processo, self._processo = self._processo, None
        if processo is None:
            return
        # Acorda quem estiver esperando resposta: sem isto, um `chamar` preso no timeout
        # ficaria até o teto mesmo com o processo já morto.
        for fila in list(self._esperando.values()):
            fila.put({"_morta": True})
        try:
            if processo.stdin:
                processo.stdin.close()
        except OSError:
            pass
        try:
            processo.terminate()
            processo.wait(timeout=3)
        except (OSError, subprocess.TimeoutExpired):
            try:
                processo.kill()
            except OSError:
                pass

    # ------------------------------------------------------------ protocolo

    def ferramentas(self) -> list[FerramentaMCP]:
        """O que está **em cache**. Não faz I/O, não conecta, não refaz a listagem.

        O `catalogo()` do gerenciador chama isto no caminho quente (a cada rodada), então
        aqui não pode haver chamada ao servidor — quem fala com o servidor é `listar()`.
        """
        return self._ferramentas

    def listar(self) -> list[FerramentaMCP]:
        """Pergunta ao servidor o que ele oferece, seguindo a paginação até o fim.

        Levanta `ErroMCP` quando não deu — quem chama decide o que fazer com o erro. O
        `nextCursor` é **opaco** (a especificação diz isso): o único uso permitido é
        devolvê-lo na próxima chamada, e é o que se faz aqui.

        Um servidor com catálogo grande responde em **páginas**, e ler só a primeira foi o
        defeito: a ferramenta que estava na segunda simplesmente não existia para o Koda.
        """
        if not self.vivo and not self.abrir():
            raise ErroMCP(self.erro or f"o servidor MCP '{self.nome}' não está no ar")

        # Guarda os avisos de agora: um `list_changed` que chegue **durante** a coleta fala de
        # uma lista mais nova do que esta, e não pode ser dado por lido no fim.
        avisos = self._avisos
        ferramentas: list[FerramentaMCP] = []
        vistos: set[str] = set()
        cursor: str | None = None
        incompleto: str | None = None
        expira_em: float | None = None
        for _ in range(MAX_PAGINAS):
            # `cursor` **presente** é o que se manda — inclusive vazio. A especificação diz
            # que string vazia é cursor válido, e o `if cursor` daqui cortava a paginação na
            # primeira página de um servidor que usa `""` como primeiro cursor.
            resultado = self._pedir("tools/list", {} if cursor is None else {"cursor": cursor})
            if not isinstance(resultado, dict):
                raise ErroMCP(f"o servidor MCP '{self.nome}' respondeu lixo a 'tools/list'")
            for ferramenta in _ferramentas_de(resultado.get("tools")):
                # Servidor que repete uma ferramenta entre páginas não pode virar duas
                # entradas: o nome externo colidiria consigo mesmo.
                if ferramenta.nome not in vistos:
                    vistos.add(ferramenta.nome)
                    ferramentas.append(ferramenta)
            if expira_em is None:
                expira_em = _expira_em(resultado.get("ttlMs"))

            proximo = resultado.get("nextCursor")
            # **Ausente/null** é o fim. `""` **não** é: a especificação é explícita ("an empty
            # string is a valid cursor and thus MUST NOT be treated as the end of results"), e
            # era exatamente isso que fazia a paginação parar antes da hora.
            if proximo is None:
                break
            if not isinstance(proximo, str):
                incompleto = (
                    f"o servidor MCP '{self.nome}' devolveu um 'nextCursor' que não é texto "
                    f"({type(proximo).__name__}); a paginação parou aí"
                )
                break
            cursor = proximo
        else:
            # Chegou no teto com cursor na mão: parar e **dizer** é melhor do que seguir num
            # laço. O que foi lido até aqui vale, e a lista sai marcada como incompleta.
            incompleto = (
                f"o servidor MCP '{self.nome}' não terminou a paginação de 'tools/list' em "
                f"{MAX_PAGINAS} páginas — o catálogo está incompleto"
            )

        self._ferramentas = ferramentas
        self._avisos_lidos = avisos
        self._expira_em = expira_em
        self.incompleto = incompleto
        return ferramentas

    def escutar_mudancas(self) -> bool:
        """Pede ao servidor para avisar quando a lista de ferramentas mudar.

        Na geração com handshake isto não se pede: o servidor manda
        `notifications/tools/list_changed` direto. Na `2026-07-28`, o aviso só vai para quem
        abriu um `subscriptions/listen` — e é um **fluxo longo**, então o pedido sai sem espera
        (a resposta dele só chega quando o fluxo fecha) e o id fica guardado em `_escutas`.

        Devolve `False` quando não se aplica ou quando o envio falhou; quem aceitou de verdade
        é a acknowledgment, que chega como notificação.
        """
        if not self._stateless or not self.vivo:
            return False
        with self._trava:
            identificador = self._proximo_id
            self._proximo_id += 1
            self._escutas.add(identificador)
            try:
                self._escrever(
                    {
                        "jsonrpc": "2.0",
                        "id": identificador,
                        "method": "subscriptions/listen",
                        "params": self._com_meta(
                            {"notifications": {"toolsListChanged": True}}
                        ),
                    }
                )
            except ErroMCP:
                self._escutas.discard(identificador)
                return False
        return True

    def chamar(self, nome: str, argumentos: dict[str, Any], tempo_s: float | None = None) -> tuple[bool, str]:
        """Executa uma ferramenta. Devolve `(ok, texto)` — nunca levanta.

        `ok=False` cobre os três jeitos de dar errado: o servidor recusou (`isError`), o
        servidor morreu no meio, ou a resposta não chegou a tempo. O texto é sempre legível
        — é ele que vira o resultado da ferramenta na conversa.
        """
        if not self.vivo and not self.abrir():
            return False, f"ERRO: o servidor MCP '{self.nome}' não está no ar: {self.erro or 'sem detalhe'}"
        try:
            resultado = self._pedir(
                "tools/call",
                {"name": nome, "arguments": argumentos or {}},
                tempo_s=tempo_s or self.tempo_s,
            )
        except ErroMCP as exc:
            return False, f"ERRO: {exc}"
        if not isinstance(resultado, dict):
            return False, f"ERRO: resposta inesperada do servidor MCP '{self.nome}'"
        texto = _conteudo_para_texto(resultado.get("content"))
        if resultado.get("isError"):
            # A marca `ERRO:` **tem** de vir: é ela que o laço lê (`saida_ok`) para saber que
            # a ferramenta falhou. Sem ela, um erro do servidor entrava no histórico como
            # sucesso — o cartão ficava normal na tela e o modelo achava que tinha dado certo.
            detalhe = texto or "sem detalhe"
            return (
                False,
                f"ERRO: a ferramenta '{nome}' do servidor MCP '{self.nome}' falhou: {detalhe}",
            )
        return True, texto or "(sem saída)"

    # ------------------------------------------------------------ transporte

    def _pedir(
        self, metodo: str, params: dict[str, Any], tempo_s: float | None = None
    ) -> Any:
        """Manda um pedido e espera a resposta com o mesmo `id`."""
        processo = self._processo
        if processo is None or processo.stdin is None or processo.poll() is not None:
            raise ErroMCP(
                f"o servidor MCP '{self.nome}' não está no ar"
                + (f": {self.erro}" if self.erro else "")
            )
        with self._trava:
            identificador = self._proximo_id
            self._proximo_id += 1
            fila: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=1)
            self._esperando[identificador] = fila
            try:
                self._escrever(
                    {
                        "jsonrpc": "2.0",
                        "id": identificador,
                        "method": metodo,
                        "params": self._com_meta(params),
                    }
                )
            except ErroMCP:
                self._esperando.pop(identificador, None)
                raise

        try:
            resposta = fila.get(timeout=tempo_s or self.tempo_s)
        except queue.Empty:
            self._esperando.pop(identificador, None)
            raise ErroMCP(
                f"o servidor MCP '{self.nome}' não respondeu a '{metodo}' em "
                f"{tempo_s or self.tempo_s:.0f}s"
            ) from None
        finally:
            self._esperando.pop(identificador, None)

        if resposta.get("_morta"):
            raise ErroMCP(f"o servidor MCP '{self.nome}' encerrou durante '{metodo}'")
        erro = resposta.get("error")
        if erro:
            if isinstance(erro, dict):
                detalhe = erro.get("message")
                codigo = erro.get("code")
            else:
                detalhe, codigo = str(erro), None
            raise ErroMCP(
                f"o servidor MCP '{self.nome}' recusou '{metodo}': {detalhe}",
                codigo if isinstance(codigo, int) else None,
            )
        return resposta.get("result")

    def _com_meta(self, params: dict[str, Any]) -> dict[str, Any]:
        """Os parâmetros com os campos de `_meta` que a geração stateless exige.

        Na `2026-07-28` não existe sessão: versão, cliente e capacidades viajam em **cada**
        requisição, e um pedido sem eles é malformado — o servidor recusa com `-32602`. Na
        geração com handshake nada disso existe: quem carrega esses dados é o `initialize`.
        """
        if not self._stateless:
            return params
        return {
            **params,
            "_meta": {
                META_VERSAO: self._protocolo,
                META_CLIENTE: _cliente_info(),
                META_CAPACIDADES: {},
            },
        }

    def _notificar(self, metodo: str, params: dict[str, Any]) -> None:
        try:
            self._escrever({"jsonrpc": "2.0", "method": metodo, "params": params})
        except ErroMCP:
            # Notificação não tem resposta: se o processo já morreu, o handshake seguinte
            # (ou o `tools/list`) vai acusar o problema com uma mensagem melhor que esta.
            pass

    def _escrever(self, mensagem: dict[str, Any]) -> None:
        processo = self._processo
        if processo is None or processo.stdin is None:
            raise ErroMCP(f"o servidor MCP '{self.nome}' não está no ar")
        try:
            processo.stdin.write(json.dumps(mensagem, ensure_ascii=False) + "\n")
            processo.stdin.flush()
        except (OSError, ValueError) as exc:
            raise ErroMCP(f"o servidor MCP '{self.nome}' fechou a entrada: {exc}") from exc

    def _ler_stdout(self) -> None:
        processo = self._processo
        if processo is None or processo.stdout is None:
            return
        for linha in processo.stdout:
            if len(linha) > MAX_LINHA:
                continue
            texto = linha.strip()
            if not texto:
                continue
            try:
                mensagem = json.loads(texto)
            except ValueError:
                # Linha que não é JSON: alguns servidores imprimem banner no stdout. Ignorar
                # é o certo — derrubar a sessão por causa de um `console.log` seria pior.
                continue
            if not isinstance(mensagem, dict):
                continue
            self._despachar(mensagem)
        # O `for` terminou: o stdout fechou, ou seja, o processo morreu.
        for fila in list(self._esperando.values()):
            fila.put({"_morta": True})

    def _despachar(self, mensagem: dict[str, Any]) -> None:
        identificador = mensagem.get("id")
        if identificador is not None and identificador in self._esperando:
            self._esperando[identificador].put(mensagem)
            return
        metodo = str(mensagem.get("method") or "")
        if identificador is not None and identificador in self._escutas:
            # Resposta de um `subscriptions/listen`. Ela só chega quando o fluxo **fecha**
            # (fechamento gracioso), ou com erro quando o servidor não tem o método — não é
            # resposta de pedido comum, e não pode ser esperada como uma.
            self._escutas.discard(identificador)
            if mensagem.get("error"):
                self.escutando_lista = False
            return
        # Notificação: sem `id`, é o servidor avisando de algo. Antes tudo o que não fosse
        # resposta caía fora em silêncio — e o aviso de lista mudada era jogado no lixo.
        if identificador is None:
            if metodo:
                self._notificacao(metodo, mensagem.get("params"))
            return
        # Pedido **do servidor** para o cliente (sampling, roots, ping). Não implementamos
        # nenhum, e deixar sem resposta travaria o servidor esperando para sempre: responder
        # "método não encontrado" é o que o protocolo manda quando o cliente não suporta.
        if metodo:
            self._notificar_erro(identificador, metodo)

    def _notificacao(self, metodo: str, params: Any = None) -> None:
        """Uma notificação do servidor.

        `notifications/tools/list_changed` é ele dizendo que a lista de ferramentas mudou —
        sem tratar, o catálogo ficava velho até o app reiniciar. O cache é invalidado e o
        contador de avisos sobe: quem tem o mapa é o gerenciador, e é ele que refaz a
        listagem (ver `Gerenciador.catalogo`).
        """
        if metodo == "notifications/tools/list_changed":
            self._ferramentas = []
            self._avisos += 1
            return
        if metodo == "notifications/subscriptions/acknowledged":
            # O servidor diz quais tipos aceitou. Se `toolsListChanged` não estiver na lista,
            # não haverá aviso nenhum nesta escuta — e aí quem segura a lista em dia é o TTL.
            aceitos = params.get("notifications") if isinstance(params, dict) else None
            self.escutando_lista = bool(
                isinstance(aceitos, dict) and aceitos.get("toolsListChanged")
            )

    def _notificar_erro(self, identificador: Any, metodo: str) -> None:
        try:
            self._escrever(
                {
                    "jsonrpc": "2.0",
                    "id": identificador,
                    "error": {"code": -32601, "message": f"método não suportado: {metodo}"},
                }
            )
        except ErroMCP:
            pass

    def _ler_stderr(self) -> None:
        processo = self._processo
        if processo is None or processo.stderr is None:
            return
        for linha in processo.stderr:
            self._erro_linhas.append(linha.rstrip("\r\n"))
            if len(self._erro_linhas) > MAX_ERRO_LINHAS:
                del self._erro_linhas[0]

    def ultimo_erro(self) -> str:
        """A última coisa que o servidor escreveu no `stderr` — o diagnóstico do porquê."""
        return "\n".join(self._erro_linhas[-6:])

    def com_saida(self, motivo: str) -> str:
        """O motivo, mais o código com que o processo morreu — quando ele morreu.

        Um `node.exe` que **existe** mas não consegue iniciar (DLL que não carrega, antivírus,
        arquitetura errada) não aparece como "não encontrei o arquivo": o `Popen` funciona e o
        processo morre logo depois. Sem o código, a tela dizia só "não respondeu ao handshake
        em 8s" — e não havia por onde começar a procurar. `0xC0000142` é o formato que o
        Windows mostra; em decimal não diz nada a ninguém.
        """
        if self._processo is None:
            return motivo
        codigo = self._processo.poll()
        if codigo is None:
            # O stdout já fechou (é por isso que chegamos aqui), mas o processo pode ainda não
            # ter sido colhido. Esperar um instante evita perder o código por corrida.
            try:
                codigo = self._processo.wait(timeout=1)
            except subprocess.TimeoutExpired:
                return motivo
        return f"{motivo} · o processo encerrou com o código 0x{codigo & 0xFFFFFFFF:08X}"


def _expira_em(ttl_ms: Any) -> float | None:
    """Quando o cache desta listagem deixa de valer, pelo `ttlMs` que o servidor devolveu.

    A `2026-07-28` manda `ttlMs` (e `cacheScope`) em toda resposta paginada: é o servidor
    dizendo por quanto tempo a lista vale. Sem isto, o cache de um servidor stateless ficava
    velho para sempre — lá não existe notificação sem `subscriptions/listen`, e não havia TTL.
    """
    if isinstance(ttl_ms, bool) or not isinstance(ttl_ms, (int, float)):
        return None
    if ttl_ms <= 0:
        return None
    return time.monotonic() + float(ttl_ms) / 1000.0


def _ferramentas_de(itens: Any) -> list[FerramentaMCP]:
    """As ferramentas de **uma página** de `tools/list`, no formato de casa."""
    ferramentas: list[FerramentaMCP] = []
    for item in itens or []:
        if not isinstance(item, dict):
            continue
        nome = str(item.get("name", "")).strip()
        if not nome:
            continue
        esquema = item.get("inputSchema")
        ferramentas.append(
            FerramentaMCP(
                nome=nome,
                descricao=str(item.get("description", "")).strip(),
                esquema=esquema if isinstance(esquema, dict) else {},
            )
        )
    return ferramentas


def _conteudo_para_texto(conteudo: Any) -> str:
    """O `content` do `tools/call` -> texto para o modelo.

    O MCP devolve uma lista de partes (`text`, `image`, `resource`). O Koda trabalha com
    texto na conversa, então o que é texto entra inteiro e o resto é **anunciado** — nunca
    silenciado: um resultado que era só imagem e some sem dizer nada faria o modelo achar
    que a ferramenta não devolveu nada.
    """
    if conteudo is None:
        return ""
    if isinstance(conteudo, str):
        return conteudo
    if not isinstance(conteudo, list):
        return str(conteudo)
    partes: list[str] = []
    for item in conteudo:
        if isinstance(item, str):
            partes.append(item)
            continue
        if not isinstance(item, dict):
            continue
        tipo = str(item.get("type", ""))
        if tipo == "text":
            partes.append(str(item.get("text", "")))
        elif tipo == "image":
            partes.append(f"[imagem: {item.get('mimeType', 'desconhecido')}]")
        elif tipo == "resource":
            recurso = item.get("resource")
            uri = recurso.get("uri") if isinstance(recurso, dict) else "?"
            partes.append(f"[recurso: {uri}]")
        else:
            partes.append(json.dumps(item, ensure_ascii=False))
    return "\n".join(parte for parte in partes if parte)


def nome_seguro(nome: str) -> str:
    """Nome de servidor/ferramenta -> pedaço utilizável num nome de função.

    O nome da ferramenta do modelo vira `mcp__<servidor>__<ferramenta>`, e um nome de
    função precisa casar com `[a-zA-Z0-9_-]` e caber em 64 caracteres. Aqui só ficam
    minúsculas, dígitos e `_`:

    - **só ASCII** porque é o que a especificação do MCP recomenda para nome de ferramenta
      (`A-Za-z0-9_` e `.` e `-`), e porque o provedor do modelo também não garante Unicode
      em nome de função. O acento é **removido**, não trocado por `_`: `ação` vira `acao`,
      e não `a__o` — o `isalnum()` do Python aceita `é`, e era por ali que o acento passava.
    - **minúsculas** porque a porteira do despacho normaliza o nome chamado com
      `registry.canonico` (que baixa a caixa). Um nome externo com maiúscula seria oferecido
      no catálogo e **negado** na hora da chamada — oferecido e permitido divergindo, que é
      exatamente o que a porteira existe para impedir.
    - **sem hífen** para não misturar `-` e `_` no mesmo nome (o modelo confunde os dois ao
      reescrever a chamada de memória).

    O nome **original** continua guardado no mapa do gerenciador, então a chamada chega ao
    servidor com o nome certo — isto é só a etiqueta que o modelo vê.
    """
    # `NFKD` separa a letra do acento (`ç` -> `c` + cedilha), e o `combining` descarta o
    # acento solto. O que sobrar fora do ASCII (cirílico, CJK) vira `_`: não há
    # transliteração honesta para isso, e inventar uma seria pior do que um separador.
    decomposto = unicodedata.normalize("NFKD", nome.strip().lower())
    sem_acento = "".join(c for c in decomposto if not unicodedata.combining(c))
    limpo = "".join(
        c if (c.isascii() and (c.isalnum() or c == "_")) else "_" for c in sem_acento
    )
    return limpo.strip("_") or "item"


def tempo_de(timeout: float | None) -> float:
    """Normaliza um timeout opcional para o valor do cliente."""
    if timeout is None or timeout <= 0:
        return TEMPO_PADRAO_S
    return float(timeout)
