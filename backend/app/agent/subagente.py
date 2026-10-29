"""Roda um sub-agente: um agente a mais, com as regras dele.

O sub-agente não é um processo separado nem um produto novo — é o **mesmo** laço
(`loop.executar`), com outro prompt e outro catálogo. O que muda:

- **não apaga nada.** As ferramentas de apagar não entram no catálogo, e o veto abaixo recusa
  qualquer ação de exclusão que chegue por outro caminho — um `rm` no shell, um
  `shutil.rmtree` no interpretador. Apagar é do agente principal, e é ele que responde por
  isso;
- **não sai da pasta** do projeto, a menos que o principal mande (`fora_da_pasta`);
- **usa as skills e os MCPs que ele tem**, e só esses. Um agente novo não herda poder: sem
  `skills:` no arquivo dele, ele não carrega skill nenhuma;
- **teto de requisições**: 30 por segundo, contadas no único ponto por onde toda requisição
  passa — o `step` do provedor.

O que ele devolve é o **relatório** que volta para o agente principal. O principal não vê a
conversa dele, vê o que ele concluiu — e é por isso que o relatório tem de dizer o que foi
feito, o que foi achado e o que ficou em aberto.
"""

from __future__ import annotations

import asyncio
from ..execution.tempo import without_host_processes
import re
import threading
import time
from collections import deque
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .. import mcp, subagentes
from ..config import Settings
from ..limits import LIMITES
from ..skills import SkillStore
from ..tools import registry
from ..policy.capabilities import deny_for_read_only

if TYPE_CHECKING:  # pragma: no cover — só para os tipos
    from .loop import Aprovar, Emit, Resultado

#: O nome da ferramenta que o laço do principal reconhece. Vem do schema para os dois não
#: divergirem — quem oferece e quem despacha leem a mesma constante.
FERRAMENTA = "sub_agente"

# O teto de requisições do sub-agente, **por segundo**, mora no `LIMITES`
# (`requisicoes_por_segundo_sub`) e é lido na hora de montar o contador — não numa constante
# deste módulo: constante de módulo guarda o valor do dia do import, e um ajuste na subida
# passaria a valer só em quem lê pelo módulo.
#
# Ele não substitui o teto de **minuto do app inteiro**: os dois valem ao mesmo tempo, e é de
# propósito. O RPS segura um sub-agente sozinho; o RPM segura o conjunto — inclusive vários
# chats abertos.

#: Teto de sub-agentes lançados numa mesma rodada do principal.
#:
#: É do motor, e não do arquivo do agente: quem escreve um agente não decide quantos podem
#: rodar de uma vez. Três é o que cabe sem o trabalho virar uma confusão de relatórios.
POR_RODADA = 3

#: As ferramentas que o sub-agente **não** recebe. Tiradas do catálogo, e negadas no despacho
#: — tirar do catálogo é pedido, negar é imposição.
PROIBIDAS = frozenset({"delete_file", "delete_directory"})

#: O que apaga, escrito de outro jeito. O sub-agente não apaga nada, e o shell e o
#: interpretador são as duas portas por onde ele poderia tentar.
#:
#: Isto é um **guarda**, não uma prova: um comando esperto o bastante pode escapar de um
#: regex. O que é garantia de verdade são as duas ferramentas acima, que não existem para
#: ele. A regra está escrita no prompt dele, e o veto responde na hora em que ele tenta.
APAGA = re.compile(
    r"(\brm\b|\brmdir\b|\bdel\b|\berase\b|\bformat\b|remove-item|\bunlink\b|"
    r"shutil\.rmtree|os\.remove|os\.unlink|os\.rmdir|pathlib\.Path\([^)]*\)\.unlink|"
    r"git\s+clean|git\s+reset\s+--hard|git\s+checkout\s+--)",
    re.IGNORECASE,
)


async def _sem_eco(evento: str, dados: dict[str, Any]) -> None:
    """O sub-agente narra para o vazio.

    Quem fala com a pessoa é o principal. Os passos dele entram no **relatório**, não na
    conversa de cima — lá em cima aparece uma coisa só: a chamada do sub-agente e o que ele
    devolveu.
    """


def _eco_de(emit: Emit | None, agente: str, chamada: str) -> Emit:
    """O que o sub-agente narra sai como evento **próprio**, endereçado à chamada dele.

    É o que deixa a área Subs abrir uma aba por sub-agente e mostrar o trabalho acontecendo
    lá dentro, sem que a conversa de cima ganhe uma linha por passo alheio. Sem `emit` (o
    caso de quem chama por fora do stream), o sub-agente volta a narrar para o vazio.
    """
    if emit is None:
        return _sem_eco

    async def eco(evento: str, dados: dict[str, Any]) -> None:
        await emit(
            "sub",
            {"chamada": chamada, "agente": agente, "evento": evento, "dados": dados},
        )

    return eco


