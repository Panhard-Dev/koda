"""Cliente MCP sobre **stdio**: conversa JSON-RPC 2.0 com um servidor MCP.

O protocolo MCP (Model Context Protocol) tem duas partes que interessam aqui, e as duas
são a mesma coisa vista de dois lados:

- o **transporte** stdio: o servidor é um processo; o cliente escreve um objeto JSON por
  linha no `stdin` dele e lê um objeto JSON por linha do `stdout`. Nada de `Content-Length`
  como no LSP — o MCP usa JSON delimitado por `\\n`.
- o **protocolo**: `initialize` → `notifications/initialized` → `tools/list` → `tools/call`.

Este módulo é só isso: um servidor, um processo, uma conversa. Quem junta vários e monta o
catálogo é o `manager`.

**Por que síncrono.** A execução de ferramenta no Koda já roda numa thread (`asyncio.to_thread`
no laço). Um cliente assíncrono aqui só acrescentaria uma camada para o mesmo resultado, e
pior: o timeout teria de ser cooperativo com o laço de eventos, que não é quem está esperando.

**Fail-closed no handshake.** Um servidor que sobe mas não responde ao `initialize`, ou que
responde lixo, entra em estado de erro e **não** publica ferramenta nenhuma — melhor não
oferecer do que oferecer uma ferramenta que vai estourar na hora de chamar.
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
from dataclasses import dataclass, field
from typing import Any

from ..execution.processo import _sem_janela

#: Versão do protocolo MCP que este cliente fala. É a revisão estável que os servidores
#: publicados hoje aceitam; se o servidor responder outra, seguimos com a dele (o MCP manda
#: o servidor escolher a versão negociada).
PROTOCOLO = "2024-11-05"

#: Teto de uma linha de resposta. Um `tools/list` de servidor grande passa de 100 KB; 8 MB
#: é folga suficiente e ainda impede que uma linha corrompida coma a memória do processo.
MAX_LINHA = 8 * 1024 * 1024

#: Quanto esperar por cada resposta do servidor. O handshake e o `tools/list` são rápidos
#: (o servidor já está subindo); uma chamada de ferramenta pode demorar de verdade, e quem
#: decide esse teto é o `tempo_limite` da chamada, não esta constante.
TEMPO_PADRAO_S = 30.0

#: Quantas linhas de `stderr` guardar para diagnóstico. O erro de um servidor MCP costuma
#: sair aqui (stack trace de Node, `command not found`), e é o que a tela mostra quando o
#: servidor não conecta — sem isso, "não conectou" não diz nada.
MAX_ERRO_LINHAS = 40


class ErroMCP(Exception):
    """Falha do servidor ou do protocolo. A mensagem é o que vai para a tela."""


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
                    "clientInfo": {"name": "koda", "version": "1.0"},
                },
            )
        except ErroMCP as exc:
            self.erro = str(exc)
            self.fechar()
            return False

        if isinstance(resultado, dict):
            negociado = resultado.get("protocolVersion")
            if isinstance(negociado, str) and negociado:
                self._protocolo = negociado
        # Notificação obrigatória: sem ela o servidor não considera a sessão inicializada e
        # recusa `tools/list` em vários servidores.
        self._notificar("notifications/initialized", {})
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
        """O que o servidor oferece (`tools/list`). Em cache depois da primeira chamada."""
        if self._ferramentas:
            return self._ferramentas
        if not self.vivo and not self.abrir():
            return []
        try:
            resultado = self._pedir("tools/list", {})
        except ErroMCP as exc:
            self.erro = str(exc)
            return []
        itens = resultado.get("tools") if isinstance(resultado, dict) else None
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
        self._ferramentas = ferramentas
        return ferramentas

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
                    {"jsonrpc": "2.0", "id": identificador, "method": metodo, "params": params}
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
            detalhe = erro.get("message") if isinstance(erro, dict) else str(erro)
            raise ErroMCP(f"o servidor MCP '{self.nome}' recusou '{metodo}': {detalhe}")
        return resposta.get("result")

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
        # Pedido **do servidor** para o cliente (sampling, roots, ping). Não implementamos
        # nenhum, e deixar sem resposta travaria o servidor esperando para sempre: responder
        # "método não encontrado" é o que o protocolo manda quando o cliente não suporta.
        if identificador is not None and "method" in mensagem:
            self._notificar_erro(identificador, str(mensagem.get("method")))

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

    - **minúsculas** porque a porteira do despacho normaliza o nome chamado com
      `registry.canonico` (que baixa a caixa). Um nome externo com maiúscula seria oferecido
      no catálogo e **negado** na hora da chamada — oferecido e permitido divergindo, que é
      exatamente o que a porteira existe para impedir.
    - **sem hífen** para não misturar `-` e `_` no mesmo nome (o modelo confunde os dois ao
      reescrever a chamada de memória).

    O nome **original** continua guardado no mapa do gerenciador, então a chamada chega ao
    servidor com o nome certo — isto é só a etiqueta que o modelo vê.
    """
    limpo = "".join(c if (c.isalnum() or c == "_") else "_" for c in nome.strip().lower())
    return limpo.strip("_") or "item"


def tempo_de(timeout: float | None) -> float:
    """Normaliza um timeout opcional para o valor do cliente."""
    if timeout is None or timeout <= 0:
        return TEMPO_PADRAO_S
    return float(timeout)
