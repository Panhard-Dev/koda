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

if TYPE_CHECKING:  # pragma: no cover - só para o tipo
    from .config import Settings

_sessao: str | None = None
#: Quem a sessão identifica, quando o front informa: (nome, e-mail).
_conta: tuple[str | None, str | None] | None = None


def definir(
    token: str | None, *, nome: str | None = None, email: str | None = None
) -> None:
    """Guarda a sessão atual: a credencial e quem ela identifica.

    Vazio, só espaços ou `None` limpam tudo — credencial e identidade. Assim, sair da conta
    apaga as duas coisas de uma vez, em vez de deixar o assistente cumprimentando alguém
    que já saiu.
    """
    global _sessao, _conta
    limpo = (token or "").strip()
    _sessao = limpo or None
    if _sessao is None:
        _conta = None
    else:
        _conta = ((nome or "").strip() or None, (email or "").strip() or None)


def atual() -> str | None:
    """A sessão em vigor, ou `None` quando não há conta logada."""
    return _sessao


def limpar() -> None:
    definir(None)


def rotulo_da_conta() -> str | None:
    """Como chamar quem está logado: `Nome (email)`, ou só o que existir.

    Quem lê isto é o prompt de sistema, para o assistente saber com quem está falando. Sem
    conta (ou sem nome e e-mail informados) devolve `None`, e o prompt não ganha linha
    nenhuma sobre identidade.
    """
    if _conta is None:
        return None
    nome, email = _conta
    if nome and email:
        return f"{nome} ({email})"
    return nome or email


def credencial(settings: Settings) -> str:
    """O que apresentar ao host, em uma linha.

    A sessão da conta manda: é ela que prova quem está logado, e é o caminho normal do
    app. A chave de serviço (`KODA_HOST_KEY`) fica como alternativa de quem opera a
    máquina — ela não existe no código nem no instalador, só no ambiente de quem a
    configurou. Sem nada, devolve vazio e o `Authorization` não vai.
    """
    return (atual() or settings.host_key or "").strip()
