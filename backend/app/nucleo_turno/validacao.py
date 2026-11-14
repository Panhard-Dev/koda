"""Validação de uma parcela explícita de JSON Schema; outros critérios são recusados."""
import math


class EsquemaInvalido(ValueError):
    pass


_PERMITIDOS = {'type', 'properties', 'required', 'additionalProperties', 'items', 'enum',
               'description', 'title', 'default', 'minimum', 'maximum', 'minLength',
               'maxLength', 'minItems', 'maxItems'}


def validar(valor, esquema, caminho='$'):
    try:
        return _validar(valor, esquema, caminho)
    except (TypeError, KeyError, OverflowError) as erro:
        raise EsquemaInvalido(f'{caminho}: esquema inválido') from erro


def _validar(valor, esquema, caminho):
    if not isinstance(esquema, dict):
        raise EsquemaInvalido(f'{caminho}: esquema deve ser objeto')
    nao_suportados = set(esquema) - _PERMITIDOS
    if nao_suportados:
        raise EsquemaInvalido(f'{caminho}: critérios não suportados: {sorted(nao_suportados)}')
    if 'additionalProperties' in esquema and not isinstance(esquema['additionalProperties'], (bool, dict)):
        raise EsquemaInvalido(f'{caminho}: additionalProperties inválido')
    if 'properties' in esquema and not isinstance(esquema['properties'], dict):
        raise EsquemaInvalido(f'{caminho}: properties inválido')
    if 'required' in esquema and (not isinstance(esquema['required'], list)
                                  or not all(isinstance(item, str) for item in esquema['required'])):
        raise EsquemaInvalido(f'{caminho}: required inválido')
    if 'enum' in esquema and not isinstance(esquema['enum'], list):
        raise EsquemaInvalido(f'{caminho}: enum inválido')
    tipo = esquema.get('type')
    tipos = {'object': lambda x: isinstance(x, dict), 'array': lambda x: isinstance(x, list),
             'string': lambda x: isinstance(x, str),
             'integer': lambda x: isinstance(x, int) and not isinstance(x, bool),
             'number': lambda x: isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x),
             'boolean': lambda x: isinstance(x, bool), 'null': lambda x: x is None}
    if tipo is not None and (tipo not in tipos or not tipos[tipo](valor)):
        raise EsquemaInvalido(f'{caminho}: tipo inválido ou não suportado: {tipo}')
    if 'enum' in esquema and not any(type(valor) is type(opcao) and valor == opcao for opcao in esquema['enum']):
        raise EsquemaInvalido(f'{caminho}: valor fora das opções')
    if isinstance(valor, dict):
        props = esquema.get('properties', {})
        for chave in esquema.get('required', []):
            if chave not in valor:
                raise EsquemaInvalido(f'{caminho}.{chave}: obrigatório')
        for chave, dado in valor.items():
            if chave in props:
                validar(dado, props[chave], f'{caminho}.{chave}')
            elif esquema.get('additionalProperties') is False:
                raise EsquemaInvalido(f'{caminho}.{chave}: propriedade inesperada')
            elif isinstance(esquema.get('additionalProperties'), dict):
                validar(dado, esquema['additionalProperties'], f'{caminho}.{chave}')
    if isinstance(valor, list):
        if len(valor) < esquema.get('minItems', 0) or len(valor) > esquema.get('maxItems', float('inf')):
            raise EsquemaInvalido(f'{caminho}: tamanho da lista inválido')
        if 'items' in esquema:
            for i, item in enumerate(valor): validar(item, esquema['items'], f'{caminho}[{i}]')
    if isinstance(valor, str):
        if len(valor) < esquema.get('minLength', 0) or len(valor) > esquema.get('maxLength', float('inf')):
            raise EsquemaInvalido(f'{caminho}: tamanho do texto inválido')
    if isinstance(valor, (int, float)) and not isinstance(valor, bool):
        if valor < esquema.get('minimum', -float('inf')) or valor > esquema.get('maximum', float('inf')):
            raise EsquemaInvalido(f'{caminho}: valor numérico fora dos limites')