class _ModeloContado:
    """O mesmo provedor, com o teto de requisições por segundo.

    O laço fala com o provedor por `step`, e só por ele — contar aqui é o que faz o teto ser
    uma medida em vez de uma promessa. A janela é de um segundo: chegando no teto, a próxima
    requisição espera a mais antiga sair da janela.
    """

    def __init__(self, modelo: Any, por_segundo: int) -> None:
        self._modelo = modelo
        self._por_segundo = max(1, por_segundo)
        self._marcas: deque[float] = deque()

    @property
    def name(self) -> str:
        return str(getattr(self._modelo, "name", ""))

    @property
    def ready(self) -> bool:
        return bool(getattr(self._modelo, "ready", False))

    async def step(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]], model: str = ""
    ) -> Any:
        await self._esperar_vez()
        return await self._modelo.step(messages, tools, model)

    async def _esperar_vez(self) -> None:
        agora = time.monotonic()
        while self._marcas and agora - self._marcas[0] >= 1.0:
            self._marcas.popleft()
        if len(self._marcas) >= self._por_segundo:
            espera = 1.0 - (agora - self._marcas[0])
            if espera > 0:
                await asyncio.sleep(espera)
        self._marcas.append(time.monotonic())


class _SkillsDoAgente(SkillStore):
    """Só as skills que o sub-agente tem direito de usar.

    `nomes()` e `instrucoes()` saem de `todas()`, então filtrar aqui filtra os três: a lista
    que a mensagem de erro oferece e o que a `use_skill` deixa carregar.
    """

    def __init__(self, settings: Settings, workspace: Path, permitidas: list[str]) -> None:
        super().__init__(settings, workspace)
        self._permitidas = {nome.casefold() for nome in permitidas}

    def todas(self) -> list[Any]:
        return [
            skill for skill in super().todas() if skill.name.casefold() in self._permitidas
        ]


def _e_apagar(acao: dict[str, Any]) -> bool:
    """A ação apaga algo?

    Vale para as duas portas: a ferramenta de apagar (`kinds` traz `exclusao`) e o comando
    que apaga, que chega como `comando` e só se reconhece pelo texto.
    """
    if "exclusao" in (acao.get("kinds") or []):
        return True
    return bool(APAGA.search(str(acao.get("resumo") or "")))


def _o_que_ele_rodou(passos: list[Any]) -> str:
    """`write_file×3, shell×2` — o que ele executou de verdade, sem as que falharam."""
    contagem: dict[str, int] = {}
    for passo in passos:
        if not getattr(passo, "ok", False):
            continue
        nome = str(getattr(passo, "name", ""))
        contagem[nome] = contagem.get(nome, 0) + 1
    return ", ".join(f"{nome}×{vezes}" for nome, vezes in contagem.items())


def _relatorio(nome: str, resultado: Resultado) -> str:
    """O que volta para o principal: o que ele concluiu, e o que mexeu."""
    if resultado.completou:
        cabeca = f"O sub-agente «{nome}» terminou."
    else:
        cabeca = (
            f"O sub-agente «{nome}» parou sem concluir ({resultado.motivo}). "
            "O que ele já executou está no disco — confira antes de repetir."
        )
    partes = [cabeca]
    if resultado.texto.strip():
        partes.append(resultado.texto.strip())
    rodou = _o_que_ele_rodou(resultado.passos)
    if rodou:
        partes.append(f"O que ele rodou: {rodou}.")
    return "\n\n".join(partes)


def _prompt_do_agente(agente: subagentes.SubAgente, workspace: Path, sem_mcp: bool) -> str:
    """O prompt de sistema do sub-agente: quem ele é, e o que ele não faz."""
    from .loop import PROMPT_FERRAMENTAS

    return (
        f"{PROMPT_FERRAMENTAS}\n\n"
        f"Você é o sub-agente «{agente.nome}», lançado pelo agente principal do Koda para "
        "tocar um pedaço do trabalho dele.\n"
        f"Pasta de trabalho: {workspace}\n\n"
        "Quem fala com a pessoa é o agente principal — o que você escrever volta para ele "
        "como relatório. Escreva para ele: o que você fez, o que achou, o que ficou em "
        "aberto. Ele não vê o seu caminho, só o que você contar.\n\n"
        "Você tem somente ferramentas de leitura. Retorne análise e propostas ao principal; "
        "ele executa as alterações e comandos autorizados.\n"
        "Duas coisas você **não** faz, e não é escolha sua:\n"
        "- não apaga arquivo nem pasta, por ferramenta nenhuma. Se um arquivo que você criou "
        "não serve mais, diga no relatório que ele pode ser apagado — apagar é do principal;\n"
        "- não mexe fora da pasta do projeto. Se o trabalho precisar disso, pare e diga no "
        "relatório.\n"
        + ("\nVocê não tem servidor MCP nenhum: resolva com o que está na máquina.\n" if sem_mcp else "")
        + (f"\n{agente.prompt}" if agente.prompt else "")
    ).strip()


