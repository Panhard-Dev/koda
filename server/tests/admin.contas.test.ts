import { beforeEach, describe, expect, it } from 'vitest';
import {
  SENHA_CONTA,
  criarConta,
  emailUnico,
  limparLimites,
  loginAdmin,
  loginConta,
  requisitar,
  zerarFalhasAdmin,
} from './helpers.js';

interface ContaApi {
  id: string;
  email: string;
  status: 'active' | 'suspended' | 'banned';
  suspended_until: string | null;
  deleted_at: string | null;
}

async function criarModeloParaTeste(token: string, slug = `modelo-${Math.random().toString(36).slice(2, 8)}`) {
  const resposta = await requisitar('/admin/api/models', {
    method: 'POST',
    token,
    json: { slug, name: 'Modelo de teste', provider: 'host', kind: 'chat', context_window: 8192 },
  });
  expect(resposta.status).toBe(201);
  return resposta.json<{ modelo: { id: string; slug: string } }>().modelo;
}

beforeEach(async () => {
  await limparLimites();
  await zerarFalhasAdmin();
});

describe('listagem de contas', () => {
  it('filtra por status, busca e pagina', async () => {
    const admin = await loginAdmin();
    const alvo = await criarConta(emailUnico('filtro'), SENHA_CONTA, admin);
    await requisitar(`/admin/api/accounts/${alvo.id}/ban`, {
      method: 'POST',
      token: admin.token,
      json: { motivo: 'teste de filtro' },
    });

    const banidas = await requisitar('/admin/api/accounts?status=banned&por_pagina=100', { token: admin.token });
    expect(banidas.status).toBe(200);
    const dadosBanidas = banidas.json<{ contas: ContaApi[]; resumo: Record<string, number> }>();
    expect(dadosBanidas.contas.some((conta) => conta.id === alvo.id)).toBe(true);
    expect(dadosBanidas.resumo['banned']).toBeGreaterThan(0);

    const busca = await requisitar(`/admin/api/accounts?busca=${encodeURIComponent(alvo.email)}`, { token: admin.token });
    expect(busca.json<{ contas: ContaApi[] }>().contas).toHaveLength(1);

    const primeiraPagina = await requisitar('/admin/api/accounts?por_pagina=1&pagina=1', { token: admin.token });
    expect(primeiraPagina.json<{ contas: unknown[] }>().contas).toHaveLength(1);
  });

  it('cria conta e devolve senha temporária quando nenhuma é enviada', async () => {
    const admin = await loginAdmin();
    const email = emailUnico('temp');
    const resposta = await requisitar('/admin/api/accounts', {
      method: 'POST',
      token: admin.token,
      json: { email, nome: 'Senha temporaria' },
    });
    expect(resposta.status).toBe(201);
    const dados = resposta.json<{ senha_temporaria?: string }>();
    expect(dados.senha_temporaria).toBeTruthy();
    expect(dados.senha_temporaria?.length ?? 0).toBeGreaterThanOrEqual(20);

    const login = await loginConta(email, dados.senha_temporaria as string);
    expect(login.status).toBe(200);
  });
});

