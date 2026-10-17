"""Projetos (pastas de verdade) e permissões.

O que o prompt box precisa saber para abrir uma pasta e para decidir quando pedir
permissão. Nada aqui adivinha caminho: ou a pasta existe no disco, ou a resposta diz que
não existe.
"""

from __future__ import annotations

import base64
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse

from .. import projects
from ..transcricao import transcrever
from ..video import QUADROS_PADRAO, analisar, elementos
from ..contracts import mudancas
from ..policy import approvals
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


#: O `media_type` de cada extensão de vídeo que o editor lista. `.mov` é quicktime e
#: `.ogv` é ogg: o `<video>` aceita os dois, e errar o tipo aqui faria o navegador
#: baixar o arquivo em vez de tocar.
_MIDIA_DE_VIDEO = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".m4v": "video/mp4",
    ".ogv": "video/ogg",
}


@router.get("/fs/videos")
async def videos(
    request: Request, caminho: str | None = Query(default=None, max_length=4096)
) -> dict[str, object]:
    """Pastas e vídeos de um caminho, para o seletor do editor de vídeo."""
    return await call(projects.navegar_videos, caminho)


@router.get("/fs/video")
async def video(request: Request, caminho: str = Query(max_length=4096)) -> FileResponse:
    """Os bytes de um vídeo do disco — o seletor do editor entrega o caminho, e o
    `<video>` toca daqui.

    Passa pelo backend, e não por `asset://`/`file://`, por uma razão medida: o
    `<video>` toca de qualquer origem, mas **não** o `<canvas>` que fotografa os frames —
    origem cruzada mancha a tela e o `toDataURL` falha. Servindo os bytes daqui, o front
    transforma em `blob:` (origem própria) e frames e waveform funcionam iguais no
    navegador e no app.
    """
    alvo = Path(caminho).expanduser()
    try:
        alvo = alvo.resolve()
        if not alvo.is_file() or alvo.suffix.lower() not in _MIDIA_DE_VIDEO:
            raise ValueError
    except (OSError, ValueError):
        raise HTTPException(
            status_code=404, detail="esse arquivo de vídeo não existe nesta máquina"
        ) from None
    return FileResponse(alvo, media_type=_MIDIA_DE_VIDEO[alvo.suffix.lower()])


#: Teto do áudio aceito na transcrição: 64 MB de WAV 16k mono dá ~35 minutos de fala.
_TETO_DO_AUDIO = 64 * 1024 * 1024


#: O que separa um quadro do outro na resposta JSON destas rotas.
_MARCA_DE_QUADRO = "KODA_QUADRO:"


def _quadros_para_json(resultado: dict[str, object]) -> dict[str, object]:
    """Troca os quadros em bytes pelo mesmo JPEG em base64, dentro do resultado.

    A rota é HTTP/JSON: bytes crus não serializam (o `dump_json` estoura com "invalid
    utf-8"). O motor devolve bytes de propósito — é o formato que o modelo consome como
    `data:` URL —, então quem converte para trafegar é aqui, na borda.

    Os marcadores `KODA_QUADRO:` são **mantidos como prefixo** da linha em `momentos`, para
    quem consome (a interface, um MCP, um teste) reconhecer a imagem pelo mesmo marcador que
    o resto do Koda usa.
    """
    for momento in resultado.get("momentos") or []:
        if not isinstance(momento, dict):
            continue
        quadro = momento.get("quadro")
        if isinstance(quadro, (bytes, bytearray)):
            momento["jpeg"] = base64.b64encode(bytes(quadro)).decode("ascii")
            momento["quadro"] = f"{_MARCA_DE_QUADRO}image/jpeg;base64,{momento['jpeg']}"
    quadros = resultado.get("quadros")
    if isinstance(quadros, list):
        resultado["quadros"] = [
            f"{_MARCA_DE_QUADRO}image/jpeg;base64,"
            f"{base64.b64encode(bytes(q)).decode('ascii')}"
            if isinstance(q, (bytes, bytearray))
            else q
            for q in quadros
        ]
    return resultado


@router.get("/fs/video/elementos")
async def elementos_do_video(
    request: Request,
    caminho: str = Query(max_length=4096),
    quadros: int = Query(default=QUADROS_PADRAO, ge=1, le=24),
    transcricao: bool = True,
) -> dict[str, object]:
    """Metadados, quadros e transcrição de um vídeo do disco.

    É o mesmo motor que entrega os elementos à IA quando alguém **manda** um vídeo na
    conversa (ver `_turns` em `routers/chat.py`). Fica exposto para o front usar e para
    conferir na mão. Roda em thread: a primeira transcrição de um vídeo leva minutos
    de CPU, e a rota de eventos não pode travar nesse tempo.

    Os quadros saem como `data:image/jpeg;base64` — **nada é gravado no disco**.
    """
    settings = request.app.state.settings
    pasta = Path(settings.workspace_path) / ".koda-video"
    try:
        return _quadros_para_json(await call(elementos, caminho, pasta, quadros, transcricao))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="esse vídeo não existe nesta máquina") from None
    except Exception as erro:
        raise HTTPException(
            status_code=400, detail=f"não consegui ler os elementos do vídeo: {erro}"
        ) from None


