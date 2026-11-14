"""Rotas dos provedores que entram por login.

Cinco perguntas, e nada além delas: **quais existem**, **o login vale**, **que modelos há em
disco**, **como entrar** e **como sair**. O login em si roda em `app/oauth_login.py` — OAuth
com PKCE para OpenAI e Google, device code para o GitHub, e o login do CLI para quem não
publica OAuth nenhum.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from .. import oauth_login, provedores, provedores_api
from ..config import Settings

router = APIRouter(tags=["provedores"])


def _settings(request: Request) -> Settings:
    return request.app.state.settings


@router.get("/provedores")
def listar(request: Request) -> list[dict]:
    return provedores.listar(_settings(request))


@router.get("/provedores/api")
def listar_api(request: Request) -> list[dict]:
    """Provedores de API independentes; contas custom ficam na aba própria."""
    return provedores_api.listar(_settings(request))


@router.post("/provedores/api/{identificador}/chave")
def salvar_chave(identificador: str, corpo: dict, request: Request) -> dict:
    try:
        estado = provedores_api.salvar(_settings(request), identificador, str(corpo.get("chave") or ""), str(corpo.get("endpoint") or ""), str(corpo.get("deployment") or ""), str(corpo.get("versao") or ""), str(corpo.get("access_id") or ""), str(corpo.get("region") or ""), str(corpo.get("session_token") or ""))
        provedores.esquecer_modelos(identificador)
        return estado
    except ValueError as erro:
        raise HTTPException(status_code=400, detail=str(erro)) from erro


@router.post("/provedores/custom")
def salvar_custom(corpo: dict, request: Request) -> dict:
    """Cria/atualiza um provedor por URL + chave (OpenAI ou Anthropic)."""
    resultado = provedores.salvar_custom(
        _settings(request),
        nome=str(corpo.get("nome") or ""),
        base=str(corpo.get("base") or ""),
        chave=str(corpo.get("chave") or ""),
        formato=str(corpo.get("formato") or "openai"),
    )
    if not resultado.get("ok"):
        raise HTTPException(status_code=400, detail=resultado.get("detalhe") or "dados inválidos")
    return resultado


@router.post("/provedores/custom/testar")
def testar_custom(corpo: dict, request: Request) -> dict:
    """Testa URL + chave sem salvar."""
    return provedores.testar_custom(
        str(corpo.get("base") or ""),
        str(corpo.get("chave") or ""),
        str(corpo.get("formato") or "openai"),
    )


@router.patch("/provedores/custom/{identificador}")
def editar_custom(identificador: str, corpo: dict, request: Request) -> dict:
    try:
        return provedores.atualizar_custom(_settings(request), identificador, nome=corpo.get("nome"), base=corpo.get("base"), formato=corpo.get("formato"), modelo=corpo.get("modelo"), acao=corpo.get("acao"))
    except (ValueError, TypeError) as erro:
        raise HTTPException(status_code=400, detail=str(erro)) from erro


@router.post("/provedores/custom/{identificador}/chaves")
def adicionar_chave_custom(identificador: str, corpo: dict, request: Request) -> dict:
    contas = oauth_login.contas(_settings(request), identificador) if identificador.startswith("custom-") else []
    chave = str(corpo.get("chave") or "").strip()
    if not contas or not chave:
        raise HTTPException(status_code=400, detail="Provedor ou chave inválida")
    oauth_login.gravar_chave(_settings(request), identificador, chave, contas[0].get("specific") or {})
    provedores.esquecer_modelos(identificador)
    return provedores.estado_custom(identificador, _settings(request))


@router.put("/provedores/custom/{identificador}/chaves/{conta}")
def substituir_chave_custom(identificador: str, conta: str, corpo: dict, request: Request) -> dict:
    try:
        provedores.substituir_chave_custom(_settings(request), identificador, conta, str(corpo.get("chave") or ""))
        return {"ok": True}
    except ValueError as erro:
        raise HTTPException(status_code=400, detail=str(erro)) from erro


@router.post("/provedores/{identificador}/testar")
def testar(identificador: str, request: Request) -> dict:
    resultado = provedores.testar(identificador, _settings(request))
    if resultado.get("detalhe") == "provedor desconhecido":
        raise HTTPException(status_code=404, detail="provedor desconhecido")
    return resultado


@router.get("/provedores/{identificador}/modelos")
def modelos(identificador: str, request: Request, atualizar: bool = False) -> dict:
    if atualizar:
        provedores.esquecer_modelos(identificador)
    return provedores.modelos(identificador, _settings(request))


@router.get("/provedores/{identificador}/saldo")
def saldo(identificador: str, request: Request) -> dict:
    return provedores.saldo_do_provedor(identificador, _settings(request))


@router.post("/provedores/{identificador}/modelos/{modelo:path}/testar")
def testar_modelo(identificador: str, modelo: str, request: Request) -> dict:
    """Pergunta ao fornecedor, com o token da conta, se ela alcança este modelo."""
    return provedores.testar_modelo(identificador, modelo, _settings(request))


@router.post("/provedores/{identificador}/entrar")
def entrar(identificador: str, request: Request) -> dict:
    resultado = provedores.entrar(identificador, _settings(request))
    if resultado.get("mensagem") == "provedor desconhecido":
        raise HTTPException(status_code=404, detail="provedor desconhecido")
    return resultado


@router.post("/provedores/{identificador}/entrar/codigo")
def concluir_pelo_codigo(identificador: str, corpo: dict, request: Request) -> dict:
    """Termina o login com o código colado (Claude mostra o código; Codex cai nisso quando a
    1455 está ocupada)."""
    return oauth_login.concluir_com_texto(
        _settings(request), identificador, str(corpo.get("codigo") or "")
    )


@router.get("/provedores/{identificador}/entrar")
def estado_do_login(identificador: str) -> dict:
    return provedores.estado_do_login(identificador)


@router.delete("/provedores/{identificador}/entrar")
def cancelar_login(identificador: str) -> dict:
    oauth_login.cancelar(identificador)
    return {"estado": "cancelado"}


@router.post("/provedores/{identificador}/sair")
def sair(identificador: str, request: Request, conta: str | None = None) -> dict:
    """Sai da conta. Com `?conta=<id>`, só daquela; sem, de todas as do provedor."""
    return provedores.sair(identificador, _settings(request), conta)


@router.post("/provedores/{identificador}/contas/{conta}/testar")
def testar_conta(identificador: str, conta: str, request: Request) -> dict:
    """Testa uma conta específica: mensagem curta ao modelo e o que voltou."""
    return provedores.testar_conta(identificador, conta, _settings(request))
