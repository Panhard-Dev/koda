"""A máquina de processo: rodar comando e não perder o processo de vista.

`execution/` é folha — não conhece schema de ferramenta nem lógica do agente. Aqui mora o
`subprocess`: ambiente, argumentos, prazos, o registro do que ficou rodando
(`ComandoRodando`), o acompanhamento e o encerramento. Quem decide **o que** rodar é o
domínio; quem cuida de **como** rodar é isto.

O corte da saída vem de `app/limits.py` (infraestrutura compartilhada) — de propósito: se
viesse de `agent/`, esta camada importaria para cima, que é o que a regra proíbe.
"""

from __future__ import annotations

import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from ..limits import LIMITES, cortar_cabeca_e_cauda
from .tempo import (
    _CANCELAMENTO_DA_FERRAMENTA,
    _PRAZO_DA_FERRAMENTA,
    _restante_da_ferramenta,
    _timeout_da_ferramenta,
    _verificar_cancelamento,
)

def _reservar_processo() -> bool:
    """Reserva uma vaga sem bloquear as outras requisições do backend."""
    global _PROCESSOS_ATIVOS
    for rodando in list(_RODANDO.values()):
        if rodando.terminou():
            rodando.liberar_vaga()
    with _TRAVA_PROCESSOS:
        if _PROCESSOS_ATIVOS >= LIMITES.processos:
            return False
        _PROCESSOS_ATIVOS += 1
        return True
def _liberar_processo() -> None:
    global _PROCESSOS_ATIVOS
    with _TRAVA_PROCESSOS:
        _PROCESSOS_ATIVOS = max(0, _PROCESSOS_ATIVOS - 1)
def encerrar_tudo() -> int:
    """Mata **todos** os comandos que ficaram rodando. Devolve quantos foram derrubados.

    É o que faltava no shutdown: `_RODANDO` é um dict de processo — e um dict de processo
    não morre junto com o app. Um `npm run dev` (ou qualquer filho dele) sobrevivia ao
    fechamento do Koda, segurando porta e CPU, e ninguém tinha mais como achá-lo. Chamado
    no `lifespan` do FastAPI.
    """
    quantos = 0
    for rodando in list(_RODANDO.values()):
        try:
            rodando.matar()
            quantos += 1
        except Exception:  # noqa: BLE001 — encerrar é melhor esforço, nunca derruba a saída
            continue
    _RODANDO.clear()
    return quantos
def encerrar_do_dono(dono: str) -> int:
    """Mata só os comandos **desta** tarefa. Devolve quantos foram derrubados.

    É o que faz o botão Parar parar de verdade: cancelar a coroutine do loop **não** mata o
    subprocesso que ela começou, e o `shell` continuava rodando (`npm install`, build) depois
    de o usuário mandar parar. O `dono` é o id da tarefa (ver `routers/chat.py`), então
    parar uma conversa não derruba o comando de outra.
    """
    if not dono:
        return 0
    quantos = 0
    for identificador, rodando in list(_RODANDO.items()):
        if rodando.dono != dono:
            continue
        _RODANDO.pop(identificador, None)
        try:
            rodando.matar()
            quantos += 1
        except Exception:  # noqa: BLE001
            continue
    return quantos
_TRAVA_PROCESSOS = threading.Lock()

#: O PATH aumentado, montado uma vez por processo (a busca em disco é cara para repetir).
_PATH_AUMENTADO: str | None = None

