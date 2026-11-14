"""
Rotas do koda-link vistas pelo app do PC.

Elas fazem três coisas:

1. sobem o servidor de link **dentro do backend**, para o modo "mesma Wi-Fi";
2. criam a sala e devolvem o QR que o celular lê;
3. no modo "de qualquer lugar", mantêm o PC conectado de saída ao servidor
   de link que o dono subiu (VPS, Raspberry Pi, Tailscale…).

O token da API local nunca entra no QR nem vai para o servidor de link.
"""

from __future__ import annotations

import asyncio
import atexit
import base64
import importlib.util
import io
import json
import logging
import secrets
import socket
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import uvicorn
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .. import seguranca
from ..remoto import ClienteRemoto
from ..tunel import TunelCloudflare

router = APIRouter(tags=["remoto"])

RAIZ = Path(__file__).resolve().parents[3]
CAMINHO_DO_LINK = RAIZ / "link" / "server.py"


class LinkLocalPedido(BaseModel):
    porta: int = Field(default=8798, ge=1024, le=65535)


class SalaPedido(BaseModel):
    """`link` vazio = servidor local; preenchido = servidor próprio do dono."""

    link: str | None = None
    token: str | None = None


class ConectarPedido(BaseModel):
    link: str
    sala: str
    segredo: str


class AbrirTunelPedido(BaseModel):
    """`forcar` só no botão «Novo QR»; reabrir a tela reaproveita o túnel vivo."""

    forcar: bool = False


class RedePedido(BaseModel):
    """Liga/desliga o «modo rede local»: o celular acha o PC sozinho na Wi-Fi."""

    ativo: bool = True


@dataclass
class Estado:
    servidor: Any = None
    modulo: Any = None
    thread: threading.Thread | None = None
    porta: int | None = None
    ip: str | None = None
    cliente: ClienteRemoto | None = None
    ultima_sala: dict[str, str] | None = None
    #: Modo rede local ligado: a porta 8798 aceita o pareamento sem QR/chave.
    rede: bool = False


@dataclass
class SessaoTunel:
    """Um QR público: porta própria, link próprio, túnel próprio."""

    porta: int
    servidor: Any
    thread: threading.Thread
    tunel: TunelCloudflare
    modulo: Any
    admin: str
    sala: dict[str, Any]
    criada: float

    def viva(self) -> bool:
        """Confere todas as partes, não só o processo do Cloudflare."""
        if (
            not getattr(self.servidor, "started", False)
            or not self.thread.is_alive()
            or not self.tunel.vivo
        ):
            return False
        try:
            with socket.create_connection(("127.0.0.1", self.porta), timeout=0.2):
                return True
        except OSError:
            return False


_estado = Estado()
_tunel: SessaoTunel | None = None
_tarefa_tunel: asyncio.Task[SessaoTunel] | None = None
_trava_tunel = asyncio.Lock()

#: Onde o interruptor «entrada pela rede local» é lembrado entre execuções.
_ARQUIVO_REDE: Path | None = None

_log = logging.getLogger(__name__)


def configurar(pasta: Path) -> None:
    """Aponta a preferência persistida para a pasta de dados do app e a lê."""
    global _ARQUIVO_REDE
    _ARQUIVO_REDE = pasta / "rede-local.json"
    _estado.rede = _ler_rede_salva()


def _ler_rede_salva() -> bool:
    if _ARQUIVO_REDE is None:
        return False
    try:
        dados = json.loads(_ARQUIVO_REDE.read_text("utf-8"))
    except (OSError, ValueError):
        return False
    return bool(dados.get("ativo"))


def _salvar_rede(ativo: bool) -> None:
    if _ARQUIVO_REDE is None:
        return
    try:
        _ARQUIVO_REDE.parent.mkdir(parents=True, exist_ok=True)
        _ARQUIVO_REDE.write_text(json.dumps({"ativo": ativo}), "utf-8")
    except OSError:
        # Sem disco para a preferência: o interruptor vale só nesta execução.
        pass


def _ip_local() -> str:
    """O IP que o celular usa na Wi-Fi — não o 127.0.0.1 do próprio PC."""
    soquete = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        soquete.connect(("8.8.8.8", 80))
        return soquete.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        soquete.close()


