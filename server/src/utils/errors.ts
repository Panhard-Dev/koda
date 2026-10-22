/**
 * Erros da aplicação. `code` é estável e vai para o cliente; `detalhe` fica só
 * no log do servidor — nunca na resposta em produção.
 */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly exposto: boolean;
  readonly detalhe: string | undefined;
  readonly retryAfterS: number | undefined;

  constructor(
    code: string,
    status: number,
    message: string,
    detalhe?: string,
    opcoes?: { exposto?: boolean; retryAfterS?: number },
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.detalhe = detalhe;
    this.exposto = opcoes?.exposto ?? true;
    this.retryAfterS = opcoes?.retryAfterS;
  }
}

export const erroApi = (
  code: string,
  status: number,
  message: string,
  detalhe?: string,
): AppError => new AppError(code, status, message, detalhe);

export const requisicaoInvalida = (detalhe?: string) =>
  erroApi('invalid_request', 400, 'Requisicao invalida', detalhe);

export const naoAutenticado = (code = 'missing_token', detalhe?: string) =>
  erroApi(code, 401, 'Autenticacao necessaria', detalhe);

export const acessoNegado = (code = 'insufficient_role', detalhe?: string) =>
  erroApi(code, 403, 'Acesso negado', detalhe);

export const naoEncontrado = (detalhe?: string) => erroApi('not_found', 404, 'Recurso nao encontrado', detalhe);

export const conflito = (code: string, detalhe?: string) => erroApi(code, 409, 'Conflito de estado', detalhe);

export const bloqueado = (code: string, retryAfterS: number, detalhe?: string) =>
  new AppError(code, 429, 'Muitas tentativas', detalhe, { retryAfterS });

export const erroInterno = (detalhe?: string) =>
  new AppError('internal_error', 500, 'Erro interno', detalhe, { exposto: false });

export function mensagemDeErro(erro: unknown): string {
  if (erro instanceof Error) return `${erro.name}: ${erro.message}`;
  if (typeof erro === 'string') return erro;
  try {
    return JSON.stringify(erro);
  } catch {
    return String(erro);
  }
}

/** Resposta segura: em produção nada de stack trace, SQL ou nome de tabela. */
export function corpoDeErro(erro: AppError, requestId: string, isProduction: boolean): Record<string, unknown> {
  const corpo: Record<string, unknown> = {
    ok: false,
    error: erro.code,
    message: isProduction && !erro.exposto ? 'Erro interno. Tente novamente.' : erro.message,
    request_id: requestId,
  };
  // Detalhe só aparece quando o erro é claramente de entrada do usuário.
  if (erro.detalhe && erro.exposto && erro.status < 500 && !isProduction) corpo['details'] = erro.detalhe;
  return corpo;
}