#: Comandos que ficaram rodando depois de uma olhada, por id. O processo é do app: sai daqui
#: quando termina, quando o modelo para, ou quando o app fecha (`encerrar_tudo`).
#:
#: Cada entrada guarda **de quem** é o processo (`dono`), **onde** ele roda (`workspace`) e
#: **até quando** pode viver (`deadline`). Era só o id num dict global: em duas tarefas
#: simultâneas ninguém sabia a quem pertencia cada processo, e o shutdown não tinha como
#: achar quem matar.
_RODANDO: dict[str, "ComandoRodando"] = {}
_PROCESSOS_ATIVOS = 0
#: Onde os programas costumam ficar no Windows. O app é aberto pelo Explorer, e o PATH que
#: ele herda **não** é o mesmo do terminal de quem instalou: `node`, `npm`, `git` e `python`
#: somem sem que nada esteja quebrado. Sem isto, metade dos comandos do projeto morria em
#: "is not recognized" — e o modelo tentava de novo, de outro jeito, até gastar a tarefa.
LUGARES_DE_PROGRAMA = (
    r"C:\Program Files\nodejs",
    r"C:\Program Files (x86)\nodejs",
    r"~\AppData\Roaming\npm",
    r"~\AppData\Local\Programs\nodejs",
    r"C:\Program Files\Git\cmd",
    r"C:\Program Files\Git\bin",
    r"~\AppData\Local\Programs\Python",
    r"~\AppData\Local\Programs\Python\Scripts",
    r"~\AppData\Local\Microsoft\WindowsApps",
    r"~\AppData\Roaming\Python",
    r"C:\Python313",
    r"C:\Python312",
    r"C:\Python311",
    r"C:\Python310",
    r"~\.local\bin",
    r"~\.cargo\bin",
    r"~\scoop\shims",
    r"C:\ProgramData\chocolatey\bin",
)
def _path_com_programas() -> str:
    """O PATH do processo **mais** os lugares conhecidos que existem de verdade.

    Só entra o diretório que tem executável dentro: adivinhar caminho não resolve nada.
    """
    global _PATH_AUMENTADO
    if _PATH_AUMENTADO is not None:
        return _PATH_AUMENTADO

    atual = os.environ.get("PATH", "")
    partes = atual.split(os.pathsep) if atual else []
    vistos = {p.rstrip("\\/").lower() for p in partes}

    extras: list[str] = []
    for bruto in LUGARES_DE_PROGRAMA:
        base = Path(os.path.expanduser(bruto))
        candidatos = [base]
        if base.name == "Python":  # as versões ficam em subpastas: Python\Python311
            candidatos = sorted(
                (filho for filho in base.glob("Python3*") if filho.is_dir()), reverse=True
            )
        for pasta in candidatos:
            if not pasta.is_dir():
                continue
            chave = str(pasta).rstrip("\\/").lower()
            if chave in vistos:
                continue
            if not any(pasta.glob("*.exe")):
                continue
            vistos.add(chave)
            extras.append(str(pasta))
            # As ferramentas de linha de comando dos scripts ficam ao lado.
            scripts = pasta / "Scripts"
            if scripts.is_dir() and any(scripts.glob("*.exe")):
                vistos.add(str(scripts).lower())
                extras.append(str(scripts))

    _PATH_AUMENTADO = os.pathsep.join([*partes, *extras]) if extras else atual
    return _PATH_AUMENTADO
def _ambiente_do_comando(extra: dict[str, str] | None = None) -> dict[str, str]:
    """O ambiente de **todo** processo filho: PATH aumentado + o que o chamador pedir.

    Centralizado de propósito. Antes o `shell` usava o PATH aumentado e o git, o
    `shutil.which("node")` e o linter usavam o PATH **cru** do processo — e quando o app é
    aberto pelo Explorer (e não por um terminal) o PATH herdado não tem `node`, `git` nem
    `npm`. O resultado era o modelo recebendo "não está instalado nesta máquina" para um
    programa que existe.
    """
    ambiente = {**os.environ, "PATH": _path_com_programas()}
    if extra:
        ambiente.update(extra)
    return ambiente
def _which(programa: str) -> str | None:
    """`shutil.which` no PATH **aumentado** — o mesmo que o shell enxerga."""
    return shutil.which(programa, path=_path_com_programas())
def _sem_janela() -> dict[str, Any]:
    """Impede a janela de console piscando no Windows em cada subprocesso.

    O backend é criado pelo Rust com `CREATE_NO_WINDOW`, mas isso **não** se propaga aos
    netos: cada `Popen`/`subprocess.run` daqui abria um console próprio quando o app roda
    empacotado (sem terminal na frente). No Linux/macOS devolve vazio.
    """
    if os.name != "nt":
        return {}
    return {"creationflags": subprocess.CREATE_NO_WINDOW}
def _kwargs_de_processo(
    *, shell: bool, workspace: Path, env: dict[str, str] | None = None
) -> dict[str, Any]:
    """Os argumentos comuns de criação de processo — com grupo/sessão **próprio**.

    `start_new_session=True` (Unix) é o que torna `os.killpg` seguro: sem ele o filho nasce
    no **mesmo grupo do backend**, e `killpg` matava o grupo inteiro — inclusive o próprio
    Koda (reproduzido: o backend morria com 137 ao apertar Parar). No Windows o equivalente
    é o `taskkill /T`, que já derruba a árvore pelo pid.

    `stdin=DEVNULL` é obrigatório num agente automático: com o stdin herdado, um comando que
    pede entrada fica pendurado esperando algo que nunca vem (o modo dev herda o terminal).
    """
    return {
        "shell": shell,
        "cwd": str(workspace),
        "env": _ambiente_do_comando(env),
        "stdin": subprocess.DEVNULL,
        "start_new_session": os.name != "nt",
        **_sem_janela(),
    }
