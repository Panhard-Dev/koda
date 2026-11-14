"""Gerenciamento dos combos de modelos."""
from fastapi import APIRouter, HTTPException, Request
from .. import combos

router = APIRouter(tags=['combos'])

@router.get('/combos')
def listar(request: Request):
    return combos.listar(request.app.state.settings)

@router.post('/combos')
def salvar(dados: dict, request: Request):
    try:
        return combos.salvar(request.app.state.settings, dados)
    except ValueError as erro:
        raise HTTPException(400, str(erro)) from erro

@router.delete('/combos/{identificador}')
def apagar(identificador: str, request: Request):
    if not combos.obter(request.app.state.settings, identificador):
        raise HTTPException(404, 'Combo não encontrado')
    combos.apagar(request.app.state.settings, identificador)
    return {'ok': True}
