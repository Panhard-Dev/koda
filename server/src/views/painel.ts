import type { AuditoriaRow } from '../models/auditLog.js';
import type { NotificacaoRow } from '../models/notifications.js';
import type { UserRow } from '../models/users.js';
import type { UserModelRow } from '../models/userModels.js';
import type { ModeloParaUsuario } from '../models/catalogModels.js';
import { atributo, escapeHtml, formatarData, jsonSeguro, truncar } from '../utils/html.js';
import { campoOcultoCsrf } from './layout.js';

const ROTULO_STATUS: Record<string, string> = {
  active: 'ativa',
  suspended: 'suspensa',
  banned: 'banida',
};

function pilulaStatus(status: string): string {
  const chave = ROTULO_STATUS[status] ? status : 'active';
  return `<span class="pilula ${chave}">${escapeHtml(ROTULO_STATUS[status] ?? status)}</span>`;
}

/* ------------------------------- Painel ---------------------------------- */
export function paginaPainel(dados: {
  csrf: string | null;
  admin: { email: string; papel: string; ultimo_login: string | null };
  contas: Record<string, number>;
  modelos: { total: number; ativos: number; excecoes: number };
  releases: { total: number; publicadas: number };
  auditoria: { total: number; ultimas: AuditoriaRow[] };
}): string {
  const contasAtivas = dados.contas['active'] ?? 0;
  const suspensas = dados.contas['suspended'] ?? 0;
  const banidas = dados.contas['banned'] ?? 0;

  const linhas = dados.auditoria.ultimas
    .map(
      (item) => `<tr>
        <td class="mono">${escapeHtml(formatarData(item.created_at))}</td>
        <td class="mono">${escapeHtml(item.action)}</td>
        <td>${escapeHtml(item.actor_email ?? item.actor_type)}</td>
        <td>${escapeHtml(item.target_type ?? '—')}</td>
        <td class="${item.outcome === 'success' ? 'fraco' : 'ruim'}">${escapeHtml(item.outcome)}</td>
      </tr>`,
    )
    .join('');

  return `
<h1>Painel</h1>
<p class="fraco">Sessao de ${escapeHtml(dados.admin.email)} (${escapeHtml(dados.admin.papel)}) · ultimo login ${escapeHtml(formatarData(dados.admin.ultimo_login))}</p>
<section class="cartoes">
  <div class="cartao"><span>contas ativas</span><b>${contasAtivas}</b></div>
  <div class="cartao"><span>suspensas</span><b>${suspensas}</b></div>
  <div class="cartao"><span>banidas</span><b>${banidas}</b></div>
  <div class="cartao"><span>modelos ativos</span><b>${dados.modelos.ativos}/${dados.modelos.total}</b></div>
  <div class="cartao"><span>excecoes por usuario</span><b>${dados.modelos.excecoes}</b></div>
  <div class="cartao"><span>releases publicadas</span><b>${dados.releases.publicadas}/${dados.releases.total}</b></div>
  <div class="cartao"><span>eventos auditados</span><b>${dados.auditoria.total}</b></div>
</section>
<h2>Ultimas acoes administrativas</h2>
<table>
  <thead><tr><th>quando</th><th>acao</th><th>autor</th><th>alvo</th><th>resultado</th></tr></thead>
  <tbody>${linhas || '<tr><td colspan="5" class="fraco">Nada registrado ainda.</td></tr>'}</tbody>
</table>`;
}

