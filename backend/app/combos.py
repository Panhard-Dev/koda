"""Combos de modelos do Koda, independentes de gateways externos."""
from __future__ import annotations
import asyncio
import json
import re
import secrets
import threading
import time
import httpx
from dataclasses import replace
from typing import Any

from . import oauth_login
from .providers.base import ProviderError, Piece
from .contracts.turn import StepResult

PREFIXO = 'combo:'
TEMPO_PRIMEIRA_RESPOSTA = 30.0
SYSTEMONE_JEV = 'systemone:opencode:jev-1.13-free'
_lock = threading.Lock()
_sticky: dict[tuple[str, str], str] = {}


def _db(settings):
    banco = oauth_login._conexao(settings)
    banco.execute('CREATE TABLE IF NOT EXISTS combos_koda (id TEXT PRIMARY KEY, dados TEXT NOT NULL, proximo INTEGER NOT NULL DEFAULT 0)')
    banco.commit()
    return banco


def listar(settings):
    with _db(settings) as banco:
        return [json.loads(row['dados']) for row in banco.execute('SELECT dados FROM combos_koda ORDER BY rowid')]


def obter(settings, identificador):
    with _db(settings) as banco:
        linha = banco.execute('SELECT dados FROM combos_koda WHERE id=?', (identificador,)).fetchone()
    return json.loads(linha['dados']) if linha else None


def salvar(settings, dados):
    nome = str(dados.get('nome') or '').strip()
    estrategia = dados.get('estrategia')
    modelos = dados.get('modelos')
    if not nome or len(nome) > 100 or estrategia not in ('fallback', 'round-robin', 'smart', 'fusion'):
        raise ValueError('Informe nome e estratégia válidos')
    if not isinstance(modelos, list) or not modelos or len(modelos) > 12 or any(not isinstance(m, str) or not m.strip() or m.startswith(PREFIXO) for m in modelos):
        raise ValueError('Escolha de 1 a 12 modelos; combos não podem conter outros combos')
    modelos = list(dict.fromkeys(m.strip() for m in modelos))
    decisor = str(dados.get('decisor') or '').strip()
    juiz = str(dados.get('juiz') or '').strip()
    if any(m.startswith(PREFIXO) for m in (decisor, juiz)):
        raise ValueError('O decisor e o juiz não podem ser combos')
    if estrategia == 'smart' and not decisor:
        raise ValueError('Escolha um modelo decisor para o Smart Router')
    politica = dados.get('politica') or 'smart-switch'
    if politica not in ('smart-switch', 'strict', 'per-turn'):
        raise ValueError('Política Smart inválida')
    try: limiar = float(dados.get('limiar', 0.8))
    except (ValueError, TypeError): raise ValueError('Confiança inválida') from None
    if not 0 <= limiar <= 1: raise ValueError('Confiança deve ficar entre 0 e 1')
    identificador = str(dados.get('id') or '')
    with _db(settings) as banco:
        if identificador and not banco.execute('SELECT 1 FROM combos_koda WHERE id=?', (identificador,)).fetchone():
            raise ValueError('Combo não encontrado')
        identificador = identificador or secrets.token_hex(8)
        item = {'id': identificador, 'nome': nome, 'estrategia': estrategia, 'modelos': modelos,
                'decisor': decisor, 'juiz': juiz or modelos[0], 'politica': politica, 'limiar': limiar}
        banco.execute('INSERT INTO combos_koda(id,dados,proximo) VALUES(?,?,0) ON CONFLICT(id) DO UPDATE SET dados=excluded.dados,proximo=0', (identificador, json.dumps(item, ensure_ascii=False)))
        banco.commit()
    with _lock:
        for key in list(_sticky):
            if key[0] == identificador: del _sticky[key]
    return item


def apagar(settings, identificador):
    with _db(settings) as banco:
        banco.execute('DELETE FROM combos_koda WHERE id=?', (identificador,))
        banco.commit()
    with _lock:
        for key in list(_sticky):
            if key[0] == identificador: del _sticky[key]


