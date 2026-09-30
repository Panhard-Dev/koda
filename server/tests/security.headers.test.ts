import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { env } from 'cloudflare:test';
import type { Aplicacao } from '../src/types.js';
import type { Env } from '../src/config/env.js';
import { contextoDaRequisicao } from '../src/middlewares/contexto.js';
import { cabecalhosDeSeguranca } from '../src/middlewares/seguranca.js';
import { corsRestritivo } from '../src/middlewares/cors.js';
import { exigirHttps } from '../src/middlewares/https.js';

/**
 * Configuração de produção: os testes usam NODE_ENV=test, então HSTS e o
 * redirecionamento de HTTP só podem ser verificados com um env próprio — que é
 * exatamente o que o Hono permite passar por requisição.
 */
const envProducao = {
  ...(env as unknown as Record<string, unknown>),
  NODE_ENV: 'production',
  CORS_ORIGIN: 'https://koda.test,https://tauri.localhost',
  ALLOW_INSECURE_HTTP: 'false',
} as unknown as Env;

const app = new Hono<Aplicacao>();
app.use('*', contextoDaRequisicao);
app.use('*', cabecalhosDeSeguranca);
app.use('*', exigirHttps);
app.use('*', corsRestritivo);
app.get('/pagina', (c) => c.html('<p>painel</p>'));
app.get('/dados', (c) => c.json({ ok: true }));

const pedir = (url: string, init: RequestInit = {}, ambiente: Env = envProducao) => app.request(url, init, ambiente);

describe('cabeçalhos de segurança (produção)', () => {
  it('redireciona HTTP para HTTPS preservando método e caminho', async () => {
    const resposta = await pedir('http://admin.koda.test/pagina?a=1');
    expect(resposta.status).toBe(308);
    expect(resposta.headers.get('location')).toBe('https://admin.koda.test/pagina?a=1');
  });

  it('manda HSTS apenas em HTTPS', async () => {
    const resposta = await pedir('https://admin.koda.test/pagina');
    expect(resposta.status).toBe(200);
    expect(resposta.headers.get('strict-transport-security')).toContain('max-age=31536000');
    expect(resposta.headers.get('strict-transport-security')).toContain('includeSubDomains');
  });

  it('aplica a família de cabeçalhos do helmet', async () => {
    const resposta = await pedir('https://admin.koda.test/dados');
    expect(resposta.headers.get('x-content-type-options')).toBe('nosniff');
    expect(resposta.headers.get('x-frame-options')).toBe('DENY');
    expect(resposta.headers.get('referrer-policy')).toBe('no-referrer');
    expect(resposta.headers.get('permissions-policy')).toContain('geolocation=()');
    expect(resposta.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(resposta.headers.get('x-permitted-cross-domain-policies')).toBe('none');
    expect(resposta.headers.get('cache-control')).toContain('no-store');
    expect(resposta.headers.get('x-request-id')).toBeTruthy();
  });

  it('CSP é restritiva e diferente para HTML e para dados', async () => {
    const html = await pedir('https://admin.koda.test/pagina');
    const cspHtml = html.headers.get('content-security-policy') ?? '';
    expect(cspHtml).toContain("default-src 'none'");
    expect(cspHtml).toContain("script-src 'self'");
    expect(cspHtml).toContain("frame-ancestors 'none'");
    expect(cspHtml).toContain("form-action 'self'");
    expect(cspHtml).not.toContain("'unsafe-inline'");
    expect(cspHtml).not.toContain('*');

    const dados = await pedir('https://admin.koda.test/dados');
    const cspDados = dados.headers.get('content-security-policy') ?? '';
    expect(cspDados).toContain("default-src 'none'");
    expect(cspDados).not.toContain('script-src');
  });

  it('em modo de teste (HTTP liberado) não redireciona nem manda HSTS', async () => {
    const emTeste = { ...(env as unknown as Record<string, unknown>) } as unknown as Env;
    const resposta = await pedir('http://localhost:8788/dados', {}, emTeste);
    expect(resposta.status).toBe(200);
    expect(resposta.headers.get('strict-transport-security')).toBeNull();
  });
});

describe('CORS com whitelist', () => {
  it('libera origem da lista com credenciais', async () => {
    const resposta = await pedir('https://admin.koda.test/dados', {
      headers: { origin: 'https://tauri.localhost' },
    });
    expect(resposta.headers.get('access-control-allow-origin')).toBe('https://tauri.localhost');
    expect(resposta.headers.get('access-control-allow-credentials')).toBe('true');
    expect(resposta.headers.get('vary')).toContain('Origin');
  });

  it('não devolve cabeçalho para origem fora da lista', async () => {
    const resposta = await pedir('https://admin.koda.test/dados', {
      headers: { origin: 'https://site-malicioso.test' },
    });
    expect(resposta.headers.get('access-control-allow-origin')).toBeNull();
    expect(resposta.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('aceita loopback em produção (Vite de quem desenvolve) e recusa disfarce', async () => {
    // O desenvolvimento no navegador fala com o Worker publicado: `localhost` precisa
    // passar mesmo em produção, em qualquer porta.
    for (const origem of ['http://localhost:5173', 'http://127.0.0.1:5199', 'http://localhost']) {
      const resposta = await pedir('https://admin.koda.test/dados', { headers: { origin: origem } });
      expect(resposta.headers.get('access-control-allow-origin')).toBe(origem);
    }

    // O que parece loopback e não é continua fora.
    for (const origem of [
      'https://localhost.site-malicioso.test',
      'http://localhost.site-malicioso.test',
      'http://127.0.0.1.site-malicioso.test',
    ]) {
      const resposta = await pedir('https://admin.koda.test/dados', { headers: { origin: origem } });
      expect(resposta.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('preflight só responde com credenciais quando a origem é permitida', async () => {
    const permitido = await pedir('https://admin.koda.test/dados', {
      method: 'OPTIONS',
      headers: { origin: 'https://koda.test', 'access-control-request-method': 'POST' },
    });
    expect(permitido.status).toBe(204);
    expect(permitido.headers.get('access-control-allow-methods')).toContain('POST');
    expect(permitido.headers.get('access-control-allow-headers')).toContain('x-koda-csrf');

    const negado = await pedir('https://admin.koda.test/dados', {
      method: 'OPTIONS',
      headers: { origin: 'https://outro.test', 'access-control-request-method': 'POST' },
    });
    expect(negado.status).toBe(204);
    expect(negado.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('nunca responde com curinga quando há credenciais', async () => {
    const resposta = await pedir('https://admin.koda.test/dados', { headers: { origin: 'https://koda.test' } });
    expect(resposta.headers.get('access-control-allow-origin')).not.toBe('*');
  });
});
