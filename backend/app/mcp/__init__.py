"""MCP no Koda: os servidores configurados viram **ferramentas de verdade** para o agente.

Até a 0.6.2 o submenu MCPs guardava uma lista de `{name, command, params}` em
`data/mcps.json` e nada mais: não havia cliente, não havia chamada, e o agente não sabia que
os servidores existiam. O comentário da rota dizia isso com todas as letras. Este pacote é o
que faltava — a lista passa a ser consumida.

**A diferença entre skill e MCP, que o produto respeita:**

- uma **skill** é um pacote de **instruções**: o agente lê e aplica o que está escrito. Ela
  não executa nada. Quem carrega é `use_skill`.
- um **servidor MCP** é um pacote de **ferramentas**: cada uma é um programa que roda e
  devolve um resultado. O agente chama, e a chamada aparece na conversa como qualquer outra
  ferramenta.

**Como as ferramentas entram na rodada.** O catálogo da rodada (o que vai ao modelo) e a
porteira do despacho saem da **mesma** lista — é o que garante que "não ofereci" e "não deixo
chamar" não divirjam. As ferramentas MCP entram nessa lista pelo `catalogo()` daqui, e a
chamada é despachada por `executar()`.

**Quando a conexão acontece.** `preparar()` sobe os servidores e faz o handshake; ele é
chamado na subida do app e sempre que a configuração muda — **sempre de uma thread**, nunca
do laço de eventos, porque subir processo e esperar `initialize` bloqueia. O `catalogo()` só
lê o que já está conectado e em cache: se um servidor não subiu, as ferramentas dele não são
oferecidas nesta rodada, em vez de a conversa travar esperando.
"""

from __future__ import annotations

import json
import threading
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .cliente import ErroMCP, ServidorMCP, nome_seguro

#: Prefixo dos nomes de ferramenta que vêm de um servidor MCP. É o que separa, na conversa,
#: o que é do Koda do que é de fora — e o que a interface usa para escolher o ícone.
PREFIXO = "mcp__"

#: Teto do nome de função aceito pelo provedor. O padrão da OpenAI é 64.
MAX_NOME = 64

#: Quanto esperar pelo handshake de um servidor. É curto de propósito: um servidor que não
#: responde em 8 s não vai responder na hora de chamar, e prender a subida do app nele é pior
#: do que marcá-lo como fora do ar e seguir.
TEMPO_HANDSHAKE_S = 8.0


@dataclass(slots=True)
class Servidor:
    """A configuração de um servidor MCP, como está em `mcps.json`."""

    nome: str
    comando: str
    params: str = ""
    descricao: str = ""
    enabled: bool = True


@dataclass(slots=True)
class Ligacao:
    """Um servidor **conectado** (ou a razão de não estar)."""

    config: Servidor
    cliente: ServidorMCP | None = None
    erro: str | None = None

    @property
    def conectado(self) -> bool:
        return self.cliente is not None and self.cliente.vivo


