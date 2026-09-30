import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { EMISSOR, assinarToken } from '../src/utils/jwt.js';
import type { ClaimsAccess } from '../src/utils/jwt.js';
import { getConfig, type Env } from '../src/config/env.js';
import { base64url } from './utilitarios.js';
import { SENHA_CONTA, criarConta, emailUnico, limparLimites, loginAdmin, loginConta, requisitar } from './helpers.js';

const ROTAS: { method: string; caminho: string }[] = [
  { method: 'GET', caminho: '/admin/api/me' },
  { method: 'GET', caminho: '/admin/api/overview' },
  { method: 'GET', caminho: '/admin/api/accounts' },
  { method: 'POST', caminho: '/admin/api/accounts' },
  { method: 'GET', caminho: '/admin/api/accounts/naoexiste123' },
  { method: 'POST', caminho: '/admin/api/accounts/naoexiste123/ban' },
  { method: 'POST', caminho: '/admin/api/accounts/naoexiste123/suspend' },
  { method: 'POST', caminho: '/admin/api/accounts/naoexiste123/reactivate' },
  { method: 'POST', caminho: '/admin/api/accounts/naoexiste123/delete' },
  { method: 'POST', caminho: '/admin/api/accounts/naoexiste123/restore' },
  { method: 'POST', caminho: '/admin/api/accounts/naoexiste123/notify' },
  { method: 'PUT', caminho: '/admin/api/accounts/naoexiste123/models/modelx123' },
  { method: 'DELETE', caminho: '/admin/api/accounts/naoexiste123' },
  { method: 'GET', caminho: '/admin/api/models' },
  { method: 'POST', caminho: '/admin/api/models' },
  { method: 'PATCH', caminho: '/admin/api/models/naoexiste123' },
  { method: 'POST', caminho: '/admin/api/models/naoexiste123/activate' },
  { method: 'POST', caminho: '/admin/api/models/naoexiste123/deactivate' },
  { method: 'POST', caminho: '/admin/api/models/naoexiste123/restore' },
  { method: 'DELETE', caminho: '/admin/api/models/naoexiste123' },
  { method: 'GET', caminho: '/admin/api/uploads' },
  { method: 'POST', caminho: '/admin/api/uploads' },
  { method: 'GET', caminho: '/admin/api/releases' },
  { method: 'POST', caminho: '/admin/api/releases' },
  { method: 'PATCH', caminho: '/admin/api/releases/naoexiste123' },
  { method: 'POST', caminho: '/admin/api/releases/naoexiste123/publish' },
  { method: 'DELETE', caminho: '/admin/api/releases/naoexiste123' },
  { method: 'GET', caminho: '/admin/api/audit' },
  { method: 'GET', caminho: '/admin/api/audit/verify' },
  { method: 'GET', caminho: '/admin/api/audit/logins' },
  { method: 'POST', caminho: '/admin/api/security/password' },
  { method: 'POST', caminho: '/admin/api/security/totp/setup' },
  { method: 'POST', caminho: '/admin/api/security/sessions/revoke-all' },
];

let secret: string;

beforeAll(async () => {
  secret = getConfig(env as unknown as Env).secrets.jwt;
});

describe('autorizacao das rotas /admin/*', () => {
  it('sem token responde 401 em todas as rotas administrativas', async () => {
    for (const rota of ROTAS) {
      const resposta = await requisitar(rota.caminho, { method: rota.method, json: {} });
      expect(resposta.status, `${rota.method} ${rota.caminho}`).toBe(401);
      expect(resposta.json<{ error: string }>().error).toBe('missing_token');
    }
  });

  it('com token ilegivel responde 401', async () => {
    for (const token of ['nao-e-token', 'a.b', 'a.b.c.d', '']) {
      const resposta = await requisitar('/admin/api/me', { token: token === '' ? null : token });
      expect(resposta.status).toBe(401);
    }
  });

  it('com assinatura adulterada responde 401', async () => {
    const admin = await loginAdmin();
    // Troca o último caractere da assinatura: o HMAC deixa de conferir.
    const assinaturaOriginal = admin.token.slice(admin.token.lastIndexOf('.') + 1);
    const trocado = `${admin.token.slice(0, admin.token.lastIndexOf('.'))}.${assinaturaOriginal.slice(0, -1)}${
      assinaturaOriginal.endsWith('A') ? 'B' : 'A'
    }`;
    const resposta = await requisitar('/admin/api/me', { token: trocado });
    expect(resposta.status).toBe(401);
    expect(resposta.json<{ error: string }>().error).toBe('invalid_token');
  });

  it('com token expirado responde 401 token_expired', async () => {
    const admin = await loginAdmin();
    const agora = Math.floor(Date.now() / 1000);
    const claims: ClaimsAccess = {
      sub: admin.id,
      typ: 'access',
      aud: 'admin',
      iss: EMISSOR,
      iat: agora - 3600,
      exp: agora - 60,
      sid: 'familia-qualquer',
      role: 'superadmin',
    };
    const token = await assinarToken(claims, secret);
    const resposta = await requisitar('/admin/api/me', { token });
    expect(resposta.status).toBe(401);
    expect(resposta.json<{ error: string }>().error).toBe('token_expired');
  });

  it('recusa alg=none (troca de algoritmo)', async () => {
    const admin = await loginAdmin();
    const [, payload] = admin.token.split('.');
    const cabecalhoFalso = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const token = `${cabecalhoFalso}.${payload}.`;
    const resposta = await requisitar('/admin/api/me', { token });
    expect(resposta.status).toBe(401);
    expect(resposta.json<{ error: string }>().error).toBe('invalid_token');
  });

  it('token de conta comum nao acessa painel (403)', async () => {
    const conta = await criarConta(emailUnico('comum'));
    const login = await loginConta(conta.email, SENHA_CONTA, '198.51.100.77');
    expect(login.status).toBe(200);
    const token = login.json<{ access_token: string }>().access_token;

    for (const rota of [
      { method: 'GET', caminho: '/admin/api/accounts' },
      { method: 'GET', caminho: '/admin/api/audit' },
      { method: 'POST', caminho: '/admin/api/accounts' },
    ]) {
      const resposta = await requisitar(rota.caminho, { method: rota.method, token, json: {} });
      expect(resposta.status, `${rota.method} ${rota.caminho}`).toBe(403);
      expect(resposta.json<{ error: string }>().error).toBe('insufficient_role');
    }
  });

  it('token de admin nao vale nas rotas de conta do app', async () => {
    const admin = await loginAdmin();
    const resposta = await requisitar('/api/account/me', { token: admin.token });
    expect([401, 403]).toContain(resposta.status);
  });

  it('admin autenticado acessa as rotas de leitura', async () => {
    await limparLimites();
    const admin = await loginAdmin();
    for (const caminho of ['/admin/api/me', '/admin/api/overview', '/admin/api/accounts', '/admin/api/models']) {
      const resposta = await requisitar(caminho, { token: admin.token });
      expect(resposta.status, caminho).toBe(200);
    }
  });

  it('painel HTML sem sessao redireciona para o login', async () => {
    const resposta = await requisitar('/admin/contas');
    expect(resposta.status).toBe(303);
    expect(resposta.headers.get('location')).toContain('/admin/login');
  });
});
