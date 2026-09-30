import { escapeHtml } from '../utils/html.js';

export type SecaoAtiva = 'painel' | 'contas' | 'modelos' | 'versoes' | 'auditoria' | 'seguranca';

export interface DadosLayout {
  titulo: string;
  secao: SecaoAtiva;
  conteudo: string;
  admin?: { email: string; papel: string; totp_ativo: boolean } | null;
  csrfToken?: string | null;
  aviso?: string | null;
  erro?: string | null;
}

export const AVISOS: Record<string, string> = {
  'admin-logado': 'Sessao iniciada.',
  'conta-atualizada': 'Conta atualizada e tokens revogados.',
  'conta-criada': 'Conta criada.',
  'conta-removida': 'Conta removida (soft delete).',
  'conta-restaurada': 'Conta restaurada.',
  'conta-avisada': 'Aviso enviado.',
  'modelo-criado': 'Modelo criado.',
  'modelo-atualizado': 'Modelo atualizado.',
  'modelo-removido': 'Modelo removido.',
  'versao-publicada': 'Release publicada.',
  'versao-atualizada': 'Release atualizada.',
  'auditoria-ok': 'Integridade conferida: nenhuma adulteracao encontrada.',
  'senha-trocada': 'Senha alterada. Entre novamente.',
  'totp-preparado': 'Segredo gerado: cadastre no app autenticador e confirme.',
  'totp-ativado': '2FA atividado.',
  'totp-desativado': '2FA desativado.',
  'sessoes-revogadas': 'Todas as sessoes foram revogadas.',
};

export const ERROS: Record<string, string> = {
  'credenciais-invalidas': 'E-mail ou senha invalidos.',
  '2fa-obrigatorio': 'Informe o codigo do autenticador.',
  '2fa-invalido': 'Codigo de 2FA invalido.',
  'conta-travada': 'Conta temporariamente bloqueada por tentativas erradas.',
  'csrf': 'Sessao expirada no formulario. Recarregue a pagina.',
  'nao-encontrada': 'Registro nao encontrado.',
  'estado-invalido': 'A acao nao se aplica ao estado atual do registro.',
  'entrada-invalida': 'Dados invalidos: revise os campos.',
  'arquivo-invalido': 'Arquivo recusado (tipo, tamanho ou extensao).',
  'sem-permissao': 'Seu papel nao permite esta acao.',
  'erro-interno': 'Falha inesperada. Tente de novo.',
  'sem-csrf': 'Token de seguranca ausente.',
};

export function mensagemDeAviso(codigo: string | undefined | null): string | null {
  if (!codigo) return null;
  return AVISOS[codigo] ?? null;
}

export function mensagemDeErro(codigo: string | undefined | null): string | null {
  if (!codigo) return null;
  return ERROS[codigo] ?? 'Nao foi possivel concluir a acao.';
}

const ITENS: { chave: SecaoAtiva; href: string; rotulo: string }[] = [
  { chave: 'painel', href: '/admin', rotulo: 'Painel' },
  { chave: 'contas', href: '/admin/contas', rotulo: 'Contas' },
  { chave: 'modelos', href: '/admin/modelos', rotulo: 'Modelos' },
  { chave: 'versoes', href: '/admin/versoes', rotulo: 'Versoes' },
  { chave: 'auditoria', href: '/admin/auditoria', rotulo: 'Auditoria' },
  { chave: 'seguranca', href: '/admin/seguranca', rotulo: 'Seguranca' },
];

function navegacao(secao: SecaoAtiva): string {
  return ITENS.map(
    (item) =>
      `<a class="nav-item${item.chave === secao ? ' ativo' : ''}" href="${item.href}">${escapeHtml(item.rotulo)}</a>`,
  ).join('');
}

export function pagina(dados: DadosLayout): Response {
  const aviso = mensagemDeAviso(dados.aviso);
  const erro = mensagemDeErro(dados.erro);
  const csrf = escapeHtml(dados.csrfToken ?? '');

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(dados.titulo)} · Koda Admin</title>
<link rel="stylesheet" href="/admin/assets/painel.css">
</head>
<body>
<header class="topo">
  <div class="marca"><span class="coroa">♛</span> Koda Admin</div>
  <nav class="nav">${navegacao(dados.secao)}</nav>
  <div class="sessao">
    ${
      dados.admin
        ? `<span class="quem">${escapeHtml(dados.admin.email)} <em>${escapeHtml(dados.admin.papel)}</em>${
            dados.admin.totp_ativo ? ' <b class="selo">2FA</b>' : ' <b class="selo alerta">sem 2FA</b>'
          }</span>
           <form method="post" action="/admin/logout" class="inline" data-confirmar="Encerrar a sessao?">
             <input type="hidden" name="csrf" value="${csrf}">
             <button class="botao pequeno" type="submit">Sair</button>
           </form>`
        : ''
    }
  </div>
</header>
<main class="conteudo">
  ${aviso ? `<p class="alerta ok">${escapeHtml(aviso)}</p>` : ''}
  ${erro ? `<p class="alerta ruim">${escapeHtml(erro)}</p>` : ''}
  ${dados.conteudo}
</main>
<script src="/admin/assets/painel.js"></script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
  });
}

export function campoOcultoCsrf(token: string | null): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(token ?? '')}">`;
}