@router.get("/video-analizar")
async def video_analizar(
    request: Request,
    caminho: str = Query(max_length=4096),
    quadros: int = Query(default=QUADROS_PADRAO, ge=1, le=24),
    pergunta: str = Query(default="", max_length=2000),
) -> dict[str, object]:
    """Analisa um vídeo do disco: metadados, transcrição e os **momentos**.

    Cada momento é `{tempo_s, quadro, fala}` — o quadro gerado, o segundo em que ele
    está e o que era falado naquele instante. É o formato que a IA consome de uma vez,
    sem cruzar lista de quadros com lista de falas. `pergunta` é o que a pessoa quer
    com o vídeo, e volta no resultado: a resposta é para **ele**, não para o vídeo em
    geral. Roda em thread — a primeira transcrição leva minutos de CPU.

    Os quadros saem como `data:image/jpeg;base64`, em memória.
    """
    settings = request.app.state.settings
    pasta = Path(settings.workspace_path) / ".koda-video"
    try:
        return _quadros_para_json(await call(analisar, caminho, pasta, quadros, pergunta))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="esse vídeo não existe nesta máquina") from None
    except Exception as erro:
        raise HTTPException(
            status_code=400, detail=f"não consegui analisar o vídeo: {erro}"
        ) from None


@router.post("/fs/transcricao")
async def transcrever_video(request: Request) -> dict[str, object]:
    """Transcreve a fala de um WAV 16 kHz mono — a coluna do editor de vídeo.

    O áudio vem do **próprio front**: ele já decodifica o arquivo inteiro para desenhar a
    onda, e reexportar um WAV 16k mono daí evita ffmpeg no servidor — e evita que o
    backend precise do arquivo de vídeo em si. Roda em thread porque o Whisper em CPU
    leva minutos, e a rota de eventos não pode travar nesse tempo.
    """
    corpo = await request.body()
    if len(corpo) < 44:
        raise HTTPException(status_code=400, detail="áudio vazio")
    if len(corpo) > _TETO_DO_AUDIO:
        raise HTTPException(status_code=413, detail="árudio grande demais (teto de 64 MB)")
    return {"segmentos": await call(transcrever, corpo)}


# --------------------------------------------------- o painel de código (aba Código)


@router.get("/fs/arvore")
async def arvore(caminho: str = Query(max_length=4096)) -> dict[str, object]:
    """Os filhos de **uma** pasta, para a árvore do painel de código.

    Um nível por vez de propósito: a árvore inteira de um projeto de verdade não cabe numa
    tela, e trazê-la inteira para mostrar o que ninguém vai ler travaria a tela à toa.
    """
    try:
        return await call(projects.arvore, caminho)
    except NotADirectoryError:
        raise HTTPException(status_code=404, detail="essa pasta não existe nesta máquina") from None
    except OSError:
        raise HTTPException(status_code=400, detail="não consegui abrir essa pasta") from None


@router.get("/fs/arquivo")
async def arquivo(caminho: str = Query(max_length=4096)) -> dict[str, object]:
    """O texto de um arquivo, para o visualizador do painel de código.

    Devolve o conteúdo real — o mesmo que o agente lê. `truncado: true` quando o arquivo
    passou do teto do painel: é o que permite a tela dizer que cortou em vez de mentir que
    aquilo é o arquivo inteiro.

    Vai junto a **mudança** que a IA fez neste arquivo nesta execução (`null` quando não
    mexeu). É o que o visualizador pinta de verde e de vermelho. Vem no mesmo pedido, e não
    em outro, porque dois pedidos dariam duas chances de a tela mostrar o código de um
    arquivo com o diff de outro.
    """
    try:
        lido = await call(projects.ler_arquivo, caminho)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="esse arquivo não existe") from None
    except OSError:
        raise HTTPException(status_code=400, detail="não consegui ler esse arquivo") from None
    lido["mudanca"] = await call(mudancas.de, str(lido["caminho"]))
    return lido


@router.get("/fs/mudancas")
async def mudancas_da_execucao() -> dict[str, object]:
    """O que a IA mudou nos arquivos nesta execução do Koda.

    Sem as linhas do diff: é o que marca as linhas da árvore, e para isso bastam o caminho e
    a contagem. As linhas vêm em `/fs/arquivo`, só do arquivo que estiver aberto.
    """
    return {"itens": await call(mudancas.listar)}


@router.get("/fs/mudancas/chamada")
async def mudanca_de_uma_chamada(id: str = Query(max_length=200)) -> dict[str, object]:
    """O que **uma** chamada de ferramenta mudou, com as linhas do diff.

    É o que o cartão da ferramenta mostra na conversa. Por chamada, e não por arquivo: num
    arquivo escrito três vezes, o acumulado apareceria igual nos três cartões.

    Lista vazia é resposta legítima — chamada que não escreveu nada, ou conversa reaberta
    depois de o app fechar (o registro vive no processo, ver `contracts/mudancas.py`).
    """
    return {"itens": await call(mudancas.da_chamada, id)}


@router.delete("/fs/mudancas")
async def esquecer_mudancas() -> dict[str, object]:
    """Esquece as marcas. O arquivo no disco **não** é tocado — sai só o registro."""
    return {"removidas": await call(mudancas.limpar)}


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
