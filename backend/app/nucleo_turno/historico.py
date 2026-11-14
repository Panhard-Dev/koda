"""Port parcial de context_manager/normalize.rs (Apache-2.0; LICENCA e AVISOS)."""
from copy import deepcopy
from uuid import UUID, uuid5

_NAMESPACE = UUID('90d38d3e-6a5b-4d52-bfe2-2f1e634bfac4')
_CHAMADAS = {'function_call': 'function_call_output', 'local_shell_call': 'function_call_output',
             'tool_search_call': 'tool_search_output', 'custom_tool_call': 'custom_tool_call_output'}
_PREFIXOS = {'function_call_output': 'fco', 'tool_search_output': 'tso', 'custom_tool_call_output': 'ctco'}


def normalizar_historico(itens):
    dados = deepcopy(itens)
    pares = {(item.get('type'), item.get('call_id')) for item in dados
             if item.get('type') in _PREFIXOS and item.get('call_id') is not None}
    saida = []
    for item in dados:
        saida.append(item)
        alvo = _CHAMADAS.get(item.get('type'))
        chamada = item.get('call_id')
        if not alvo or chamada is None or (alvo, chamada) in pares:
            continue
        prefixo = _PREFIXOS[alvo]
        identificador = item.get('id')
        id_saida = f'{prefixo}_{uuid5(_NAMESPACE, prefixo + ":" + identificador)}' if identificador else None
        if alvo == 'tool_search_output':
            novo = {'type': alvo, 'id': id_saida, 'call_id': chamada,
                    'status': 'completed', 'execution': 'client', 'tools': []}
        else:
            novo = {'type': alvo, 'id': id_saida, 'call_id': chamada, 'output': 'aborted'}
        saida.append(novo)
    chamadas = {(_CHAMADAS[item['type']], item.get('call_id')) for item in saida
                if item.get('type') in _CHAMADAS and item.get('call_id') is not None}
    return [item for item in saida if not (
        item.get('type') in _PREFIXOS and item.get('call_id') is not None
        and (item['type'], item['call_id']) not in chamadas
        and not (item['type'] == 'tool_search_output' and item.get('execution') == 'server'))]


def normalizar_chat(itens):
    """Aplica a ideia de saídas interrompidas ao formato Chat Completions."""
    dados = deepcopy(itens)
    encontrados = set()
    for item in dados:
        if item.get('role') != 'assistant':
            continue
        for chamada in item.get('tool_calls') or []:
            identificador = chamada.get('id') if isinstance(chamada, dict) else None
            if not isinstance(identificador, str) or not identificador or identificador in encontrados:
                raise ValueError('histórico contém chamada sem ID válido ou com ID duplicado')
            encontrados.add(identificador)
    resultados = set()
    for item in dados:
        if item.get('role') != 'tool':
            continue
        identificador = item.get('tool_call_id')
        if not isinstance(identificador, str) or not identificador or identificador in resultados:
            raise ValueError('histórico contém saída sem ID válido ou com ID duplicado')
        resultados.add(identificador)
    saida = []
    for item in dados:
        if item.get('role') == 'tool' and item.get('tool_call_id') not in encontrados:
            continue
        saida.append(item)
        if item.get('role') != 'assistant':
            continue
        for chamada in item.get('tool_calls') or []:
            identificador = chamada['id']
            if identificador not in resultados:
                saida.append({'role': 'tool', 'tool_call_id': identificador, 'content': 'aborted'})
    return saida
