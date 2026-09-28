"""GET /api/skills — skills instaladas, do jeito que a seção Skills usa.

Uma "skill" é uma pasta com um `SKILL.md` (frontmatter com `name` e `description`) que
ensina o agente a fazer um tipo de tarefa. A descoberta olha dois lugares, na ordem:

- **projeto**: `<workspace>/.agents/skills/` — dentro da pasta de trabalho, então o
  agente consegue ler o arquivo com `read_file` e seguir as instruções;
- **global**: `~/.agents/skills/` — instalada para todos os agentes da máquina (o
  padrão do `npx skills add`), visível na interface mas fora do alcance das
  ferramentas de arquivo.

Nome repetido: o do projeto vence. Sem dependência de YAML — o frontmatter que interessa
são duas linhas planas, e um parse simples não derruba a rota por causa de formatação.

Ligada/desligada: skill instalada nasce **ligada**; o estado fica em
`data/skills-state.json` (só os desvios do padrão) e sobrevive a reinícios. Desligada,
ela continua na lista da interface, mas sai do prompt do agente.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

from ..config import Settings
from ..schemas import SkillInfo

router = APIRouter(tags=["skills"])

#: Frente do SKILL.md: `---` + frontmatter + `---`.
_FRENTES = re.compile(r"\A---\s*\n(.*?)\n---", re.DOTALL)


@dataclass(slots=True)
class Skill:
    """Uma skill descoberta em disco, antes de virar `SkillInfo`."""

    name: str
    description: str
    scope: str
    file: Path
    """Ligada por padrão; desvios ficam em `data/skills-state.json`."""
    enabled: bool = True


def caminho_estado(settings: Settings) -> Path:
    """Onde ficam os desvios do padrão (`ligada`), ao lado do banco."""
    return settings.database_path.parent / "skills-state.json"


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


def _frontmatter(texto: str) -> dict[str, str]:
    """`name` e `description` da frente do SKILL.md (linhas planas `chave: valor`)."""
    campos: dict[str, str] = {}
    match = _FRENTES.match(texto)
    if not match:
        return campos
    for linha in match.group(1).splitlines():
        chave, separador, valor = linha.partition(":")
        if separador and chave.strip() in ("name", "description"):
            campos[chave.strip()] = valor.strip().strip("'\"")
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


def listar(workspace: Path, estado: dict[str, bool] | None = None) -> list[Skill]:
    """Skills do projeto e da máquina; nome repetido, fica a do projeto."""
    estado = estado or {}
    achadas: dict[str, Skill] = {}
    for pasta in _pastas(Path(workspace) / ".agents" / "skills"):
        skill = _ler(pasta / "SKILL.md", "projeto", estado)
        if skill:
            achadas[skill.name] = skill
    global_skills = Path.home() / ".agents" / "skills"
    for pasta in _pastas(global_skills):
        skill = _ler(pasta / "SKILL.md", "global", estado)
        if skill and skill.name not in achadas:
            achadas[skill.name] = skill
    return list(achadas.values())


def indice_para_agente(settings: Settings) -> str:
    """Bloco do prompt do sistema com as skills ligadas que o agente pode ler.

    Só as do projeto entram: estão dentro da pasta de trabalho, então `read_file`
    alcança o `SKILL.md`. Desligadas não entram. Vazio quando não resta nenhuma —
    o bloco não existe na conversa.
    """
    estado = ler_estado(caminho_estado(settings))
    do_projeto = [
        skill
        for skill in listar(settings.workspace_path, estado)
        if skill.scope == "projeto" and skill.enabled
    ]
    if not do_projeto:
        return ""
    linhas = "\n".join(
        f"- {skill.name}: {skill.description} (instruções: .agents/skills/{skill.file.parent.name}/SKILL.md)"
        for skill in do_projeto
    )
    return (
        "Skills instaladas neste projeto:\n"
        f"{linhas}\n"
        "Quando a tarefa do usuário combinar com uma skill, leia o SKILL.md dela com "
        "read_file antes de responder e siga as instruções que estiverem lá."
    )


def _info(skill: Skill, workspace: Path) -> SkillInfo:
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
    """Lista as skills instaladas (projeto primeiro) para a seção Skills."""
    settings: Settings = request.app.state.settings
    estado = ler_estado(caminho_estado(settings))
    return [
        _info(skill, settings.workspace_path)
        for skill in listar(settings.workspace_path, estado)
    ]


@router.post("/skills/{name}/toggle", response_model=SkillInfo)
async def alternar_skill(name: str, request: Request) -> SkillInfo:
    """Liga/desliga uma skill e guarda o estado ao lado do banco."""
    settings: Settings = request.app.state.settings
    caminho = caminho_estado(settings)
    estado = ler_estado(caminho)
    skill = next(
        (item for item in listar(settings.workspace_path, estado) if item.name == name),
        None,
    )
    if skill is None:
        raise HTTPException(status_code=404, detail="skill não encontrada")
    estado[name] = not estado.get(name, True)
    _salvar_estado(caminho, estado)
    # O objeto veio de antes da virada: ele precisa refletir o estado novo.
    skill.enabled = estado[name]
    return _info(skill, settings.workspace_path)
