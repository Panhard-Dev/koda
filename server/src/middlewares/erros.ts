import type { ErrorHandler, NotFoundHandler } from 'hono';
import type { Aplicacao, ContextoApp } from '../types.js';
import { getConfig } from '../config/env.js';
import { AppError, corpoDeErro, erroInterno, mensagemDeErro } from '../utils/errors.js';
import { formularioDoPainel, telaComErro } from '../utils/errosDoPainel.js';
import { logger } from '../utils/logger.js';

/** Traduz erros conhecidos (Zod, D1, JSON) sem expor detalhe ao cliente. */
function classificar(erro: unknown): AppError {
  if (erro instanceof AppError) return erro;
  const texto = mensagemDeErro(erro);
  if (/D1_ERROR|SQLITE|no such table|UNIQUE constraint/i.test(texto)) {
    return erroInterno(`banco: ${texto}`);
  }
  return erroInterno(texto);
}

/** Config quebrada não pode derrubar o próprio tratador de erros. */
function producao(c: ContextoApp): boolean {
  try {
    return getConfig(c.env).isProduction;
  } catch {
    return true;
  }
}

export const tratadorDeErros: ErrorHandler<Aplicacao> = (erro, c) => {
  const appError = classificar(erro);
  const requestId = c.get('requestId') ?? 'sem-id';
  const isProduction = producao(c);

  const caminho = new URL(c.req.url).pathname;
  logger.error('http.erro', {
    requestId,
    codigo: appError.code,
    status: appError.status,
    caminho,
    metodo: c.req.method,
    ip: c.get('ip'),
    ator: c.get('ator')?.id ?? null,
    detalhe: appError.detalhe ?? null,
    erro: erro instanceof Error ? `${erro.name}: ${erro.message}` : String(erro),
  });

  if (appError.retryAfterS !== undefined) c.header('retry-after', String(appError.retryAfterS));
  c.header('cache-control', 'no-store');
  c.header('x-request-id', requestId);

  // Formulário do painel responde tela, não JSON: quem preencheu precisa ler o
  // aviso na própria página. O erro continua registrado acima, com o detalhe.
  // (No Hono o erro é tratado aqui, no `onError` — um middleware em volta não
  // chega a recebê-lo.)
  if (formularioDoPainel(c.req.method, caminho)) {
    logger.warn('painel.formulario_recusado', {
      requestId,
      rota: caminho,
      codigo: appError.code,
      detalhe: appError.detalhe ?? null,
    });
    return c.redirect(telaComErro(caminho, appError), 303);
  }

  return c.json(corpoDeErro(appError, requestId, isProduction), appError.status as 400);
};

export const tratadorDeNaoEncontrado: NotFoundHandler<Aplicacao> = (c) => {
  const requestId = c.get('requestId') ?? 'sem-id';
  return c.json(corpoDeErro(new AppError('not_found', 404, 'Recurso nao encontrado'), requestId, producao(c)), 404);
};
