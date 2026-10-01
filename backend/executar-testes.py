"""Runner da suíte do backend — com **teto de tempo e de memória**.

Motivo de existir: a suíte antiga rodava direto no `pytest`, sem nenhum limite. Numa
máquina com a memória já apertada (era 1,1 GB livre em 7,9 GB), um teste que abre processo
de verdade e espera 240 s por olhada segura a máquina até o Windows travar em swap — e aí
não volta sozinho. Este runner é a rede que faltava:

- acompanha a **memória da árvore de processos** do pytest (não só do pai);
- acompanha o **relógio**;
- ao estourar qualquer um dos dois, mata a árvore inteira (`taskkill /F /T`) e sai com
  código 3, dizendo qual teste estava em curso.

Uso:
    .venv\\Scripts\\python.exe executar-testes.py                 # a suíte toda
    .venv\\Scripts\\python.exe executar-testes.py tests/test_shell.py -q
    .venv\\Scripts\\python.exe executar-testes.py --teto-s 120 --teto-mb 500

Qualquer argumento que não seja `--teto-s` / `--teto-mb` é repassado ao pytest.
"""

from __future__ import annotations

import argparse
import ctypes
import subprocess
import sys
import threading
import time
from ctypes import wintypes
from pathlib import Path

RAIZ = Path(__file__).resolve().parent

#: Tetos padrão. Escolhidos para *cortar antes de a máquina sofrer*: a suíte nova inteira
#: fica bem abaixo disto (medido), então estourar aqui é sinal de defeito, não de tamanho.
TETO_S = 600.0
TETO_MB = 700.0

INTERVALO_DE_AMOSTRA = 0.5


# --------------------------------------------------------------- memória da árvore

class _PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", ctypes.c_wchar * 260),
    ]


class _PROCESS_MEMORY_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("PageFaultCount", wintypes.DWORD),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
    ]


TH32CS_SNAPPROCESS = 0x00000002
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


def _retrato() -> list[tuple[int, int, str]]:
    """Retrato do sistema: `[(pid, pid_do_pai, nome_do_executavel)]`."""
    kernel32 = ctypes.windll.kernel32
    retrato = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if retrato == -1:
        return []
    achados: list[tuple[int, int, str]] = []
    try:
        entrada = _PROCESSENTRY32W()
        entrada.dwSize = ctypes.sizeof(_PROCESSENTRY32W)
        if not kernel32.Process32FirstW(retrato, ctypes.byref(entrada)):
            return []
        while True:
            achados.append(
                (entrada.th32ProcessID, entrada.th32ParentProcessID, entrada.szExeFile)
            )
            if not kernel32.Process32NextW(retrato, ctypes.byref(entrada)):
                break
    finally:
        kernel32.CloseHandle(retrato)
    return achados


def _filhos_por_pai() -> dict[int, list[int]]:
    """Mapa `pid -> [pids dos filhos]`, pelo retrato do sistema."""
    mapa: dict[int, list[int]] = {}
    for pid, pai, _nome in _retrato():
        mapa.setdefault(pai, []).append(pid)
    return mapa


def _membros_da_arvore(raiz: int) -> list[tuple[float, int, int, str]]:
    """Os processos da árvore de `raiz`, com memória, pai e nome — para o relatório do aborto."""
    retrato = _retrato()
    filhos: dict[int, list[int]] = {}
    pai_de: dict[int, int] = {}
    nome_de: dict[int, str] = {}
    for pid, pai, nome in retrato:
        filhos.setdefault(pai, []).append(pid)
        pai_de[pid] = pai
        nome_de[pid] = nome

    pilha = [raiz]
    vistos: list[int] = []
    while pilha:
        pid = pilha.pop()
        if pid in vistos:
            continue
        vistos.append(pid)
        pilha.extend(filhos.get(pid, ()))

    membros = [
        (_memoria_do_pid(pid) / 1024 / 1024, pid, pai_de.get(pid, 0), nome_de.get(pid, "?"))
        for pid in vistos
    ]
    membros.sort(reverse=True)
    return membros


def _memoria_do_pid(pid: int) -> int:
    """Working set do processo, em bytes (0 se não der para abrir)."""
    kernel32 = ctypes.windll.kernel32
    alca = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not alca:
        return 0
    try:
        contadores = _PROCESS_MEMORY_COUNTERS()
        contadores.cb = ctypes.sizeof(_PROCESS_MEMORY_COUNTERS)
        if not ctypes.windll.psapi.GetProcessMemoryInfo(
            alca, ctypes.byref(contadores), contadores.cb
        ):
            return 0
        return int(contadores.WorkingSetSize)
    finally:
        kernel32.CloseHandle(alca)


def _memoria_da_arvore(raiz: int) -> int:
    """Soma a memória do processo e de **todos** os descendentes."""
    filhos = _filhos_por_pai()
    pilha = [raiz]
    vistos: set[int] = set()
    total = 0
    while pilha:
        pid = pilha.pop()
        if pid in vistos:
            continue
        vistos.add(pid)
        total += _memoria_do_pid(pid)
        pilha.extend(filhos.get(pid, ()))
    return total


