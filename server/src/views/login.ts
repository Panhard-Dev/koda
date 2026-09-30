import { escapeHtml } from '../utils/html.js';
import { ERROS } from './layout.js';

/**
 * Tela de login do painel (/admin/login). Rota separada do login de contas
 * comuns do app: outra tabela, outro público de token, outra política.
 */
export function telaDeLogin(opcoes: {
  erro?: string | null;
  csrfToken: string;
  proximo?: string;
  /**
   * O campo de 2FA só aparece quando o servidor já respondeu que precisa dele.
   * A conta padrão não tem 2FA, então o formulário fica só com e-mail e senha.
   */
  pedirTotp?: boolean;
}): Response {
  const erro = opcoes.erro ? (ERROS[opcoes.erro] ?? 'Nao foi possivel entrar.') : null;

  const campoTotp = opcoes.pedirTotp
    ? `<label>Codigo 2FA <span class="fraco">(do app autenticador)</span>
      <input type="text" name="totp" inputmode="numeric" autocomplete="one-time-code" maxlength="64" placeholder="000000" autofocus>
    </label>`
    : '';

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Entrar · Koda Admin</title>
<link rel="stylesheet" href="/admin/assets/painel.css">
</head>
<body>
<main class="caixa-login">
  <h1><span class="coroa">♛</span> Koda Admin</h1>
  <p class="fraco">Acesso restrito. Toda tentativa de login fica registrada.</p>
  ${erro ? `<p class="alerta ruim">${escapeHtml(erro)}</p>` : ''}
  <form method="post" action="/admin/login" autocomplete="off">
    <input type="hidden" name="csrf" value="${escapeHtml(opcoes.csrfToken)}">
    <input type="hidden" name="proximo" value="${escapeHtml(opcoes.proximo ?? '/admin')}">
    <label>E-mail
      <input type="email" name="email" required maxlength="254" autocomplete="username">
    </label>
    <label>Senha
      <input type="password" name="senha" required minlength="1" maxlength="200" autocomplete="current-password">
    </label>
    ${campoTotp}
    <button class="botao" type="submit">Entrar</button>
  </form>
  <p class="fraco mono">Cinco tentativas erradas travam a conta e o IP, por 15 minutos.</p>
</main>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
  });
}
