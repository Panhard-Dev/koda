"""Rotas dos provedores que entram por login.

Cinco perguntas, e nada além delas: **quais existem**, **o login vale**, **que modelos há em
disco**, **como entrar** e **como sair**. O login em si roda em `app/oauth_login.py` — OAuth
com PKCE para OpenAI e Google, device code para o GitHub, e o login do CLI para quem não
publica OAuth nenhum.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from .. import oauth_login, provedores
from ..config import Settings

router = APIRouter(tags=["provedores"])


def _settings(request: Request) -> Settings:
    return request.app.state.settings


@router.get("/provedores")
def listar(request: Request) -> list[dict]:
    return provedores.listar(_settings(request))


@router.post("/provedores/{identificador}/testar")
def testar(identificador: str, request: Request) -> dict:
    resultado = provedores.testar(identificador, _settings(request))
    if resultado.get("detalhe") == "provedor desconhecido":
        raise HTTPException(status_code=404, detail="provedor desconhecido")
    return resultado


@router.get("/provedores/{identificador}/modelos")
def modelos(identificador: str, request: Request) -> dict:
    return provedores.modelos(identificador, _settings(request))


@router.get("/provedores/{identificador}/saldo")
def saldo(identificador: str, request: Request) -> dict:
    return provedores.saldo_do_provedor(identificador, _settings(request))


@router.post("/provedores/{identificador}/modelos/{modelo}/testar")
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
    return oauth_login.estado(identificador)


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
