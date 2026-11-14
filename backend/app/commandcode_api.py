"""Protocolo de chat e ferramentas do Command Code (API NDJSON)."""
from __future__ import annotations
import json
import os
import uuid
from datetime import date
import httpx
from .contracts.turn import StepResult, ToolCall
from .providers.base import Piece, ProviderError

URL = 'https://api.commandcode.ai/alpha/generate'


def corpo(modelo, messages, tools, sessao):
    chamadas = {t.get('id'): (t.get('function') or {}).get('name', '') for m in messages for t in m.get('tool_calls', [])}
    saida, sistemas = [], []
    for m in messages:
        papel = m.get('role', 'user')
        conteudo = m.get('content') or ''
        if isinstance(conteudo, list):
            conteudo = '\n'.join(str(p.get('text', '')) for p in conteudo if isinstance(p, dict))
        if papel == 'system':
            sistemas.append(str(conteudo)); continue
        if papel == 'tool':
            ident = m.get('tool_call_id', '')
            blocos = [{'type':'tool-result', 'toolCallId':ident, 'toolName':m.get('name') or chamadas.get(ident) or 'unknown', 'output':{'type':'text', 'value':str(conteudo)}}]
        else:
            blocos = [{'type':'text', 'text':str(conteudo)}] if conteudo else []
            for t in m.get('tool_calls', []):
                f = t.get('function') or {}
                try: args = json.loads(f.get('arguments') or '{}')
                except (TypeError, ValueError): args = {}
                blocos.append({'type':'tool-call', 'toolCallId':t.get('id',''), 'toolName':f.get('name',''), 'input':args})
            if not blocos: blocos = [{'type':'text', 'text':''}]
        saida.append({'role':papel, 'content':blocos})
    params = {'model':modelo, 'messages':saida, 'stream':True, 'max_tokens':64000, 'temperature':0.3}
    if sistemas: params['system'] = '\n\n'.join(sistemas)
    if tools: params['tools'] = [{'name':(t.get('function') or t).get('name'), 'description':(t.get('function') or t).get('description',''), 'input_schema':(t.get('function') or t).get('parameters', {'type':'object'})} for t in tools]
    return {'threadId':sessao, 'memory':None, 'taste':None, 'skills':None, 'permissionMode':'standard', 'config':{'workingDir':os.getcwd(), 'date':str(date.today()), 'environment':'linux', 'structure':[], 'isGitRepo':False, 'currentBranch':'', 'mainBranch':'', 'gitStatus':'', 'recentCommits':[]}, 'params':params}


async def fluxo(chave, modelo, messages, tools):
    sessao = str(uuid.uuid4())
    headers = {'authorization':f'Bearer {chave}', 'content-type':'application/json', 'user-agent':'cli', 'x-command-code-version':'1.88.5', 'x-cli-environment':'production', 'x-cli-surface':'cli', 'x-taste-learning':'false', 'x-session-id':sessao, 'x-project-slug':'koda'}
    texto, parciais, chamadas = [], {}, {}
    async with httpx.AsyncClient(timeout=180, follow_redirects=False) as cliente:
        async with cliente.stream('POST', URL, headers=headers, json=corpo(modelo,messages,tools,sessao)) as response:
            if response.status_code >= 400:
                raise ProviderError(f'Command Code respondeu HTTP {response.status_code}')
            async for linha in response.aiter_lines():
                try: evento=json.loads(linha.removeprefix('data:').strip())
                except ValueError: continue
                tipo=evento.get('type')
                if tipo in {'text-delta','reasoning-delta'}:
                    trecho=str(evento.get('text') or evento.get('delta') or '')
                    if tipo == 'text-delta': texto.append(trecho)
                    if trecho: yield Piece(text=trecho, reasoning=tipo == 'reasoning-delta')
                elif tipo == 'tool-input-start':
                    ident=evento.get('id') or evento.get('toolCallId'); parciais[ident]={'name':evento.get('toolName',''), 'args':''}
                elif tipo == 'tool-input-delta':
                    ident=evento.get('id') or evento.get('toolCallId')
                    if ident in parciais: parciais[ident]['args']+=str(evento.get('delta') or evento.get('inputTextDelta') or '')
                elif tipo == 'tool-call':
                    ident=evento.get('toolCallId'); chamadas[ident]={'name':evento.get('toolName',''), 'args':evento.get('input') or {}}
                elif tipo == 'error': raise ProviderError('Command Code interrompeu a resposta: '+str(evento.get('error') or evento.get('message') or '')[:300])
    for ident, item in parciais.items():
        if ident not in chamadas:
            try: args=json.loads(item['args'] or '{}')
            except ValueError: args={}
            chamadas[ident]={'name':item['name'],'args':args}
    lista=[]
    for ident, item in chamadas.items():
        args=item['args']
        if isinstance(args,str):
            try: args=json.loads(args)
            except ValueError: args={}
        if not isinstance(args,dict): args={}
        lista.append(ToolCall(id=str(ident or ''), name=str(item['name']), arguments=args, raw_arguments=json.dumps(args)))
    yield StepResult(text=''.join(texto), calls=lista)
