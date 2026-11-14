"""Turno isolado com ferramentas estruturadas e limites locais, sem prompt de sistema."""
import asyncio
import json
from copy import deepcopy
from .limite_saida import limitar_saida
from .repeticao_fluxo import RepeticaoFluxo
from .controle import Recusa
from .modelo import stream_text
from .validacao import validar, EsquemaInvalido
from .historico import normalizar_chat


class TurnoInterrompido(Exception):
    def __init__(self, motivo, historico=None):
        super().__init__(motivo)
        self.historico = deepcopy(historico) if historico is not None else []


def _constante_json_invalida(valor):
    raise ValueError(f'constante JSON inválida: {valor}')


async def executar_turno(historico, controlador, especificacoes, *, modelo=None,
                         chamar_modelo=stream_text, max_passos=24, max_repeticoes=3,
                         max_saida_bytes=16000, max_texto_bytes=128000, timeout=180, ao_texto=None,
                         detectar_repeticao=True, entrada_pendente=None):
    if max_passos < 1 or max_repeticoes < 2 or max_saida_bytes < 0 or max_texto_bytes < 1 or timeout <= 0:
        raise ValueError('limites inválidos')
    mensagens = deepcopy(historico)
    if any(item.get('role') in ('system', 'developer') for item in mensagens):
        raise ValueError('este turno não aceita mensagens de sistema ou desenvolvedor')
    mensagens = normalizar_chat(mensagens)
    ids = {chamada['id'] for item in mensagens if item.get('role') == 'assistant'
           for chamada in item.get('tool_calls') or []}
    ultimas, repetidas = None, 0
    oferecidas = {}
    for item in especificacoes:
        if not isinstance(item, dict) or not isinstance(item.get('function'), dict):
            raise ValueError('especificação de ferramenta inválida')
        funcao = item['function']
        nome = funcao.get('name')
        if not isinstance(nome, str) or not nome or nome in oferecidas:
            raise ValueError('nome de ferramenta inválido ou duplicado')
        oferecidas[nome] = funcao.get('parameters', {})
    bytes_emitidos = 0
    guarda = RepeticaoFluxo() if detectar_repeticao else None
    def drenar_entrada():
        nonlocal ultimas, repetidas
        if entrada_pendente is None:
            return False
        recebeu = False
        while True:
            try:
                texto = entrada_pendente.get_nowait()
            except asyncio.QueueEmpty:
                if recebeu:
                    ultimas, repetidas = None, 0
                return recebeu
            if not isinstance(texto, str) or not texto.strip():
                raise TurnoInterrompido('entrada pendente inválida', mensagens)
            mensagens.append({'role': 'user', 'content': texto})
            recebeu = True
    async def receber(delta):
        nonlocal bytes_emitidos
        bytes_emitidos += len(delta.encode('utf-8'))
        if bytes_emitidos > max_texto_bytes:
            raise TurnoInterrompido('limite de texto do turno atingido', mensagens)
        if guarda and guarda.alimentar(delta):
            raise TurnoInterrompido('repetição literal na saída do modelo', mensagens)
        if ao_texto:
            await ao_texto(delta)
    try:
        async with asyncio.timeout(timeout):
            for _ in range(max_passos):
                guarda = RepeticaoFluxo() if detectar_repeticao else None
                resultado = await chamar_modelo(mensagens, modelo, receber, tools=especificacoes)
                if len(resultado.text.encode('utf-8')) > max_texto_bytes:
                    raise TurnoInterrompido('limite de texto do turno atingido', mensagens)
                chamadas = resultado.tool_calls
                if not isinstance(chamadas, list):
                    raise TurnoInterrompido('lista de ferramentas inválida', mensagens)
                if not chamadas:
                    mensagens.append({'role': 'assistant', 'content': resultado.text})
                    if drenar_entrada():
                        continue
                    return mensagens
                mensagens.append({'role': 'assistant', 'content': resultado.text or None, 'tool_calls': chamadas})
                lote = []
                ids_lote = set()
                for chamada in chamadas:
                    if not isinstance(chamada, dict) or chamada.get('type') != 'function':
                        raise TurnoInterrompido('tipo de ferramenta inválido', mensagens)
                    identificador = chamada.get('id')
                    funcao = chamada.get('function') or {}
                    if not isinstance(funcao, dict):
                        raise TurnoInterrompido('chamada de ferramenta inválida', mensagens)
                    nome = funcao.get('name')
                    if not isinstance(identificador, str) or not identificador or identificador in ids or identificador in ids_lote:
                        raise TurnoInterrompido('identificador de ferramenta inválido ou repetido', mensagens)
                    ids_lote.add(identificador)
                    try:
                        argumentos = json.loads(funcao.get('arguments', ''), parse_constant=_constante_json_invalida)
                        if not isinstance(argumentos, dict) or not isinstance(nome, str):
                            raise ValueError('argumentos devem ser objeto')
                    except (TypeError, ValueError) as erro:
                        raise TurnoInterrompido('chamada de ferramenta inválida', mensagens) from erro
                    lote.append((identificador, nome, argumentos))
                ids.update(ids_lote)
                for identificador, nome, argumentos in lote:
                    assinatura = (nome, json.dumps(argumentos, sort_keys=True, ensure_ascii=False, separators=(',', ':')))
                    repetidas = repetidas + 1 if assinatura == ultimas else 1
                    ultimas = assinatura
                    if repetidas >= max_repeticoes:
                        raise TurnoInterrompido('chamada idêntica repetida; execução interrompida', mensagens)
                    try:
                        if nome not in oferecidas:
                            raise Recusa('ferramenta fora do catálogo oferecido')
                        try:
                            validar(argumentos, oferecidas[nome])
                        except EsquemaInvalido as erro:
                            raise Recusa(f'argumentos inválidos: {erro}') from erro
                        saida = await controlador.chamar(nome, argumentos)
                        conteudo = {'sucesso': saida.sucesso, 'resultado': saida.conteudo}
                    except Recusa as erro:
                        conteudo = {'sucesso': False, 'erro': str(erro)}
                    texto = json.dumps(conteudo, ensure_ascii=False, default=str)
                    mensagens.append({'role': 'tool', 'tool_call_id': identificador,
                                      'content': limitar_saida(texto, max_saida_bytes)})
                drenar_entrada()
    except TimeoutError as erro:
        raise TurnoInterrompido('tempo limite do turno atingido', mensagens) from erro
    raise TurnoInterrompido('limite de passos do turno atingido', mensagens)
