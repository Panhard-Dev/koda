import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { codigoDeErro } from '../src/controllers/panelController.js';
import { requisicaoInvalida } from '../src/utils/errors.js';
import { EMAIL_ADMIN, SENHA_ADMIN, requisitar } from './helpers.js';

/**
 * O painel é HTML com formulários: sessão em cookie (não Bearer) e CSRF em campo
 * oculto. Nada disso passa pelo middleware do Bearer, então é aqui que se garante
 * que uma ação de formulário realmente autentica, grava e não volta para o login.
 */

const cookieDe = (cookies: string, nome: string) =>
  cookies
    .split('; ')
    .find((item) => item.startsWith(`${nome}=`))
    ?.slice(nome.length + 1) ?? '';

const CORPO_FORM = { 'content-type': 'application/x-www-form-urlencoded' };

/** Entra pelo próprio formulário do painel e devolve a sessão em cookies. */
async function entrarNoPainel(): Promise<{ cookie: string; csrf: string }> {
  const tela = await requisitar('/admin/login');
  const csrf = cookieDe(tela.cookies, 'koda_admin_csrf');
  const entrada = await requisitar('/admin/login', {
    method: 'POST',
    cookie: tela.cookies,
    headers: CORPO_FORM,
    body: new URLSearchParams({
      email: EMAIL_ADMIN,
      senha: SENHA_ADMIN,
      csrf,
      proximo: '/admin',
    }).toString(),
  });
  expect(entrada.status).toBe(303);
  return { cookie: entrada.cookies, csrf: cookieDe(entrada.cookies, 'koda_admin_csrf') };
}

describe('tela de login do painel', () => {
  it('abre só com e-mail e senha quando a conta não usa 2FA', async () => {
    const resposta = await requisitar('/admin/login');

    expect(resposta.status).toBe(200);
    expect(resposta.texto).toContain('name="senha"');
    expect(resposta.texto).not.toContain('name="totp"');
  });

  it('reabre com o campo de 2FA quando o servidor pede o código', async () => {
    const resposta = await requisitar('/admin/login?erro=2fa-obrigatorio');

    expect(resposta.texto).toContain('name="totp"');
    expect(resposta.texto).toContain('Informe o codigo do autenticador.');
  });

  it('só traduz para "pede 2FA" o erro que é de 2FA', () => {
    expect(codigoDeErro(requisicaoInvalida('codigo de 2FA obrigatorio'))).toBe('2fa-obrigatorio');
    expect(codigoDeErro(requisicaoInvalida('campo qualquer'))).toBe('entrada-invalida');
  });
});

describe('ações de formulário do painel', () => {
  it('publica release pelo formulário e grava no D1', async () => {
    const { cookie, csrf } = await entrarNoPainel();

    const resposta = await requisitar('/admin/versoes', {
      method: 'POST',
      cookie,
      headers: CORPO_FORM,
      body: new URLSearchParams({
        csrf,
        version: '0.2.0',
        download_url: 'https://downloads.exemplo/koda.exe',
        channel: 'stable',
        mandatory: '0',
        notes: 'Publicada pelo formulário do painel.',
      }).toString(),
    });

    // Já falhou aqui: o POST caía em /admin/login?proximo=... e nada era gravado.
    expect(resposta.status).toBe(303);
    expect(resposta.headers.get('location')).toContain('/admin/versoes');
    expect(resposta.headers.get('location')).not.toContain('/login');

    const linha = await env.DB.prepare(
      'SELECT version, channel, notes FROM releases WHERE version = ?',
    )
      .bind('0.2.0')
      .first<{ version: string; channel: string; notes: string }>();

    expect(linha?.version).toBe('0.2.0');
    expect(linha?.channel).toBe('stable');
    expect(linha?.notes).toContain('formulário');
  });

  it('publica com os campos opcionais em branco', async () => {
    const { cookie, csrf } = await entrarNoPainel();

    // Era exatamente o formulário do print: versão mínima e changelog vazios
    // derrubavam a validação inteira e a resposta vinha em JSON cru.
    const resposta = await requisitar('/admin/versoes', {
      method: 'POST',
      cookie,
      headers: CORPO_FORM,
      body: new URLSearchParams({
        csrf,
        version: '0.3.0',
        download_url: 'https://downloads.exemplo/koda-0.3.0.exe',
        channel: 'stable',
        mandatory: '0',
        min_supported_version: '',
        notes: '',
      }).toString(),
    });

    expect(resposta.status).toBe(303);
    expect(resposta.headers.get('location')).toContain('/admin/versoes?aviso=versao-publicada');

    const linha = await env.DB.prepare('SELECT version, min_supported_version, notes FROM releases WHERE version = ?')
      .bind('0.3.0')
      .first<{ version: string; min_supported_version: string | null; notes: string | null }>();

    expect(linha?.version).toBe('0.3.0');
    expect(linha?.min_supported_version).toBeNull();
    expect(linha?.notes).toBeNull();
  });

  it('formulário inválido volta para a tela com aviso, nunca em JSON', async () => {
    const { cookie, csrf } = await entrarNoPainel();

    const resposta = await requisitar('/admin/versoes', {
      method: 'POST',
      cookie,
      headers: CORPO_FORM,
      body: new URLSearchParams({
        csrf,
        version: 'nao-e-versao',
        download_url: 'https://downloads.exemplo/koda.exe',
        channel: 'stable',
      }).toString(),
    });

    expect(resposta.status).toBe(303);
    expect(resposta.headers.get('location')).toBe('/admin/versoes?erro=entrada-invalida');
    expect(resposta.texto).not.toContain('"ok":false');
  });

  it('listagem com filtro em branco continua abrindo', async () => {
    const { cookie } = await entrarNoPainel();

    const resposta = await requisitar('/admin/contas?status=&criado_de=&criado_ate=&busca=', {
      cookie,
    });

    expect(resposta.status).toBe(200);
    expect(resposta.texto).toContain('Contas');
  });

  it('sem sessão, a ação continua voltando para o login', async () => {
    const resposta = await requisitar('/admin/versoes', {
      method: 'POST',
      headers: CORPO_FORM,
      body: 'csrf=qualquer&version=9.9.9',
    });

    expect(resposta.status).toBe(303);
    expect(resposta.headers.get('location')).toContain('/admin/login');
  });
});
