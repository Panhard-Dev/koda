import { AppError } from './errors.js';

/**
 * Erro do painel vira um código fixo, nunca texto livre: o que a pessoa digitou
 * não volta pela barra de endereço (e não há XSS refletido na mensagem).
 */
export function codigoDeErro(erro: unknown): string {
  if (erro instanceof AppError) {
    switch (erro.code) {
      case 'invalid_credentials':
        return 'credenciais-invalidas';
      case 'invalid_csrf':
        return 'csrf';
      case 'account_locked':
      case 'too_many_attempts':
      case 'rate_limited':
        return 'conta-travada';
      case 'not_found':
        return 'nao-encontrada';
      case 'insufficient_role':
        return 'sem-permissao';
      case 'invalid_request':
        // 2FA ligado e nenhum código digitado: a tela reabre com o campo, em vez
        // de dizer “dados invalidos” e deixar a pessoa sem onde digitar.
        return /2FA/.test(erro.detalhe ?? '') ? '2fa-obrigatorio' : 'entrada-invalida';
      case 'invalid_totp':
        return '2fa-invalido';
      default:
        return erro.status >= 500 ? 'erro-interno' : 'entrada-invalida';
    }
  }
  if (erro instanceof Error && /UNIQUE constraint|ja existe|ja esta/.test(erro.message)) return 'estado-invalido';
  return 'erro-interno';
}

/** Para onde cada formulário do painel volta quando algo dá errado. */
const TELA_DO_FORMULARIO: [prefixo: string, destino: string][] = [
  ['/admin/login', '/admin/login'],
  ['/admin/logout', '/admin/login'],
  ['/admin/contas', '/admin/contas'],
  ['/admin/modelos', '/admin/modelos'],
  ['/admin/versoes', '/admin/versoes'],
  ['/admin/seguranca', '/admin/seguranca'],
];

/**
 * A requisição é um formulário do painel? Se for, quem responde é uma tela —
 * não o JSON da API. As rotas `/admin/api/*` e `/admin/auth/*` ficam de fora: são
 * API de verdade e continuam falando JSON.
 */
export function formularioDoPainel(metodo: string, caminho: string): boolean {
  if (metodo.toUpperCase() !== 'POST') return false;
  if (!caminho.startsWith('/admin/')) return false;
  return !caminho.startsWith('/admin/api/') && !caminho.startsWith('/admin/auth/');
}

/** Destino do formulário, com o código do erro no lugar do texto. */
export function telaComErro(caminho: string, erro: unknown): string {
  const destino = TELA_DO_FORMULARIO.find(([prefixo]) => caminho.startsWith(prefixo))?.[1] ?? '/admin';
  return `${destino}?erro=${encodeURIComponent(codigoDeErro(erro))}`;
}
