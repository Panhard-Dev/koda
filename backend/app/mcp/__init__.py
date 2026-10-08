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
        self._node: Path | None = None
        self._trava = threading.Lock()
        self._preparando = threading.Lock()

    # ------------------------------------------------------------ configuração

    def configurar(self, caminho: Path | None, node: Path | None = None) -> None:
        """Aponta o gerenciador para o arquivo de configuração (ao lado do banco).

        `node` é o `node.exe` que viaja com o app (`Settings.node_path`). É opcional de
        propósito: sem ele o comando do `mcps.json` vale como está, que é o comportamento de
        quem tem Node no `PATH` e o dos testes.
        """
        with self._trava:
            self._node = node
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

            with self._trava:
                self._ligacoes = ligacoes
                self._mapa = self._montar_mapa(ligacoes)
        finally:
            self._preparando.release()

    def _conectar(self, config: Servidor) -> Ligacao:
        if not config.enabled:
            return Ligacao(config=config, erro="desligado")
        cliente = ServidorMCP(
            nome=config.nome,
            comando=self._comando_de_verdade(config.comando),
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
        try:
            # A listagem é parte de conectar: um servidor que sobe mas não responde ao
            # `tools/list` não serve para nada, e é melhor saber disso agora do que na hora
            # em que o modelo chamar a primeira ferramenta.
            cliente.listar()
        except ErroMCP as exc:
            stderr = cliente.ultimo_erro()
            # `com_saida` **antes** de fechar: depois não há mais processo para perguntar o
            # código com que ele morreu, e é ele que explica um binário que existe e não roda.
            motivo = cliente.com_saida(str(exc))
            cliente.fechar()
            return Ligacao(
                config=config,
                erro=motivo + (f" · {stderr}" if stderr else ""),
            )
        return Ligacao(config=config, cliente=cliente)

    def _comando_de_verdade(self, comando: str) -> str:
        """Troca `node`/`node.exe` pelo Node que **viaja com o Koda**, quando ele existe.

        O `mcps.json` guarda `"command": "node"` — um **nome**, não um caminho. É o que faz o
        mesmo arquivo valer em qualquer máquina, e é o que deixa quem quiser apontar para o
        Node dele escrevendo o caminho por extenso. Mas o app instalado não pode depender de a
        máquina de destino ter Node: o instalador promete que não é preciso instalar mais nada,
        e os dois servidores que o app traz são programas Node. Então, quando o Node que vem
        junto existe, é ele que roda.

        Comando que já é caminho (tem pasta) passa intacto: quem escreveu escolheu.
        """
        if self._node is None or not self._node.is_file():
            return comando
        if len(Path(comando).parts) > 1:
            return comando
        if comando.strip().lower() not in ("node", "node.exe"):
            return comando
        return str(self._node)

    def _montar_mapa(self, ligacoes: dict[str, Ligacao]) -> dict[str, tuple[str, str]]:
        """O mapa `nome externo -> (servidor, ferramenta real)`.

        A montagem é **ordenada** e **em duas passadas**, e as duas coisas são de propósito:

        1. **ordenada** — as propostas são ordenadas antes de qualquer atribuição. Sem isso,
           quem recebe o sufixo de desempate é quem aparece primeiro na lista do servidor, e
           um `tools/list` que troque a ordem (ou um reinício) trocaria o ID de duas
           ferramentas entre si: a conversa antiga passaria a apontar para a ferramenta
           errada. Ordenar tira a ordem de chegada da conta.
        2. **em duas passadas** — primeiro conta-se quantas bases repetem; depois quem repete
           (ou passa do teto de 64 caracteres) leva sufixo derivado do nome **original**.
           Assim **todas** as colidentes são desambiguadas, e não só a segunda a chegar.
        """
        propostas: list[tuple[str, str, str]] = []  # (base, servidor, nome real)
        for nome, ligacao in ligacoes.items():
            if not ligacao.conectado or ligacao.cliente is None:
                continue
            for ferramenta in ligacao.cliente.ferramentas():
                base = f"{PREFIXO}{nome_seguro(nome)}__{nome_seguro(ferramenta.nome)}"
                propostas.append((base, nome, ferramenta.nome))
        propostas.sort()

        repetidas: dict[str, int] = {}
        for base, _, _ in propostas:
            repetidas[base] = repetidas.get(base, 0) + 1

        mapa: dict[str, tuple[str, str]] = {}
        usados: set[str] = set()
        for base, servidor, ferramenta in propostas:
            externo = self._nome_externo(
                base, servidor, ferramenta, repetidas[base] > 1, usados
            )
            mapa[externo] = (servidor, ferramenta)
        return mapa

    def _nome_externo(
        self, base: str, servidor: str, ferramenta: str, repetida: bool, usados: set[str]
    ) -> str:
        """Nome da função que o modelo vê: `mcp__<servidor>__<ferramenta>`.

        Sem sufixo quando a base cabe em `MAX_NOME` e é única. Com sufixo quando ela repete
        (dois nomes diferentes que a normalização igualou — `x-y` e `x.y` viram os dois
        `x_y`) ou quando não cabe.

        O sufixo sai do **nome original**, e não da posição na lista: é o que faz o ID ser o
        mesmo depois de um reinício, de uma reordenação, ou de uma ferramenta nova entrar na
        frente. Ele fica gravado no histórico da conversa, e um sufixo que muda faria a
        conversa antiga apontar para outra ferramenta.
        """
        if len(base) <= MAX_NOME and not repetida and base not in usados:
            usados.add(base)
            return base
        sufixo = format(
            zlib.crc32(f"{servidor}\x00{ferramenta}".encode("utf-8")) & 0xFFFF, "04x"
        )
        corte = base[: MAX_NOME - 6]
        externo = f"{corte}_{sufixo}"
        while externo in usados:  # pragma: no cover — hash de 16 bits colidindo de verdade
            sufixo = format((int(sufixo, 16) + 1) & 0xFFFF, "04x")
            externo = f"{corte}_{sufixo}"
        usados.add(externo)
        return externo

    # ------------------------------------------------------------ catálogo

    def catalogo(self) -> list[dict[str, Any]]:
        """As ferramentas MCP no formato do provedor — só as que estão conectadas **agora**.

        Lê o cache; **não** conecta nada. É chamado a cada rodada, no caminho quente. A única
        exceção é o servidor que avisou que a lista mudou (`tools/list_changed`): aí a
        listagem dele é refeita aqui, porque servir o catálogo velho na rodada seguinte é
        exatamente o que o aviso existe para evitar — e é uma chamada só, no servidor que
        avisou.
        """
        with self._trava:
            ligacoes = dict(self._ligacoes)

        if any(
            lig.cliente is not None and lig.cliente.desatualizado for lig in ligacoes.values()
        ):
            self._relistar(ligacoes)
            with self._trava:
                ligacoes = dict(self._ligacoes)

        with self._trava:
            mapa = dict(self._mapa)

        definicoes: list[dict[str, Any]] = []
        for externo, (nome_servidor, nome_real) in sorted(mapa.items()):
            ligacao = ligacoes.get(nome_servidor)
            # `conectado`, e não só `cliente is not None`: processo morto não publica
            # ferramenta. O cache do cliente continuaria listando o que ele oferecia antes de
            # cair, e o modelo chamaria uma ferramenta que não existe mais.
            if ligacao is None or not ligacao.conectado or ligacao.cliente is None:
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

    def _relistar(self, ligacoes: dict[str, Ligacao]) -> None:
        """Refaz a listagem de quem avisou que mudou, e o mapa inteiro em seguida.

        A falha de um servidor aqui não derruba os outros: o cliente dele fica com a lista
        vazia (foi invalidada no aviso) e o erro vai para o estado — o `catalogo()` já não
        publica ferramenta de servidor que não responde.
        """
        for ligacao in ligacoes.values():
            cliente = ligacao.cliente
            if cliente is None or not cliente.desatualizado:
                continue
            try:
                cliente.listar()
            except ErroMCP as exc:
                ligacao.erro = cliente.com_saida(str(exc))
                cliente.aviso_tratado()
        with self._trava:
            self._mapa = self._montar_mapa(ligacoes)

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

    def descricao(self, nome: str) -> str:
        """O que o **servidor** diz que esta ferramenta faz. Vazio quando ele não diz.

        Vai para o cartão de permissão. O Koda não sabe o que uma ferramenta de fora faz —
        a única fonte é o próprio servidor, e é por isso que este texto vai **citado** no
        cartão: quem lê precisa saber de quem é a frase.
        """
        with self._trava:
            alvo = self._mapa.get(nome)
            ligacao = self._ligacoes.get(alvo[0]) if alvo else None
        if alvo is None or ligacao is None or ligacao.cliente is None:
            return ""
        ferramenta = next(
            (f for f in ligacao.cliente.ferramentas() if f.nome == alvo[1]), None
        )
        return ferramenta.descricao.strip() if ferramenta is not None else ""

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
            conectado = bool(cliente is not None and cliente.vivo)
            erro = ligacao.erro if ligacao else None
            if cliente is not None and not conectado and not erro:
                # Processo que morreu depois de conectar. Sem isto a linha ficava
                # "desconectado" e **sem motivo** — e o `ferramentas` ainda contava o cache
                # do que ele oferecia antes de cair.
                ultimo = cliente.ultimo_erro()
                erro = "o servidor encerrou" + (f" · {ultimo}" if ultimo else "")
            saida.append(
                {
                    "name": nome,
                    "enabled": config.enabled,
                    "conectado": conectado,
                    "erro": erro,
                    "ferramentas": len(cliente.ferramentas()) if conectado else 0,
                    # Lista parcial apresentada como completa é pior do que lista parcial com
                    # o motivo escrito: `conectado: true` com metade das ferramentas não diz a
                    # ninguém que faltou coisa. `None` quando a última listagem foi inteira.
                    "incompleto": (
                        cliente.incompleto if cliente is not None and conectado else None
                    ),
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


def configurar(caminho: Path | None, node: Path | None = None) -> None:
    """Liga o gerenciador ao arquivo de configuração e ao Node que vem com o app."""
    gerenciador.configurar(caminho, node)


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


def descricao(nome: str) -> str:
    """A descrição que o servidor publicou para a ferramenta (para o cartão de permissão)."""
    return gerenciador.descricao(nome)


def status() -> list[dict[str, Any]]:
    return gerenciador.status()