def _carregar_servidor() -> Any:
    if not CAMINHO_DO_LINK.exists():
        raise HTTPException(status_code=500, detail="o servidor do link não está nesta build")
    spec = importlib.util.spec_from_file_location("koda_link_server", CAMINHO_DO_LINK)
    if spec is None or spec.loader is None:
        raise HTTPException(status_code=500, detail="não consegui carregar o servidor do link")
    modulo = importlib.util.module_from_spec(spec)
    sys.modules["koda_link_server"] = modulo
    spec.loader.exec_module(modulo)
    return modulo


def _estado_publico() -> dict[str, Any]:
    rodando = _estado.servidor is not None and bool(getattr(_estado.servidor, "started", False))
    tunel_vivo = _tunel is not None and _tunel.viva()
    return {
        "link": {
            "rodando": rodando,
            "porta": _estado.porta,
            "ip": _estado.ip,
            "url": f"http://{_estado.ip}:{_estado.porta}" if rodando else None,
            # O celular acha o PC sozinho enquanto isto estiver ligado.
            "rede_local": bool(_estado.rede),
        },
        "tunel": {
            "aberto": tunel_vivo,
            "porta": _tunel.porta if tunel_vivo and _tunel is not None else None,
            "public_url": _tunel.tunel.url if tunel_vivo and _tunel is not None else None,
            "sala": _tunel.sala.get("sala") if tunel_vivo and _tunel is not None else None,
            "desde": _tunel.criada if tunel_vivo and _tunel is not None else None,
        },
        "cliente": _estado.cliente.estado() if _estado.cliente is not None else None,
    }


def _parar_servidor() -> None:
    if _estado.servidor is not None:
        _estado.servidor.should_exit = True
        if _estado.thread is not None:
            _estado.thread.join(timeout=5)
    _estado.servidor = None
    _estado.modulo = None
    _estado.thread = None
    _estado.porta = None
    _estado.ip = None


def _subir_servidor(porta: int, porta_do_backend: int) -> dict[str, Any]:
    if _estado.servidor is not None and _estado.porta == porta:
        return _estado_publico()

    _parar_servidor()
    modulo = _carregar_servidor()
    ip = _ip_local()
    modulo.API_URL = f"http://127.0.0.1:{porta_do_backend}"
    modulo.API_TOKEN = seguranca.token() or ""
    modulo.PUBLIC_URL = f"http://{ip}:{porta}"
    # O modo rede local é decisão do PC, e não do arquivo: só vale enquanto o
    # interruptor estiver ligado na tela do celular.
    modulo.REDE_LOCAL = bool(_estado.rede)
    # O celular lê esta porta no `/api/rede`: quando a 8798 está ocupada, o link
    # sobe numa vizinha e é este número que passa a valer para ele.
    modulo.PORTA = porta
    _estado.modulo = modulo

    config = uvicorn.Config(
        modulo.app,
        host="0.0.0.0",
        port=porta,
        log_level="warning",
        access_log=False,
    )
    servidor = uvicorn.Server(config)
    thread = threading.Thread(target=servidor.run, name="koda-link", daemon=True)
    thread.start()

    limite = time.monotonic() + 8.0
    while time.monotonic() < limite:
        if getattr(servidor, "started", False):
            _estado.servidor = servidor
            _estado.thread = thread
            _estado.porta = porta
            _estado.ip = ip
            return _estado_publico()
        if not thread.is_alive():
            break
        time.sleep(0.05)

    servidor.should_exit = True
    thread.join(timeout=2)
    raise HTTPException(
        status_code=409,
        detail=f"não consegui abrir a porta {porta}; ela pode estar ocupada",
    )


def _porta_livre() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as soquete:
        soquete.bind(("127.0.0.1", 0))
        return int(soquete.getsockname()[1])


def _subir_servidor_preferindo(porta: int, porta_do_backend: int) -> dict[str, Any]:
    """Sobe o link na porta pedida; se ela estiver ocupada, numa vizinha livre.

    A 8798 é a que o celular procura sozinho na Wi-Fi, então continua sendo a
    primeira escolha. Mas porta fixa em máquina que não é nossa é aposta: uma
    execução anterior, outro programa ou o TIME_WAIT do sistema deixavam a tela
    com «não consegui abrir a porta 8798». Aqui o link anda para a porta livre
    seguinte — o QR e o `/api/rede` levam o número real, e o celular usa ele.
    """
    ultimo: HTTPException | None = None
    for tentativa in range(porta, porta + 13):
        try:
            return _subir_servidor(tentativa, porta_do_backend)
        except HTTPException as erro:
            if erro.status_code != 409:
                raise
            ultimo = erro
    if ultimo is not None:
        raise ultimo
    raise HTTPException(status_code=409, detail="não consegui abrir o servidor do link")


