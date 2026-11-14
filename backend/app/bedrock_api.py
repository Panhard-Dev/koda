"""Amazon Bedrock InvokeModel com credenciais AWS estáticas e assinatura SigV4."""
from __future__ import annotations
import hashlib, hmac, json, re
from datetime import datetime, timezone
from urllib.parse import quote
import httpx
from .contracts.turn import StepResult, ToolCall
from .providers.base import ProviderError


def assinar(region, access_id, secret, token, path, corpo, agora):
    host = f'bedrock-runtime.{region}.amazonaws.com'
    data = agora.strftime('%Y%m%d'); instante = agora.strftime('%Y%m%dT%H%M%SZ')
    headers = {'content-type':'application/json', 'host':host, 'x-amz-date':instante}
    if token: headers['x-amz-security-token'] = token
    nomes = ';'.join(sorted(headers)); canon = ''.join(f'{k}:{headers[k]}\n' for k in sorted(headers))
    resumo = hashlib.sha256(corpo).hexdigest()
    canonical = f'POST\n{quote(path, safe="/-_.~")}\n\n{canon}\n{nomes}\n{resumo}'
    scope = f'{data}/{region}/bedrock/aws4_request'
    texto = f'AWS4-HMAC-SHA256\n{instante}\n{scope}\n{hashlib.sha256(canonical.encode()).hexdigest()}'
    def sign(key, value): return hmac.new(key, value.encode(), hashlib.sha256).digest()
    chave = sign(sign(sign(sign(('AWS4'+secret).encode(),data),region),'bedrock'),'aws4_request')
    assinatura = hmac.new(chave,texto.encode(),hashlib.sha256).hexdigest()
    headers['authorization'] = f'AWS4-HMAC-SHA256 Credential={access_id}/{scope}, SignedHeaders={nomes}, Signature={assinatura}'
    return host, headers


async def executar(conta, modelo, messages, tools, xai=False):
    from .providers.conta import _mensagens_anthropic, _sistema_de, _ferramenta_anthropic, _resultado_openai
    cfg=conta.get('specific') or {}; region=str(cfg.get('region') or '')
    if not re.fullmatch(r'[a-z]{2}(?:-gov)?-[a-z]+-\d+',region): raise ProviderError('Região AWS inválida')
    if not cfg.get('access_id'): raise ProviderError('Informe o AWS Access Key ID')
    path='/model/'+quote(modelo,safe='-_.~')+'/invoke'
    if xai:
        data={'messages':messages}
        if tools: data['tools']=tools
    else:
        data={'anthropic_version':'bedrock-2023-05-31','max_tokens':8192,'messages':_mensagens_anthropic(messages)}
        sistema=_sistema_de(messages)
        if sistema: data['system']=sistema
        if tools: data['tools']=[_ferramenta_anthropic(t) for t in tools]
    body=json.dumps(data,ensure_ascii=False,separators=(',',':')).encode()
    host,headers=assinar(region,str(cfg['access_id']),str(conta['access']),str(cfg.get('session_token') or ''),path,body,datetime.now(timezone.utc))
    async with httpx.AsyncClient(timeout=180,follow_redirects=False) as client:
        response=await client.post('https://'+host+path,headers=headers,content=body)
    if response.status_code >= 400: raise ProviderError(f'Bedrock respondeu HTTP {response.status_code}: {response.text[:300]}')
    if xai: return _resultado_openai(response, 'Bedrock xAI')
    result=response.json(); texto=[]; calls=[]
    for bloco in result.get('content') or []:
        if bloco.get('type')=='text': texto.append(str(bloco.get('text') or ''))
        elif bloco.get('type')=='tool_use':
            args=bloco.get('input') if isinstance(bloco.get('input'),dict) else {}
            calls.append(ToolCall(id=str(bloco.get('id') or ''),name=str(bloco.get('name') or ''),arguments=args,raw_arguments=json.dumps(args)))
    usage=result.get('usage') or {}
    return StepResult(text=''.join(texto),calls=calls,usage={'prompt_tokens':int(usage.get('input_tokens') or 0),'completion_tokens':int(usage.get('output_tokens') or 0)},truncado=result.get('stop_reason')=='max_tokens')
