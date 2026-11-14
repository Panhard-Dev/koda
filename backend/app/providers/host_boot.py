"""Mantém o host dos modelos no ar.

O host oficial é o **LizProxy** (`LizProxy.py`), um processo Python que fala
OpenAI-compatible em `/v1/models` e `/v1/chat/completions` e exige a senha
dinâmica do dia inclusive para listar o catálogo. No app instalado quem abre e
vigia esse processo é o launcher Tauri; em **desenvolvimento** não há shell, e
é este módulo que faz esse papel.

A regra que evita o «401 intermitente» é uma só: backend e LizProxy têm de ler
**o mesmo arquivo** de senha dinâmica. O backend resolve o caminho por
`host_dinamica.caminho(settings)` e passa `KODA_DYNAMIC_KEY_FILE` ao proxy. Se
cada lado usar o diretório padrão que bem entende, o painel escreve a senha num
lugar e o host procura noutro, recusando a conversa para sempre.

O LizProxy escolhe uma porta livre e a publica na saída; este módulo lê o
endereço, guarda a porta num arquivo estável e atualiza `settings.host_url`.
Assim outra execução reencontra o host sem varrer portas. No app instalado o
marcador `KODA_BACKEND_PACKAGED=1` (ou `KODA_GATEWAY_GERENCIADO=1`) impede que
o backend suba um segundo processo e brigue com o launcher.

Os helpers de descoberta do antigo gateway Node ficam abaixo para compatibilidade
com checkouts que ainda tenham `host/c-host.exe`; o caminho oficial não os usa.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

from ..config import Settings

#: Onde o painel de contas vive: o host pergunta a ele se a sessão de quem fala vale. É o
#: mesmo endereço que o shell usa (`src-tauri/src/main.rs`, `URL_DO_PAINEL`) — o binário do
#: host **não** carrega endereço nenhum dentro dele, ele lê daqui.
URL_DO_PAINEL = "https://koda-cloud-api.studiosluxgames.workers.dev"

# O launcher Tauri passa a mesma chave ao `c-host` (src-tauri/src/main.rs). Em modo dev
# sem shell, o backend faz esse papel; ela abre a configuração empacotada no executável e
# não é a credencial da conta, que continua chegando por /host/sessao.
CHAVE_DA_CONFIG_SELADA = "5b32d14288b278d1ebd71775ebfd7d504434914bdd025ae9"

#: Porta do `c-host` antigo quando `host_url` não disser outra.
PORTA_PADRAO = 21128

#: Porta de fábrica do gateway headless. Ele mesmo pula para a próxima livre.
PORTA_PADRAO_GATEWAY = 8794

#: Faixa em que o gateway headless pode aparecer (`8794`, `8795`, …).
PORTAS_DO_GATEWAY = tuple(range(8790, 8800))

#: Catálogo do gateway novo. Serve para não confundir o gateway com qualquer outro serviço
#: que esteja ouvindo na faixa — adotar o endereço errado seria pior do que não achar nada.
#:
#: O Claude Haiku 5.5 continua aqui só como **impressão digital**: o gateway ainda o
#: publica, mas o app não o oferece no seletor (ver `routers/models.py`, `FORA_DO_MAPA`).
#: A detecção usa interseção, então qualquer um dos ids já prova que é o gateway.
MODELOS_DO_GATEWAY = frozenset(
    {
        "claude-haiku-5.5",
        "glm-5.3-flash",
        "qwen-3.8-flash",
        "qwen-3.8-flash-legacy",
    }
)

#: Quanto esperar o gateway escrever a porta e o catálogo responder, em segundos.
#:
#: O Node leva de 4 s (disco quente) a quase um minuto (primeira execução, disco frio e
#: loja de contas sendo aberta) para escrever o `ACCIO_PORT_FILE`. Com 10 s o backend
#: desistia no meio da subida, escolhia o `local` — que não tem ferramentas — e a tela
#: ficava sem os modelos oficiais até alguém reiniciar tudo. O teto aqui é generoso de
#: propósito: quem está no caminho é a abertura do app, não uma requisição de chat.
ESPERA_DO_GATEWAY_S = 90.0

_trava = threading.Lock()
_processo: subprocess.Popen[bytes] | None = None


def processo_vivo() -> bool:
    """O gateway que **este backend** abriu ainda está de pé?

    Quem espera o catálogo usa isto para não gastar o prazo inteiro quando o processo
    morreu logo depois de subir (Node ausente, porta ocupada, loja de contas corrompida).
    Um gateway encontrado pronto na rede não é nosso, e aí a resposta é `False` — mas
    nesse caso a sonda seguinte já o encontra.
    """
    return _processo is not None and _processo.poll() is None


def dono_e_o_shell() -> bool:
    """O app instalado manda no host? Se sim, quem o reergue é o vigia do shell.

    O marcador é `KODA_BACKEND_PACKAGED`, que o launcher põe em `1` (ver
    `src-tauri/src/main.rs`). Antes era `KODA_HOST_URL`, mas o backend de desenvolvimento
    também define essa variável no `.env` — e aí o backend achava que o shell era o dono e
    nunca subia o host.
    """
    return os.environ.get("KODA_BACKEND_PACKAGED") == "1" or os.environ.get("KODA_GATEWAY_GERENCIADO") == "1"


def _gateway_dir() -> Path:
    """A pasta do gateway-local — ou a que `KODA_GATEWAY_DIR` apontar."""
    do_ambiente = os.environ.get("KODA_GATEWAY_DIR")
    if do_ambiente:
        return Path(do_ambiente).expanduser()
    return Path(__file__).resolve().parents[3] / "host" / "gateway-local"


def _gateway_script() -> Path | None:
    """O `src/headless.js` do gateway, se ele existir neste checkout."""
    caminho = _gateway_dir() / "src" / "headless.js"
    return caminho if caminho.is_file() else None


def _node() -> str | None:
    """O Node que vai rodar o gateway: o empacotado, o do `PATH` ou o de `KODA_NODE_BIN`.

    O app instalado já leva um Node em `src-tauri/runtime*/node`; em dev, o mesmo arquivo
    está no checkout. O `PATH` é a última cartada para quem tem Node global.
    """
    do_ambiente = os.environ.get("KODA_NODE_BIN")
    if do_ambiente:
        caminho = Path(do_ambiente).expanduser()
        return str(caminho) if caminho.is_file() else None
    raiz = Path(__file__).resolve().parents[3]
    for candidato in (
        raiz / "src-tauri" / "runtime-linux" / "node" / "node",
        raiz / "src-tauri" / "runtime" / "node" / "node.exe",
        raiz / "src-tauri" / "runtime" / "node" / "node",
    ):
        if candidato.is_file():
            return str(candidato)
    return shutil.which("node")


def _binario() -> Path | None:
    """O `c-host.exe` deste checkout — ou o que `KODA_HOST_BIN` apontar.

    O caminho é resolvido pelo **arquivo** (`backend/app/providers/host_boot.py`), e não pelo
    diretório de trabalho: o backend é subido da pasta `backend/` em dev e de outra pasta no
    app empacotado, e um caminho relativo ao cwd acharia o host num caso e não no outro.
    """
    do_ambiente = os.environ.get("KODA_HOST_BIN")
    if do_ambiente:
        caminho = Path(do_ambiente)
        return caminho if caminho.exists() else None
    raiz = Path(__file__).resolve().parents[3]
    for candidato in (raiz / "host" / "c-host.exe", raiz / "host" / "c-host"):
        if candidato.exists():
            return candidato
    return None


def _porta(host_url: str) -> int:
    """A porta do host, tirada do endereço que o backend já usa para falar com ele."""
    return urlsplit(host_url).port or PORTA_PADRAO


def _host_local(host_url: str) -> str | None:
    """O nome local que pode receber o host, ou `None` para endereço remoto."""
    hostname = urlsplit(host_url).hostname
    return hostname if hostname in {"localhost", "127.0.0.1", "::1"} else None


def _porta_aberta(host: str, porta: int, timeout: float = 0.25) -> bool:
    """Tem alguém ouvindo nesta porta? Pergunta barata, antes do HTTP.

    A varredura passa por uma dúzia de portas; abrir conexão em cada uma custa milissegundos
    quando não há ninguém, enquanto esperar o timeout do `/models` em cada uma custaria
    segundos. O HTTP só acontece onde já existe um listener.
    """
    try:
        with socket.create_connection((host, porta), timeout=timeout):
            return True
    except OSError:
        return False


def _modelos_do_gateway(
    base_url: str, chave: str | None = None, timeout: float = 2.0
) -> bool:
    """O endereço responde `/models` com o catálogo do gateway novo?

    Um serviço qualquer na mesma porta pode responder 200; só o catálogo prova que é o
    gateway. A chave é opcional porque o headless não exige uma (`requireApiKey: false`).

    O timeout não é mais 0,8 s: a primeira chamada de um gateway recém-aberto monta o
    catálogo e pode passar disso, e uma sonda apressada fazia o backend concluir que não
    havia host nenhum.
    """
    pedido = urllib.request.Request(
        f"{base_url.rstrip('/')}/models", headers={"Accept": "application/json"}
    )
    if chave:
        pedido.add_header("Authorization", f"Bearer {chave}")
    try:
        with urllib.request.urlopen(pedido, timeout=timeout) as resposta:
            if resposta.status >= 400:
                return False
            dados = json.loads(resposta.read(1_000_000))
    except (OSError, ValueError):
        return False
    itens = dados.get("data") if isinstance(dados, dict) else None
    if not isinstance(itens, list):
        return False
    ids = {item.get("id") for item in itens if isinstance(item, dict)}
    return bool(ids & MODELOS_DO_GATEWAY)


def descobrir(settings: Settings) -> str | None:
    """Procura o gateway no ar e adota o endereço dele.

    Devolve a base encontrada (`.../v1`) ou `None`. A ordem é: o endereço configurado, a
    porta de fábrica do headless (`8794`), o resto da faixa (`8790–8799`) e as portas do
    c-host antigo (`21128`/`21129`) — esta última só para o caso de alguém ter subido o
    gateway numa delas. Endereço remoto não é procurado: quem manda nele é outra máquina.
    """
    if _host_local(settings.host_url) is None:
        return None
    candidatas: list[str] = []
    atual = settings.host_url.strip().rstrip("/")
    if atual:
        candidatas.append(atual)

    # O arquivo de porta é a memória entre execuções: se o gateway foi aberto numa porta
    # fora da faixa (o app instalado sorteia a dele), é aqui que a próxima subida o acha.
    for caminho in (
        os.environ.get("KODA_GATEWAY_PORT_FILE"),
        str(Path(tempfile.gettempdir()) / "koda-gateway.port"),
    ):
        if not caminho:
            continue
        achada = _porta_do_arquivo(Path(caminho))
        if achada:
            base = f"http://127.0.0.1:{achada}/v1"
            if base not in candidatas:
                candidatas.append(base)

    portas = [
        PORTA_PADRAO_GATEWAY,
        _porta(settings.host_url),
        *PORTAS_DO_GATEWAY,
        PORTA_PADRAO,
        PORTA_PADRAO + 1,
    ]
    for porta in portas:
        base = f"http://127.0.0.1:{porta}/v1"
        if base not in candidatas:
            candidatas.append(base)
    abertas: list[str] = []
    for base in candidatas:
        partes = urlsplit(base)
        if not partes.port or not _porta_aberta(partes.hostname or "127.0.0.1", partes.port):
            continue
        if _modelos_do_gateway(base, settings.host_key):
            settings.host_url = base
            return base
        abertas.append(base)

    # Segunda passada, só nas portas que têm alguém ouvindo. Um gateway ocupado com uma
    # conversa pode demorar mais que o timeout curto para responder ao catálogo; desistir
    # dele e abrir um segundo processo seria pior (dois gateways, duas lojas de contas).
    for base in abertas:
        if _modelos_do_gateway(base, settings.host_key, timeout=5.0):
            settings.host_url = base
            return base
    return None


def _porta_respondendo(settings: Settings) -> bool:
    """Evita iniciar um segundo `c-host` quando já existe alguém ouvindo naquela porta."""
    hostname = _host_local(settings.host_url)
    if hostname is None:
        return False
    try:
        with socket.create_connection((hostname, _porta(settings.host_url)), timeout=0.2):
            return True
    except OSError:
        return False


def _porta_do_arquivo(arquivo: Path) -> int | None:
    """A porta que o headless escreveu em `ACCIO_PORT_FILE`, se ela já está lá."""
    try:
        texto = arquivo.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    try:
        porta = int(texto)
    except ValueError:
        return None
    return porta if 0 < porta < 65_536 else None


def _subir_gateway(settings: Settings) -> subprocess.Popen[bytes] | None:
    """Sobe o gateway headless e devolve o processo — ou `None` se não deu.

    A porta desejada sai do `host_url`; se ele não estiver na faixa conhecida, usa a de
    fábrica. O gateway pode pular para a próxima livre, então quem manda é o
    `ACCIO_PORT_FILE`: assim que ele escreve a porta, o `host_url` é atualizado. Não espera
    o catálogo responder — quem espera é o chamador, com a sonda dele.
    """
    script = _gateway_script()
    node = _node()
    if script is None or node is None:
        return None

    porta = _porta(settings.host_url)
    if porta not in (*PORTAS_DO_GATEWAY, PORTA_PADRAO, PORTA_PADRAO + 1):
        porta = PORTA_PADRAO_GATEWAY

    # Caminho estável (e não por PID): é o que permite a uma execução seguinte achar o
    # gateway que já está no ar sem varrer a faixa inteira — e o que o shell usa para
    # amarrar o backend à porta que ele escolheu.
    arquivo = Path(
        os.environ.get("KODA_GATEWAY_PORT_FILE")
        or (Path(tempfile.gettempdir()) / "koda-gateway.port")
    )
    try:
        arquivo.unlink()
    except OSError:
        pass

    ambiente = {
        **os.environ,
        "ACCIO_HEADLESS": "1",
        "ACCIO_PORT": str(porta),
        "ACCIO_PORT_FILE": str(arquivo),
    }
    dados = os.environ.get("KODA_GATEWAY_DATA_DIR")
    if dados:
        ambiente["ACCIO_DATA_DIR"] = dados

    try:
        processo = subprocess.Popen(
            [node, str(script)],
            cwd=str(script.parent.parent),
            env=ambiente,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError:
        return None

    # Espera o arquivo **e** o catálogo. Só a porta não basta: o headless escreve o arquivo
    # antes de a loja de contas terminar de abrir, e a primeira conversa ainda pode levar
    # alguns segundos. Devolver cedo demais fazia o chamador desistir no meio da subida.
    limite = time.monotonic() + ESPERA_DO_GATEWAY_S
    achada: int | None = None
    while time.monotonic() < limite:
        if processo.poll() is not None:
            return None
        if achada is None:
            achada = _porta_do_arquivo(arquivo)
            if achada:
                settings.host_url = f"http://127.0.0.1:{achada}/v1"
        if _porta_aberta("127.0.0.1", _porta(settings.host_url)) and _modelos_do_gateway(
            settings.host_url, settings.host_key, timeout=1.0
        ):
            return processo
        time.sleep(0.2)

    # O arquivo não apareceu (ou o catálogo não ficou pronto): o processo pode ter subido
    # numa porta da faixa mesmo assim. Se o catálogo responder em alguma, adota; senão
    # devolve o processo vivo para o chamador decidir (a próxima tentativa não abre outro).
    for candidata in PORTAS_DO_GATEWAY:
        base = f"http://127.0.0.1:{candidata}/v1"
        if _porta_aberta("127.0.0.1", candidata) and _modelos_do_gateway(
            base, settings.host_key, timeout=1.0
        ):
            settings.host_url = base
            return processo
    return processo if processo.poll() is None else None


def _arquivo_da_porta_do_proxy() -> Path:
    """Onde o LizProxy iniciado em dev publica a porta que ele mesmo sorteou."""
    escolhido = os.environ.get("KODA_GATEWAY_PORT_FILE")
    return Path(escolhido) if escolhido else Path(tempfile.gettempdir()) / "koda-lizproxy.port"


def _ler_endereco_do_proxy(processo: subprocess.Popen[bytes]) -> str | None:
    """Lê a linha de arranque do proxy sem bloquear a subida do backend.

    O `readline()` antigo segurava o lifespan do FastAPI enquanto o pipe existisse. Se o
    proxy não imprimisse nada, o app inteiro ficava "a abrir" sem porta HTTP. A porta
    também vai para um arquivo estável: outra execução consegue reencontrar este host.
    """
    saida = processo.stdout
    if saida is None:
        return None
    linha = saida.readline().decode(errors="replace").strip() if hasattr(saida, "readline") else ""
    endereco = linha.rsplit(" ", 1)[-1]
    if not (endereco.startswith("http://127.0.0.1:") and endereco.endswith("/v1")):
        return None
    try:
        porta = urlsplit(endereco).port
        if porta:
            arquivo = _arquivo_da_porta_do_proxy()
            arquivo.parent.mkdir(parents=True, exist_ok=True)
            arquivo.write_text(str(porta), encoding="ascii")
    except OSError:
        pass
    return endereco


def _subir_lizproxy(settings: Settings) -> bool:
    """Sobe o host oficial em dev, com o mesmo arquivo de senha do backend."""
    global _processo
    with _trava:
        arquivo_da_porta = _arquivo_da_porta_do_proxy()
        if _processo is not None and _processo.poll() is None:
            porta = _porta_do_arquivo(arquivo_da_porta)
            if porta:
                settings.host_url = f"http://127.0.0.1:{porta}/v1"
            return True
        porta = _porta_do_arquivo(arquivo_da_porta)
        if porta:
            base = f"http://127.0.0.1:{porta}/v1"
            if _porta_aberta("127.0.0.1", porta):
                settings.host_url = base
                return True
        script = Path(__file__).resolve().parents[3] / "LizProxy.py"
        if not script.is_file():
            return False
        from .. import host_dinamica

        caminho = host_dinamica.caminho(settings).resolve()
        caminho.parent.mkdir(parents=True, exist_ok=True)
        ambiente = {
            **os.environ,
            "KODA_PROXY_INTERNO": "1",
            "KODA_DYNAMIC_KEY_FILE": str(caminho),
        }
        try:
            _processo = subprocess.Popen(
                [sys.executable, "-u", str(script)],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                env=ambiente,
            )
            endereco = _ler_endereco_do_proxy(_processo)
            if endereco is None:
                _processo.terminate()
                _processo = None
                return False
            settings.host_url = endereco
            return True
        except OSError:
            _processo = None
            return False


def subir(settings: Settings) -> bool:
    """Tenta deixar o host no ar. `True` quando ele está/ficou disponível agora.

    O LizProxy é o host oficial do app instalado. Em dev ele também é o dono da porta,
    para que o teste no navegador use exatamente o mesmo contrato de autenticação. Ele
    recebe o mesmo `KODA_DYNAMIC_KEY_FILE` que o backend; sem isso, o backend escreve a
    senha do dia num lugar e o host procura noutro, devolvendo 401 para sempre.
    """
    if dono_e_o_shell():
        return False
    if _host_local(settings.host_url) is None:
        return False
    return _subir_lizproxy(settings)