def _porta_do_backend() -> int:
    """A porta em que este backend atende — o `--port` que o launcher passa ao uvicorn."""
    argumentos = sys.argv
    for indice, argumento in enumerate(argumentos):
        if argumento == "--port" and indice + 1 < len(argumentos):
            try:
                return int(argumentos[indice + 1])
            except ValueError:
                break
        if argumento.startswith("--port="):
            try:
                return int(argumento.split("=", 1)[1])
            except ValueError:
                break
    return 8787


def iniciar_rede_salva() -> None:
    """Sobe o link na 8798 quando a pessoa deixou a entrada pela rede ligada.

    Roda numa thread: abrir porta e esperar o uvicorn não pode atrasar a subida
    do app. Sem isto, o interruptor «ligado» esquecia a porta fechada depois de
    reiniciar, e o celular não achava mais o PC.
    """
    if not _estado.rede:
        return
    try:
        _subir_servidor_preferindo(8798, _porta_do_backend())
    except HTTPException:
        # Porta ocupada: a tela do Celular mostra o erro quando a pessoa abrir.
        pass
    except Exception:
        _log.exception("link_rede_salva_failed")


async def _subir_link_publico(porta_do_backend: int) -> SessaoTunel:
    """Uma porta nova, um link novo, um túnel novo — por QR.

    A porta escuta só em 127.0.0.1. Quem chega de fora é o Cloudflare, e ele
    encontra uma instância do link que só conhece esta sala e só aceita as
    rotas da lista fechada.
    """
    porta = _porta_livre()
    admin = secrets.token_urlsafe(32)
    modulo = _carregar_servidor()
    modulo.API_URL = f"http://127.0.0.1:{porta_do_backend}"
    modulo.API_TOKEN = seguranca.token() or ""
    modulo.SO_PUBLICO = True
    modulo.TTL = 0  # fica aberto até o dono fechar
    # O túnel é público: o pareamento sem chave nunca vale por ele.
    modulo.REDE_LOCAL = False
    modulo.LINK_TOKEN = admin
    modulo.PUBLIC_URL = ""

    config = uvicorn.Config(
        modulo.app,
        host="127.0.0.1",
        port=porta,
        log_level="warning",
        access_log=False,
    )
    servidor = uvicorn.Server(config)
    thread = threading.Thread(target=servidor.run, name=f"koda-link-{porta}", daemon=True)
    thread.start()

    limite = time.monotonic() + 8.0
    while time.monotonic() < limite:
        if getattr(servidor, "started", False):
            break
        if not thread.is_alive():
            break
        await asyncio.sleep(0.05)
    if not getattr(servidor, "started", False):
        servidor.should_exit = True
        thread.join(timeout=2)
        raise HTTPException(status_code=409, detail="não consegui abrir a porta local do link")

    tunel = TunelCloudflare(porta)
    try:
        publico = await tunel.abrir()
        modulo.PUBLIC_URL = publico
        sala = await _pedir_sala(f"http://127.0.0.1:{porta}", admin)
    except asyncio.CancelledError:
        tunel.matar_agora()
        servidor.should_exit = True
        thread.join(timeout=2)
        raise
    except Exception:
        await tunel.parar()
        servidor.should_exit = True
        thread.join(timeout=3)
        raise

    return SessaoTunel(
        porta=porta,
        servidor=servidor,
        thread=thread,
        tunel=tunel,
        modulo=modulo,
        admin=admin,
        sala=sala,
        criada=time.time(),
    )


async def _parar_sessao(sessao: SessaoTunel) -> None:
    await sessao.tunel.parar()
    sessao.servidor.should_exit = True
    await asyncio.to_thread(sessao.thread.join, 5)


async def _abrir_e_guardar_tunel(porta_do_backend: int, forcar: bool) -> SessaoTunel:
    """Executa a abertura numa tarefa que sobrevive à desconexão da tela."""
    global _tunel
    async with _trava_tunel:
        if _tunel is not None and _tunel.viva() and not forcar:
            # «Registered tunnel connection» e socket local não provam que a URL
            # pública ainda atravessa o edge: ela pode ter começado a devolver
            # 1033 depois que o QR apareceu. Só reaproveita a sala se o health
            # público continuar respondendo pelo link do Koda.
            try:
                await _tunel.tunel.confirmar_publico(tentativas=2)
            except (RuntimeError, httpx.HTTPError):
                await _parar_sessao(_tunel)
                _tunel = None
            else:
                return _tunel
        if _tunel is not None:
            await _parar_sessao(_tunel)
            _tunel = None
        sessao = await _subir_link_publico(porta_do_backend)
        _tunel = sessao
        return sessao


