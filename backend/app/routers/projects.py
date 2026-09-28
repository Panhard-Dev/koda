"""Projetos (pastas de verdade) e permissões.

O que o prompt box precisa saber para abrir uma pasta e para decidir quando pedir
permissão. Nada aqui adivinha caminho: ou a pasta existe no disco, ou a resposta diz que
não existe.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request

from .. import approvals, projects
from ..config import Settings
from ..db import Database
from ..deps import call, database
from ..schemas import ApprovalMode, Project, ProjectInput, ProjectNew, ProjectsEstado

router = APIRouter(tags=["projects"])


def _padrao(request: Request) -> str:
    settings: Settings = request.app.state.settings
    return str(settings.workspace_path)


def _estado(db: Database, padrao: str) -> ProjectsEstado:
    with db.connect() as conn:
        lista = projects.listar(conn)
        atual = projects.ativo(conn)
        modo = approvals.modo(conn)
    return ProjectsEstado(
        projetos=[Project(**item) for item in lista],  # type: ignore[arg-type]
        ativo_id=str(atual["id"]) if atual else None,
        padrao=padrao,
        permissao=modo,  # type: ignore[arg-type]
    )


@router.get("/projects", response_model=ProjectsEstado)
async def listar(request: Request) -> ProjectsEstado:
    """Projetos salvos, qual está aberto e a pasta padrão desta máquina."""
    db = database(request)
    return await call(_estado, db, _padrao(request))


@router.post("/projects", response_model=ProjectsEstado, status_code=201)
async def usar(request: Request, payload: ProjectInput) -> ProjectsEstado:
    """«Usar pasta existente»: registra a pasta escolhida e abre ela."""
    db = database(request)

    def acao() -> ProjectsEstado:
        with db.connect() as conn:
            try:
                projects.usar(conn, payload.caminho, payload.nome)
            except NotADirectoryError:
                raise HTTPException(
                    status_code=400, detail="essa pasta não existe nesta máquina"
                ) from None
        return _estado(db, _padrao(request))

    return await call(acao)


@router.post("/projects/novo", response_model=ProjectsEstado, status_code=201)
async def criar(request: Request, payload: ProjectNew) -> ProjectsEstado:
    """«Começar do zero»: cria a pasta dentro da pasta-pai escolhida."""
    db = database(request)

    def acao() -> ProjectsEstado:
        with db.connect() as conn:
            try:
                projects.criar(conn, payload.pasta_pai, payload.nome)
            except NotADirectoryError:
                raise HTTPException(
                    status_code=400, detail="a pasta onde criar não existe"
                ) from None
            except ValueError as erro:
                raise HTTPException(status_code=400, detail=str(erro)) from None
        return _estado(db, _padrao(request))

    return await call(acao)


@router.post("/projects/{project_id}/ativo", response_model=ProjectsEstado)
async def ativar(request: Request, project_id: str) -> ProjectsEstado:
    db = database(request)

    def acao() -> ProjectsEstado:
        with db.connect() as conn:
            if projects.definir_ativo(conn, project_id) is None:
                raise HTTPException(status_code=404, detail="projeto não encontrado")
        return _estado(db, _padrao(request))

    return await call(acao)


@router.post("/projects/soltar", response_model=ProjectsEstado)
async def soltar(request: Request) -> ProjectsEstado:
    """Fecha o projeto: a conversa volta a ser solta, sem contexto de pasta."""
    db = database(request)

    def acao() -> ProjectsEstado:
        with db.connect() as conn:
            projects.soltar(conn)
        return _estado(db, _padrao(request))

    return await call(acao)


@router.delete("/projects/{project_id}", response_model=ProjectsEstado)
async def esquecer(request: Request, project_id: str) -> ProjectsEstado:
    """Tira da lista. A pasta no disco fica onde está — apagar arquivo é outra conversa."""
    db = database(request)

    def acao() -> ProjectsEstado:
        with db.connect() as conn:
            projects.esquecer(conn, project_id)
        return _estado(db, _padrao(request))

    return await call(acao)


@router.get("/fs/pastas")
async def pastas(
    request: Request, caminho: str | None = Query(default=None, max_length=4096)
) -> dict[str, object]:
    """Subpastas de um caminho, para escolher a pasta sem diálogo do sistema."""
    return await call(projects.navegar, caminho)


# ------------------------------------------------------------------ permissões


@router.get("/permissions")
async def permissoes(request: Request) -> dict[str, object]:
    """Modo em vigor e o que já foi respondido «para sempre»."""
    db = database(request)

    def acao() -> dict[str, object]:
        with db.connect() as conn:
            return {
                "modo": approvals.modo(conn),
                "modos": list(approvals.MODOS),
                "regras": approvals.regras(conn),
            }

    return await call(acao)


@router.put("/permissions")
async def definir_permissao(request: Request, payload: ApprovalMode) -> dict[str, object]:
    db = database(request)

    def acao() -> dict[str, object]:
        with db.connect() as conn:
            modo = approvals.definir_modo(conn, payload.modo)
            return {"modo": modo, "regras": approvals.regras(conn)}

    return await call(acao)


@router.delete("/permissions/regras")
async def limpar_regras(request: Request) -> dict[str, object]:
    db = database(request)

    def acao() -> dict[str, object]:
        with db.connect() as conn:
            removidas = approvals.limpar(conn)
        return {"ok": True, "removidas": removidas}

    return await call(acao)


@router.delete("/permissions/regras/{regra_id}")
async def esquecer_regra(request: Request, regra_id: str) -> dict[str, object]:
    db = database(request)

    def acao() -> dict[str, object]:
        with db.connect() as conn:
            if not approvals.esquecer(conn, regra_id):
                raise HTTPException(status_code=404, detail="regra não encontrada")
        return {"ok": True}

    return await call(acao)
