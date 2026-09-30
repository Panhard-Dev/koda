import type { AuditoriaRow } from '../models/auditLog.js';
import type { ModeloRow } from '../models/catalogModels.js';
import type { ReleaseRow } from '../models/releases.js';
import { atributo, escapeHtml, formatarData, truncar } from '../utils/html.js';
import { campoOcultoCsrf } from './layout.js';

/* ------------------------------- Modelos --------------------------------- */
export function paginaModelos(dados: { csrf: string | null; modelos: ModeloRow[]; total: number }): string {
  const linhas = dados.modelos
    .map((modelo) => {
      const removido = modelo.deleted_at !== null;
      return `<tr>
      <td>${escapeHtml(modelo.name)}<br><span class="fraco mono">${escapeHtml(modelo.slug)}</span>
        ${modelo.asset_id ? `<br><a class="mono" href="/api/public/assets/${atributo(modelo.asset_id)}" target="_blank" rel="noopener">imagem</a>` : ''}
      </td>
      <td>${modelo.is_active === 1 ? '<span class="pilula active">ativo global</span>' : '<span class="pilula banned">inativo</span>'}
        ${removido ? ' <span class="pilula banned">removido</span>' : ''}</td>
      <td class="fraco">${escapeHtml(modelo.provider)} / ${escapeHtml(modelo.kind)}</td>
      <td class="mono fraco">${modelo.context_window ? escapeHtml(modelo.context_window) : '—'}</td>
      <td>
        <div class="acoes">
          <form class="inline" method="post" action="/admin/modelos/${atributo(modelo.id)}/alternar">
            ${campoOcultoCsrf(dados.csrf)}
            <input type="hidden" name="ativo" value="${modelo.is_active === 1 ? '0' : '1'}">
            <button class="botao pequeno neutro" type="submit">${modelo.is_active === 1 ? 'desativar' : 'ativar'}</button>
          </form>
          <form class="inline" method="post" action="/admin/modelos/${atributo(modelo.id)}/editar">
            ${campoOcultoCsrf(dados.csrf)}
            <input type="text" name="name" value="${atributo(modelo.name)}" maxlength="80" required>
            <input type="text" name="description" value="${atributo(modelo.description ?? '')}" maxlength="500" placeholder="descricao">
            <input type="number" name="sort_order" value="${atributo(modelo.sort_order)}" min="-10000" max="10000">
            <button class="botao pequeno" type="submit">salvar</button>
          </form>
          <form class="inline" method="post" action="/admin/modelos/${atributo(modelo.id)}/imagem" enctype="multipart/form-data">
            ${campoOcultoCsrf(dados.csrf)}
            <input type="file" name="arquivo" accept="image/png,image/jpeg,image/gif,image/webp" required>
            <button class="botao pequeno neutro" type="submit">enviar imagem</button>
          </form>
          ${
            removido
              ? `<form class="inline" method="post" action="/admin/modelos/${atributo(modelo.id)}/restaurar">
                  ${campoOcultoCsrf(dados.csrf)}
                  <button class="botao pequeno" type="submit">restaurar</button>
                </form>`
              : `<form class="inline" method="post" action="/admin/modelos/${atributo(modelo.id)}/remover" data-confirmar="Remover modelo?">
                  ${campoOcultoCsrf(dados.csrf)}
                  <button class="botao pequeno ruim" type="submit">remover</button>
                </form>`
          }
        </div>
      </td>
    </tr>`;
    })
    .join('');

  return `
<h1>Modelos <span class="fraco">(${dados.total})</span></h1>
<p class="fraco">Ativo/inativo global vale para todos; o ajuste por usuario fica na pagina da conta.</p>

<h2>Novo modelo</h2>
<form class="formulario" method="post" action="/admin/modelos">
  ${campoOcultoCsrf(dados.csrf)}
  <label>slug<input type="text" name="slug" required minlength="2" maxlength="45" pattern="[a-z0-9][a-z0-9._-]*"></label>
  <label>nome<input type="text" name="name" required minlength="2" maxlength="80"></label>
  <label>descricao<input type="text" name="description" maxlength="500"></label>
  <label>tipo
    <select name="kind">
      <option value="chat">chat</option>
      <option value="imagem">imagem</option>
      <option value="audio">audio</option>
      <option value="embedding">embedding</option>
      <option value="ferramenta">ferramenta</option>
    </select>
  </label>
  <label>contexto<input type="number" name="context_window" min="128" max="10000000"></label>
  <label>ordem<input type="number" name="sort_order" value="0" min="-10000" max="10000"></label>
  <button class="botao" type="submit">criar</button>
</form>

<table>
  <thead><tr><th>modelo</th><th>status</th><th>origem</th><th>contexto</th><th>acoes</th></tr></thead>
  <tbody>${linhas || '<tr><td colspan="5" class="fraco">Nenhum modelo cadastrado.</td></tr>'}</tbody>
</table>`;
}