def _limpar_tarefa_tunel(tarefa: asyncio.Task[SessaoTunel]) -> None:
    global _tarefa_tunel
    if _tarefa_tunel is tarefa:
        _tarefa_tunel = None
    if not tarefa.cancelled():
        # Consome a exceção mesmo quando a requisição foi cancelada.
        try:
            tarefa.exception()
        except (asyncio.CancelledError, Exception):
            pass


async def _sessao_para_abrir(porta_do_backend: int, forcar: bool) -> SessaoTunel:
    """Compartilha uma única abertura e não a cancela quando o frontend sai."""
    global _tarefa_tunel
    async with _trava_tunel:
        if _tunel is not None and _tunel.viva() and not forcar:
            return _tunel
        tarefa = _tarefa_tunel
        if tarefa is None or tarefa.done():
            tarefa = asyncio.create_task(
                _abrir_e_guardar_tunel(porta_do_backend, forcar),
                name="koda-cloudflare-open",
            )
            _tarefa_tunel = tarefa
            tarefa.add_done_callback(_limpar_tarefa_tunel)
    return await asyncio.shield(tarefa)


def _encerrar_agora() -> None:
    """Rede de segurança do `atexit`: não deixa o cloudflared órfão."""
    sessao = _tunel
    if sessao is None:
        return
    sessao.tunel.matar_agora()
    sessao.servidor.should_exit = True


atexit.register(_encerrar_agora)


def _qr_svg(texto: str) -> str | None:
    """QR em SVG, embutido como `data:` para o `<img>` da tela.

    O `qrcode` é puro Python e já vem no sistema em muitas distribuições. Se não
    estiver, a tela mostra o link e o código — o pareamento continua funcionando.
    """
    try:
        import qrcode  # type: ignore[import-not-found]
        import qrcode.image.svg  # type: ignore[import-not-found]
    except ImportError:
        caminho_do_sistema = "/usr/lib/python3/dist-packages"
        if caminho_do_sistema not in sys.path:
            sys.path.append(caminho_do_sistema)
        try:
            import qrcode  # type: ignore[import-not-found]
            import qrcode.image.svg  # type: ignore[import-not-found]
        except ImportError:
            return None
    imagem = qrcode.make(texto, image_factory=qrcode.image.svg.SvgPathImage)
    buffer = io.BytesIO()
    imagem.save(buffer)
    return "data:image/svg+xml;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


async def _pedir_sala(base: str, token: str | None) -> dict[str, Any]:
    cabecalhos = {"authorization": f"Bearer {token}"} if token else {}
    try:
        async with httpx.AsyncClient(timeout=10.0) as cliente:
            resposta = await cliente.post(f"{base.rstrip('/')}/api/salas", headers=cabecalhos)
            resposta.raise_for_status()
            dados = resposta.json()
    except httpx.HTTPError as erro:
        raise HTTPException(status_code=502, detail=f"o servidor de link não respondeu: {erro}") from erro
    if not isinstance(dados, dict) or "url" not in dados:
        raise HTTPException(status_code=502, detail="o servidor de link devolveu uma sala inválida")
    dados["qr"] = _qr_svg(str(dados["url"]))
    return dados


async def _estado_da_sala(base: str, token: str | None, sala: str) -> dict[str, Any]:
    cabecalhos = {"authorization": f"Bearer {token}"} if token else {}
    try:
        async with httpx.AsyncClient(timeout=5.0) as cliente:
            resposta = await cliente.get(
                f"{base.rstrip('/')}/api/salas/{sala}", headers=cabecalhos
            )
            resposta.raise_for_status()
            dados = resposta.json()
    except httpx.HTTPError as erro:
        raise HTTPException(status_code=502, detail=f"o servidor de link não respondeu: {erro}") from erro
    return dados if isinstance(dados, dict) else {}


@router.get("/remoto/estado")
async def estado() -> dict[str, Any]:
    return _estado_publico()


@router.post("/remoto/link/iniciar")
async def iniciar_link_local(dados: LinkLocalPedido, request: Request) -> dict[str, Any]:
    porta_do_backend = request.url.port or 8787
    return _subir_servidor_preferindo(dados.porta, porta_do_backend)


@router.post("/remoto/link/parar")
async def parar_link_local() -> dict[str, Any]:
    _parar_servidor()
    return _estado_publico()


