"""Conta: ler, vincular telefone/Google e sair (limpando a sessão)."""

from __future__ import annotations

from fastapi import APIRouter, Request

from ..db import Database
from ..deps import call, database
from ..repository import (
    UNSET,
    clear_conversations,
    get_account,
    reset_account,
    update_account,
)
from ..schemas import Account, AccountPatch

router = APIRouter(prefix="/account", tags=["account"])


def _get(db: Database) -> Account:
    with db.connect() as conn:
        return get_account(conn)


def _patch(db: Database, patch: AccountPatch) -> Account:
    # `model_fields_set` diz o que veio no corpo: mandar `"phone": null` desvincula,
    # e omitir o campo não mexe em nada.
    sent = patch.model_fields_set
    with db.connect() as conn:
        return update_account(
            conn,
            phone=patch.phone if "phone" in sent else UNSET,
            google=patch.google if "google" in sent else UNSET,
        )


def _sign_out(db: Database) -> Account:
    """Sair da conta limpa o que era dela: conversas e vínculos."""
    with db.connect() as conn:
        clear_conversations(conn)
        return reset_account(conn)


@router.get("", response_model=Account)
async def show(request: Request) -> Account:
    return await call(_get, database(request))


@router.patch("", response_model=Account)
async def update(patch: AccountPatch, request: Request) -> Account:
    return await call(_patch, database(request), patch)


@router.post("/sign-out", response_model=Account)
async def sign_out(request: Request) -> Account:
    return await call(_sign_out, database(request))