def _argv_shell(comando: str) -> str:
    """O comando como o shell do sistema espera recebê-lo.

    **String, e não lista** — e isso é o conserto de metade dos comandos que falhavam. Com
    `["cmd", "/c", comando]` o `cmd` come as aspas internas: `python -c "print(1 + 1)"`
    chegava no Python como `print(1 + 1` e voltava `exit code: 1`. Medido com os comandos
    que os modelos escrevem: **6 de 12 falhavam** na lista contra **0 de 12** com a string
    (que é o `shell=True` do Python). O modelo tentava de novo, tentava de outro jeito, e
    era isso que parecia "os modelos não conseguem rodar comando".
    """
    return comando
#: Quando o shell não conhece o programa: em inglês e em português, cmd e PowerShell.
NAO_RECONHECIDO = re.compile(
    r"is not recognized|n[aã]o [eé] reconhecido|CommandNotFound|n[aã]o pode ser encontrado",
    re.IGNORECASE,
)
#: Programas que o modelo mais tenta rodar. A dica abaixo responde a pergunta que ele ia
#: fazer em três tentativas — "então o que existe nesta máquina?".
PROGRAMAS = ("python", "python3", "py", "node", "npm", "npx", "git", "pip", "uv")
def _dica_de_programa(saida: str) -> str:
    """O que fazer quando o comando não existe nesta máquina.

    Sem isto o modelo tentava `python`, depois `python3`, depois `py`, depois `cmd`… e
    gastava a tarefa inteira nisso — era o "tenta tudo e não vai" que o dono descreveu. Com
    a lista na mão ele muda de caminho na primeira tentativa.
    """
    if not NAO_RECONHECIDO.search(saida):
        return ""
    achados = []
    for programa in PROGRAMAS:
        caminho = _which(programa)
        if caminho:
            achados.append(f"{programa} → {caminho}")
    if not achados:
        return "\n\nDICA: nenhum destes programas está no PATH desta máquina: " + ", ".join(
            PROGRAMAS
        )
    return (
        "\n\nDICA: este programa não existe (ou não está no PATH). O que **existe** aqui: "
        + " · ".join(achados)
        + ". Use um destes, ou resolva por outra ferramenta (arquivo com `write_file`, "
        "código com `code_interpreter`) em vez de insistir no mesmo nome."
    )
def _formatar(proc: subprocess.CompletedProcess[str]) -> str:
    saida = f"exit code: {proc.returncode}\n"
    if proc.stdout:
        saida += f"--- stdout ---\n{proc.stdout}"
    if proc.stderr:
        saida += f"\n--- stderr ---\n{proc.stderr}"
    return cortar_cabeca_e_cauda(
        (saida.strip() or "(sem saída)") + _dica_de_programa(saida), LIMITES.saida
    )
#: Código de saída no começo da saída de um comando/script (`_formatar`).
_CODIGO_DE_SAIDA = re.compile(r"^exit code:\s*(-?\d+)", re.MULTILINE)
def _codigo_de_saida(saida: str) -> int | None:
    """O código de retorno **real** lido do retorno formatado (`None` se não houver).

    Existia só o teste `"exit code: 0" in saida` espalhado pelo código — frágil, porque
    casa com a frase em qualquer lugar da saída. Aqui é o número.
    """
    achado = _CODIGO_DE_SAIDA.search(saida or "")
    return int(achado.group(1)) if achado else None
