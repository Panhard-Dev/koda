import inspect
from app.tools import registry, ferramentas
from app.providers.base import ChatOptions, system_prompt
from app.providers.presentation import BLOCOS_VISUAIS, UI_GENERATIVA
from app.mcp import _esquema


def test_aliases_resolve_to_registered_contracts():
    definitions = {item['function']['name']: item['function'] for item in registry.DEFINICOES}
    assert len(definitions) == len(registry.DEFINICOES)
    for alias, target in registry.APELIDOS.items():
        assert target in definitions, (alias, target)
        assert registry.canonico(alias) == target
    for name, handler in ferramentas._TOOL_HANDLERS.items():
        assert name in definitions
        inspect.signature(handler).bind(name, {}, '.', set(), acesso_livre=False,
            dono='', anexos=None, skills=None, chamada='')
    assert set(definitions) - set(ferramentas._TOOL_HANDLERS) == {'sub_agente'}


def test_tool_schemas_are_accepted_by_host_adapter():
    # Bedrock rejeita inputSchema sem propriedades, inclusive para ferramentas sem args.
    for item in registry.DEFINICOES:
        schema = item['function']['parameters']
        assert schema['type'] == 'object'
        assert schema['properties'], item['function']['name']
    assert _esquema({})['properties']
    assert _esquema({'type': 'object', 'properties': {}})['properties']


def test_presentation_blocks_are_conditional_and_default_remains_compatible():
    full = system_prompt(ChatOptions(model='offline'))
    plain = system_prompt(ChatOptions(model='offline', visuals=False, interactive_ui=False))
    assert BLOCOS_VISUAIS in full and UI_GENERATIVA in full
    assert BLOCOS_VISUAIS not in plain and UI_GENERATIVA not in plain
    # A ordem dos campos antigos do contrato posicional continua igual.
    options = ChatOptions('offline', False, True)
    assert options.reasoning is False and options.web is True