def ordem_round_robin(settings, combo):
    with _db(settings) as banco:
        banco.execute('BEGIN IMMEDIATE')
        row = banco.execute('SELECT proximo FROM combos_koda WHERE id=?', (combo['id'],)).fetchone()
        index = int(row['proximo']) % len(combo['modelos']) if row else 0
        banco.execute('UPDATE combos_koda SET proximo=? WHERE id=?', (index + 1, combo['id']))
        banco.commit()
    return combo['modelos'][index:] + combo['modelos'][:index]


def so_modelos_externos(combo: dict[str, Any]) -> bool:
    """Só pula a sonda do host quando toda chamada possível é externa."""
    modelos = list(combo.get('modelos') or [])
    if not modelos:
        return False
    if combo.get('estrategia') == 'smart':
        modelos.append(combo.get('decisor') or '')
    if combo.get('estrategia') == 'fusion':
        modelos.append(combo.get('juiz') or modelos[0])
    return all(isinstance(m, str) and m.startswith(('provedor:', 'systemone:')) for m in modelos)


def _soma(destino, origem):
    for k in ('prompt_tokens', 'completion_tokens', 'total_tokens'):
        destino[k] = destino.get(k, 0) + int(origem.get(k, 0) or 0)


async def _com_prazo_no_inicio(fonte):
    """Não bloqueia o fallback para sempre quando um serviço aceita e não responde."""
    iterator = fonte.__aiter__()
    iniciou = False
    try:
        while True:
            try:
                item = await (anext(iterator) if iniciou else asyncio.wait_for(anext(iterator), TEMPO_PRIMEIRA_RESPOSTA))
            except StopAsyncIteration:
                return
            if isinstance(item, StepResult) or (isinstance(item, Piece) and item.text):
                iniciou = True
            yield item
    finally:
        fechar = getattr(iterator, 'aclose', None)
        if fechar:
            await fechar()


