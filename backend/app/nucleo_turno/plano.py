"""Port parcial de core/src/tools/handlers/plan.rs e protocol/src/plan_tool.rs.
Derivado do projeto aberto; licença Apache-2.0 em LICENCA e AVISOS.
"""
import json


class ErroPlano(ValueError):
    pass


def atualizar_plano(argumentos: str, *, modo_plano: bool, emitir):
    if modo_plano:
        raise ErroPlano('update_plan é uma lista de tarefas e não é permitido no modo de planejamento')
    try:
        dados = json.loads(argumentos)
        if not isinstance(dados, dict) or set(dados) - {'explanation', 'plan'}:
            raise ValueError('campos inválidos')
        explicacao = dados.get('explanation')
        if explicacao is not None and not isinstance(explicacao, str):
            raise ValueError('explanation deve ser texto ou null')
        plano = dados['plan']
        if not isinstance(plano, list):
            raise ValueError('plan deve ser lista')
        for item in plano:
            if not isinstance(item, dict) or set(item) != {'step', 'status'}:
                raise ValueError('item inválido')
            if not isinstance(item['step'], str) or item['status'] not in ('pending', 'in_progress', 'completed'):
                raise ValueError('etapa ou estado inválido')
    except (ValueError, KeyError, TypeError) as erro:
        raise ErroPlano(f'falha ao interpretar argumentos: {erro}') from erro
    evento = {'explanation': explicacao, 'plan': plano}
    emitir(evento)
    return {'output': 'Plan updated', 'success': True}


def especificacao_plano():
    """Estrutura da ferramenta de core/src/tools/handlers/plan_spec.rs."""
    return {
        'type': 'function',
        'name': 'update_plan',
        'description': ('Updates the task plan. Provide an optional explanation and a list of plan '
                        'items, each with a step and status. At most one step can be in_progress at a time.'),
        'strict': False,
        'parameters': {
            'type': 'object', 'additionalProperties': False, 'required': ['plan'],
            'properties': {
                'explanation': {'type': 'string'},
                'plan': {'type': 'array', 'items': {
                    'type': 'object', 'additionalProperties': False, 'required': ['step', 'status'],
                    'properties': {'step': {'type': 'string'},
                                   'status': {'type': 'string', 'enum': ['pending', 'in_progress', 'completed']}}}},
            },
        },
    }