#: Nomes que nunca devem entrar num commit automático sem a pessoa saber: segredo,
#: credencial, chave e afins. `git add -A` num projeto sem `.gitignore` subia tudo isso.
_SENSIVEIS = frozenset(
    {
        ".env",
        ".env.local",
        ".env.production",
        ".env.development",
        ".npmrc",
        ".pypirc",
        "id_rsa",
        "id_ed25519",
        "credentials.json",
        "secrets.json",
        "serviceaccount.json",
    }
)
def _git_add_seguro(workspace: Path) -> str:
    """`git add -A` sem levar segredo junto — e avisando quando algo foi posto de lado.

    Num projeto sem `.gitignore` o `git add -A` sobe `.env` e chave para o commit, e o
    commit vai para o remoto. Aqui o que tem cara de segredo é **desmarcado** depois do add
    e o retorno avisa, em vez de subir em silêncio.
    """
    adicionado = _rodar_lista(["git", "add", "-A"], workspace)
    if _codigo_de_saida(adicionado) != 0:
        return adicionado
    listados = _rodar_lista(["git", "diff", "--cached", "--name-only"], workspace)
    if _codigo_de_saida(listados) != 0:
        return adicionado
    corpo = listados.split("--- stdout ---\n", 1)[-1]
    sensiveis = [
        linha.strip()
        for linha in corpo.splitlines()
        if linha.strip() and Path(linha.strip()).name.lower() in _SENSIVEIS
    ]
    if not sensiveis:
        return adicionado
    _rodar_lista(["git", "reset", "-q", "--", *sensiveis], workspace)
    return (
        "AVISO: arquivo(s) com cara de segredo ficaram **fora** do commit ("
        + ", ".join(sensiveis)
        + "). Crie um .gitignore para silenciar isto.\n"
        + adicionado
    )
def _rodar_lista(
    argv: list[str],
    workspace: Path,
    tempo: float = LIMITES.tempo_comando,
    env: dict[str, str] | None = None,
) -> str:
    """Executa um argv direto (sem shell) e devolve a saída formatada.

    Passa pelo **mesmo** caminho de criação de processo do `shell` (`_kwargs_de_processo`):
    grupo/sessão próprio, stdin fechado, sem janela no Windows e PATH aumentado. No timeout
    mata a **árvore** — `subprocess.run(timeout=…)` só mata o pai e deixava filho órfão
    rodando (o `npm` morria e o `node` do build continuava vivo).

    `env` é mesclado ao ambiente: é o que pede ao git para **não** abrir prompt de senha
    (`GIT_TERMINAL_PROMPT=0`) — sem isso um `git push` num remoto que pede credencial ficava
    parado até o teto, sem nada na tela.
    """
    restante = _restante_da_ferramenta()
    if restante is not None:
        if restante <= 0:
            return "ERRO: o prazo desta chamada de ferramenta acabou antes da execução."
        tempo = min(float(tempo), restante)
    if not _reservar_processo():
        return (
            f"ERRO: já há {LIMITES.processos} comandos em execução. "
            "Aguarde um terminar ou encerre um comando que ficou rodando."
        )
    try:
        proc = subprocess.Popen(
            argv,
            stdout=subprocess.PIPE,
            # stderr **no mesmo cano** do stdout: com dois canos separados o texto era
            # concatenado no fim e a ordem original se perdia — num log de build/teste é
            # justamente a ordem que diz onde o erro apareceu.
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            **_kwargs_de_processo(shell=False, workspace=workspace, env=env),
        )
    except FileNotFoundError:
        _liberar_processo()
        return f"ERRO: executável não encontrado: {argv[0]}"
    except OSError as exc:
        _liberar_processo()
        return f"ERRO ao rodar {argv[0]!r}: {exc}"

    rodando = ComandoRodando(
        uuid.uuid4().hex[:8], " ".join(argv), proc, vaga_reservada=True
    )
    fim = time.monotonic() + float(tempo)
    while True:
        evento_cancelamento = _CANCELAMENTO_DA_FERRAMENTA.get()
        if evento_cancelamento is not None and evento_cancelamento.is_set():
            rodando.matar()
            rodando.fechar_leitores()
            rodando.liberar_vaga()
            return "ERRO: a pessoa cancelou a tarefa; o processo foi interrompido."
        restante = fim - time.monotonic()
        if restante <= 0:
            break
        if rodando.esperar(min(0.2, restante)):
            rodando.fechar_leitores()
            rodando.liberar_vaga()
            return _formatar(
                subprocess.CompletedProcess(
                    args=argv, returncode=proc.returncode or 0, stdout=rodando.texto(), stderr=""
                )
            )
    rodando.matar()
    rodando.fechar_leitores()
    rodando.liberar_vaga()
    return (
        f"ERRO: comando excedeu {tempo:g}s e foi interrompido\n"
        f"--- saída até a interrupção ---\n{rodando.texto()}"
    )