/* ------------------------------- Versoes --------------------------------- */
export function paginaVersoes(dados: { csrf: string | null; releases: ReleaseRow[]; total: number }): string {
  const linhas = dados.releases
    .map(
      (release) => `<tr>
      <td class="mono"><b>${escapeHtml(release.version)}</b>${release.is_prerelease === 1 ? ' <span class="pilula suspended">pre-release</span>' : ''}</td>
      <td>${release.published === 1 ? '<span class="pilula active">publicada</span>' : '<span class="pilula banned">rascunho</span>'}
          ${release.mandatory === 1 ? ' <span class="pilula suspended">obrigatoria</span>' : ''}</td>
      <td class="fraco mono">${escapeHtml(formatarData(release.published_at))}</td>
      <td>${escapeHtml(truncar(release.notes ?? '—', 90))}</td>
      <td>
        <div class="acoes">
          <form class="inline" method="post" action="/admin/versoes/${atributo(release.id)}/${release.published === 1 ? 'despublicar' : 'publicar'}">
            ${campoOcultoCsrf(dados.csrf)}
            <button class="botao pequeno neutro" type="submit">${release.published === 1 ? 'despublicar' : 'publicar'}</button>
          </form>
          <form class="inline" method="post" action="/admin/versoes/${atributo(release.id)}/remover" data-confirmar="Remover esta release?">
            ${campoOcultoCsrf(dados.csrf)}
            <button class="botao pequeno ruim" type="submit">remover</button>
          </form>
        </div>
        <div class="fraco mono">${escapeHtml(release.download_url)}</div>
      </td>
    </tr>`,
    )
    .join('');

  return `
<h1>Versoes <span class="fraco">(${dados.total})</span></h1>
<p class="fraco">O app consulta <span class="mono">GET /api/public/version?versao=1.0.0&amp;canal=stable</span> ao abrir.</p>

<h2>Publicar versao</h2>
<form class="formulario" method="post" action="/admin/versoes">
  ${campoOcultoCsrf(dados.csrf)}
  <label>versao<input type="text" name="version" required placeholder="1.0.0" maxlength="32"></label>
  <label>url de download<input type="url" name="download_url" required maxlength="500" placeholder="https://..."></label>
  <label>canal
    <select name="channel">
      <option value="stable">stable</option>
      <option value="beta">beta</option>
    </select>
  </label>
  <label>versao minima suportada<input type="text" name="min_supported_version" maxlength="32" placeholder="0.9.0"></label>
  <label>obrigatoria
    <select name="mandatory"><option value="0">nao</option><option value="1">sim</option></select>
  </label>
  <label>changelog<textarea name="notes" maxlength="4000"></textarea></label>
  <button class="botao" type="submit">publicar</button>
</form>

<table>
  <thead><tr><th>versao</th><th>estado</th><th>publicada em</th><th>changelog</th><th>acoes</th></tr></thead>
  <tbody>${linhas || '<tr><td colspan="5" class="fraco">Nenhuma release.</td></tr>'}</tbody>
</table>`;
}

