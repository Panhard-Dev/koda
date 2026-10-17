"""Reergue o host dos modelos quando ele não está no ar.

O app instalado já tem quem cuide disso: o **vigia do shell** (`src-tauri/src/servicos.rs`)
abre o host na subida e o reabre quando ele cai — com cinco tentativas rápidas e, depois
delas, uma a cada cinco minutos. Em **desenvolvimento** não há shell nenhum: o host é subido
à mão, e o sintoma é o que o dono descreveu — a tela diz «Reconectando ao serviço de modelos»,
insiste sozinha para sempre, e o host nunca volta, porque não há ninguém para levantá-lo.

Aqui quem levanta é o **backend**: ele roda na mesma máquina, sabe onde o binário mora, e é
quem depende do host. O gatilho é a própria reescolha do provider (`build_provider`) — a mesma
que a tela provoca ao insistir —, com duas travas:

1. **Só em dev.** `KODA_HOST_URL` no ambiente marca o app instalado (o launcher o repassa, ver
   `src-tauri/src/main.rs`); lá o dono do host é o shell, e subir um segundo processo brigaria
   pela porta com o vigia dele.
2. **Com espera entre tentativas.** A tela insiste a cada poucos segundos; sem a espera, cada
   volta da tela criaria um processo novo.
"""

from __future__ import annotations

import os
import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

from ..config import Settings

#: Onde o painel de contas vive: o host pergunta a ele se a sessão de quem fala vale. É o
#: mesmo endereço que o shell usa (`src-tauri/src/main.rs`, `URL_DO_PAINEL`) — o binário do
#: host **não** carrega endereço nenhum dentro dele, ele lê daqui.
URL_DO_PAINEL = "https://koda-cloud-api.studiosluxgames.workers.dev"

#: Porta do host quando `host_url` não disser outra (a de sempre, em dev).
PORTA_PADRAO = 21128

#: Espera entre tentativas de subir o host, em segundos.
ESPERA_ENTRE_TENTATIVAS_S = 20.0

_trava = threading.Lock()
_ultima_tentativa = 0.0
_processo: subprocess.Popen[bytes] | None = None


def dono_e_o_shell() -> bool:
    """O app instalado manda no host? Se sim, quem o reergue é o vigia do shell."""
    return bool(os.environ.get("KODA_HOST_URL"))


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


def subir(settings: Settings) -> bool:
    """Tenta subir o host. `True` quando um processo foi lançado **agora**.

    Não espera o host responder: quem espera é quem chamou (a sonda logo depois), porque o
    tempo de subida é dele e não nosso. Um processo nosso que ainda está vivo não é
    substituído — pode estar abrindo a porta —, e o binário ausente (checkout sem o
    `host/c-host.exe`) não é erro: simplesmente não há o que subir.
    """
    global _ultima_tentativa, _processo
    if dono_e_o_shell():
        return False

    with _trava:
        agora = time.monotonic()
        if agora - _ultima_tentativa < ESPERA_ENTRE_TENTATIVAS_S:
            return False
        _ultima_tentativa = agora

        if _processo is not None and _processo.poll() is None:
            return False

        binario = _binario()
        if binario is None:
            return False

        painel = os.environ.get("KODA_CLOUD_URL", URL_DO_PAINEL)
        try:
            _processo = subprocess.Popen(
                [str(binario), "-port", str(_porta(settings.host_url))],
                env={**os.environ, "SERVE_LIZ_AUTH_URL": painel},
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except OSError:
            # Binário bloqueado pelo antivírus, sem permissão de execução: não há o que
            # fazer daqui, e insistir não muda nada — a espera acima já limita a tentativa.
            return False
        return True