/* ------------------------------- Contas ---------------------------------- */
export function paginaContas(dados: {
  csrf: string | null;
  contas: UserRow[];
  total: number;
  pagina: number;
  porPagina: number;
  filtro: { status?: string; busca?: string };
}): string {
  const linhas = dados.contas
    .map(
      (conta) => `<tr>
      <td>${escapeHtml(conta.email)}${conta.display_name ? `<br><span class="fraco">${escapeHtml(conta.display_name)}</span>` : ''}</td>
      <td>${pilulaStatus(conta.status)}${conta.suspended_until ? `<br><span class="fraco mono">ate ${escapeHtml(formatarData(conta.suspended_until))}</span>` : ''}</td>
      <td class="fraco mono">${escapeHtml(formatarData(conta.created_at))}</td>
      <td class="fraco mono">${escapeHtml(formatarData(conta.last_login_at))}</td>
      <td>${conta.deleted_at ? '<span class="pilula banned">removida</span>' : ''}</td>
      <td><a class="botao pequeno neutro" href="/admin/contas/${escapeHtml(conta.id)}">abrir</a></td>
    </tr>`,
    )
    .join('');

  const totalPaginas = Math.max(1, Math.ceil(dados.total / dados.porPagina));
  const anterior = dados.pagina > 1 ? dados.pagina - 1 : 1;
  const proxima = dados.pagina < totalPaginas ? dados.pagina + 1 : totalPaginas;

  return `
<h1>Contas <span class="fraco">(${dados.total})</span></h1>
<form class="formulario" method="get" action="/admin/contas">
  <label>busca<input type="text" name="busca" maxlength="120" value="${atributo(dados.filtro.busca ?? '')}"></label>
  <label>status
    <select name="status" data-enviar-ao-mudar>
      <option value="">todas</option>
      ${['active', 'suspended', 'banned']
        .map(
          (valor) =>
            `<option value="${valor}"${dados.filtro.status === valor ? ' selected' : ''}>${ROTULO_STATUS[valor]}</option>`,
        )
        .join('')}
    </select>
  </label>
  <label>por pagina<input type="number" name="por_pagina" min="1" max="100" value="${dados.porPagina}"></label>
  <button class="botao" type="submit">Filtrar</button>
</form>

<h2>Criar conta</h2>
<form class="formulario" method="post" action="/admin/contas">
  ${campoOcultoCsrf(dados.csrf)}
  <label>e-mail<input type="email" name="email" required maxlength="254"></label>
  <label>nome<input type="text" name="nome" maxlength="160"></label>
  <label>senha inicial<input type="password" name="senha" required minlength="12" maxlength="200"></label>
  <button class="botao" type="submit">Criar</button>
</form>

<table>
  <thead><tr><th>conta</th><th>status</th><th>criada</th><th>ultimo login</th><th>marcadores</th><th></th></tr></thead>
  <tbody>${linhas || '<tr><td colspan="6" class="fraco">Nenhuma conta encontrada.</td></tr>'}</tbody>
</table>

<div class="paginacao">
  <a class="botao pequeno neutro" href="/admin/contas?pagina=${anterior}&por_pagina=${dados.porPagina}">anterior</a>
  <span class="fraco">pagina ${dados.pagina} de ${totalPaginas}</span>
  <a class="botao pequeno neutro" href="/admin/contas?pagina=${proxima}&por_pagina=${dados.porPagina}">proxima</a>
  <a class="botao pequeno neutro" href="/admin/contas?incluir_deletados=1">incluir removidas</a>
</div>`;
}