class ComandoRodando:
    """Um comando que passou da olhada e continua vivo, com a saída guardada.

    A saída é lida por duas threads (stdout e stderr) que só **acrescentam** à lista — quem
    espera é a thread principal, no `wait` do processo. Assim a saída parcial está sempre
    disponível para a próxima olhada, e nada do que o comando já escreveu se perde.

    O processo é **deste** comando: `dono` diz de que tarefa ele é, `workspace` diz de que
    pasta, e `deadline` diz até quando ele pode viver. É o que permite o encerramento
    limpo no shutdown e o teto absoluto de verdade (ver `_relatorio_de_olhada`).
    """

    def __init__(
        self,
        identificador: str,
        comando: str,
        proc: subprocess.Popen[str],
        *,
        dono: str = "",
        workspace: Path | None = None,
        deadline: float | None = None,
        vaga_reservada: bool = False,
    ) -> None:
        self.id = identificador
        self.comando = comando
        self.proc = proc
        self.saida: list[str] = []
        self.erro: list[str] = []
        self.inicio = time.monotonic()
        #: Teto **absoluto** do processo (monotonic) ou `None`. É o que faltava: antes o
        #: `tempo_limite` só limitava cada olhada, e o comando podia viver para sempre com
        #: o modelo dizendo "continuar".
        self.deadline = deadline
        self.vaga_reservada = vaga_reservada
        self.dono = dono
        self.workspace = workspace
        #: Quantos caracteres o comando já escreveu (contador, e não `len()` da lista: a
        #: saída guardada é cortada no teto, e o corte faria um comando tagarela parecer
        #: parado).
        self.escrito = 0
        #: Trava do contador: as duas threads de leitura escrevem nele ao mesmo tempo, e sem
        #: isto um `escrito` inconsistente faria o comando parecer parado (falso "travado").
        self._trava = threading.Lock()
        #: Quantas olhadas já houve, e quantas seguidas não trouxeram **nada novo**.
        self.olhadas = 0
        self.paradas = 0
        #: Marca d'água da última olhada que viu saída nova, e quando isso foi.
        self._visto = 0
        self._ultima_saida = self.inicio
        self._leitores: list[threading.Thread] = []
        for fluxo, destino in ((proc.stdout, self.saida), (proc.stderr, self.erro)):
            if fluxo is not None:
                leitor = threading.Thread(target=self._ler, args=(fluxo, destino), daemon=True)
                leitor.start()
                self._leitores.append(leitor)

    def _ler(self, fluxo: Any, destino: list[str]) -> None:
        try:
            for linha in fluxo:
                with self._trava:
                    destino.append(linha)
                    self.escrito += len(linha)
                self._ultima_saida = time.monotonic()
        except (ValueError, OSError):
            # O processo morreu e levou o cano junto: o que já foi lido fica.
            pass

    def fechar_leitores(self, tempo: float = 5.0) -> None:
        """Espera as threads de leitura esvaziarem os canos. Idempotente.

        `proc.wait()` volta assim que o processo morre, **antes** de as threads lerem o que
        ainda estava no buffer do cano — e a última linha do comando se perdia (medido: 2
        falhas em 300 `echo`). A execução só é considerada encerrada depois que os leitores
        terminaram: é isso que garante a saída completa para o modelo.
        """
        limite = time.monotonic() + tempo
        for leitor in self._leitores:
            leitor.join(max(0.05, limite - time.monotonic()))

    def olhar(self) -> int:
        """Conta a olhada e devolve quantas seguidas vieram sem saída nova.

        O contador é o que diz se o comando está **trabalhando** ou **parado** — e é isso
        que decide se ele continua vivo ou é interrompido. Tempo sozinho não decide nada:
        build de duas horas que está imprimindo é trabalho.
        """
        self.olhadas += 1
        with self._trava:
            antes = self.escrito
        if antes > self._visto:
            self._visto = antes
            self.paradas = 0
            self._ultima_saida = time.monotonic()
        else:
            self.paradas += 1
        return self.paradas

    def mudo_desde(self) -> float:
        """Segundos desde a última linha escrita — a **inatividade** de verdade."""
        return time.monotonic() - self._ultima_saida

    def decorrido(self) -> float:
        return time.monotonic() - self.inicio

    def terminou(self) -> bool:
        return self.proc.poll() is not None

    def esperar(self, segundos: float) -> bool:
        """Espera até `segundos`. `True` quando o comando terminou nesse meio-tempo."""
        try:
            self.proc.wait(timeout=max(0.05, segundos))
            return True
        except subprocess.TimeoutExpired:
            return False

    def texto(self) -> str:
        """O que o comando escreveu até agora — o fim da saída, que é onde está o erro."""
        junto = "".join(self.saida)
        if self.erro:
            junto += ("\n--- stderr ---\n" if junto else "--- stderr ---\n") + "".join(self.erro)
        junto = junto.strip()
        if len(junto) > LIMITES.saida_rodando:
            fora = len(junto) - LIMITES.saida_rodando
            return (
                f"(...{fora} caracteres anteriores descartados...)\n"
                + junto[-LIMITES.saida_rodando:]
            )
        return junto or "(sem saída até agora)"

    def matar(self) -> None:
        """Mata o processo **e a árvore dele**. Não mexe na saída já guardada."""
        if self.terminou():
            self.liberar_vaga()
            return
        _matar_arvore(self.proc.pid)
        if not self.esperar(2):
            # `taskkill /T` pode não ter permissão para encerrar a árvore em ambientes
            # restritos. Ainda assim, o processo que o Koda iniciou não pode ficar vivo
            # fora do registro: encerra o pai como fallback e espera o estado final.
            try:
                self.proc.kill()
            except OSError:
                pass
            self.esperar(5)
        if self.terminou():
            self.liberar_vaga()

    def liberar_vaga(self) -> None:
        global _PROCESSOS_ATIVOS
        with _TRAVA_PROCESSOS:
            if self.vaga_reservada:
                self.vaga_reservada = False
                _PROCESSOS_ATIVOS = max(0, _PROCESSOS_ATIVOS - 1)

    def parar(self) -> str:
        """Interrompe o comando e a árvore dele, e devolve o que já tinha saído."""
        if self.terminou():
            self.liberar_vaga()
            self.fechar_leitores()
            return _formatar(
                subprocess.CompletedProcess(
                    args=self.comando,
                    returncode=self.proc.returncode or 0,
                    stdout=self.texto(),
                    stderr="",
                )
            )
        self.matar()
        self.fechar_leitores()
        return (
            f"interrompido a pedido (pid {self.proc.pid})\n"
            f"--- saída até a interrupção ---\n{self.texto()}"
        )