/** CSS do painel: arquivo estático servido pelo próprio Worker. */
export function cssDoPainel(): string {
  return `/* Koda Admin */
:root{--fundo:#0b0b10;--painel:#15161d;--borda:#272934;--texto:#e8e8f0;--fraco:#a0a2b4;--roxo:#b040d0;--ok:#2fbf71;--ruim:#ef5350;--aviso:#f0b429}
*{box-sizing:border-box}
body{margin:0;background:var(--fundo);color:var(--texto);font:14px/1.5 "Segoe UI",system-ui,sans-serif}
a{color:#d9a6ea;text-decoration:none}
a:hover{text-decoration:underline}
.topo{display:flex;align-items:center;gap:20px;padding:12px 20px;background:linear-gradient(90deg,#1a1020,#15161d);border-bottom:1px solid var(--borda);flex-wrap:wrap}
.marca{font-weight:700;letter-spacing:.5px}
.coroa{color:var(--roxo)}
.nav{display:flex;gap:4px;flex:1;flex-wrap:wrap}
.nav-item{padding:6px 12px;border-radius:8px;color:var(--fraco)}
.nav-item.ativo,.nav-item:hover{background:#20222c;color:var(--texto)}
.sessao{display:flex;align-items:center;gap:10px;color:var(--fraco);font-size:13px}
.quem em{font-style:normal;color:var(--roxo)}
.selo{background:#243;border:1px solid #365;border-radius:6px;padding:1px 6px;font-size:11px;color:var(--ok)}
.selo.alerta{border-color:#553;color:var(--aviso)}
.conteudo{max-width:1180px;margin:0 auto;padding:24px 20px 60px}
h1{font-size:20px;margin:0 0 16px}
h2{font-size:16px;margin:28px 0 10px}
.cartoes{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:20px}
.cartao{background:var(--painel);border:1px solid var(--borda);border-radius:10px;padding:14px}
.cartao b{display:block;font-size:24px}
.cartao span{color:var(--fraco);font-size:12px;text-transform:uppercase;letter-spacing:.5px}
table{width:100%;border-collapse:collapse;background:var(--painel);border:1px solid var(--borda);border-radius:10px;overflow:hidden}
th,td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--borda);vertical-align:top}
th{background:#1b1d26;color:var(--fraco);font-size:12px;text-transform:uppercase;letter-spacing:.4px}
tr:last-child td{border-bottom:0}
form{margin:0}
.formulario{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin:0 0 16px;background:var(--painel);border:1px solid var(--borda);border-radius:10px;padding:12px}
.formulario label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--fraco)}
input,select,textarea{background:#0f1016;border:1px solid var(--borda);color:var(--texto);border-radius:8px;padding:7px 9px;font:inherit;min-width:140px}
textarea{min-height:70px}
.inline{display:inline-flex;gap:6px;align-items:flex-end;margin:2px 0}
.botao{background:var(--roxo);color:#fff;border:0;border-radius:8px;padding:8px 14px;font:inherit;cursor:pointer}
.botao:hover{filter:brightness(1.1)}
.botao.pequeno{padding:5px 10px;font-size:12px}
.botao.ruim{background:#8d2c2c}
.botao.neutro{background:#2a2d38}
.alerta{padding:10px 14px;border-radius:8px;margin:0 0 14px}
.alerta.ok{background:#14301f;border:1px solid #2fbf7155;color:#9fe6bd}
.alerta.ruim{background:#331616;border:1px solid #ef535055;color:#f5b7b6}
.fraco{color:var(--fraco)}
.mono{font-family:Consolas,monospace;font-size:12px}
.pilula{display:inline-block;border-radius:999px;padding:2px 9px;font-size:12px;border:1px solid var(--borda)}
.pilula.active{color:var(--ok);border-color:#2fbf7155}
.pilula.suspended{color:var(--aviso);border-color:#f0b42955}
.pilula.banned{color:var(--ruim);border-color:#ef535055}
.acoes{display:flex;gap:6px;flex-wrap:wrap}
.detalhe{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.paginacao{display:flex;gap:8px;margin:14px 0;align-items:center}
.codigos{font-family:Consolas,monospace;background:#0f1016;border:1px solid var(--borda);border-radius:8px;padding:12px;white-space:pre-wrap}
.caixa-login{max-width:420px;margin:8vh auto;background:var(--painel);border:1px solid var(--borda);border-radius:12px;padding:24px}
.caixa-login h1{margin:0 0 4px}
.caixa-login form{display:flex;flex-direction:column;gap:12px;margin:18px 0}
.caixa-login label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--fraco)}
.caixa-login input{min-width:0}
@media (max-width:720px){.formulario{flex-direction:column;align-items:stretch}table{font-size:13px}}
`;
}

/** JS do painel: confirmação e envio automático de filtros. Nada inline no HTML. */
export function jsDoPainel(): string {
  return `// Koda Admin — sem dependencia externa
document.addEventListener('submit', function (evento) {
  var formulario = evento.target;
  if (!(formulario instanceof HTMLFormElement)) return;
  var pergunta = formulario.getAttribute('data-confirmar');
  if (pergunta && !window.confirm(pergunta)) evento.preventDefault();
});
document.addEventListener('change', function (evento) {
  var alvo = evento.target;
  if (alvo instanceof HTMLSelectElement && alvo.hasAttribute('data-enviar-ao-mudar')) {
    if (alvo.form) alvo.form.submit();
  }
});
`;
}
