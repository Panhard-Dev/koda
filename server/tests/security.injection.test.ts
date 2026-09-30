import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { criarConta, emailUnico, limparLimites, loginAdmin, requisitar } from './helpers.js';

const INJECOES = [
  "' OR 1=1 --",
  "'; DROP TABLE users; --",
  "1' UNION SELECT password_hash FROM admins --",
  'admin@koda.test" OR "1"="1',
  '%27%20OR%201%3D1',
];

beforeEach(async () => {
  await limparLimites();
});

describe('injeção de SQL', () => {
  it('login com carga de injeção não autentica nem derruba o banco', async () => {
    for (const carga of INJECOES) {
      const resposta = await requisitar('/admin/auth/login', {
        method: 'POST',
        ip: '192.0.2.10',
        json: { email: carga, senha: carga },
      });
      expect([400, 401, 429], carga).toContain(resposta.status);
      expect(resposta.texto).not.toMatch(/SQLITE|D1_ERROR|no such table|syntax error/i);
    }
    // A tabela continua de pé e com o admin intacto.
    const linha = await env.DB.prepare('SELECT COUNT(*) AS total FROM admins WHERE deleted_at IS NULL').first<{
      total: number;
    }>();
    expect(Number(linha?.total ?? 0)).toBeGreaterThan(0);
  });

  it('filtros e ordenação são parametrizados (nada de SQL montado)', async () => {
    const admin = await loginAdmin();
    const alvo = await criarConta(emailUnico('injecao'), 'SenhaDeConta#2026', admin);

    for (const carga of INJECOES) {
      const busca = await requisitar(`/admin/api/accounts?busca=${encodeURIComponent(carga)}`, { token: admin.token });
      expect(busca.status, carga).toBe(200);
      expect(busca.json<{ contas: unknown[] }>().contas).toHaveLength(0);
    }

    // Coluna de ordenação fora da whitelist é recusada pelo esquema.
    const ordenacao = await requisitar('/admin/api/accounts?ordenar=id;DROP+TABLE+users', { token: admin.token });
    expect(ordenacao.status).toBe(400);

    const ordemValida = await requisitar('/admin/api/accounts?ordenar=email&direcao=asc&busca=injecao', {
      token: admin.token,
    });
    expect(ordemValida.status).toBe(200);
    expect(ordemValida.json<{ contas: { id: string }[] }>().contas[0]?.id).toBe(alvo.id);

    const tabela = await env.DB.prepare('SELECT COUNT(*) AS total FROM users').first<{ total: number }>();
    expect(Number(tabela?.total ?? 0)).toBeGreaterThan(0);
  });

  it('rotas públicas resistem a carga em versão, canal e id de asset', async () => {
    for (const carga of INJECOES) {
      const versao = await requisitar(`/api/public/version?versao=${encodeURIComponent(carga)}`);
      expect(versao.status, carga).toBe(400);
      expect(versao.texto).not.toMatch(/SQLITE|D1_ERROR/i);
    }
    const canalRuim = await requisitar('/api/public/version?versao=1.0.0&canal=stable%27%20OR%201=1');
    expect(canalRuim.status).toBe(400);

    const asset = await requisitar('/api/public/assets/1%27%20OR%20%271%27%3D%271');
    expect([400, 404]).toContain(asset.status);
  });

  it('slug e versão com metacaracteres são tratados como texto', async () => {
    const admin = await loginAdmin();
    const modelo = await requisitar('/admin/api/models', {
      method: 'POST',
      token: admin.token,
      json: { slug: "koda'--", name: 'Modelo' },
    });
    expect(modelo.status).toBe(400);

    const release = await requisitar('/admin/api/releases', {
      method: 'POST',
      token: admin.token,
      json: { version: "1.0.0'; DROP TABLE releases;--", download_url: 'https://cdn.koda.test/app.exe' },
    });
    expect(release.status).toBe(400);

    const releaseRuim = await requisitar('/admin/api/releases', {
      method: 'POST',
      token: admin.token,
      json: { version: '9.9.9', download_url: 'https://usuario:senha@cdn.koda.test/app.exe' },
    });
    expect(releaseRuim.status).toBe(400);
  });
});

describe('XSS', () => {
  it('painel escapa HTML vindo do banco', async () => {
    const admin = await loginAdmin();
    const carga = '<script>alert(1)</script>';
    const criado = await requisitar('/admin/api/models', {
      method: 'POST',
      token: admin.token,
      json: { slug: `xss-${Math.random().toString(36).slice(2, 8)}`, name: carga, description: carga },
    });
    expect(criado.status).toBe(201);

    const pagina = await requisitar('/admin/modelos', { cookie: admin.cookies });
    expect(pagina.status).toBe(200);
    expect(pagina.headers.get('content-type')).toContain('text/html');
    // O texto escapado aparece; a tag crua não.
    expect(pagina.texto).not.toContain(carga);
    expect(pagina.texto).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // E a CSP bloqueia script inline, mesmo se algo escapasse.
    expect(pagina.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(pagina.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('aviso com HTML é escapado na tela da conta e volta como dado na API', async () => {
    const admin = await loginAdmin();
    const conta = await criarConta(emailUnico('xss-aviso'), 'SenhaDeConta#2026', admin);
    const carga = '<img src=x onerror=alert(1)>';
    await requisitar(`/admin/api/accounts/${conta.id}/notify`, {
      method: 'POST',
      token: admin.token,
      json: { titulo: carga, corpo: carga, severidade: 'info' },
    });

    const pagina = await requisitar(`/admin/contas/${conta.id}`, { cookie: admin.cookies });
    expect(pagina.texto).not.toContain(carga);
    expect(pagina.texto).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('resposta JSON nunca é servida como HTML', async () => {
    const resposta = await requisitar('/api/public/models');
    expect(resposta.headers.get('content-type')).toContain('application/json');
    expect(resposta.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
