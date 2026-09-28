"""Ponte com o backend na nuvem do Koda (Koda Cloud).

O serviço na nuvem é um extra do app: aviso de atualização, changelog e o catálogo
publicado. O Koda continua inteiro sem ele — nenhuma falha da nuvem pode derrubar a
requisição que chamou, e por isso aqui tudo devolve `None` em vez de levantar.

O que vale para toda chamada:

* HTTPS obrigatório (só endereço local escapa, e a configuração é quem decide);
* sem redirecionamento: um 302 para outro host não é seguido, então a nuvem não
  consegue empurrar o app para um endereço arbitrário;
* timeout curto e corpo com teto — serviço lento ou resposta gigante não travam a tela;
* a resposta passa por validação antes de chegar na interface, e um campo que o app não
  sabe usar (link de download fora do HTTPS ou de domínio não permitido) é descartado;
* o token, quando existe, viaja só no cabeçalho `Authorization` — nunca na URL, nunca em
  mensagem de erro, nunca no log.
"""

from __future__ import annotations

import time
from typing import Any
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError

from . import __version__
from .config import Settings

USER_AGENT = "Koda/1.0 (+backend)"
"""Identifica o app no serviço. Não carrega versão de build nem identificador de máquina."""

LIMITE_CORPO = 256 * 1024
"""Teto do corpo aceito da nuvem. Acima disso a resposta é descartada sem ser lida."""

VALIDADE_S = 900.0
"""Quanto tempo um resultado **bom** vale antes de consultar de novo."""

VALIDADE_ERRO_S = 15.0
"""Quanto tempo uma falha fica guardada antes de tentar outra vez.

Curta de propósito. Guardar a falha pelo mesmo prazo do acerto deixava a tela dizendo
"sem resposta" por 15 minutos depois de um tropeço de rede — e um tropeço desses acontece
justamente quando o painel está sendo publicado, que foi como a tela ficou presa assim.
"""

ERRO_GENERICO = "serviço indisponível"
"""A mensagem que sai daqui. Nada de detalhe de rede, de endereço ou de token."""


class Atualizacao(BaseModel):
    """O que a nuvem responde em `/api/public/version`."""

    model_config = ConfigDict(extra="ignore")

    update_available: bool = False
    latest_version: str | None = None
    download_url: str | None = None
    update_required: bool = False
    mandatory: bool = False
    channel: str = "stable"
    notes: str | None = None
    published_at: str | None = None
    checked_version: str | None = None


class Estado(BaseModel):
    """Estado da nuvem, para a interface mostrar (ou esconder) o aviso de atualização."""

    ativo: bool = False
    """Existe endereço configurado?"""
    disponivel: bool = False
    """A última consulta funcionou?"""
    canal: str = "stable"
    atualizado_em: float | None = None
    erro: str | None = None
    atualizacao: Atualizacao | None = None

    @property
    def tem_atualizacao(self) -> bool:
        return bool(self.atualizacao and self.atualizacao.update_available)


def link_seguro(url: str, permitidos: list[str] | None = None) -> bool:
    """O app pode mandar o usuário para esse link?

    Exige HTTPS, host presente e nenhuma credencial embutida (`https://user:senha@host/…`
    é o truque clássico para esconder o destino real). Com domínios permitidos
    configurados, o host precisa bater com um deles ou ser subdomínio.
    """
    url = (url or "").strip()
    if not url:
        return False
    partes = urlsplit(url)
    if partes.scheme != "https" or not partes.hostname:
        return False
    if partes.username or partes.password:
        return False
    if permitidos:
        host = partes.hostname.lower()
        return any(host == item or host.endswith(f".{item}") for item in permitidos)
    return True


