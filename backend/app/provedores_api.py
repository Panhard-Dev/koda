"""Provedores por chave: endpoints nativos, sem gateway intermediário.

Catálogo baseado no registro público de 9router, revisão 1339107e624d1ab150c6a0c2c2ee22caa7e9db2f.
"""
from __future__ import annotations
import json
from pathlib import Path
from typing import Any
import httpx
from . import oauth_login
from .config import Settings

CATALOGO = json.loads(Path(__file__).with_name('provedores_api_catalogo.json').read_text(encoding='utf-8'))
POR_ID = {item['id']: item for item in CATALOGO}

def estado(item: dict, settings: Settings | None) -> dict:
    contas = oauth_login.contas(settings, item['id']) if settings else []
    return {'id': item['id'], 'nome': item['nome'], 'sigla': item['sigla'],
            'cli': 'Chave de API', 'login': None, 'cliInstalado': False,
            'conectado': bool(contas), 'arquivo': None, 'conta': item['nome'] if contas else None,
            'plano': None, 'planoAte': None, 'expiraEm': None, 'expirado': None, 'renova': False,
            'detalhe': ('Chave salva' if contas else 'Sem conexão') if item['disponivel'] else 'Protocolo específico ainda não implementado',
            'disponivel': item['disponivel'], 'chaveOpcional': item['id'] == 'api-ollama-local',
            'contas': [{'id': c['id'], 'conta': c.get('conta'), 'expiraEm': None,
                        'esgotadaAte': c.get('esgotadaAte'), 'motivo': c.get('motivo'), 'atual': i == 0}
                       for i, c in enumerate(contas)]}

def listar(settings: Settings | None) -> list[dict]:
    return [estado(item, settings) for item in CATALOGO]

def salvar(settings: Settings, identificador: str, chave: str, endpoint: str = "", deployment: str = "", versao: str = "2024-10-01-preview", access_id: str = "", region: str = "", session_token: str = "") -> dict:
    item = POR_ID.get(identificador)
    if not item or not item['disponivel']:
        raise ValueError('Este protocolo ainda não está disponível')
    if not chave.strip() and identificador != 'api-ollama-local':
        raise ValueError('Informe a chave de API')
    specific = {}
    if identificador == 'api-azure':
        from urllib.parse import urlsplit
        parsed = urlsplit(endpoint.strip())
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('Informe o endpoint HTTPS do Azure')
        if not deployment.strip():
            raise ValueError('Informe o nome do deployment')
        specific = {'endpoint': endpoint.strip().rstrip('/'), 'deployment': deployment.strip(), 'versao': versao.strip() or '2024-10-01-preview'}
    if identificador in {'api-bedrock','api-bedrock-xai'}:
        import re
        if not access_id.strip() or not re.fullmatch(r'[a-z]{2}(?:-gov)?-[a-z]+-\d+', region.strip()):
            raise ValueError('Informe Access Key ID e região AWS válida')
        specific = {'access_id':access_id.strip(), 'region':region.strip(), 'session_token':session_token.strip()}
    if identificador == 'api-vertex-partner':
        import re
        if not re.fullmatch(r'[a-z][a-z0-9-]{4,61}[a-z0-9]', deployment.strip()):
            raise ValueError('Informe o ID do projeto Google Cloud')
        specific = {'project_id': deployment.strip()}
    oauth_login.gravar_chave(settings, identificador, chave.strip() or 'ollama-local', specific)
    return estado(item, settings)

def cabecalhos(item: dict, chave: str) -> dict[str, str]:
    if item['id'] == 'api-azure':
        return {'api-key': chave, 'content-type': 'application/json'}
    if item['id'] == 'api-ollama-local':
        return {'content-type': 'application/json'}
    if item['formato'] == 'claude':
        return {'x-api-key': chave, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'}
    return {'authorization': f'Bearer {chave}', 'content-type': 'application/json'}

def modelos(identificador: str, settings: Settings | None) -> dict[str, Any]:
    item = POR_ID.get(identificador)
    if not item:
        return {'modelos': [], 'nomes': {}, 'fonte': None, 'motivo': 'Provedor desconhecido'}
    conta = oauth_login.guardado(settings, identificador) if settings else None
    if not conta:
        nomes = {str(m['id']): str(m.get('nome') or m['id']) for m in item['modelos'] if isinstance(m, dict) and m.get('id')}
        if not nomes and identificador in {'api-bai', 'api-chutes', 'api-vercel-ai-gateway', 'api-ollama-local'}:
            url = item['url'].removesuffix('/chat/completions') + '/models'
            try:
                with httpx.Client(timeout=5, follow_redirects=False) as client:
                    resposta = client.get(url)
                dados = resposta.json() if resposta.is_success else {}
                lista = dados.get('data', []) if isinstance(dados, dict) else []
                nomes = {str(m['id']): str(m.get('display_name') or m['id']) for m in lista if isinstance(m, dict) and m.get('id')}
            except (httpx.HTTPError, ValueError):
                pass
            if nomes:
                return {'modelos': list(nomes), 'nomes': nomes, 'fonte': 'catálogo público do provedor', 'motivo': ''}
        motivo = '' if nomes else ('Informe o deployment do Azure' if identificador == 'api-azure' else 'O catálogo deste provedor é consultado após a conexão')
        return {'modelos': list(nomes), 'nomes': nomes, 'fonte': 'catálogo de referência', 'motivo': motivo}
    if not item['disponivel']:
        return {'modelos': [], 'nomes': {}, 'fonte': None, 'motivo': 'Protocolo ainda não implementado'}
    if identificador == 'api-azure':
        deployment = str((conta.get('specific') or {}).get('deployment') or '')
        return {'modelos': [deployment] if deployment else [], 'nomes': {deployment: deployment}, 'fonte': 'Deployment configurado', 'motivo': '' if deployment else 'Configure o deployment'}
    if identificador in {'api-bedrock', 'api-bedrock-xai'}:
        nomes = {m['id']: m['nome'] for m in item['modelos']}
        return {'modelos': list(nomes), 'nomes': nomes, 'fonte': 'catálogo de referência', 'motivo': ''}
    if identificador == 'api-commandcode':
        nomes = {m['id']: m['nome'] for m in item['modelos']}
        return {'modelos': list(nomes), 'nomes': nomes, 'fonte': 'catálogo de referência', 'motivo': ''}
    # Alguns serviços não publicam /models; o catálogo é uma alternativa, não prova de acesso.
    url = item['url'].removesuffix('/chat/completions').removesuffix('/messages').removesuffix('/responses') + '/models'
    itens = []
    try:
        with httpx.Client(timeout=8, follow_redirects=False) as client:
            resposta = client.get(url, headers=cabecalhos(item, conta['access']))
            if resposta.is_success:
                dados = resposta.json()
                itens = dados.get('data', []) if isinstance(dados, dict) else []
    except (httpx.HTTPError, ValueError):
        pass
    origem = 'API do provedor' if itens else 'catálogo de referência'
    itens = itens or item['modelos']
    nomes = {str(m['id']): str(m.get('display_name') or m.get('nome') or m['id']) for m in itens if isinstance(m, dict) and m.get('id')}
    return {'modelos': list(nomes), 'nomes': nomes, 'fonte': origem,
            'motivo': '' if nomes else 'O provedor não forneceu uma lista de modelos'}