def _matar_arvore(pid: int) -> None:
    """Mata o processo **e os filhos** dele, sem tocar no grupo do backend.

    No Windows quem sabe derrubar a árvore é o `taskkill /T`. No Unix, `killpg` só é seguro
    porque todo filho nasce com `start_new_session=True` — o grupo dele é próprio. A
    checagem `grupo == os.getpgid(0)` é a rede de segurança: se por qualquer motivo o filho
    tiver nascido no **grupo do Koda**, o `killpg` derrubaria o backend junto (era o bug
    reproduzido, exit 137), então aí mata-se só o processo.
    """
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                capture_output=True,
                text=True,
                timeout=15,
                **_sem_janela(),
            )
        except (OSError, subprocess.SubprocessError):
            pass
        return
    try:
        grupo = os.getpgid(pid)
        if grupo == os.getpgid(0):
            os.kill(pid, signal.SIGKILL)
        else:
            os.killpg(grupo, signal.SIGKILL)
    except OSError:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
def _relatorio_de_olhada(rodando: "ComandoRodando") -> str:
    """O retorno da olhada: o comando **não** morreu, e o modelo decide o que fazer.

    As duas últimas linhas são o que o modelo precisa para agir — sem elas ele responde
    texto, a conversa trava e o comando fica rodando sem ninguém olhando.

    Três decisões, nesta ordem, e todas do **backend** (o modelo não é a autoridade do
    lifecycle do processo):

    1. **teto absoluto** (`deadline`): passou do tempo pedido em `tempo_limite`, é morto e
       o resultado volta. Antes o `tempo_limite` só limitava *cada olhada*, e um comando
       podia viver para sempre com o modelo chamando `continuar`;
    2. **inatividade**: mudo por `LIMITES.inatividade_s` segundos, é travado — esperando
       entrada, em laço mudo ou morto por dentro. Medido em segundos, não em olhadas;
    3. caso contrário, devolve a saída e deixa o modelo decidir (continuar ou parar).
    """
    minutos = rodando.decorrido() / 60
    paradas = rodando.olhar()
    mudo = rodando.mudo_desde()

    if rodando.deadline is not None and time.monotonic() >= rodando.deadline:
        _RODANDO.pop(rodando.id, None)
        rodando.matar()
        rodando.fechar_leitores()
        return (
            f"INTERROMPIDO: o comando atingiu o tempo limite de "
            f"{rodando.deadline - rodando.inicio:.0f}s — id={rodando.id}\n"
            f"comando: {rodando.comando}\n"
            f"--- saída até a interrupção ---\n{rodando.texto()}\n"
            "--- fim da saída ---\n"
            "O teto de tempo do processo é do backend e não se estende por `continuar`. "
            "Isso **não** é o fim da tarefa: siga por outro caminho (comando mais direto, "
            "`code_interpreter`, ou a ferramenta de arquivo) e diga o que ficou pronto."
        )

    if paradas >= LIMITES.olhadas_sem_saida or mudo >= LIMITES.inatividade_s:
        _RODANDO.pop(rodando.id, None)
        # Interromper é **matar**, não só tirar do registro. Sem o `parar()` aqui o processo
        # continuava rodando e, pior, órfão: fora do registro, ninguém conseguia pará-lo pelo
        # id. A mensagem dizia "interrompi" e era falso.
        rodando.parar()
        return (
            f"INTERROMPIDO: o comando parece TRAVADO — {mudo / 60:.0f} min sem escrever "
            f"nada — id={rodando.id}\n"
            f"comando: {rodando.comando}\n"
            f"--- saída até a interrupção ---\n{rodando.texto()}\n"
            f"--- fim da saída ---\n"
            "Comando vivo mas mudo por todo esse tempo está travado (esperando entrada, em "
            "laço mudo, ou morto por dentro), e continuar esperando não ia resolver. "
            "Isso **não** é o fim da tarefa: siga por outro caminho (comando mais direto, "
            "`code_interpreter`, ou a ferramenta de arquivo) e diga o que ficou pronto."
        )

    aviso = ""
    if rodando.olhadas >= LIMITES.olhadas_ate_cobrar:
        # Sem teto por tempo, este é o freio do "vou continuar" infinito: o modelo é cobrado
        # a decidir — mas quem decide continua sendo ele.
        aviso = (
            f"\nATENÇÃO: já são {rodando.olhadas} olhadas neste mesmo comando "
            f"({minutos:.0f} min). Se ele não termina sozinho (servidor, programa com janela, "
            "prévia), **pare agora**. Se está perto de terminar, continue — mas decida, não "
            "fique só acompanhando."
        )

    restante = ""
    if rodando.deadline is not None:
        restante = (
            f"\nTempo restante até o teto do processo: "
            f"{max(0, rodando.deadline - time.monotonic()):.0f}s."
        )

    return (
        f"AINDA RODANDO ({minutos:.1f} min) — id={rodando.id}\n"
        f"comando: {rodando.comando}\n"
        f"--- saída até agora ---\n{rodando.texto()}\n"
        f"--- fim da saída até agora ---\n"
        f"O comando NÃO foi interrompido: ele continua rodando.\n"
        f"- Está indo bem e pode demorar? Continue acompanhando: "
        f'shell com {{"continuar": "{rodando.id}"}}\n'
        f"- Não termina sozinho (servidor, programa com janela, prévia) ou travou? Pare: "
        f'shell com {{"parar": "{rodando.id}"}}'
        f"{restante}{aviso}"
    )