export function paginaConta(dados: {
  csrf: string | null;
  conta: Omit<UserRow, 'password_hash'>;
  excecoes: UserModelRow[];
  avisos: NotificacaoRow[];
  sessoesAtivas: number;
  historico: AuditoriaRow[];
  modelosDisponiveis: ModeloParaUsuario[];
}): string {
  const conta = dados.conta;
  const historico = dados.historico
    .map(
      (item) => `<tr>
      <td class="mono">${escapeHtml(formatarData(item.created_at))}</td>
      <td class="mono">${escapeHtml(item.action)}</td>
      <td>${escapeHtml(item.actor_email ?? item.actor_type)}</td>
      <td class="fraco">${escapeHtml(truncar(item.details ?? '', 80))}</td>
    </tr>`,
    )
    .join('');

  const avisos = dados.avisos
    .map(
      (item) => `<li><b>${escapeHtml(item.title)}</b> <span class="fraco mono">${escapeHtml(formatarData(item.created_at))}</span>
      <div class="fraco">${escapeHtml(truncar(item.body, 160))}</div></li>`,
    )
    .join('');

  const excecoes = new Map(dados.excecoes.map((item) => [item.model_id, item.enabled === 1]));
  const modelos = dados.modelosDisponiveis
    .map(
      (modelo) => `<tr>
      <td>${escapeHtml(modelo.name)} <span class="fraco mono">${escapeHtml(modelo.slug)}</span></td>
      <td>${modelo.habilitado_usuario === 1 ? '<span class="pilula active">habilitado</span>' : '<span class="pilula banned">desabilitado</span>'}</td>
      <td class="fraco">${excecoes.has(modelo.id) ? 'excecao individual' : 'herda o global'}</td>
      <td>
        <form class="inline" method="post" action="/admin/contas/${escapeHtml(conta.id)}/modelos">
          ${campoOcultoCsrf(dados.csrf)}
          <input type="hidden" name="model_id" value="${escapeHtml(modelo.id)}">
          <select name="habilitado">
            <option value="1">habilitar</option>
            <option value="0">desabilitar</option>
            <option value="herdar">herdar global</option>
          </select>
          <button class="botao pequeno" type="submit">aplicar</button>
        </form>
      </td>
    </tr>`,
    )
    .join('');

  return `
<h1>${escapeHtml(conta.email)}</h1>
<p>${pilulaStatus(conta.status)} ${conta.deleted_at ? '<span class="pilula banned">removida</span>' : ''}
  <span class="fraco mono">id ${escapeHtml(conta.id)}</span></p>

<section class="detalhe cartoes">
  <div class="cartao"><span>criada em</span><b class="mono">${escapeHtml(formatarData(conta.created_at))}</b></div>
  <div class="cartao"><span>ultimo login</span><b class="mono">${escapeHtml(formatarData(conta.last_login_at))}</b></div>
  <div class="cartao"><span>sessoes ativas</span><b>${dados.sessoesAtivas}</b></div>
  <div class="cartao"><span>motivo do status</span><b class="fraco">${escapeHtml(conta.status_reason ?? '—')}</b></div>
</section>

<h2>Moderacao</h2>
<div class="formulario">
  <form class="inline" method="post" action="/admin/contas/${atributo(conta.id)}/banir" data-confirmar="Banir esta conta?">
    ${campoOcultoCsrf(dados.csrf)}
    <label>motivo<input type="text" name="motivo" required minlength="3" maxlength="300"></label>
    <button class="botao ruim" type="submit">banir</button>
  </form>
  <form class="inline" method="post" action="/admin/contas/${atributo(conta.id)}/suspender" data-confirmar="Suspender temporariamente?">
    ${campoOcultoCsrf(dados.csrf)}
    <label>motivo<input type="text" name="motivo" required minlength="3" maxlength="300"></label>
    <label>horas<input type="number" name="horas" min="1" max="8760" value="72" required></label>
    <button class="botao" type="submit">suspender</button>
  </form>
  <form class="inline" method="post" action="/admin/contas/${atributo(conta.id)}/reativar" data-confirmar="Reverter banimento/suspensao?">
    ${campoOcultoCsrf(dados.csrf)}
    <label>motivo<input type="text" name="motivo" required minlength="3" maxlength="300" value="revertido pelo painel"></label>
    <button class="botao neutro" type="submit">reativar</button>
  </form>
  <form class="inline" method="post" action="/admin/contas/${atributo(conta.id)}/remover" data-confirmar="Remover a conta (soft delete)?">
    ${campoOcultoCsrf(dados.csrf)}
    <label>motivo<input type="text" name="motivo" required minlength="3" maxlength="300"></label>
    <button class="botao ruim" type="submit">remover</button>
  </form>
  ${
    conta.deleted_at
      ? `<form class="inline" method="post" action="/admin/contas/${atributo(conta.id)}/restaurar">
          ${campoOcultoCsrf(dados.csrf)}
          <label>motivo<input type="text" name="motivo" required minlength="3" maxlength="300" value="restaurada pelo painel"></label>
          <button class="botao" type="submit">restaurar</button>
        </form>`
      : ''
  }
</div>

<h2>Enviar aviso</h2>
<form class="formulario" method="post" action="/admin/contas/${atributo(conta.id)}/avisar">
  ${campoOcultoCsrf(dados.csrf)}
  <label>titulo<input type="text" name="titulo" required minlength="2" maxlength="120"></label>
  <label>mensagem<textarea name="corpo" required minlength="2" maxlength="2000"></textarea></label>
  <label>gravidade
    <select name="severidade">
      <option value="info">info</option>
      <option value="warning">aviso</option>
      <option value="critical">critico</option>
    </select>
  </label>
  <button class="botao" type="submit">enviar</button>
</form>
${avisos ? `<ul>${avisos}</ul>` : '<p class="fraco">Nenhum aviso enviado ainda.</p>'}

<h2>Modelos para esta conta</h2>
<table>
  <thead><tr><th>modelo</th><th>efetivo</th><th>origem</th><th>excecao</th></tr></thead>
  <tbody>${modelos || '<tr><td colspan="4" class="fraco">Nenhum modelo ativo no catalogo.</td></tr>'}</tbody>
</table>

<h2>Historico desta conta</h2>
<table>
  <thead><tr><th>quando</th><th>acao</th><th>autor</th><th>detalhe</th></tr></thead>
  <tbody>${historico || '<tr><td colspan="4" class="fraco">Sem eventos.</td></tr>'}</tbody>
</table>`;
}

export function dadosBrutosParaDebug(valor: unknown): string {
  return `<pre class="codigos">${escapeHtml(jsonSeguro(valor))}</pre>`;
}