describe('moderação de contas', () => {
  it('banir invalida na hora os tokens ativos da conta', async () => {
    const admin = await loginAdmin();
    const conta = await criarConta(emailUnico('banida'), SENHA_CONTA, admin);
    const login = await loginConta(conta.email);
    const token = login.json<{ access_token: string; refresh_token: string }>();

    expect((await requisitar('/api/account/me', { token: token.access_token })).status).toBe(200);

    const banimento = await requisitar(`/admin/api/accounts/${conta.id}/ban`, {
      method: 'POST',
      token: admin.token,
      json: { motivo: 'violacao de termos' },
    });
    expect(banimento.status).toBe(200);
    expect(banimento.json<{ conta: ContaApi; tokens_invalidados: boolean }>().conta.status).toBe('banned');

    // Access token em circulação para de valer imediatamente.
    const aposBan = await requisitar('/api/account/me', { token: token.access_token });
    expect([401, 403]).toContain(aposBan.status);

    // Refresh token também morreu.
    const refresh = await requisitar('/api/auth/refresh', { method: 'POST', json: { refresh_token: token.refresh_token } });
    expect(refresh.status).toBe(401);

    // E o login novo é recusado como conta banida.
    const novoLogin = await loginConta(conta.email);
    expect(novoLogin.status).toBe(403);
    expect(novoLogin.json<{ error: string }>().error).toBe('account_banned');
  });

  it('suspender com prazo, reativar e voltar a entrar', async () => {
    const admin = await loginAdmin();
    const conta = await criarConta(emailUnico('suspensa'), SENHA_CONTA, admin);

    const suspensao = await requisitar(`/admin/api/accounts/${conta.id}/suspend`, {
      method: 'POST',
      token: admin.token,
      json: { motivo: 'uso indevido', horas: 48 },
    });
    expect(suspensao.status).toBe(200);
    const suspensa = suspensao.json<{ conta: ContaApi }>().conta;
    expect(suspensa.status).toBe('suspended');
    expect(Date.parse(suspensa.suspended_until ?? '')).toBeGreaterThan(Date.now());

    const bloqueado = await loginConta(conta.email);
    expect(bloqueado.status).toBe(403);
    expect(bloqueado.json<{ error: string }>().error).toBe('account_suspended');

    const reativacao = await requisitar(`/admin/api/accounts/${conta.id}/reactivate`, {
      method: 'POST',
      token: admin.token,
      json: { motivo: 'recurso aceito' },
    });
    expect(reativacao.status).toBe(200);
    expect(reativacao.json<{ conta: ContaApi }>().conta.status).toBe('active');
    expect((await loginConta(conta.email)).status).toBe(200);
  });

  it('suspensão vencida volta sozinha no próximo login', async () => {
    const admin = await loginAdmin();
    const conta = await criarConta(emailUnico('vencida'), SENHA_CONTA, admin);
    await requisitar(`/admin/api/accounts/${conta.id}/suspend`, {
      method: 'POST',
      token: admin.token,
      json: { motivo: 'prazo curto', horas: 1 },
    });
    // Empurra o vencimento para o passado direto no banco (simula o tempo passar).
    const { db } = await import('./helpers.js');
    await db
      .prepare('UPDATE users SET suspended_until = ? WHERE id = ?')
      .bind(new Date(Date.now() - 60_000).toISOString(), conta.id)
      .run();

    expect((await loginConta(conta.email)).status).toBe(200);
    const depois = await requisitar(`/admin/api/accounts/${conta.id}`, { token: admin.token });
    expect(depois.json<{ conta: ContaApi }>().conta.status).toBe('active');
  });

  it('soft delete esconde da listagem e restaurar traz de volta', async () => {
    const admin = await loginAdmin();
    const conta = await criarConta(emailUnico('removida'), SENHA_CONTA, admin);

    const remocao = await requisitar(`/admin/api/accounts/${conta.id}/delete`, {
      method: 'POST',
      token: admin.token,
      json: { motivo: 'pedido do titular' },
    });
    expect(remocao.status).toBe(200);
    expect(remocao.json<{ conta: ContaApi }>().conta.deleted_at).not.toBeNull();

    const padrao = await requisitar(`/admin/api/accounts?busca=${encodeURIComponent(conta.email)}`, { token: admin.token });
    expect(padrao.json<{ contas: ContaApi[] }>().contas).toHaveLength(0);

    const comRemovidas = await requisitar(
      `/admin/api/accounts?busca=${encodeURIComponent(conta.email)}&incluir_deletados=1`,
      { token: admin.token },
    );
    expect(comRemovidas.json<{ contas: ContaApi[] }>().contas).toHaveLength(1);

    const restauracao = await requisitar(`/admin/api/accounts/${conta.id}/restore`, {
      method: 'POST',
      token: admin.token,
      json: { motivo: 'arrependimento' },
    });
    expect(restauracao.status).toBe(200);
    expect((await loginConta(conta.email)).status).toBe(200);
  });

  it('envia aviso e o titular vê na própria conta', async () => {
    const admin = await loginAdmin();
    const conta = await criarConta(emailUnico('avisada'), SENHA_CONTA, admin);
    const aviso = await requisitar(`/admin/api/accounts/${conta.id}/notify`, {
      method: 'POST',
      token: admin.token,
      json: { titulo: 'Atualize o app', corpo: 'Saiu versão nova com correções.', severidade: 'warning' },
    });
    expect(aviso.status).toBe(201);

    const login = await loginConta(conta.email);
    const token = login.json<{ access_token: string }>().access_token;
    const perfil = await requisitar('/api/account/me', { token });
    const dados = perfil.json<{ avisos: { titulo?: string; title: string }[]; avisos_nao_lidos: number }>();
    expect(dados.avisos.some((item) => item.title === 'Atualize o app')).toBe(true);
    expect(dados.avisos_nao_lidos).toBeGreaterThan(0);
  });

  it('hard delete exige confirmação com o e-mail e some do banco', async () => {
    const admin = await loginAdmin();
    const conta = await criarConta(emailUnico('apagada'), SENHA_CONTA, admin);

    const semConfirmacao = await requisitar(`/admin/api/accounts/${conta.id}`, {
      method: 'DELETE',
      token: admin.token,
      json: { motivo: 'LGPD' },
    });
    expect(semConfirmacao.status).toBe(400);

    const errada = await requisitar(`/admin/api/accounts/${conta.id}`, {
      method: 'DELETE',
      token: admin.token,
      json: { motivo: 'LGPD', confirmacao: 'outro@email.com' },
    });
    expect(errada.status).toBe(400);

    const correta = await requisitar(`/admin/api/accounts/${conta.id}`, {
      method: 'DELETE',
      token: admin.token,
      json: { motivo: 'LGPD', confirmacao: conta.email },
    });
    expect(correta.status).toBe(200);
    expect((await requisitar(`/admin/api/accounts/${conta.id}`, { token: admin.token })).status).toBe(404);
  });

  it('exceção de modelo por usuário muda o que a conta enxerga', async () => {
    const admin = await loginAdmin();
    const modelo = await criarModeloParaTeste(admin.token);
    const conta = await criarConta(emailUnico('modelos'), SENHA_CONTA, admin);
    const login = await loginConta(conta.email);
    const token = login.json<{ access_token: string }>().access_token;

    const antes = await requisitar('/api/account/me', { token });
    expect(antes.json<{ modelos: { slug: string }[] }>().modelos.some((item) => item.slug === modelo.slug)).toBe(true);

    const excecao = await requisitar(`/admin/api/accounts/${conta.id}/models/${modelo.id}`, {
      method: 'PUT',
      token: admin.token,
      json: { habilitado: false },
    });
    expect(excecao.status).toBe(200);

    const depois = await requisitar('/api/account/me', { token });
    expect(depois.json<{ modelos: { slug: string }[] }>().modelos.some((item) => item.slug === modelo.slug)).toBe(false);
  });

  it('registra cada ação administrativa na auditoria', async () => {
    const admin = await loginAdmin();
    const conta = await criarConta(emailUnico('auditada'), SENHA_CONTA, admin);
    await requisitar(`/admin/api/accounts/${conta.id}/ban`, {
      method: 'POST',
      token: admin.token,
      json: { motivo: 'auditoria' },
    });
    await requisitar(`/admin/api/accounts/${conta.id}/reactivate`, {
      method: 'POST',
      token: admin.token,
      json: { motivo: 'auditoria' },
    });

    const auditoria = await requisitar(`/admin/api/audit?target_id=${conta.id}&por_pagina=50`, { token: admin.token });
    const entradas = auditoria.json<{ entradas: { action: string; actor_id: string | null; ip: string | null }[] }>().entradas;
    const acoes = entradas.map((item) => item.action);
    expect(acoes).toContain('account.create');
    expect(acoes).toContain('account.ban');
    expect(acoes).toContain('account.reactivate');
    expect(entradas.every((item) => item.actor_id === admin.id)).toBe(true);
    expect(entradas.some((item) => item.ip !== null)).toBe(true);
  });
});