def _matar_arvore(pid: int) -> None:
    try:
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(pid)],
            capture_output=True,
            text=True,
            timeout=20,
            creationflags=0x08000000,  # CREATE_NO_WINDOW
        )
    except (OSError, subprocess.SubprocessError):
        pass


# --------------------------------------------------------------- vigia

class Vigia:
    """Amostra memória e relógio do pytest e mata a árvore se estourar o teto."""

    def __init__(self, processo: subprocess.Popen[str], teto_s: float, teto_mb: float) -> None:
        self.processo = processo
        self.teto_s = teto_s
        self.teto_mb = teto_mb
        self.pico_bytes = 0
        self.pico_s = 0.0
        self.motivo: str | None = None
        self.arvore: list[tuple[float, int, int, str]] = []
        self.inicio = time.monotonic()
        self._parar = threading.Event()

    def _vigiar(self) -> None:
        while not self._parar.wait(INTERVALO_DE_AMOSTRA):
            if self.processo.poll() is not None:
                return
            try:
                bytes_agora = _memoria_da_arvore(self.processo.pid)
            except OSError:
                continue
            decorrido = time.monotonic() - self.inicio
            if bytes_agora > self.pico_bytes:
                self.pico_bytes = bytes_agora
                self.pico_s = decorrido
            if bytes_agora > self.teto_mb * 1024 * 1024:
                self.motivo = (
                    f"memória da árvore passou de {self.teto_mb:.0f} MB "
                    f"(chegou a {bytes_agora / 1024 / 1024:.0f} MB)"
                )
                self.arvore = _membros_da_arvore(self.processo.pid)
                break
            if decorrido > self.teto_s:
                self.motivo = f"o relógio passou de {self.teto_s:.0f}s"
                self.arvore = _membros_da_arvore(self.processo.pid)
                break
        if self.motivo:
            _matar_arvore(self.processo.pid)

    def __enter__(self) -> "Vigia":
        self.fio = threading.Thread(target=self._vigiar, daemon=True)
        self.fio.start()
        return self

    def __exit__(self, *_erro: object) -> None:
        self._parar.set()
        self.fio.join(timeout=3)


# --------------------------------------------------------------- entrada

def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--teto-s", type=float, default=TETO_S)
    parser.add_argument("--teto-mb", type=float, default=TETO_MB)
    parser.add_argument("-h", "--help", action="store_true")
    conhecidos, do_pytest = parser.parse_known_args()

    if conhecidos.help:
        print(__doc__)
        return 0

    alvo = do_pytest or ["tests/", "-q", "-p", "no:cacheprovider"]
    if not do_pytest:
        do_pytest = alvo

    comando = [sys.executable, "-m", "pytest", *do_pytest]
    print(
        f"[runner] {' '.join(comando[2:])}\n"
        f"[runner] teto: {conhecidos.teto_s:.0f}s de relógio, "
        f"{conhecidos.teto_mb:.0f} MB de memória na árvore",
        flush=True,
    )

    processo = subprocess.Popen(
        comando,
        cwd=str(RAIZ),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )

    saida: list[str] = []

    def drenar() -> None:
        assert processo.stdout is not None
        for linha in processo.stdout:
            saida.append(linha)
            print(linha, end="", flush=True)

    fio_saida = threading.Thread(target=drenar, daemon=True)
    fio_saida.start()

    with Vigia(processo, conhecidos.teto_s, conhecidos.teto_mb) as vigia:
        codigo = processo.wait()
    fio_saida.join(timeout=10)

    duracao = time.monotonic() - vigia.inicio
    pico_mb = vigia.pico_bytes / 1024 / 1024
    print(
        f"\n[runner] duração: {duracao:.1f}s | pico de memória da árvore: {pico_mb:.0f} MB "
        f"(em {vigia.pico_s:.1f}s) | saída do pytest: {codigo}"
    )

    if vigia.motivo:
        ultimas = "".join(saida[-40:])
        print(
            f"\n[runner] ABORTADO: {vigia.motivo}.\n"
            "[runner] a árvore de processos foi morta. Últimas linhas antes do corte:\n"
            f"{ultimas}",
            file=sys.stderr,
        )
        if vigia.arvore:
            print("[runner] quem estava na árvore (maior primeiro):", file=sys.stderr)
            for mb, membro, pai, nome in vigia.arvore[:8]:
                print(f"[runner]   {mb:8.1f} MB  pid={membro:<7} pai={pai:<7} {nome}", file=sys.stderr)
        return 3
    return codigo


def relatar_arvore(pid: int) -> None:
    """Imprime quem compõe a árvore de `pid` — usado à mão para investigar um estouro."""
    for mb, membro, pai, nome in _membros_da_arvore(pid):
        print(f"  {mb:8.1f} MB  pid={membro:<7} pai={pai:<7} {nome}")


if __name__ == "__main__":
    raise SystemExit(main())
