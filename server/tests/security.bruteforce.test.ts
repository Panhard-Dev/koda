import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { consumir } from '../src/services/rateLimitService.js';
import { EMAIL_ADMIN, SENHA_ADMIN, limparLimites, requisitar, zerarFalhasAdmin } from './helpers.js';

const IP = '203.0.113.50';
const SENHA_ERRADA = 'SenhaErradaMasLonga#2026';

function tentar(senha: string, email = EMAIL_ADMIN, ip = IP) {
  return requisitar('/admin/auth/login', { method: 'POST', ip, json: { email, senha } });
}

beforeEach(async () => {
  await limparLimites();
  await zerarFalhasAdmin();
});

describe('forca bruta no login do admin', () => {
  it('trava conta e IP apos 5 tentativas erradas', async () => {
    for (let tentativa = 1; tentativa <= 5; tentativa += 1) {
      const resposta = await tentar(SENHA_ERRADA);
      expect(resposta.status, `tentativa ${tentativa}`).toBe(401);
      expect(resposta.json<{ error: string }>().error).toBe('invalid_credentials');
    }

    // A senha correta não fura o bloqueio.
    const comSenhaCerta = await tentar(SENHA_ADMIN);
    expect(comSenhaCerta.status).toBe(429);
    expect(comSenhaCerta.json<{ error: string }>().error).toBe('too_many_attempts');
    expect(Number(comSenhaCerta.headers.get('retry-after'))).toBeGreaterThan(0);

    // Outro e-mail, mesmo IP: o bloqueio por IP também vale.
    const outroEmail = await tentar(SENHA_ERRADA, 'ninguem@koda.test');
    expect(outroEmail.status).toBe(429);
  });

  it('login bem-sucedido zera os contadores', async () => {
    expect((await tentar(SENHA_ERRADA)).status).toBe(401);
    expect((await tentar(SENHA_ERRADA)).status).toBe(401);
    expect((await tentar(SENHA_ADMIN)).status).toBe(200);

    // Quatro falhas novas não travam, porque o balde foi zerado no acerto.
    for (let i = 0; i < 4; i += 1) expect((await tentar(SENHA_ERRADA)).status).toBe(401);
    expect((await tentar(SENHA_ADMIN)).status).toBe(200);

    // Os baldes de lockout (login-ip/login-conta) ficam vazios; o balde do
    // limitador de rota segue contando a janela dele.
    const baldes = await env.DB.prepare("SELECT COUNT(*) AS total FROM rate_limits WHERE bucket LIKE 'login-%'").first<{
      total: number;
    }>();
    expect(Number(baldes?.total ?? 0)).toBe(0);
  });

  it('guarda o histórico das tentativas (append-only) para investigação', async () => {
    await tentar(SENHA_ERRADA);
    const registros = await env.DB.prepare('SELECT * FROM login_attempts ORDER BY id DESC').all<{
      success: number;
      email: string | null;
      reason: string | null;
    }>();
    expect(registros.results?.length ?? 0).toBeGreaterThan(0);
    expect(registros.results?.[0]?.success).toBe(0);
    expect(registros.results?.[0]?.reason).toContain('senha');

    // UPDATE é recusado pelo trigger: o histórico não pode ser reescrito.
    await expect(env.DB.prepare('UPDATE login_attempts SET reason = ? WHERE id = ?').bind('sumiu', 1).run()).rejects.toThrow();
  });

  it('respeita o limite da própria rota de login', async () => {
    // A janela do limitador de rota é de 60s com teto de 10 por IP.
    let bloqueios = 0;
    for (let i = 0; i < 12; i += 1) {
      const resposta = await tentar(SENHA_ERRADA, `pessoa${i}@koda.test`, '203.0.113.99');
      if (resposta.status === 429) bloqueios += 1;
    }
    expect(bloqueios).toBeGreaterThan(0);
  });
});

describe('contador de limite', () => {
  it('conta de forma atômica e bloqueia acima do teto', async () => {
    const chave = 'teste-limite:unico';
    const primeiro = await consumir(env.DB, { chave, limite: 3, janelaMs: 60_000 });
    expect([primeiro.hits, primeiro.permitido]).toEqual([1, true]);

    await consumir(env.DB, { chave, limite: 3, janelaMs: 60_000 });
    const terceiro = await consumir(env.DB, { chave, limite: 3, janelaMs: 60_000 });
    expect(terceiro.permitido).toBe(true);

    const quarto = await consumir(env.DB, { chave, limite: 3, janelaMs: 60_000 });
    expect(quarto.permitido).toBe(false);
    expect(quarto.hits).toBe(4);
  });

  it('reinicia a contagem quando a janela virra', async () => {
    const chave = 'teste-limite:janela';
    const agora = Date.now();
    for (let i = 0; i < 4; i += 1) {
      await consumir(env.DB, { chave, limite: 2, janelaMs: 1_000, agoraMs: agora });
    }
    const depoisDaJanela = await consumir(env.DB, { chave, limite: 2, janelaMs: 1_000, agoraMs: agora + 2_000 });
    expect(depoisDaJanela.hits).toBe(1);
    expect(depoisDaJanela.permitido).toBe(true);
  });
});