@router.post("/remoto/rede")
async def definir_rede_local(dados: RedePedido, request: Request) -> dict[str, Any]:
    """Liga o «modo rede local»: o celular acha este PC na Wi-Fi sem QR nem chave.

    Enquanto estiver ligado, qualquer aparelho da mesma rede entra no Koda — é o
    preço de não pedir chave. Por isso o padrão é desligado, o endereço só atende
    IP privado e o interruptor fica visível na tela do celular.
    """
    _estado.rede = dados.ativo
    # A escolha sobrevive ao reinício: o celular precisa achar o PC na próxima
    # abertura do app, sem alguém ter de religar o interruptor toda vez.
    _salvar_rede(_estado.rede)
    if dados.ativo:
        if _estado.servidor is None or not getattr(_estado.servidor, "started", False):
            _subir_servidor_preferindo(8798, request.url.port or 8787)
        if _estado.modulo is not None:
            _estado.modulo.REDE_LOCAL = True
    elif _estado.modulo is not None:
        _estado.modulo.REDE_LOCAL = False
    return _estado_publico()


@router.post("/remoto/tunel/abrir")
async def abrir_tunel(
    request: Request, dados: AbrirTunelPedido | None = None
) -> dict[str, Any]:
    """Abre o QR público; sem `forcar`, reaproveita o túnel que já está vivo.

    Rotacionar a cada abertura de tela matava o QR que o celular acabou de
    escanear. O botão «Novo QR» manda `forcar: true` e só ele gira a sala.
    """
    sessao = await _sessao_para_abrir(
        request.url.port or 8787,
        bool(dados and dados.forcar),
    )
    return {
        **sessao.sala,
        "modo": "tunel",
        "porta": sessao.porta,
        "public_url": sessao.tunel.url,
        "expira_em": 0,
    }


@router.post("/remoto/tunel/fechar")
async def fechar_tunel() -> dict[str, Any]:
    global _tunel
    async with _trava_tunel:
        if _tunel is not None:
            await _parar_sessao(_tunel)
            _tunel = None
    return _estado_publico()


@router.get("/remoto/tunel/sala/{sala}")
async def estado_da_sala_do_tunel(sala: str) -> dict[str, Any]:
    sessao = _tunel
    if sessao is None or sessao.sala.get("sala") != sala:
        raise HTTPException(status_code=404, detail="sala do túnel desconhecida")
    return await _estado_da_sala(f"http://127.0.0.1:{sessao.porta}", sessao.admin, sala)


@router.post("/remoto/sala")
async def criar_sala(dados: SalaPedido, request: Request) -> dict[str, Any]:
    if dados.link:
        base = dados.link.rstrip("/")
        token = dados.token or None
    else:
        if _estado.servidor is None or not getattr(_estado.servidor, "started", False):
            _subir_servidor_preferindo(8798, request.url.port or 8787)
        base = f"http://127.0.0.1:{_estado.porta}"
        token = None

    sala = await _pedir_sala(base, token)
    _estado.ultima_sala = {
        "sala": str(sala.get("sala", "")),
        "link": base,
        "token": token or "",
    }
    return sala


@router.get("/remoto/sala/{sala}")
async def estado_da_sala(sala: str) -> dict[str, Any]:
    if _tunel is not None and _tunel.sala.get("sala") == sala:
        return await _estado_da_sala(f"http://127.0.0.1:{_tunel.porta}", _tunel.admin, sala)
    contexto = _estado.ultima_sala
    if not contexto or contexto.get("sala") != sala:
        raise HTTPException(status_code=404, detail="sala desconhecida")
    return await _estado_da_sala(contexto["link"], contexto.get("token") or None, sala)


@router.post("/remoto/conectar")
async def conectar(dados: ConectarPedido, request: Request) -> dict[str, Any]:
    if _estado.cliente is not None:
        await _estado.cliente.parar()
    cliente = ClienteRemoto(
        dados.link,
        dados.sala,
        dados.segredo,
        api_url=f"http://127.0.0.1:{request.url.port or 8787}",
        api_token=seguranca.token() or "",
    )
    _estado.cliente = cliente
    await cliente.iniciar()
    return cliente.estado()


@router.post("/remoto/desconectar")
async def desconectar() -> dict[str, Any]:
    if _estado.cliente is not None:
        estado_do_cliente = await _estado.cliente.parar()
        _estado.cliente = None
        return estado_do_cliente
    return {}