/* ------------------------------ Auditoria -------------------------------- */
export function paginaAuditoria(dados: {
  csrf: string | null;
  entradas: AuditoriaRow[];
  total: number;
  pagina: number;
  porPagina: number;
  filtro: { action?: string; actor_id?: string; target_id?: string; outcome?: string };
  integridade?: { ok: boolean; verificadas: number; adulteradas: { id: number }[] };
}): string {
  const linhas = dados.entradas
    .map(
      (item) => `<tr>
      <td class="mono">${item.id}</td>
      <td class="mono">${escapeHtml(formatarData(item.created_at))}</td>
      <td class="mono">${escapeHtml(item.action)}</td>
      <td>${escapeHtml(item.actor_email ?? item.actor_type)}</td>
      <td class="mono fraco">${escapeHtml(item.target_type ?? '—')} ${escapeHtml(truncar(item.target_id ?? '', 26))}</td>
      <td>${item.outcome === 'success' ? '<span class="pilula active">ok</span>' : '<span class="pilula banned">falha</span>'}</td>
      <td class="mono fraco">${escapeHtml(truncar(item.details ?? '', 60))}</td>
      <td class="mono fraco">${escapeHtml(truncar(item.entry_hash, 16))}…</td>
    </tr>`,
    )
    .join('');

  const totalPaginas = Math.max(1, Math.ceil(dados.total / dados.porPagina));

  return `
<h1>Auditoria <span class="fraco">(${dados.total})</span></h1>
<p class="fraco">Tabela append-only: o banco recusa UPDATE e DELETE. Cada linha carrega o proprio SHA-256.</p>
${
  dados.integridade
    ? `<p class="alerta ${dados.integridade.ok ? 'ok' : 'ruim'}">Integridade: ${dados.integridade.ok ? 'sem adulteracao' : 'ADULTERACAO DETECTADA'} · ${dados.integridade.verificadas} entradas conferidas${
        dados.integridade.ok ? '' : ` · ids: ${dados.integridade.adulteradas.map((item) => item.id).join(', ')}`
      }</p>`
    : ''
}
<form class="formulario" method="get" action="/admin/auditoria">
  <label>acao<input type="text" name="action" maxlength="80" value="${atributo(dados.filtro.action ?? '')}" placeholder="account.ban"></label>
  <label>autor (id)<input type="text" name="actor_id" maxlength="64" value="${atributo(dados.filtro.actor_id ?? '')}"></label>
  <label>alvo (id)<input type="text" name="target_id" maxlength="64" value="${atributo(dados.filtro.target_id ?? '')}"></label>
  <label>resultado
    <select name="outcome" data-enviar-ao-mudar>
      <option value="">todos</option>
      <option value="success"${dados.filtro.outcome === 'success' ? ' selected' : ''}>sucesso</option>
      <option value="failure"${dados.filtro.outcome === 'failure' ? ' selected' : ''}>falha</option>
    </select>
  </label>
  <button class="botao" type="submit">Filtrar</button>
</form>
<p><a class="botao pequeno neutro" href="/admin/auditoria?verificar=1">conferir integridade</a></p>

<table>
  <thead><tr><th>#</th><th>quando</th><th>acao</th><th>autor</th><th>alvo</th><th>resultado</th><th>detalhe</th><th>hash</th></tr></thead>
  <tbody>${linhas || '<tr><td colspan="8" class="fraco">Nenhum evento.</td></tr>'}</tbody>
</table>

<div class="paginacao">
  <a class="botao pequeno neutro" href="/admin/auditoria?pagina=${Math.max(1, dados.pagina - 1)}&por_pagina=${dados.porPagina}">anterior</a>
  <span class="fraco">pagina ${dados.pagina} de ${totalPaginas}</span>
  <a class="botao pequeno neutro" href="/admin/auditoria?pagina=${Math.min(totalPaginas, dados.pagina + 1)}&por_pagina=${dados.porPagina}">proxima</a>
</div>`;
}