class ComboProvider:
    """Um objeto por turno: mantém modelo escolhido durante as chamadas de ferramentas."""
    name = 'combo'
    ready = True

    def __init__(self, engine, settings, combo, sessao):
        self.engine, self.settings, self.combo, self.sessao = engine, settings, combo, sessao
        self.ordem = None
        self.uso_extra: dict[str, int] = {}
        self.tempo_koda_ms = 0
        self.tokens_koda = 0
        self.modelo_koda = None

    def _eh_koda(self, modelo):
        return bool(modelo) and not modelo.startswith(('provedor:', 'systemone:'))

    async def _medir_step(self, messages, tools, modelo):
        inicio = time.monotonic()
        try:
            resultado = await self.engine.step(messages, tools, modelo)
            if self._eh_koda(modelo):
                self.tokens_koda += int(resultado.usage.get('total_tokens') or 0)
            return resultado
        finally:
            if self._eh_koda(modelo):
                self.modelo_koda = modelo
                self.tempo_koda_ms += max(1, int((time.monotonic() - inicio) * 1000))

    async def _medir_stream(self, fonte, modelo):
        inicio = time.monotonic()
        ultimo_uso = 0
        try:
            async for item in fonte:
                if isinstance(item, StepResult): ultimo_uso = int(item.usage.get('total_tokens') or 0)
                elif isinstance(item, Piece) and item.usage: ultimo_uso = int(item.usage.get('total_tokens') or 0)
                yield item
        finally:
            if self._eh_koda(modelo):
                self.modelo_koda = modelo
                self.tempo_koda_ms += max(1, int((time.monotonic() - inicio) * 1000))
                self.tokens_koda += ultimo_uso

    def cobranca_koda(self):
        return {'modelo': self.modelo_koda, 'tempo_ms': self.tempo_koda_ms, 'tokens': self.tokens_koda}

    def resolve_model(self, model):
        return PREFIXO + self.combo['id']

    async def _decidir(self, messages):
        nomes = '\n'.join(f'{i}: {m}' for i, m in enumerate(self.combo['modelos']))
        pedido = next((str(m.get('content', '')) for m in reversed(messages) if m.get('role') == 'user'), '')
        if self.combo['decisor'] == SYSTEMONE_JEV:
            try:
                conta = oauth_login.guardado(self.settings, 'api-opencode-zen')
                token = str((conta or {}).get('access') or 'public')
                headers = {'Authorization': f'Bearer {token}', 'x-opencode-client': 'desktop',
                           'User-Agent': 'opencode/1.18.31', 'x-opencode-session': secrets.token_hex(16)}
                payload = {'model': 'jev-1.13-free', 'state': pedido[:2000], 'questions': {'route': {
                    'type': 'choice', 'instructions': 'Which of these configured models is the most appropriate for this request?',
                    'criteria': {modelo: None for modelo in self.combo['modelos']}}}}
                async with httpx.AsyncClient(timeout=8) as client:
                    response = await client.post('https://opencode.ai/zen/v1/systemone', json=payload, headers=headers)
                    response.raise_for_status()
                    data = response.json()
                usage = data.get('usage') or {}
                _soma(self.uso_extra, {'prompt_tokens': usage.get('input_tokens', 0), 'completion_tokens': usage.get('output_tokens', 0), 'total_tokens': (usage.get('input_tokens', 0) or 0) + (usage.get('output_tokens', 0) or 0)})
                rota = (data.get('answers') or {}).get('route') or {}
                escolha, confianca = rota.get('choice'), rota.get('confidence')
                if escolha in self.combo['modelos']:
                    return escolha, float(confianca) if confianca is not None else 1.0
            except (httpx.HTTPError, ValueError, TypeError, AttributeError):
                pass
            return None, 0.0
        prompt = ('Escolha o modelo mais adequado para o pedido. Responda somente JSON com '
                  '"indice" (número inteiro) e "confianca" (0 a 1).\nModelos:\n' + nomes + '\nPedido:\n' + pedido[:12000])
        try:
            result = await asyncio.wait_for(self._medir_step([{'role': 'user', 'content': prompt}], [], self.combo['decisor']), 20)
            _soma(self.uso_extra, result.usage)
            obj = json.loads(re.search(r'\{[^{}]*\}', result.text, re.S).group())
            indice, confianca = int(obj['indice']), float(obj['confianca'])
            if 0 <= indice < len(self.combo['modelos']) and 0 <= confianca <= 1:
                return self.combo['modelos'][indice], confianca
        except (Exception,):
            pass
        return None, 0.0

    async def _ordem(self, messages):
        if self.ordem is not None: return self.ordem
        modelos = list(self.combo['modelos'])
        estrategia = self.combo['estrategia']
        if estrategia == 'round-robin':
            modelos = await asyncio.to_thread(ordem_round_robin, self.settings, self.combo)
        elif estrategia == 'smart':
            key = (self.combo['id'], self.sessao)
            with _lock: antigo = _sticky.get(key)
            if antigo not in modelos: antigo = None
            escolha = antigo if antigo and self.combo['politica'] == 'strict' else None
            if escolha is None:
                candidato, confianca = await self._decidir(messages)
                escolha = candidato if candidato and confianca >= self.combo['limiar'] else antigo
            escolha = escolha or modelos[0]
            modelos = [escolha] + [m for m in modelos if m != escolha]
            if self.combo['politica'] != 'per-turn':
                with _lock: _sticky[key] = escolha
        self.ordem = modelos
        return modelos

    async def _painel(self, messages, modelo):
        try:
            # Sem ferramentas no painel: somente o juiz pode executar ações.
            texto = '\n'.join(f"{m.get('role')}: {str(m.get('content') or '')}" for m in messages if m.get('role') in ('user','assistant','tool'))
            result = await asyncio.wait_for(self._medir_step([{'role': 'user', 'content': texto}], [], modelo), 90)
            return result if result and result.text.strip() else None
        except Exception:
            return None

    async def _preparar(self, messages):
        if self.combo['estrategia'] != 'fusion': return messages, None
        if len(self.combo['modelos']) == 1: return messages, self.combo['modelos'][0]
        respostas = await asyncio.gather(*(self._painel(messages, m) for m in self.combo['modelos']))
        validas = [r for r in respostas if r]
        for resposta in validas: _soma(self.uso_extra, resposta.usage)
        if not validas: raise ProviderError('Todos os modelos do painel Fusion falharam')
        if len(validas) == 1: return messages, self.combo['modelos'][respostas.index(validas[0])]
        painel = '\n\n'.join(f'Análise {i+1}: {r.text}' for i, r in enumerate(validas))
        return [*messages, {'role': 'user', 'content': 'Considere as análises independentes abaixo, verifique divergências e responda ao pedido original. Use ferramentas quando necessário.\n\n' + painel}], self.combo['juiz']

    async def step_streaming(self, messages, tools, model='', reasoning=True, effort=None):
        ordem = await self._ordem(messages)
        mensagens, juiz = await self._preparar(messages)
        candidatos = ([juiz] + [m for m in ordem if m != juiz]) if juiz else ordem
        ultimo = None
        for candidato in candidatos:
            iniciou = False
            try:
                terminou = False
                async for item in self._medir_stream(_com_prazo_no_inicio(self.engine.step_streaming(mensagens, tools, candidato, reasoning, effort)), candidato):
                    if isinstance(item, StepResult):
                        terminou = True
                        if not item.text.strip() and not item.calls: raise ProviderError('Modelo retornou resposta vazia')
                        _soma(item.usage, self.uso_extra)
                        self.uso_extra.clear()
                        self.ordem = [candidato] + [m for m in ordem if m != candidato]
                        if self.combo['estrategia'] == 'smart' and self.combo['politica'] != 'per-turn':
                            with _lock: _sticky[(self.combo['id'], self.sessao)] = candidato
                    elif isinstance(item, Piece) and item.text:
                        iniciou = True
                    yield item
                if not terminou: raise ProviderError('Modelo encerrou sem resultado completo')
                return
            except (ProviderError, httpx.HTTPError, OSError, asyncio.TimeoutError) as erro:
                if iniciou: raise
                ultimo = erro
        raise ProviderError(f'Todos os modelos do combo falharam: {ultimo}')

    async def step(self, messages, tools, model=''):
        resultado = None
        async for item in self.step_streaming(messages, tools, model):
            if isinstance(item, StepResult): resultado = item
        if resultado is None: raise ProviderError('Combo não retornou resultado')
        return resultado

    async def stream(self, turns, options):
        # Caminho de chat sem ferramentas usa a mesma seleção e fallback.
        messages = [{'role': t.role, 'content': t.text} for t in turns]
        ordem = await self._ordem(messages)
        mensagens, juiz = await self._preparar(messages)
        if juiz:
            from .providers.base import ChatTurn
            turns = [ChatTurn(role=m['role'], text=str(m.get('content') or '')) for m in mensagens]
        candidatos = ([juiz] + [m for m in ordem if m != juiz]) if juiz else ordem
        ultimo = None
        for candidato in candidatos:
            iniciou = False
            try:
                async for item in self._medir_stream(_com_prazo_no_inicio(self.engine.stream(turns, replace(options, model=candidato))), candidato):
                    if item.text: iniciou = True
                    yield item
                if not iniciou: raise ProviderError('Modelo retornou resposta vazia')
                return
            except (ProviderError, httpx.HTTPError, OSError, asyncio.TimeoutError) as erro:
                if iniciou: raise
                ultimo = erro
        raise ProviderError(f'Todos os modelos do combo falharam: {ultimo}')
