"""A senha dinâmica do dia — a credencial que o painel entrega ao Koda.

São **duas** formas de o backend se autorizar no host dos modelos, e as duas
continuam valendo:

1. a **sessão da conta** (`host_auth`): o host pergunta ao painel se ela vive.
   É o caminho normal, e o que faz um banimento no painel valer na hora.
2. a **senha dinâmica do dia** (este módulo): o painel deriva uma senha que gira
   à meia-noite UTC e entrega a quem está logado em `GET /api/host/senha-
   dinamica`. O backend grava o JSON em `koda-host-dinamica.json` na pasta de
   dados e o `c-host` — apontado para esse arquivo por `SERVE_LIZ_DYNAMIC_KEY_FILE`
   — autoriza quem apresentar a senha, sem falar com ninguém.

A senha dinâmica tem três virtudes sobre a sessão: sobrevive a uma queda do
painel (a comparação é local), serve de API pura (curl com um `Bearer` resolve,
sem conta logada) e não guarda credencial de conta nenhuma em disco — o que
fica no arquivo é uma senha de um dia, não um token de acesso.

Quem escreve o arquivo é `atualizar` (chamada quando a sessão chega e na
reescolha do provider, sempre com espera entre tentativas). Quem apaga é
`esquecer` (sair da conta). A senha em si nunca vai para log.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx

if TYPE_CHECKING:  # pragma: no cover - só para o tipo
    from .config import Settings

#: Nome do arquivo na pasta de dados — o mesmo que o shell passa ao host em
#: `SERVE_LIZ_DYNAMIC_KEY_FILE`, e o que o host procura ao lado do executável
#: quando o ambiente não diz nada (regra do `proxy-pools.json`).
NOME_DO_ARQUIVO = "koda-host-dinamica.json"

#: Rota do painel que emite a senha do dia (sessão de conta no cabeçalho).
ROTA_NO_PAINEL = "/api/host/senha-dinamica"

#: Espera mínima entre duas buscas ao painel, em segundos. A tela renova a
#: sessão de tempos em tempos; cada renovação não precisa virar uma ida à rede.
INTERVALO_MINIMO_S = 60.0

#: Uma falha de rede no painel não pode bloquear a próxima tentativa: noutro
#: PC, DNS/TLS/proxy podem falhar na primeira abertura e voltar no segundo
#: seguinte. O throttle de 60 s vale apenas quando já existe chave válida;
#: sem chave, o LizProxy atual não aceita o access token puro e devolve 401.
FALHAS_DE_REDE = ("ConnectError", "ConnectTimeout", "ReadTimeout", "WriteTimeout",
                  "PoolTimeout", "ProtocolError", "NetworkError", "TimeoutException")

_trava = threading.Lock()
_ultima_busca = 0.0
#: Cache de leitura por mtime: (mtime) -> (senha, validade). A validade é
#: conferida a cada chamada — o arquivo não muda quando a senha expira.
_cache: dict[float, tuple[str, datetime | None]] = {}
#: Onde está o binário do host, resolvido uma vez (usado para achar o lugar
#: padrão do JSON quando o ambiente não aponta um).
_binario_do_host_cache: Path | None = None
_binario_resolvido = False


def _binario_do_host() -> Path | None:
    """O `c-host.exe` desta máquina, pela mesma regra do `host_boot`."""
    global _binario_do_host_cache, _binario_resolvido
    if not _binario_resolvido:
        from .providers import host_boot  # tardio: providers importa este módulo

        _binario_do_host_cache = host_boot._binario()
        _binario_resolvido = True
    return _binario_do_host_cache


def _agora() -> datetime:
    return datetime.now(timezone.utc)


def caminho(settings: "Settings") -> Path:
    """Onde a senha do dia mora nesta máquina.

    A ordem é a mesma dos dois lados, e é isso que importa: o shell passa
    `KODA_DYNAMIC_KEY_FILE` (é ele que sobe o host, e os dois precisam
    concordar); sem ela, o arquivo mora **ao lado do binário do host** — o
    mesmo lugar que o host procura quando o ambiente não diz nada, então um
    app instalado funciona sem o launcher novo. Sem binário achado (checkout
    sem `host/`), cai ao lado do banco.
    """
    if settings.dynamic_key_file:
        return Path(settings.dynamic_key_file)
    binario = _binario_do_host()
    if binario is not None:
        return binario.parent / NOME_DO_ARQUIVO
    return settings.database_path.parent / NOME_DO_ARQUIVO


def _prazo(valor: Any) -> datetime | None:
    """A validade do JSON, ou `None` quando não vem (aí a senha não expira)."""
    texto = str(valor or "").strip()
    if not texto:
        return None
    try:
        quando = datetime.fromisoformat(texto.replace("Z", "+00:00"))
    except ValueError:
        return None
    return quando if quando.tzinfo else quando.replace(tzinfo=timezone.utc)


def vigente(settings: "Settings") -> str | None:
    """A senha do dia se ainda vale, ou `None` (sem arquivo, sem senha, expirada)."""
    try:
        arquivo = caminho(settings)
        estado = arquivo.stat()
    except OSError:
        return None
    with _trava:
        par = _cache.get(estado.st_mtime)
        if par is None:
            try:
                dados = json.loads(arquivo.read_text(encoding="utf-8"))
                par = (str(dados.get("senha") or "").strip(), _prazo(dados.get("validade")))
            except (OSError, ValueError):
                par = ("", None)
            _cache.clear()
            _cache[estado.st_mtime] = par
    senha, validade = par
    if not senha:
        return None
    if validade is not None and validade <= _agora():
        return None
    return senha


def _gravar(arquivo: Path, documento: dict[str, Any]) -> bool:
    """Escreve atômico: o host lê o arquivo a qualquer momento, e um arquivo
    pela metade não pode ser lido como senha nova."""
    try:
        arquivo.parent.mkdir(parents=True, exist_ok=True)
        temporario = arquivo.with_name(arquivo.name + ".tmp")
        temporario.write_text(json.dumps(documento, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporario, arquivo)
    except OSError:
        return False
    return True


def atualizar(settings: "Settings", token: str) -> bool:
    """Busca a senha do dia no painel e grava o JSON. `True` quando gravou.

    Devolve `False` em falha de rede ou do painel sem derrubar o login: quem
    chama está no caminho de escolher o provider e a sessão da conta continua
    valendo. Sem senha vigente, a busca pode ser repetida imediatamente: o
    LizProxy atual não aceita access token puro, então esperar 60 s com o
    arquivo ausente deixaria o chat preso no 401 depois de uma oscilação.
    """
    global _ultima_busca
    token = (token or "").strip()
    if not token or not settings.cloud_url:
        return False
    # A leitura vem **antes** da trava: `vigente` também a usa, e um Lock não
    # é reentrante — chamá-la aqui dentro seria deadlock (a segunda tentativa
    # travaria para sempre, com o arquivo já gravado).
    precisa = vigente(settings) is None
    with _trava:
        agora = time.monotonic()
        # Sem chave válida, a espera não pode ser aplicada: o login faz três
        # tentativas seguidas para vencer uma oscilação de rede e a rotação
        # diária não pode esperar cinco segundos com o LizProxy devolvendo 401.
        # O intervalo de 60 s continua protegendo a renovação com chave válida.
        if not precisa and agora - _ultima_busca < INTERVALO_MINIMO_S:
            return False
        _ultima_busca = agora

    url = settings.cloud_url.rstrip("/") + ROTA_NO_PAINEL
    try:
        resposta = httpx.get(
            url,
            headers={"Authorization": f"Bearer {token}"},
            timeout=settings.cloud_timeout_s,
            follow_redirects=False,
        )
    except httpx.HTTPError as erro:
        if type(erro).__name__ in FALHAS_DE_REDE:
            with _trava:
                _ultima_busca = 0.0
        # Loga só a categoria: nunca URL com query, token, corpo ou chave.
        logging.getLogger(__name__).warning("senha_dinamica_rede_indisponivel tipo=%s", type(erro).__name__)
        return False
    if resposta.status_code != 200:
        logging.getLogger(__name__).warning("senha_dinamica_painel_recusou status=%d", resposta.status_code)
        return False
    try:
        dados = resposta.json()
        senha = str(dados.get("senha") or "").strip()
        if not senha:
            return False
        documento = {
            "formato": str(dados.get("formato") or "koda-host-dinamica-v1"),
            "senha": senha,
            "girada": str(dados.get("girada") or ""),
            "validade": str(dados.get("validade") or ""),
            "painel": settings.cloud_url.rstrip("/"),
        }
    except (AttributeError, TypeError, ValueError):
        return False
    return _gravar(caminho(settings), documento)


def garantir(settings: "Settings") -> None:
    """Chamada na reescolha do provider: se a senha do dia está faltando ou
    expirou e tem gente logada, busca agora."""
    from . import host_auth  # import tardio: host_auth usa este módulo

    token = host_auth.atual()
    if token:
        atualizar(settings, token)


def esquecer(settings: "Settings") -> None:
    """Apaga a senha da máquina — sair da conta desliga a credencial dinâmica."""
    try:
        caminho(settings).unlink()
    except OSError:
        pass