class ClienteNuvem:
    """Cliente HTTP da nuvem. Uma instância por aplicação."""

    def __init__(
        self,
        base: str,
        *,
        token: str | None = None,
        timeout_s: float = 5.0,
        canal: str = "stable",
        hosts_download: list[str] | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.base = (base or "").strip().rstrip("/")
        self.token = token or None
        self.timeout_s = timeout_s
        self.canal = canal
        self.hosts_download = list(hosts_download or [])
        #: Transporte do httpx. `None` = rede de verdade; os testes injetam um falso.
        self.transport = transport

    @property
    def ativo(self) -> bool:
        return bool(self.base)

    @property
    def host(self) -> str | None:
        """Só o host do serviço, para a tela mostrar o destino (nunca a URL inteira)."""
        return urlsplit(self.base).hostname or None

    async def _get(self, caminho: str, params: dict[str, str]) -> dict[str, Any] | None:
        """GET que nunca levanta: qualquer problema vira `None`."""
        if not self.ativo:
            return None
        cabecalhos = {"Accept": "application/json", "User-Agent": USER_AGENT}
        if self.token:
            cabecalhos["Authorization"] = f"Bearer {self.token}"
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(self.timeout_s),
                follow_redirects=False,
                transport=self.transport,
            ) as cliente:
                resposta = await cliente.get(f"{self.base}{caminho}", params=params, headers=cabecalhos)
            if resposta.status_code != 200:
                return None
            if len(resposta.content) > LIMITE_CORPO:
                return None
            dados = resposta.json()
        except (httpx.HTTPError, ValueError):
            return None
        return dados if isinstance(dados, dict) else None

    def _higienizar(self, atualizacao: Atualizacao) -> Atualizacao:
        """Descarta o que a interface não deve usar sem conferir."""
        url = (atualizacao.download_url or "").strip()
        if url and link_seguro(url, self.hosts_download):
            return atualizacao
        # O aviso continua de pé, mas o link não é oferecido.
        return atualizacao.model_copy(update={"download_url": None})

    async def checar_atualizacao(self, versao_local: str, canal: str | None = None) -> Atualizacao | None:
        dados = await self._get(
            "/api/public/version",
            {"versao": versao_local, "canal": canal or self.canal},
        )
        if dados is None:
            return None
        try:
            atualizacao = Atualizacao.model_validate(dados)
        except ValidationError:
            return None
        return self._higienizar(atualizacao)

    async def changelog(self, canal: str | None = None) -> list[dict[str, Any]]:
        dados = await self._get("/api/public/changelog", {"canal": canal or self.canal})
        if dados is None:
            return []
        itens = dados.get("releases")
        if not isinstance(itens, list):
            return []
        return [item for item in itens if isinstance(item, dict)]

    async def saude(self) -> bool:
        """A nuvem está de pé? Usado só pelo painel de diagnóstico."""
        return await self._get("/api/public/health", {}) is not None


class ServicoNuvem:
    """Cliente mais a memória da última resposta, para a tela não esperar a rede."""

    def __init__(self, settings: Settings, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.cliente = ClienteNuvem(
            settings.cloud_url,
            token=settings.cloud_token,
            timeout_s=settings.cloud_timeout_s,
            canal=settings.cloud_canal,
            hosts_download=settings.cloud_download_permitidos,
            transport=transport,
        )
        self.canal = settings.cloud_canal
        self.versao = settings.cloud_versao or __version__
        self._estado = Estado(ativo=self.cliente.ativo, canal=self.canal)
        self._chave: tuple[str, str] | None = None

    @property
    def estado(self) -> Estado:
        return self._estado

    def _vencido(self, versao: str, canal: str) -> bool:
        if self._chave != (versao, canal) or self._estado.atualizado_em is None:
            return True
        # Acerto vale 15 minutos; falha vale 15 segundos. Sem isso a tela ficava
        # "sem resposta" por um quarto de hora por causa de uma consulta perdida.
        janela = VALIDADE_S if self._estado.disponivel else VALIDADE_ERRO_S
        return (time.monotonic() - self._estado.atualizado_em) > janela

    async def verificar(
        self,
        *,
        versao: str | None = None,
        canal: str | None = None,
        forcar: bool = False,
    ) -> Estado:
        """Consulta a nuvem e guarda o resultado. Nunca levanta.

        O acerto fica em memória por `VALIDADE_S`; a falha, por `VALIDADE_ERRO_S` —
        assim a próxima abertura da tela já tenta de novo em vez de repetir o erro.
        """
        if not self.cliente.ativo:
            return self._estado
        alvo = versao or self.versao
        canal_escolhido = canal or self.canal
        if not forcar and not self._vencido(alvo, canal_escolhido):
            return self._estado

        atualizacao = await self.cliente.checar_atualizacao(alvo, canal_escolhido)
        self._chave = (alvo, canal_escolhido)
        self._estado = Estado(
            ativo=True,
            disponivel=atualizacao is not None,
            canal=canal_escolhido,
            atualizado_em=time.monotonic(),
            erro=None if atualizacao is not None else ERRO_GENERICO,
            atualizacao=atualizacao,
        )
        return self._estado

    async def changelog(self, canal: str | None = None) -> list[dict[str, Any]]:
        return await self.cliente.changelog(canal)
