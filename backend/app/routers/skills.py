"""GET/POST /api/skills — skills instaladas e cadastradas, do jeito que a seção Skills usa.

Uma "skill" é um pacote de instruções que ensina o agente a fazer um tipo de tarefa. O Koda
conhece três origens, e a lista mistura as três:

- **projeto**: `<workspace>/.agents/skills/` — dentro da pasta de trabalho, então o agente
  consegue ler o `SKILL.md` com `read_file` e seguir as instruções;
- **global**: `~/.agents/skills/` — instalada para todos os agentes da máquina (o padrão do
  `npx skills add`), visível na interface mas fora do alcance das ferramentas de arquivo;
- **cadastrada**: criada na própria tela de Ajustes (nome, descrição e ação) e guardada em
  `data/skills.json`. Não é pasta em disco: as instruções vão **inteiras** para o prompt, e
  por isso o agente a aplica mesmo sem conseguir ler arquivo nenhum.

Nome repetido: projeto vence global. Skill cadastrada não aceita nome já usado — cadastrar
de novo com o mesmo nome é recusado com 409, em vez de sobrescrever em silêncio.

Ligada/desligada: skill nasce **ligada**; o estado fica em `data/skills-state.json` (só os
desvios do padrão) e sobrevive a reinícios. Desligada, ela continua na lista da interface,
mas sai do prompt do agente.

Sem dependência de YAML — o frontmatter que interessa são duas linhas planas, e um parse
simples não derruba a rota por causa de formatação.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

from ..config import Settings
from ..schemas import SkillCreate, SkillInfo

router = APIRouter(tags=["skills"])

#: Frente do SKILL.md: `---` + frontmatter + `---`.
_FRENTES = re.compile(r"\A---\s*\n(.*?)\n---", re.DOTALL)

#: Teto de cada ação cadastrada dentro do prompt. Skill de gente é curta; o teto existe
#: para um paste gigante não comer o contexto inteiro da conversa.
_MAX_ACAO = 4000

#: Teto do bloco todo (todas as cadastradas somadas).
_MAX_BLOCO = 12000


@dataclass(slots=True)
class Skill:
    """Uma skill descoberta (ou cadastrada), antes de virar `SkillInfo`."""

    name: str
    description: str
    scope: str
    """`None` para skill cadastrada: ela não tem arquivo em disco."""
    file: Path | None
    """Instruções da skill cadastrada; vazio nas que moram em disco (o corpo é o arquivo)."""
    action: str = ""
    """Ligada por padrão; desvios ficam em `data/skills-state.json`."""
    enabled: bool = True


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


def _salvar_estado(caminho: Path, estado: dict[str, bool]) -> None:
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


def _salvar_cadastradas(caminho: Path, itens: list[dict[str, str]]) -> None:
    caminho.parent.mkdir(parents=True, exist_ok=True)
    caminho.write_text(json.dumps(itens, ensure_ascii=False, indent=2), encoding="utf-8")


def _frontmatter(texto: str) -> dict[str, str]:
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
    campos = _frontmatter(texto)
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


def listar(
    workspace: Path,
    estado: dict[str, bool] | None = None,
    cadastradas: list[dict[str, str]] | None = None,
) -> list[Skill]:
    """Skills cadastradas, do projeto e da máquina — nesta ordem.

    As cadastradas chegam prontas (lidas de `data/skills.json` por quem tem o `settings`):
    elas não moram no projeto, então `listar` não teria como achá-las sozinha. Nome
    repetido: cadastrada primeiro, depois projeto, depois global. A cadastrada vence porque
    foi escolha explícita de quem usa; a do projeto vence a global pelo motivo de sempre
    (está ao alcance do `read_file`).
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
        for skill in listar(raiz, estado, ler_cadastradas(caminho_cadastradas(settings)))
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
            "Antes de usar uma delas, leia o SKILL.md com read_file e siga o que está lá."
        )

    globais = [skill for skill in ligadas if skill.scope == "global"]
    if globais:
        linhas = "\n".join(f"- {skill.name}: {skill.description}" for skill in globais)
        partes.append(
            "Skills instaladas na máquina (fora da pasta de trabalho):\n"
            f"{linhas}\n"
            "Elas existem e podem ser mencionadas; para usá-las de verdade, confirme o "
            "caminho em ~/.agents/skills antes de prometer o resultado."
        )

    bloco = "\n\n".join(partes)
    return bloco[:_MAX_BLOCO]


def _info(skill: Skill, workspace: Path) -> SkillInfo:
    if skill.file is None:
        caminho = ""
    else:
        try:
            caminho = str(skill.file.relative_to(workspace)).replace("\\", "/")
        except ValueError:
            caminho = str(skill.file)
    return SkillInfo(
        name=skill.name,
        description=skill.description,
        scope=skill.scope,
        path=caminho,
        enabled=skill.enabled,
    )


@router.get("/skills", response_model=list[SkillInfo])
async def skills(request: Request) -> list[SkillInfo]:
    """Lista as skills instaladas e cadastradas (cadastradas primeiro) para a tela."""
    settings: Settings = request.app.state.settings
    estado = ler_estado(caminho_estado(settings))
    return [
        _info(skill, settings.workspace_path)
        for skill in listar(
            settings.workspace_path, estado, ler_cadastradas(caminho_cadastradas(settings))
        )
    ]


@router.post("/skills", response_model=SkillInfo, status_code=201)
async def cadastrar_skill(payload: SkillCreate, request: Request) -> SkillInfo:
    """Cadastra uma skill nova (nome, descrição e ação) e devolve ela pronta.

    Recusa nome já usado por outra skill (instalada ou cadastrada) com 409: sobrescrever
    calado apagaria uma skill de verdade sem aviso. O resto da validação de campo vazio
    fica no schema (`SkillCreate`), que responde 422.
    """
    settings: Settings = request.app.state.settings
    caminho = caminho_cadastradas(settings)
    estado = ler_estado(caminho_estado(settings))
    existentes = {
        skill.name.casefold()
        for skill in listar(settings.workspace_path, estado, ler_cadastradas(caminho))
    }
    if payload.name.casefold() in existentes:
        raise HTTPException(status_code=409, detail=f'já existe uma skill chamada "{payload.name}"')

    itens = ler_cadastradas(caminho)
    itens.append(
        {"name": payload.name, "description": payload.description, "action": payload.action}
    )
    _salvar_cadastradas(caminho, itens)

    return SkillInfo(
        name=payload.name,
        description=payload.description,
        scope="cadastrada",
        path="",
        enabled=estado.get(payload.name, True),
    )


@router.post("/skills/{name}/toggle", response_model=SkillInfo)
async def alternar_skill(name: str, request: Request) -> SkillInfo:
    """Liga/desliga uma skill e guarda o estado ao lado do banco."""
    settings: Settings = request.app.state.settings
    caminho = caminho_estado(settings)
    estado = ler_estado(caminho)
    skill = next(
        (
            item
            for item in listar(
                settings.workspace_path, estado, ler_cadastradas(caminho_cadastradas(settings))
            )
            if item.name == name
        ),
        None,
    )
    if skill is None:
        raise HTTPException(status_code=404, detail="skill não encontrada")
    estado[name] = not estado.get(name, True)
    _salvar_estado(caminho, estado)
    # O objeto veio de antes da virada: ele precisa refletir o estado novo.
    skill.enabled = estado[name]
    return _info(skill, settings.workspace_path)
