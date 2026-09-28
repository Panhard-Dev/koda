"""Rotas da nuvem: aviso de atualização, changelog e download do instalador.

Quase tudo aqui é leitura, sem efeito colateral e sem dado do usuário: o front chama ao
carregar para saber se há versão nova. Se a nuvem estiver fora do ar, a resposta sai com
`disponivel: false` e o app segue funcionando — nunca um erro na cara do usuário.

A exceção é o download: ele escreve o instalador na pasta de downloads da máquina. Por
isso o endereço **não** vem do corpo do pedido — sai do último estado da nuvem, que já
passou por `link_seguro`. Cliente nenhum escolhe o que este processo baixa.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request, status

from ..deps import baixador, nuvem
from ..instalador import StatusDownload
from ..nuvem import Estado

router = APIRouter(prefix="/cloud", tags=["cloud"])


@router.get("/update", response_model=Estado)
async def update(
    request: Request,
    versao: str | None = Query(default=None, max_length=32),
    canal: str | None = Query(default=None, pattern="^(stable|beta)$"),
    refresh: bool = False,
) -> Estado:
    """Há versão nova?

    O resultado fica em memória por 15 minutos; `refresh=true` força nova consulta — é o
    que o botão "verificar de novo" da tela usa.
    """
    servico = nuvem(request)
    if not servico.cliente.ativo:
        return servico.estado
    return await servico.verificar(versao=versao, canal=canal, forcar=refresh)


@router.get("/changelog", response_model=list[dict])
async def changelog(
    request: Request,
    canal: str | None = Query(default=None, pattern="^(stable|beta)$"),
) -> list[dict]:
    """Notas das versões publicadas. Lista vazia quando a nuvem não responde."""
    servico = nuvem(request)
    if not servico.cliente.ativo:
        return []
    return await servico.changelog(canal)


@router.get("/download", response_model=StatusDownload)
async def status_do_download(request: Request) -> StatusDownload:
    """Como está o download do instalador (parado, baixando, concluído ou com erro).

    A tela usa isso para desenhar a barra de progresso; nenhum arquivo é tocado aqui.
    """
    return baixador(request).status


@router.post("/download", response_model=StatusDownload)
async def baixar_instalador(request: Request) -> StatusDownload:
    """Baixa o instalador da versão publicada para a pasta de downloads do sistema.

    O link vem do estado da nuvem, nunca do pedido. Um download por vez: pedir de novo
    enquanto ele corre devolve o mesmo progresso em vez de começar outro.
    """
    servico = nuvem(request)
    maquina = baixador(request)
    if maquina.em_andamento():
        return maquina.status

    # O estado da nuvem pode estar vazio (ninguém abriu os Ajustes nesta sessão): consulta
    # antes de dizer que não há o que baixar. Com o resultado ainda válido, isso é memória
    # — não é uma consulta nova a cada clique.
    estado = servico.estado
    if estado.atualizacao is None and servico.cliente.ativo:
        estado = await servico.verificar()

    atualizacao = estado.atualizacao
    link = (atualizacao.download_url if atualizacao else None) or ""
    if not link:
        # Sem link publicado (ou com link recusado na conferência da nuvem) não há o que
        # baixar: o aviso de versão nova continua de pé, mas o arquivo não é oferecido.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="nao_ha_link_de_download",
        )

    return maquina.iniciar(
        link,
        versao=atualizacao.latest_version if atualizacao else None,
        permitidos=servico.cliente.hosts_download,
    )