def _comecar(
    comando: str,
    workspace: Path,
    *,
    tempo: int = LIMITES.tempo_comando,
    dono: str = "",
) -> "ComandoRodando":
    """Cria o processo com grupo/sessão próprio e o registra em `_RODANDO`.

    O `deadline` é calculado **aqui**, uma vez: é o teto absoluto do processo, e não muda
    por `continuar` (o modelo não estica o prazo do backend).
    """
    if not _reservar_processo():
        raise RuntimeError(
            f"limite global de {LIMITES.processos} comandos concorrentes atingido"
        )
    try:
        proc = subprocess.Popen(
            _argv_shell(comando),
            stdout=subprocess.PIPE,
            # Mesmo cano para stdout e stderr: preserva a ordem das linhas.
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            **_kwargs_de_processo(shell=True, workspace=workspace),
        )
    except BaseException:
        _liberar_processo()
        raise
    identificador = uuid.uuid4().hex[:8]
    prazo = time.monotonic() + tempo if tempo and tempo > 0 else None
    rodando = ComandoRodando(
        identificador,
        comando,
        proc,
        dono=dono,
        workspace=workspace,
        deadline=prazo,
        vaga_reservada=True,
    )
    _RODANDO[identificador] = rodando
    return rodando
def _acompanhar(
    identificador: str, tempo: int, espera_maxima: float | None = None
) -> str:
    """Espera mais um tanto por um comando que já estava rodando."""
    rodando = _RODANDO.get(identificador)
    if rodando is None:
        return (
            f"ERRO: não há comando rodando com id {identificador!r} — ele já terminou ou o "
            "id está errado. Rode o comando de novo se precisar."
        )
    # A espera nunca passa do que resta do teto absoluto: sem isto o `continuar` empurrava
    # o fim do processo para depois do prazo.
    restante = min(LIMITES.intervalo_olhada, espera_maxima or LIMITES.intervalo_olhada)
    if rodando.deadline is not None:
        restante = min(restante, max(0.05, rodando.deadline - time.monotonic()))
    restante_chamada = _restante_da_ferramenta()
    if restante_chamada is not None:
        restante = min(restante, max(0.05, restante_chamada))
    if rodando.esperar(min(tempo, restante)):
        _RODANDO.pop(identificador, None)
        rodando.fechar_leitores()
        rodando.liberar_vaga()
        return _formatar(
            subprocess.CompletedProcess(
                args=rodando.comando,
                returncode=rodando.proc.returncode or 0,
                stdout=rodando.texto(),
                stderr="",
            )
        )
    relatorio = _relatorio_de_olhada(rodando)
    prazo_chamada = _restante_da_ferramenta()
    if prazo_chamada is not None and prazo_chamada <= 0 and not rodando.terminou():
        return (
            "ERRO: o tempo desta chamada acabou; o comando continua registrado e pode ser "
            "acompanhado ou cancelado.\n" + relatorio
        )
    return relatorio
