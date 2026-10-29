"""A credencial que o backend apresenta ao host dos modelos.

O app não guarda chave de API nenhuma. O que ele apresenta é a **sessão da conta** que
está logada: o mesmo access token que o painel emitiu, com prazo curto. O host repassa esse
valor ao painel (`/api/public/host/authorize`), o painel responde se a conta existe, está
ativa e a sessão está viva — e só então o modelo responde. Banir alguém no painel derruba
o acesso ao modelo, não só o login.

Vive **em memória**, e isso é decisão, não descuido:

* não vai para o disco — fechar o app não deixa credencial para trás;
* não vai para log, nem para arquivo de configuração, nem para o instalador: não existe
  chave de API no código do Koda para alguém extrair;
* some quando a conta sai, e aí o host volta a recusar.

Quem escreve aqui é a rota `/api/host/sessao`, chamada pelo front depois de entrar e a cada
renovação da sessão (o token de acesso vence em minutos; o host guarda um "sim" por até dez
minutos, então uma renovação por ciclo basta).
"""

from __future__ import annotations

from typing import TYPE_CHECKING
from contextvars import ContextVar
from dataclasses import dataclass
from threading import RLock


@dataclass(frozen=True)
class RequestContext:
    window: str = "desktop"
    token: str | None = None
    nome: str | None = None
    email: str | None = None
    account_id: str | None = None


_context: ContextVar[RequestContext | None] = ContextVar("koda_request", default=None)
_sessions: dict[str, RequestContext] = {}
_lock = RLock()


def capturar(window: str) -> RequestContext:
    with _lock:
        return _sessions.get(window, RequestContext(window=window))


def vincular(context: RequestContext):
    return _context.set(context)


def desvincular(token) -> None:
    _context.reset(token)


def contexto_atual() -> RequestContext:
    return _context.get() or RequestContext(token=_sessao, nome=(_conta or (None, None))[0],
                                          email=(_conta or (None, None))[1])


def proprietario() -> str:
    # Conta validada pela nuvem. Dados locais sem conta pertencem ao perfil local;
    # linhas legadas ambíguas permanecem NULL e não ficam visíveis por acidente.
    context = contexto_atual()
    return ("account:" + context.account_id) if context.account_id else (context.email or "local:desktop")

if TYPE_CHECKING:  # pragma: no cover - só para o tipo
    from .config import Settings

_sessao: str | None = None
#: Quem a sessão identifica, quando o front informa: (nome, e-mail).
_conta: tuple[str | None, str | None] | None = None


def definir(
    token: str | None, *, nome: str | None = None, email: str | None = None,
    account_id: str | None = None,
) -> None:
    """Guarda a sessão atual: a credencial e quem ela identifica.

    Vazio, só espaços ou `None` limpam tudo — credencial e identidade. Assim, sair da conta
    apaga as duas coisas de uma vez, em vez de deixar o assistente cumprimentando alguém
    que já saiu.
    """
    global _sessao, _conta
    limpo = (token or "").strip()
    current = _context.get()
    if current is not None:
        updated = RequestContext(window=current.window, token=limpo or None,
                                 nome=(nome or "").strip() or None if limpo else None,
                                 email=(email or "").strip().casefold() or None if limpo else None,
                                 account_id=account_id if limpo else None)
        with _lock:
            _sessions[current.window] = updated
        _context.set(updated)
        return
    _sessao = limpo or None
    if _sessao is None:
        _conta = None
    else:
        _conta = ((nome or "").strip() or None, (email or "").strip() or None)


def atual() -> str | None:
    """A sessão em vigor, ou `None` quando não há conta logada."""
    return contexto_atual().token


def limpar() -> None:
    definir(None)


def rotulo_da_conta() -> str | None:
    """Como chamar quem está logado: `Nome (email)`, ou só o que existir.

    Quem lê isto é o prompt de sistema, para o assistente saber com quem está falando. Sem
    conta (ou sem nome e e-mail informados) devolve `None`, e o prompt não ganha linha
    nenhuma sobre identidade.
    """
    context = contexto_atual()
    nome, email = context.nome, context.email
    if nome and email:
        return f"{nome} ({email})"
    return nome or email


def email_da_conta() -> str | None:
    """O e-mail de quem está logado — a **chave** com que o uso é separado por conta.

    É o que faz o tempo do dia e as moedas pertencerem à **conta**, e não à máquina: sem
    isto, trocar de conta no mesmo PC continuava mostrando o que a anterior tinha gasto.
    `None` quando não há conta (ou o front não informou o e-mail) — quem grava o uso marca
    a linha como «conta desconhecida», e a leitura por conta simplesmente não a alcança.
    """
    return contexto_atual().email


def credencial(settings: Settings) -> str:
    """O que apresentar ao host, em uma linha.

    A **senha dinâmica do dia** manda quando existe: o painel entregou, o host
    autoriza localmente, e nada disso depende de o painel estar de pé agora. Sem
    ela (ninguém logado, painel não entregou, ou já expirou), vale a sessão da
    conta — o caminho normal, que o painel revalida a cada chave nova. A chave
    de serviço (`KODA_HOST_KEY`) fica como alternativa de quem opera a máquina.
    Sem nada, devolve vazio e o `Authorization` não vai.
    """
    from . import host_dinamica  # import tardio: host_dinamica usa host_auth

    return (host_dinamica.vigente(settings) or atual() or settings.host_key or "").strip()
