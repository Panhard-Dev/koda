"""Skills: os pacotes de **instruções** que o agente lê e aplica.

Uma skill não executa nada — ela ensina. São três origens, e a diferença importa na hora de
aplicar:

- **projeto**: `<workspace>/.agents/skills/<nome>/SKILL.md`. Está dentro da pasta de trabalho,
  então o `read_file` também alcança.
- **global**: `~/.agents/skills/<nome>/SKILL.md`. Instalada para a máquina inteira — **fora**
  da pasta de trabalho, e por isso o `read_file` **não** a alcança.
- **cadastrada**: criada na tela de Ajustes e guardada em `data/skills.json`. Não é pasta em
  disco: as instruções vivem no arquivo do Koda.

O prompt do sistema já **anuncia** as skills ligadas (`indice_para_agente`), com o caminho
das que estão em disco. Mas anunciar não é aplicar: o agente precisa das instruções na mão
para segui-las. É o que `SkillStore.instrucoes()` faz, e é ele que a ferramenta `use_skill`
chama — inclusive para as **globais**, que o `read_file` não alcança, e para as
**cadastradas**, que não têm arquivo nenhum.

Este módulo é infraestrutura de raiz: não importa camada nenhuma do projeto.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from .config import Settings

#: Frente do SKILL.md: `---` + frontmatter + `---`.
_FRENTES = re.compile(r"\A---\s*\n(.*?)\n---", re.DOTALL)

#: Teto de cada ação cadastrada dentro do prompt. Skill de gente é curta; o teto existe
#: para um paste gigante não comer o contexto inteiro da conversa.
_MAX_ACAO = 4000

#: Teto do bloco todo (todas as cadastradas somadas) no prompt do sistema.
_MAX_BLOCO = 12000

#: Teto das instruções devolvidas por `use_skill`. É maior que o do prompt porque aqui é a
#: skill **em uso**, não o índice — mas ainda cabe num turno sem estourar o contexto.
MAX_INSTRUCOES = 60_000


@dataclass(slots=True)
class Skill:
    """Uma skill descoberta (ou cadastrada), antes de virar resposta de API."""

    name: str
    description: str
    scope: str
    """`None` para skill cadastrada: ela não tem arquivo em disco."""
    file: Path | None
    """Instruções da skill cadastrada; vazio nas que moram em disco (o corpo é o arquivo)."""
    action: str = ""
    """Ligada por padrão; desvios ficam em `data/skills-state.json`."""
    enabled: bool = True


class SkillNaoEncontrada(Exception):
    """Não existe skill com esse nome (nem instalada, nem cadastrada)."""


class SkillDesligada(Exception):
    """A skill existe, mas está desligada na tela — o agente não deve usá-la."""


def caminho_estado(settings: Settings) -> Path:
    """Onde ficam os desvios do padrão (`ligada`), ao lado do banco."""
    return settings.database_path.parent / "skills-state.json"


def caminho_cadastradas(settings: Settings) -> Path:
    """Onde ficam as skills cadastradas na tela, ao lado do banco."""
    return settings.database_path.parent / "skills.json"


def ler_estado(caminho: Path) -> dict[str, bool]:
    """Nome -> ligada. Arquivo ausente ou ilegível = tudo no padrão (ligada)."""
    try:
        dados = json.loads(caminho.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(dados, dict):
        return {}
    return {str(chave): bool(valor) for chave, valor in dados.items()}


def salvar_estado(caminho: Path, estado: dict[str, bool]) -> None:
    caminho.parent.mkdir(parents=True, exist_ok=True)
    caminho.write_text(json.dumps(estado, ensure_ascii=False, indent=2), encoding="utf-8")


def ler_cadastradas(caminho: Path) -> list[dict[str, str]]:
    """As skills cadastradas, na ordem em que foram criadas.

    Arquivo ausente ou ilegível = nenhuma. Item sem nome ou sem ação é descartado: é
    registro quebrado, e listar assim mesmo daria uma skill que não faz nada.
    """
    try:
        dados = json.loads(caminho.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(dados, list):
        return []
    itens: list[dict[str, str]] = []
    for item in dados:
        if not isinstance(item, dict):
            continue
        nome = str(item.get("name", "")).strip()
        acao = str(item.get("action", "")).strip()
        if not nome or not acao:
            continue
        itens.append(
            {
                "name": nome,
                "description": str(item.get("description", "")),
                "action": acao,
            }
        )
    return itens


def salvar_cadastradas(caminho: Path, itens: list[dict[str, str]]) -> None:
    caminho.parent.mkdir(parents=True, exist_ok=True)
    caminho.write_text(json.dumps(itens, ensure_ascii=False, indent=2), encoding="utf-8")


def frontmatter(texto: str) -> dict[str, str]:
    """`name` e `description` da frente do SKILL.md (linhas planas `chave: valor`).

    Escalar de bloco entra também: `description: >-` seguido de linhas indentadas é o que o
    gerador de skills escreve quando a descrição passa de uma linha. Sem isto, a descrição
    chegava ao agente como o marcador cru (`>-`) — e o agente não tinha como saber quando
    usar a skill.
    """
    campos: dict[str, str] = {}
    match = _FRENTES.match(texto)
    if not match:
        return campos
    linhas = match.group(1).splitlines()
    i = 0
    while i < len(linhas):
        chave, separador, valor = linhas[i].partition(":")
        chave = chave.strip()
        valor = valor.strip()
        if separador and chave in ("name", "description"):
            if valor in (">", ">-", ">+", "|", "|-", "|+"):
                corpo: list[str] = []
                i += 1
                while i < len(linhas) and (not linhas[i].strip() or linhas[i][:1] in (" ", "\t")):
                    corpo.append(linhas[i].strip())
                    i += 1
                juntar = "\n" if valor.startswith("|") else " "
                campos[chave] = juntar.join(p for p in corpo if p).strip()
                continue
            campos[chave] = valor.strip("'\"")
        i += 1
    return campos


def _ler(arquivo: Path, escopo: str, estado: dict[str, bool]) -> Skill | None:
    try:
        texto = arquivo.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    campos = frontmatter(texto)
    nome = campos.get("name") or arquivo.parent.name
    return Skill(
        name=nome,
        description=campos.get("description", ""),
        scope=escopo,
        file=arquivo,
        enabled=estado.get(nome, True),
    )


def _pastas(raiz: Path) -> list[Path]:
    """Pastas de skill sob `raiz`, uma por subpasta que tenha `SKILL.md`."""
    try:
        return sorted(pasta for pasta in raiz.iterdir() if (pasta / "SKILL.md").is_file())
    except OSError:
        return []


def _do_catalogo(raiz: Path, estado: dict[str, bool]) -> list[Skill]:
    """As skills que vieram com o Koda, na ordem do catálogo `skills/skills.json`.

    O catálogo diz **quais** pastas viajam (e em que ordem); o conteúdo vem do `SKILL.md` de
    cada uma — o arquivo é que o agente lê, então é ele que manda no nome e na descrição.

    Entrada apontando para pasta sem `SKILL.md` é registrada e ignorada, em vez de sumir
    calada: catálogo torto vira "a skill não aparece" e ninguém descobre por quê.
    """
    try:
        itens = json.loads((raiz / "skills.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(itens, list):
        return []
    achadas: list[Skill] = []
    for item in itens:
        nome_pasta = str(item.get("pasta", "")).strip() if isinstance(item, dict) else ""
        if not nome_pasta:
            continue
        arquivo = raiz / nome_pasta / "SKILL.md"
        skill = _ler(arquivo, "global", estado)
        if skill is None:
            print(f"[koda] o catálogo lista '{nome_pasta}', mas {arquivo} não existe", flush=True)
            continue
        achadas.append(skill)
    return achadas


def listar(
    workspace: Path,
    estado: dict[str, bool] | None = None,
    cadastradas: list[dict[str, str]] | None = None,
    embutidas: Path | None = None,
) -> list[Skill]:
    """Skills cadastradas, do projeto, as do Koda e as globais da máquina — nesta ordem.

    As cadastradas chegam prontas (lidas de `data/skills.json` por quem tem o `settings`):
    elas não moram no projeto, então `listar` não teria como achá-las sozinha. Nome
    repetido: vence a primeira que aparecer — cadastrada, depois projeto, depois as do Koda,
    depois as globais. A cadastrada vence porque foi escolha explícita de quem usa; a do
    projeto vence a global pelo motivo de sempre (está ao alcance do `read_file`).

    `embutidas` é a pasta `skills/` que viaja com o Koda (`Settings.skills_dir`): as pastas
    que o instalador traz, listadas no catálogo `skills.json`. Elas entram **antes** das
    globais — são o que o app entrega, e uma cópia velha em `~/.agents/skills` não pode
    ganhar da versão que foi no pacote.

    Elas contam como `global` de propósito. O escopo é contrato de produto (`projeto` /
    `global` / `cadastrada` — está no schema da API e na tela), e o comportamento que
    interessa é o das globais: entram no prompt **por nome e descrição**, e o `use_skill` lê
    o arquivo na hora. Um quarto escopo só para trocar a etiqueta mexeria no schema e na
    interface sem mudar nada do que o agente faz.
    """
    estado = estado or {}
    achadas: dict[str, Skill] = {}
    for item in cadastradas or []:
        nome = item["name"]
        achadas[nome] = Skill(
            name=nome,
            description=item["description"],
            scope="cadastrada",
            file=None,
            action=item["action"],
            enabled=estado.get(nome, True),
        )
    for pasta in _pastas(Path(workspace) / ".agents" / "skills"):
        skill = _ler(pasta / "SKILL.md", "projeto", estado)
        if skill and skill.name not in achadas:
            achadas[skill.name] = skill
    # As do Koda vêm **antes** das globais da máquina: elas são o que o app entrega, e sem
    # esta ordem uma cópia antiga em `~/.agents/skills` ganharia da versão que foi no
    # pacote — o instalado pareceria desatualizado com a skill certa ao lado.
    if embutidas is not None:
        for skill in _do_catalogo(Path(embutidas), estado):
            if skill.name not in achadas:
                achadas[skill.name] = skill
    global_skills = Path.home() / ".agents" / "skills"
    for pasta in _pastas(global_skills):
        skill = _ler(pasta / "SKILL.md", "global", estado)
        if skill and skill.name not in achadas:
            achadas[skill.name] = skill
    return list(achadas.values())


def indice_para_agente(settings: Settings, workspace: Path | None = None) -> str:
    """Bloco do prompt do sistema com as skills ligadas que o agente pode usar.

    O `workspace` é o da conversa (o projeto escolhido no prompt box), não o padrão do
    servidor: era essa troca que fazia a skill do projeto sumir do prompt quando a conversa
    abria em outra pasta.

    As **cadastradas** entram com as instruções inteiras — não há arquivo para o agente ler,
    então o texto tem de estar aqui. As de **projeto** entram por nome e caminho, com a
    ordem de ler o `SKILL.md` antes de usar (está dentro do workspace, o `read_file`
    alcança). As **globais** entram por nome e descrição, só para o agente saber que
    existem. Vazio quando não há nenhuma ligada — o bloco não aparece na conversa.
    """
    estado = ler_estado(caminho_estado(settings))
    raiz = Path(workspace) if workspace is not None else settings.workspace_path
    ligadas = [
        skill
        for skill in listar(
            raiz,
            estado,
            ler_cadastradas(caminho_cadastradas(settings)),
            settings.skills_dir,
        )
        if skill.enabled
    ]
    if not ligadas:
        return ""

    partes: list[str] = []
    gasto = 0
    cadastradas = [skill for skill in ligadas if skill.scope == "cadastrada"]
    if cadastradas:
        linhas: list[str] = []
        for skill in cadastradas:
            acao = skill.action[: _MAX_ACAO - gasto]
            if not acao:
                break
            gasto += len(acao)
            linhas.append(f"- {skill.name}: {skill.description}\n  Instruções: {acao}")
        partes.append(
            "Skills cadastradas (instruções completas — aplique quando o pedido combinar):\n"
            + "\n".join(linhas)
        )

    do_projeto = [skill for skill in ligadas if skill.scope == "projeto"]
    if do_projeto:
        linhas = "\n".join(
            f"- {skill.name}: {skill.description} "
            f"(instruções: .agents/skills/{skill.file.parent.name}/SKILL.md)"
            for skill in do_projeto
            if skill.file is not None
        )
        partes.append(
            "Skills instaladas neste projeto:\n"
            f"{linhas}\n"
            "Antes de usar uma delas, chame `use_skill` com o nome dela (ou leia o SKILL.md "
            "com read_file) e siga o que está lá."
        )

    globais = [skill for skill in ligadas if skill.scope == "global"]
    if globais:
        linhas = "\n".join(f"- {skill.name}: {skill.description}" for skill in globais)
        partes.append(
            "Skills instaladas na máquina (fora da pasta de trabalho):\n"
            f"{linhas}\n"
            "Para usá-las, chame `use_skill` com o nome — ela mora fora do workspace e o "
            "`read_file` não a alcança."
        )

    bloco = "\n\n".join(partes)
    return bloco[:_MAX_BLOCO]


class SkillStore:
    """Carrega as instruções de uma skill **em uso**, de qualquer uma das três origens.

    É o que a ferramenta `use_skill` usa. Existe como objeto (e não como função solta) pelo
    mesmo motivo do store de anexos: o workspace da **conversa** e o `settings` da execução
    precisam viajar juntos até o despacho, e o despacho não conhece configuração.
    """

    def __init__(self, settings: Settings, workspace: Path | None = None) -> None:
        self._settings = settings
        self._workspace = workspace

    def _workspace_de_trabalho(self) -> Path:
        return Path(self._workspace) if self._workspace is not None else self._settings.workspace_path

    def todas(self) -> list[Skill]:
        return listar(
            self._workspace_de_trabalho(),
            ler_estado(caminho_estado(self._settings)),
            ler_cadastradas(caminho_cadastradas(self._settings)),
            self._settings.skills_dir,
        )

    def nomes(self) -> list[str]:
        """Nomes das skills ligadas — é o que a mensagem de erro oferece como alternativa."""
        return [skill.name for skill in self.todas() if skill.enabled]

    def instrucoes(self, nome: str) -> str:
        """As instruções da skill, prontas para o modelo seguir.

        Levanta `SkillNaoEncontrada` ou `SkillDesligada` — o despacho transforma as duas
        numa mensagem que o modelo consegue usar (com os nomes disponíveis), em vez de um
        erro seco.
        """
        alvo = (nome or "").strip()
        if not alvo:
            raise SkillNaoEncontrada("")
        procura = alvo.casefold()
        for skill in self.todas():
            if skill.name.casefold() != procura:
                continue
            if not skill.enabled:
                raise SkillDesligada(skill.name)
            return self._corpo(skill)
        raise SkillNaoEncontrada(alvo)

    def _corpo(self, skill: Skill) -> str:
        if skill.file is None:
            # Cadastrada: as instruções são o que a tela guardou.
            return skill.action[:MAX_INSTRUCOES]
        try:
            texto = skill.file.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            raise SkillNaoEncontrada(f"{skill.name} (arquivo ilegível: {exc})") from exc
        return texto[:MAX_INSTRUCOES]

    def escopo_de(self, nome: str) -> str:
        """A origem da skill (`projeto`/`global`/`cadastrada`) — vai na mensagem do modelo."""
        procura = (nome or "").strip().casefold()
        for skill in self.todas():
            if skill.name.casefold() == procura:
                return skill.scope
        return ""