def _parar(identificador: str) -> str:
    rodando = _RODANDO.pop(identificador, None)
    if rodando is None:
        return f"ERRO: não há comando rodando com id {identificador!r}."
    return rodando.parar()
def _rodar(
    comando: str,
    workspace: Path,
    tempo: int = LIMITES.tempo_comando,
    dono: str = "",
    espera_maxima: float | None = None,
) -> str:
    """Roda o comando e **não** o mata quando demora: devolve a olhada e segue vivo.

    Era `subprocess.run(timeout=...)`, que interrompia o comando no limite — um build de
    vinte minutos morria no meio e o trabalho ia junto. Agora o processo fica no registro e,
    a cada `LIMITES.intervalo_olhada`, o modelo recebe a saída até agora para decidir: continuar
    acompanhando (`continuar`) ou parar (`parar`).

    `tempo` é o teto **total** do processo, e agora é de verdade: ele vira `deadline` no
    `ComandoRodando` e `continuar` não o estende. `dono` é a tarefa que começou o processo —
    é o que permite o Parar derrubar só o que é dela.
    """
    try:
        rodando = _comecar(comando, workspace, tempo=tempo, dono=dono)
    except FileNotFoundError:
        return f"ERRO: comando não encontrado: {comando.split()[0]}"
    except RuntimeError as exc:
        return f"ERRO: {exc}"
    except OSError as exc:
        return f"ERRO ao rodar {comando!r}: {exc}"

    limite = min(tempo, LIMITES.intervalo_olhada) if tempo else LIMITES.intervalo_olhada
    if espera_maxima is not None:
        limite = min(limite, espera_maxima)
    restante_chamada = _restante_da_ferramenta()
    if restante_chamada is not None:
        limite = min(limite, max(0.05, restante_chamada))
    if rodando.esperar(limite):
        _RODANDO.pop(rodando.id, None)
        rodando.fechar_leitores()
        rodando.liberar_vaga()
        return _formatar(
            subprocess.CompletedProcess(
                args=comando,
                returncode=rodando.proc.returncode or 0,
                stdout=rodando.texto(),
                stderr="",
            )
        )
    relatorio = _relatorio_de_olhada(rodando)
    prazo_chamada = _restante_da_ferramenta()
    if prazo_chamada is not None and prazo_chamada <= 0 and not rodando.terminou():
        return (
            "ERRO: o tempo desta chamada acabou; o comando continua registrado e pode ser "
            "acompanhado ou cancelado.\n" + relatorio
        )
    return relatorio