@without_host_processes
async def executar(
    engine: Any,
    settings: Settings,
    *,
    nome: str,
    tarefa: str,
    workspace: Path,
    esforco: str | None = None,
    modelo: str | None = None,
    fora_da_pasta: bool = False,
    aprovar: Aprovar | None = None,
    emit: Emit | None = None,
    chamada: str = "",
    dono: str = "",
    cancelamento: threading.Event | None = None,
) -> str:
    """Roda o sub-agente e devolve o texto que volta para o principal.

    Devolve **texto** e não levanta: quem chama é o laço, e o modelo precisa receber um
    relatório legível tanto quando o sub-agente trabalhou quanto quando o nome não existe.
    """
    # Import aqui dentro, e não no topo: o laço importa este módulo para despachar a
    # ferramenta, e um import de mão dupla no topo fecharia o ciclo.
    from .loop import executar as rodar

    agente = subagentes.obter(settings, nome)
    if agente is None:
        existentes = ", ".join(item.nome for item in subagentes.listar(settings)) or "(nenhum)"
        return (
            f"ERRO: não existe sub-agente chamado «{nome}». "
            f"Os que existem: {existentes}."
        )
    if not (tarefa or "").strip():
        return "ERRO: informe a tarefa do sub-agente — ele começa do zero e não vê esta conversa."

    negadas = set(settings.tools_negadas) | deny_for_read_only(registry.DEFINICOES)
    # Os MCPs dele, e só os dele: tudo o que é de servidor fora da lista entra como negado.
    catalogo_mcp = mcp.catalogo()
    for item in catalogo_mcp:
        endereco = mcp.detalhar(str(item["function"]["name"])) or {}
        # Um servidor externo pode escrever ou executar código, mesmo que se anuncie leitor.
        negadas.add(str(item["function"]["name"]))

    # Sem `skills:` no arquivo dele a lista é vazia, e o filtro tira todas: um agente novo
    # não herda poder — o que ele pode usar está escrito, não subentendido.
    skills = _SkillsDoAgente(settings, workspace, agente.skills)

    async def veto(acao: dict[str, Any]) -> str:
        """O que o sub-agente **não** faz, dito na hora em que ele tenta.

        O veto responde `nao` em vez de deixar passar: o laço trata isso como ação negada e
        devolve ao modelo um texto que ele entende — melhor do que a chamada passar e o
        arquivo sumir.
        """
        if _e_apagar(acao):
            return "nao"
        if "fora_da_pasta" in (acao.get("kinds") or []):
            return "nao"
        # O resto segue o modo do app, o mesmo do principal: se ele está livre, o sub-agente
        # também está; se o principal pergunta antes de rodar comando, o sub-agente pergunta.
        if aprovar is None:
            return "sim"
        return await aprovar(acao)

    mensagens = [
        {
            "role": "system",
            "content": _prompt_do_agente(agente, workspace, sem_mcp=not agente.mcps),
        },
        {"role": "user", "content": (tarefa or "").strip()},
    ]

    resultado: Resultado = await rodar(
        _ModeloContado(engine, LIMITES.requisicoes_por_segundo_sub),
        mensagens,
        workspace=workspace,
        max_steps=settings.max_steps,
        emit=_eco_de(emit, agente.nome, chamada),
        negadas=negadas,
        model=modelo or agente.modelo or "",
        timeout_s=settings.tool_timeout_s or None,
        tentativas=settings.retry_attempts,
        espera_final=float(settings.retry_final_wait_s),
        acesso_livre=fora_da_pasta,
        reasoning=True,
        effort=esforco,
        aprovar=veto,
        orcamento=settings.contexto_tokens,
        dono=dono,
        max_tool_calls=settings.max_tool_calls,
        tool_call_timeout_s=settings.tool_call_timeout_s or None,
        cancelamento=cancelamento,
        skills=skills,
    )
    return _relatorio(agente.nome, resultado)
