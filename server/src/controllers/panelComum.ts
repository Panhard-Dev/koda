import type { ContextoApp } from '../types.js';
import { contextoDe } from '../services/auditService.js';
import { logger } from '../utils/logger.js';
import { codigoDeErro, redirecionar } from './panelController.js';

export function contexto(c: ContextoApp) {
  return contextoDe({
    ip: c.get('ip'),
    userAgent: c.get('userAgent'),
    requestId: c.get('requestId'),
    ator: c.get('ator'),
  });
}

/**
 * Roda a ação e volta para a tela com um código de retorno. Erro nunca vira
 * texto na URL: apenas o código, que a view traduz de uma tabela fixa.
 */
export async function executar(
  c: ContextoApp,
  destino: string,
  sucesso: string,
  acao: () => Promise<void>,
): Promise<Response> {
  try {
    await acao();
    return redirecionar(c, destino, { aviso: sucesso });
  } catch (erro) {
    const codigo = codigoDeErro(erro);
    logger.warn('painel.acao_falhou', {
      requestId: c.get('requestId'),
      rota: new URL(c.req.url).pathname,
      codigo,
      erro: erro instanceof Error ? `${erro.name}: ${erro.message}` : String(erro),
    });
    return redirecionar(c, destino, { erro: codigo });
  }
}

export async function comId<T>(c: ContextoApp, acao: (id: string) => Promise<T>): Promise<T> {
  const { identificadorParamSchema } = await import('../validation/schemas.js');
  const { parametros } = await import('../middlewares/validacao.js');
  const { id } = parametros(c, identificadorParamSchema);
  return acao(id);
}