/* ------------------------------ Seguranca -------------------------------- */
export function paginaSeguranca(dados: {
  csrf: string | null;
  admin: { email: string; papel: string; totp_ativo: boolean; ultimo_login: string | null; ultimo_ip: string | null };
}): string {
  const csrf = campoOcultoCsrf(dados.csrf);
  return `
<h1>Seguranca</h1>
<section class="detalhe cartoes">
  <div class="cartao"><span>admin</span><b>${escapeHtml(dados.admin.email)}</b></div>
  <div class="cartao"><span>papel</span><b>${escapeHtml(dados.admin.papel)}</b></div>
  <div class="cartao"><span>2FA (TOTP)</span><b>${dados.admin.totp_ativo ? 'ativado' : 'desativado'}</b></div>
  <div class="cartao"><span>ultimo login</span><b class="mono">${escapeHtml(formatarData(dados.admin.ultimo_login))}</b>
    <span class="fraco mono">${escapeHtml(dados.admin.ultimo_ip ?? '')}</span></div>
</section>

<h2>Trocar senha</h2>
<form class="formulario" method="post" action="/admin/seguranca/senha" data-confirmar="Trocar a senha? Todas as sessoes serao encerradas.">
  ${csrf}
  <label>senha atual<input type="password" name="senha_atual" required maxlength="200"></label>
  <label>senha nova<input type="password" name="senha_nova" required minlength="12" maxlength="72"></label>
  <button class="botao" type="submit">trocar</button>
</form>

<h2>Autenticacao em dois fatores</h2>
${
  dados.admin.totp_ativo
    ? `<form class="formulario" method="post" action="/admin/seguranca/totp/desativar" data-confirmar="Desativar o 2FA?">
        ${csrf}
        <label>codigo atual<input type="text" name="codigo" required maxlength="64" inputmode="numeric"></label>
        <button class="botao ruim" type="submit">desativar 2FA</button>
      </form>`
    : `<form class="formulario" method="post" action="/admin/seguranca/totp/preparar">
        ${csrf}
        <p class="fraco">Gera um segredo para o Google Authenticator (ou equivalente) e o guarda cifrado.</p>
        <button class="botao" type="submit">gerar segredo</button>
      </form>`
}

<h2>Sessoes</h2>
<form class="formulario" method="post" action="/admin/seguranca/sessoes/revogar" data-confirmar="Revogar todas as sessoes?">
  ${csrf}
  <p class="fraco">Invalida refresh tokens e faz todo access token em circulacao parar de valer.</p>
  <button class="botao" type="submit">revogar tudo</button>
</form>`;
}

export function paginaTotpPreparado(dados: { csrf: string | null; segredo: string; otpauthUrl: string }): string {
  return `
<h1>Confirmar 2FA</h1>
<p class="fraco">1. Adicione no aplicativo autenticador (Google Authenticator, Authy, 1Password).</p>
<p class="codigos">${escapeHtml(dados.segredo)}</p>
<p class="fraco">Ou use o link: <span class="mono">${escapeHtml(dados.otpauthUrl)}</span></p>
<p class="fraco">2. Digite o codigo de 6 digitos gerado para confirmar a ativacao.</p>
<form class="formulario" method="post" action="/admin/seguranca/totp/ativar">
  ${campoOcultoCsrf(dados.csrf)}
  <label>codigo<input type="text" name="codigo" required maxlength="64" inputmode="numeric" placeholder="000000"></label>
  <button class="botao" type="submit">ativar 2FA</button>
</form>`;
}

export function paginaCodigosRecuperacao(dados: { csrf: string | null; codigos: string[] }): string {
  return `
<h1>2FA ativado</h1>
<p class="alerta ok">Guarde os codigos abaixo. Cada um funciona uma vez e substitui o app autenticador.</p>
<p class="codigos">${escapeHtml(dados.codigos.join('\n'))}</p>
<p class="fraco">Se perder o aparelho e os codigos, o acesso exige ADMIN_PASSWORD_HASH novo no servidor.</p>
<p><a class="botao" href="/admin/seguranca">voltar para seguranca</a></p>`;
}
