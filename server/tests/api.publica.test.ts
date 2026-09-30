import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { limparLimites, loginAdmin, requisitar } from './helpers.js';

async function publicar(token: string, corpo: Record<string, unknown>) {
  return requisitar('/admin/api/releases', { method: 'POST', token, json: corpo });
}

beforeEach(async () => {
  await limparLimites();
  // Releases são globais: cada teste começa com o histórico vazio.
  await env.DB.prepare('DELETE FROM releases').run();
});

describe('sistema de versão / atualização', () => {
  it('sem release publicada, o app não recebe atualização', async () => {
    const resposta = await requisitar('/api/public/version?versao=0.1.0');
    expect(resposta.status).toBe(200);
    const dados = resposta.json<{ update_available: boolean; latest_version: string | null }>();
    expect(dados.update_available).toBe(false);
    expect(dados.latest_version).toBeNull();
  });

  it('publica versão e responde a checagem do app', async () => {
    const admin = await loginAdmin();
    const criacao = await publicar(admin.token, {
      version: '1.0.0',
      download_url: 'https://cdn.koda.test/Koda_1.0.0_x64-setup.exe',
      notes: 'Primeira versão estável.',
      channel: 'stable',
    });
    expect(criacao.status).toBe(201);
    expect(criacao.json<{ release: { published: number } }>().release.published).toBe(1);

    const desatualizado = await requisitar('/api/public/version?versao=0.9.0');
    const dados = desatualizado.json<{
      update_available: boolean;
      latest_version: string;
      download_url: string;
      notes: string;
      update_required: boolean;
    }>();
    expect(dados.update_available).toBe(true);
    expect(dados.latest_version).toBe('1.0.0');
    expect(dados.download_url).toContain('Koda_1.0.0_x64-setup.exe');
    expect(dados.notes).toContain('Primeira versão');
    expect(dados.update_required).toBe(false);

    const atualizado = await requisitar('/api/public/version?versao=1.0.0');
    expect(atualizado.json<{ update_available: boolean }>().update_available).toBe(false);

    const futuro = await requisitar('/api/public/version?versao=1.2.0');
    expect(futuro.json<{ update_available: boolean }>().update_available).toBe(false);
  });

  it('marca atualização obrigatória quando a versão mínima sobe', async () => {
    const admin = await loginAdmin();
    await publicar(admin.token, {
      version: '2.0.0',
      download_url: 'https://cdn.koda.test/koda-2.0.0.exe',
      min_supported_version: '1.5.0',
    });
    const resposta = await requisitar('/api/public/version?versao=1.0.0');
    const dados = resposta.json<{ update_available: boolean; update_required: boolean; mandatory: boolean }>();
    expect(dados.update_available).toBe(true);
    expect(dados.update_required).toBe(true);
    expect(dados.mandatory).toBe(false);
  });

  it('mantém histórico de changelog e só oferece stable para quem não pediu beta', async () => {
    const admin = await loginAdmin();
    await publicar(admin.token, { version: '1.0.0', download_url: 'https://cdn.koda.test/1.exe', notes: 'estável' });
    await publicar(admin.token, {
      version: '1.1.0-beta.1',
      download_url: 'https://cdn.koda.test/1b.exe',
      notes: 'beta',
      channel: 'beta',
    });

    const changelog = await requisitar('/api/public/changelog?canal=stable');
    const releases = changelog.json<{ releases: { versao: string; notas: string | null }[] }>().releases;
    expect(releases.map((item) => item.versao)).toContain('1.0.0');

    const estavel = await requisitar('/api/public/version?versao=1.0.0&canal=stable');
    expect(estavel.json<{ latest_version: string }>().latest_version).toBe('1.0.0');

    const beta = await requisitar('/api/public/version?versao=1.0.0&canal=beta');
    expect(beta.json<{ latest_version: string }>().latest_version).toBe('1.1.0-beta.1');
  });

  it('rascunho não é oferecido até ser publicado', async () => {
    const admin = await loginAdmin();
    const rascunho = await publicar(admin.token, {
      version: '3.0.0',
      download_url: 'https://cdn.koda.test/koda-3.exe',
      publicado: false,
    });
    expect(rascunho.status).toBe(201);
    expect(rascunho.json<{ release: { published: number } }>().release.published).toBe(0);

    const checagem = await requisitar('/api/public/version?versao=1.0.0');
    expect(checagem.json<{ latest_version: string | null }>().latest_version).toBeNull();

    const id = rascunho.json<{ release: { id: string } }>().release.id;
    const publicado = await requisitar(`/admin/api/releases/${id}/publish`, { method: 'POST', token: admin.token });
    expect(publicado.status).toBe(200);
    expect((await requisitar('/api/public/version?versao=1.0.0')).json<{ latest_version: string }>().latest_version).toBe('3.0.0');
  });

  it('aceita só semver e url de download confiável', async () => {
    const admin = await loginAdmin();
    expect((await publicar(admin.token, { version: 'v1', download_url: 'https://x.test/a.exe' })).status).toBe(400);
    expect((await publicar(admin.token, { version: '1.0.0', download_url: 'ftp://x.test/a.exe' })).status).toBe(400);
    expect((await publicar(admin.token, { version: '1.0.0', download_url: 'https://u:p@x.test/a.exe' })).status).toBe(400);
  });

  it('a rota pública é aberta, informativa e limitada por IP', async () => {
    const saude = await requisitar('/api/public/health');
    expect(saude.status).toBe(200);
    const dados = saude.json<{ servico: string; api_version: string }>();
    expect(dados.servico).toBe('koda-cloud');
    // Sem detalhes internos (banco, segredos, rotas administrativas).
    expect(saude.texto).not.toMatch(/database|secret|admin/i);
    expect(saude.headers.get('x-ratelimit-limit')).toBeTruthy();

    const semVersao = await requisitar('/api/public/version');
    expect(semVersao.status).toBe(400);

    const commitShell = await requisitar('/admin/api/accounts');
    expect(commitShell.status).toBe(401);
  });
});
