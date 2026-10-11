"""Os sub-agentes: o que cada um é, e onde isso fica escrito.

Um sub-agente é um agente **a mais** — prompt próprio, skills e MCPs escolhidos — que o
agente principal lança para tocar um pedaço do trabalho. O que ele faz volta para o
principal: ele não é um segundo produto, é mão de obra.

As definições ficam em `subs.agentes.md`, ao lado do banco e do `mcps.json`: é configuração
**deste app**, não do projeto. O prompt do agente principal é outro arquivo — o `AGENTS.md`
do projeto, que o `/init` cria e que o Koda já lê. Separados de propósito: o que vale para
todos os projetos não pode se misturar com o que vale para um só.

Markdown de propósito: quem quiser escrever um agente à mão escreve, e quem quiser usar a
tela de Ajustes usa. Uma seção por agente:

    ## revisor
    skills: revisao, testes
    mcps: navegador
    modelo: liz-4

    Você revisa código e aponta o que está errado, sem consertar nada.

**O que não entra aqui é o que o sub-agente pode fazer.** Não apagar e não sair da pasta são
regras do motor (`agent/subagente.py`), não do arquivo: quem escreve um agente não decide se
ele pode apagar coisas da máquina.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from .config import Settings

NOME_DO_ARQUIVO = "subs.agentes.md"

#: As chaves aceitas no cabeçalho de uma seção. Tudo o que não é chave é o prompt.
CHAVES = ("skills", "mcps", "modelo")

_CABECALHO = re.compile(r"^##\s+(.+?)\s*$")


@dataclass(slots=True)
class SubAgente:
    """Um sub-agente, como ele está escrito no arquivo."""

    nome: str
    prompt: str = ""
    #: Skills que ele pode carregar. Vazio = nenhuma (e não "todas"): um agente novo não
    #: ganha poder por omissão.
    skills: list[str] = field(default_factory=list)
    #: Servidores MCP que ele pode usar. Vazio = nenhum.
    mcps: list[str] = field(default_factory=list)
    #: Modelo dele, quando valer um diferente do principal. Vazio = o que o principal mandar.
    modelo: str = ""


def caminho(settings: Settings) -> Path:
    """O arquivo das definições — ao lado do banco, como o `mcps.json`."""
    return settings.database_path.parent / NOME_DO_ARQUIVO


def _lista(valor: str) -> list[str]:
    return [item.strip() for item in valor.split(",") if item.strip()]


def _secoes(texto: str) -> list[tuple[str, list[str]]]:
    """Quebra o arquivo em (nome, linhas do corpo), na ordem em que estão escritos."""
    secoes: list[tuple[str, list[str]]] = []
    for linha in texto.splitlines():
        achado = _CABECALHO.match(linha)
        if achado:
            secoes.append((achado.group(1).strip(), []))
            continue
        if secoes:
            secoes[-1][1].append(linha)
    return secoes


def _ler_secao(nome: str, linhas: list[str]) -> SubAgente:
    """Uma seção vira um agente.

    Só o **começo** da seção tem chaves: da primeira linha que não é chave em diante, tudo é
    prompt. Sem isso, um `modelo: x` escrito no meio do texto do prompt viraria configuração
    e sumiria do prompt — o que a pessoa escreveu deixaria de valer sem aviso.
    """
    agente = SubAgente(nome=nome)
    corpo: list[str] = []
    for linha in linhas:
        chave, separador, valor = linha.partition(":")
        if separador and not corpo and chave.strip().lower() in CHAVES:
            nome_da_chave = chave.strip().lower()
            if nome_da_chave == "skills":
                agente.skills = _lista(valor)
            elif nome_da_chave == "mcps":
                agente.mcps = _lista(valor)
            else:
                agente.modelo = valor.strip()
            continue
        corpo.append(linha)
    agente.prompt = "\n".join(corpo).strip()
    return agente


def listar(settings: Settings) -> list[SubAgente]:
    """Os sub-agentes do arquivo, na ordem em que estão escritos."""
    arquivo = caminho(settings)
    if not arquivo.is_file():
        return []
    try:
        texto = arquivo.read_text(encoding="utf-8")
    except OSError:
        return []
    return [_ler_secao(nome, linhas) for nome, linhas in _secoes(texto) if nome]


def obter(settings: Settings, nome: str) -> SubAgente | None:
    """Um agente pelo nome, sem ligar para maiúscula (`Revisor` acha `revisor`)."""
    alvo = (nome or "").strip().casefold()
    for agente in listar(settings):
        if agente.nome.casefold() == alvo:
            return agente
    return None


def _bloco(agente: SubAgente) -> str:
    linhas = [f"## {agente.nome}"]
    if agente.skills:
        linhas.append(f"skills: {', '.join(agente.skills)}")
    if agente.mcps:
        linhas.append(f"mcps: {', '.join(agente.mcps)}")
    if agente.modelo:
        linhas.append(f"modelo: {agente.modelo}")
    linhas.append("")
    linhas.append(agente.prompt.strip())
    return "\n".join(linhas).rstrip() + "\n"


CABECALHO = (
    "# Sub-agentes\n\n"
    "Cada seção é um sub-agente. O cabeçalho aceita `skills`, `mcps` e `modelo`; o resto é o\n"
    "prompt dele. Este arquivo é do **app** — o prompt do agente principal é o `AGENTS.md`\n"
    "do projeto.\n\n"
    "O sub-agente não apaga nada e não sai da pasta do projeto: isso é do motor, não daqui.\n"
)


def escrever(settings: Settings, agentes: list[SubAgente]) -> None:
    """Reescreve o arquivo inteiro, na ordem dada."""
    arquivo = caminho(settings)
    arquivo.parent.mkdir(parents=True, exist_ok=True)
    corpo = "\n".join(_bloco(agente) for agente in agentes)
    arquivo.write_text(f"{CABECALHO}\n{corpo}".rstrip() + "\n", encoding="utf-8")


def salvar(settings: Settings, agente: SubAgente) -> list[SubAgente]:
    """Cria ou substitui um agente pelo nome. Devolve a lista como ficou."""
    atuais = listar(settings)
    for indice, item in enumerate(atuais):
        if item.nome.casefold() == agente.nome.casefold():
            atuais[indice] = agente
            break
    else:
        atuais.append(agente)
    escrever(settings, atuais)
    return atuais


def esquecer(settings: Settings, nome: str) -> list[SubAgente]:
    """Tira um agente do arquivo. Devolve a lista como ficou."""
    alvo = (nome or "").strip().casefold()
    restantes = [item for item in listar(settings) if item.nome.casefold() != alvo]
    escrever(settings, restantes)
    return restantes