class Gerenciador:
    """Os servidores MCP desta execução: conexão, catálogo e despacho.

    Guarda o estado no processo. A configuração é um arquivo; mudou o arquivo, `recarregar()`
    derruba as conexões velhas e a próxima `preparar()` reconecta do zero — sem isso, um
    servidor removido continuaria oferecendo ferramenta até o app reiniciar.
    """

    def __init__(self) -> None:
        self._caminho: Path | None = None
        self._ligacoes: dict[str, Ligacao] = {}
        self._mapa: dict[str, tuple[str, str]] = {}
        self._trava = threading.Lock()
        self._preparando = threading.Lock()

    # ------------------------------------------------------------ configuração

    def configurar(self, caminho: Path | None) -> None:
        """Aponta o gerenciador para o arquivo de configuração (ao lado do banco)."""
        with self._trava:
            if caminho == self._caminho:
                return
            self._caminho = caminho
        self.recarregar()

    def recarregar(self) -> None:
        """Esquece as conexões: a próxima `preparar()` reconecta com a configuração nova."""
        with self._trava:
            ligacoes = list(self._ligacoes.values())
            self._ligacoes = {}
            self._mapa = {}
        for ligacao in ligacoes:
            if ligacao.cliente is not None:
                ligacao.cliente.fechar()

    def _servidores(self) -> list[Servidor]:
        caminho = self._caminho
        if caminho is None:
            return []
        try:
            dados = json.loads(caminho.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        if not isinstance(dados, list):
            return []
        servidores: list[Servidor] = []
        for item in dados:
            if not isinstance(item, dict):
                continue
            nome = str(item.get("name", "")).strip()
            comando = str(item.get("command", "")).strip()
            if not nome or not comando:
                continue
            servidores.append(
                Servidor(
                    nome=nome,
                    comando=comando,
                    params=str(item.get("params", "")),
                    descricao=str(item.get("description", "")),
                    enabled=bool(item.get("enabled", True)),
                )
            )
        return servidores

    # ------------------------------------------------------------ conexão

    def preparar(self) -> None:
        """Sobe (ou derruba) o que for preciso para a configuração atual.

        Bloqueante — chame de uma thread. É idempotente: servidor já conectado e ainda
        presente na configuração não é tocado.
        """
        if not self._preparando.acquire(blocking=False):
            return  # já tem alguém conectando; não vale a pena esperar na fila
        try:
            servidores = {item.nome: item for item in self._servidores()}
            with self._trava:
                antigos = {nome: lig for nome, lig in self._ligacoes.items()}

            for nome, ligacao in antigos.items():
                if nome not in servidores or not ligacao.conectado:
                    if ligacao.cliente is not None:
                        ligacao.cliente.fechar()

            ligacoes: dict[str, Ligacao] = {}
            for nome, config in servidores.items():
                anterior = antigos.get(nome)
                if (
                    anterior is not None
                    and anterior.conectado
                    and anterior.config == config
                ):
                    ligacoes[nome] = anterior
                    continue
                if anterior is not None and anterior.cliente is not None:
                    anterior.cliente.fechar()
                ligacoes[nome] = self._conectar(config)

            mapa: dict[str, tuple[str, str]] = {}
            usados: set[str] = set()
            for nome, ligacao in ligacoes.items():
                if not ligacao.conectado or ligacao.cliente is None:
                    continue
                for ferramenta in ligacao.cliente.ferramentas():
                    externo = self._nome_externo(nome, ferramenta.nome, usados)
                    mapa[externo] = (nome, ferramenta.nome)

            with self._trava:
                self._ligacoes = ligacoes
                self._mapa = mapa
        finally:
            self._preparando.release()

    def _conectar(self, config: Servidor) -> Ligacao:
        if not config.enabled:
            return Ligacao(config=config, erro="desligado")
        cliente = ServidorMCP(
            nome=config.nome,
            comando=config.comando,
            params=config.params,
            tempo_s=TEMPO_HANDSHAKE_S,
        )
        if not cliente.abrir():
            motivo = cliente.erro or "não respondeu ao handshake"
            stderr = cliente.ultimo_erro()
            cliente.fechar()
            return Ligacao(
                config=config,
                erro=motivo + (f" · {stderr}" if stderr else ""),
            )
        return Ligacao(config=config, cliente=cliente)

    def _nome_externo(self, servidor: str, ferramenta: str, usados: set[str]) -> str:
        """Nome da função que o modelo vê: `mcp__<servidor>__<ferramenta>`.

        Curto demais para caber: corta a **ferramenta** (não o servidor) e completa com um
        sufixo estável. Estável de propósito — o nome fica gravado no histórico da conversa,
        e um sufixo que muda a cada reinício faria a conversa antiga apontar para uma
        ferramenta que não existe mais.

        Colisão (dois nomes diferentes que a normalização igualou): o segundo recebe o mesmo
        sufixo. Sem isso, o mapa guardaria só um dos dois e o outro viraria uma chamada
        perdida.
        """
        base = f"{PREFIXO}{nome_seguro(servidor)}__{nome_seguro(ferramenta)}"
        if len(base) <= MAX_NOME and base not in usados:
            usados.add(base)
            return base
        sufixo = format(zlib.crc32(base.encode("utf-8")) & 0xFFFF, "04x")
        if len(base) > MAX_NOME - 6:
            base = base[: MAX_NOME - 6]
        externo = f"{base}_{sufixo}"
        while externo in usados:  # pragma: no cover — colisão de hash é praticamente nula
            sufixo = format((int(sufixo, 16) + 1) & 0xFFFF, "04x")
            externo = f"{base}_{sufixo}"
        usados.add(externo)
        return externo

    # ------------------------------------------------------------ catálogo

    def catalogo(self) -> list[dict[str, Any]]:
        """As ferramentas MCP no formato do provedor — só as que estão conectadas agora.

        Lê o cache; **não** conecta nada. É chamado a cada rodada, no caminho quente.
        """
        with self._trava:
            ligacoes = dict(self._ligacoes)
            mapa = dict(self._mapa)
        definicoes: list[dict[str, Any]] = []
        for externo, (nome_servidor, nome_real) in sorted(mapa.items()):
            ligacao = ligacoes.get(nome_servidor)
            if ligacao is None or ligacao.cliente is None:
                continue
            ferramenta = next(
                (f for f in ligacao.cliente.ferramentas() if f.nome == nome_real), None
            )
            if ferramenta is None:
                continue
            descricao = ferramenta.descricao or f"ferramenta '{nome_real}' do servidor MCP '{nome_servidor}'"
            definicoes.append(
                {
                    "type": "function",
                    "function": {
                        "name": externo,
                        # O prefixo na descrição é o que diz ao modelo que isto **não** é
                        # uma ferramenta do Koda: roda fora, no servidor, e o que ela pode
                        # fazer é o que o servidor decidir.
                        "description": f"[MCP · {nome_servidor}] {descricao}",
                        "parameters": _esquema(ferramenta.esquema),
                    },
                }
            )
        return definicoes

    def e_ferramenta_mcp(self, nome: str) -> bool:
        """Este nome é de uma ferramenta MCP desta rodada?"""
        with self._trava:
            return nome in self._mapa

    def detalhar(self, nome: str) -> dict[str, str] | None:
        """De qual servidor e de qual ferramenta é este nome externo.

        Vai para a interface: o nome que o modelo vê é normalizado (`eco_server`), e mostrar
        esse nome na conversa seria mostrar um nome que **não existe** em lugar nenhum. O
        que a tela mostra é o nome real do servidor e da ferramenta, como o `mcps.json` e o
        `tools/list` os escrevem.
        """
        with self._trava:
            alvo = self._mapa.get(nome)
        if alvo is None:
            return None
        return {"servidor": alvo[0], "ferramenta": alvo[1]}

    def executar(self, nome: str, argumentos: dict[str, Any], tempo_s: float | None = None) -> tuple[bool, str]:
        """Despacha uma chamada para o servidor certo. Nunca levanta."""
        with self._trava:
            alvo = self._mapa.get(nome)
            ligacao = self._ligacoes.get(alvo[0]) if alvo else None
        if alvo is None or ligacao is None or ligacao.cliente is None:
            return False, (
                f"ERRO: a ferramenta MCP '{nome}' não está disponível — o servidor pode ter "
                "sido desligado ou removido. Não insista: siga sem ela."
            )
        servidor, ferramenta = alvo
        try:
            return ligacao.cliente.chamar(ferramenta, argumentos, tempo_s=tempo_s)
        except ErroMCP as exc:  # pragma: no cover — `chamar` já trata; guarda de segurança
            return False, f"ERRO: {exc}"

    # ------------------------------------------------------------ estado (tela)

    def status(self) -> list[dict[str, Any]]:
        """O estado de cada servidor, para o `/api/health` e a tela de Ajustes.

        Não conecta nada: devolve o que já se sabe. Um servidor configurado e ainda não
        tentado aparece como `conectado: false` sem erro — é o estado honesto de "ainda não
        subiu", e não "falhou".
        """
        with self._trava:
            ligacoes = dict(self._ligacoes)
        por_nome = {item.nome: item for item in self._servidores()}
        saida: list[dict[str, Any]] = []
        for nome, config in por_nome.items():
            ligacao = ligacoes.get(nome)
            cliente = ligacao.cliente if ligacao else None
            saida.append(
                {
                    "name": nome,
                    "enabled": config.enabled,
                    "conectado": bool(cliente is not None and cliente.vivo),
                    "erro": (ligacao.erro if ligacao else None),
                    "ferramentas": len(cliente.ferramentas()) if cliente is not None else 0,
                }
            )
        return saida


def _esquema(bruto: dict[str, Any]) -> dict[str, Any]:
    """O `inputSchema` do servidor -> um esquema que o provedor aceita.

    O MCP já entrega JSON Schema, então quase sempre passa direto. O que se garante é o
    mínimo que o provedor exige: `type: object` e um `properties`. Servidor que publica
    esquema vazio (`{}`) recebe o esquema permissivo — a ferramenta continua chamável, e a
    validação fica do lado do servidor, que é quem sabe o que aceita.
    """
    if not isinstance(bruto, dict) or not bruto:
        return {"type": "object", "properties": {}}
    esquema = dict(bruto)
    if esquema.get("type") != "object" and "properties" not in esquema:
        esquema = {"type": "object", "properties": {}, **esquema}
    esquema.setdefault("type", "object")
    esquema.setdefault("properties", {})
    return esquema


#: O gerenciador da execução. Um por processo: o app tem um backend e uma configuração.
gerenciador = Gerenciador()


def configurar(caminho: Path | None) -> None:
    """Liga o gerenciador ao arquivo de configuração (chamado na subida do app)."""
    gerenciador.configurar(caminho)


def preparar() -> None:
    """Sobe os servidores configurados. Bloqueante — chame de uma thread."""
    gerenciador.preparar()


def recarregar() -> None:
    """Invalida as conexões depois de a configuração mudar."""
    gerenciador.recarregar()


def encerrar() -> None:
    """Derruba as conexões — na saída do app, para não deixar processo órfão."""
    gerenciador.recarregar()


def catalogo() -> list[dict[str, Any]]:
    """As ferramentas MCP conectadas, no formato do provedor."""
    return gerenciador.catalogo()


def executar(nome: str, argumentos: dict[str, Any], tempo_s: float | None = None) -> tuple[bool, str]:
    """Executa uma ferramenta MCP pelo nome externo (`mcp__…`)."""
    return gerenciador.executar(nome, argumentos, tempo_s=tempo_s)


def e_ferramenta_mcp(nome: str) -> bool:
    return gerenciador.e_ferramenta_mcp(nome)


def detalhar(nome: str) -> dict[str, str] | None:
    """Servidor e ferramenta reais por trás de um nome `mcp__…` (para a interface)."""
    return gerenciador.detalhar(nome)


def status() -> list[dict[str, Any]]:
    return gerenciador.status()
