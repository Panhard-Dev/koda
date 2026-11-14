"""Liga avaliação de prefixos ao executor, sem shell ou instruções de sistema."""
import inspect
from .politica_execucao import Decision


class ComandoRecusado(Exception):
    pass


async def executar_com_politica(comando, politica, fallback, executar, aprovar=None, aprovar_pessoa=None):
    if not comando or any(not isinstance(arg, str) for arg in comando):
        raise ValueError('comando deve conter argumentos de texto')
    avaliacao = politica.check(comando, fallback)
    if avaliacao.decision == Decision.FORBIDDEN:
        raise ComandoRecusado('comando proibido pela política')
    if avaliacao.decision in (Decision.PROMPT, Decision.PROMPT_USER):
        revisor = aprovar_pessoa if avaliacao.decision == Decision.PROMPT_USER else aprovar
        if revisor is None:
            raise ComandoRecusado('comando requer aprovação')
        resposta = revisor(tuple(comando), avaliacao.decision)
        if inspect.isawaitable(resposta):
            resposta = await resposta
        if resposta is not True:
            raise ComandoRecusado('aprovação recusada')
    resultado = executar(tuple(comando))
    return await resultado if inspect.isawaitable(resultado) else resultado
