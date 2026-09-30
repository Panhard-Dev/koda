import { beforeEach, describe, expect, it } from 'vitest';
import { SENHA_CONTA, criarConta, emailUnico, limparLimites, loginAdmin, loginConta, requisitar } from './helpers.js';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

function png(): Uint8Array {
  const binario = atob(PNG_BASE64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i += 1) bytes[i] = binario.charCodeAt(i);
  return bytes;
}

async function novoModelo(token: string, extras: Record<string, unknown> = {}) {
  const slug = `modelo-${Math.random().toString(36).slice(2, 9)}`;
  const resposta = await requisitar('/admin/api/models', {
    method: 'POST',
    token,
    json: { slug, name: 'Modelo Koda', provider: 'host', kind: 'chat', context_window: 8192, ...extras },
  });
  return { resposta, slug };
}

beforeEach(async () => {
  await limparLimites();
});

describe('CRUD de modelos', () => {
  it('cria, edita, lista e recusa slug repetido', async () => {
    const admin = await loginAdmin();
    const { resposta, slug } = await novoModelo(admin.token);
    expect(resposta.status).toBe(201);
    const modelo = resposta.json<{ modelo: { id: string; slug: string; is_active: number } }>().modelo;
    expect(modelo.slug).toBe(slug);
    expect(modelo.is_active).toBe(1);

    const repetido = await requisitar('/admin/api/models', {
      method: 'POST',
      token: admin.token,
      json: { slug, name: 'Duplicado' },
    });
    expect(repetido.status).toBe(409);
    expect(repetido.json<{ error: string }>().error).toBe('slug_em_uso');

    const edicao = await requisitar(`/admin/api/models/${modelo.id}`, {
      method: 'PATCH',
      token: admin.token,
      json: { name: 'Modelo renomeado', description: 'descricao nova', sort_order: 5 },
    });
    expect(edicao.status).toBe(200);
    expect(edicao.json<{ modelo: { name: string } }>().modelo.name).toBe('Modelo renomeado');

    const lista = await requisitar(`/admin/api/models?busca=${slug}&incluir_deletados=1`, { token: admin.token });
    expect(lista.json<{ modelos: unknown[] }>().modelos).toHaveLength(1);
  });

  it('recusa entrada invalida sem vazar detalhe interno', async () => {
    const admin = await loginAdmin();
    const casos = [
      { slug: 'MAIÚSCULO E ESPAÇO', name: 'x' },
      { slug: 'ok-slug', name: 'a' },
      { slug: 'ok-slug-2', name: 'Modelo', context_window: 3 },
      { slug: 'ok-slug-3', name: 'Modelo', kind: 'inexistente' },
    ];
    for (const corpo of casos) {
      const resposta = await requisitar('/admin/api/models', { method: 'POST', token: admin.token, json: corpo });
      expect(resposta.status, JSON.stringify(corpo)).toBe(400);
      expect(resposta.texto).not.toMatch(/at Object|node_modules|D1_ERROR/);
    }
  });

  it('ativa e desativa globalmente, refletindo no catálogo público', async () => {
    const admin = await loginAdmin();
    const { resposta } = await novoModelo(admin.token);
    const id = resposta.json<{ modelo: { id: string; slug: string } }>().modelo;

    const publicoAntes = await requisitar('/api/public/models');
    expect(publicoAntes.json<{ models: { id: string }[] }>().models.some((item) => item.id === id.id)).toBe(true);

    const desativar = await requisitar(`/admin/api/models/${id.id}/deactivate`, {
      method: 'POST',
      token: admin.token,
      json: { ativo: false },
    });
    expect(desativar.status).toBe(200);

    const publicoDepois = await requisitar('/api/public/models');
    expect(publicoDepois.json<{ models: { id: string }[] }>().models.some((item) => item.id === id.id)).toBe(false);

    const reativar = await requisitar(`/admin/api/models/${id.id}/activate`, {
      method: 'POST',
      token: admin.token,
      json: { ativo: true },
    });
    expect(reativar.status).toBe(200);
    const publicoFinal = await requisitar('/api/public/models');
    expect(publicoFinal.json<{ models: { id: string }[] }>().models.some((item) => item.id === id.id)).toBe(true);
  });

  it('remove com soft delete, mantém para auditoria e permite restaurar', async () => {
    const admin = await loginAdmin();
    const { resposta } = await novoModelo(admin.token);
    const id = resposta.json<{ modelo: { id: string } }>().modelo.id;

    const remocao = await requisitar(`/admin/api/models/${id}`, { method: 'DELETE', token: admin.token });
    expect(remocao.status).toBe(200);
    expect(remocao.json<{ removido: string }>().removido).toBe('logico');

    const semDeletados = await requisitar(`/admin/api/models?busca=modelo-`, { token: admin.token });
    expect(semDeletados.json<{ modelos: { id: string }[] }>().modelos.some((item) => item.id === id)).toBe(false);

    const restauracao = await requisitar(`/admin/api/models/${id}/restore`, { method: 'POST', token: admin.token });
    expect(restauracao.status).toBe(200);

    const definitivo = await requisitar(`/admin/api/models/${id}?definitivo=1`, { method: 'DELETE', token: admin.token });
    expect(definitivo.json<{ removido: string }>().removido).toBe('definitivo');
    expect((await requisitar(`/admin/api/models/${id}`, { token: admin.token })).status).toBe(404);
  });

  it('aplica exceção individual e devolve os modelos efetivos do usuário', async () => {
    const admin = await loginAdmin();
    const { resposta } = await novoModelo(admin.token);
    const id = resposta.json<{ modelo: { id: string } }>().modelo.id;
    const conta = await criarConta(emailUnico('excecao'), SENHA_CONTA, admin);

    const desabilitar = await requisitar(`/admin/api/models/${id}/users/${conta.id}`, {
      method: 'POST',
      token: admin.token,
      json: { habilitado: false },
    });
    expect(desabilitar.status).toBe(200);
    expect(desabilitar.json<{ modelos_efetivos: string[] }>().modelos_efetivos).not.toContain(
      resposta.json<{ modelo: { slug: string } }>().modelo.slug,
    );

    const herdarDeNovo = await requisitar(`/admin/api/models/${id}/users/${conta.id}`, {
      method: 'POST',
      token: admin.token,
      json: { habilitado: 'herdar' },
    });
    expect(herdarDeNovo.status).toBe(200);
    expect(herdarDeNovo.json<{ modelos_efetivos: string[] }>().modelos_efetivos).toContain(
      resposta.json<{ modelo: { slug: string } }>().modelo.slug,
    );
  });
});

describe('upload de arquivos', () => {
  async function enviar(token: string, arquivo: File, extras: Record<string, string> = {}) {
    const formulario = new FormData();
    formulario.set('arquivo', arquivo);
    for (const [chave, valor] of Object.entries(extras)) formulario.set(chave, valor);
    return requisitar('/admin/api/uploads', { method: 'POST', token, body: formulario });
  }

  it('aceita PNG válido e serve a imagem com cabeçalhos seguros', async () => {
    const admin = await loginAdmin();
    const arquivo = new File([png()], 'icone.png', { type: 'image/png' });
    const resposta = await enviar(admin.token, arquivo);
    expect(resposta.status).toBe(201);
    const salvo = resposta.json<{ arquivo: { id: string; mime: string; url: string } }>().arquivo;
    expect(salvo.mime).toBe('image/png');

    const imagem = await requisitar(`/api/public/assets/${salvo.id}`);
    expect(imagem.status).toBe(200);
    expect(imagem.headers.get('content-type')).toBe('image/png');
    expect(imagem.headers.get('x-content-type-options')).toBe('nosniff');
    expect(imagem.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(imagem.headers.get('content-disposition')).toContain('inline');
  });

  it('recusa SVG, extensão trocada, tipo divergente e arquivo grande', async () => {
    const admin = await loginAdmin();
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], 'icone.svg', {
      type: 'image/svg+xml',
    });
    expect((await enviar(admin.token, svg)).status).toBe(400);

    const trocado = new File([png()], 'icone.jpg', { type: 'image/png' });
    expect((await enviar(admin.token, trocado)).status).toBe(400);

    const tipoErrado = new File([png()], 'icone.png', { type: 'image/jpeg' });
    expect((await enviar(admin.token, tipoErrado)).status).toBe(400);

    const grande = new File([new Uint8Array(70_000)], 'grande.png', { type: 'image/png' });
    expect((await enviar(admin.token, grande)).status).toBe(400);
  });

  it('vincula a imagem ao modelo e expõe a URL pública', async () => {
    const admin = await loginAdmin();
    const { resposta } = await novoModelo(admin.token);
    const id = resposta.json<{ modelo: { id: string } }>().modelo.id;

    const upload = await enviar(admin.token, new File([png()], 'capa.png', { type: 'image/png' }), { model_id: id });
    expect(upload.status).toBe(201);

    const models = await requisitar('/api/public/models');
    const modelo = models.json<{ models: { id: string; image_url: string | null }[] }>().models.find((item) => item.id === id);
    expect(modelo?.image_url).toBe(`/api/public/models/${id}/image`);

    const imagem = await requisitar(`/api/public/models/${id}/image`);
    expect(imagem.status).toBe(200);
  });

  it('não vaza arquivo inexistente nem aceita id estranho', async () => {
    expect((await requisitar('/api/public/assets/naoexiste123')).status).toBe(404);
    expect((await requisitar('/api/public/assets/%%%')).status).toBe(400);
  });
});

describe('catálogo efetivo da conta', () => {
  it('modelo desativado globalmente some para o usuário comum', async () => {
    const admin = await loginAdmin();
    const { resposta } = await novoModelo(admin.token);
    const modelo = resposta.json<{ modelo: { id: string; slug: string } }>().modelo;
    const conta = await criarConta(emailUnico('catalogo'), SENHA_CONTA, admin);
    const token = (await loginConta(conta.email)).json<{ access_token: string }>().access_token;

    const antes = await requisitar('/api/account/me', { token });
    expect(antes.json<{ modelos: { slug: string }[] }>().modelos.some((item) => item.slug === modelo.slug)).toBe(true);

    await requisitar(`/admin/api/models/${modelo.id}/deactivate`, { method: 'POST', token: admin.token, json: { ativo: false } });

    const depois = await requisitar('/api/account/me', { token });
    expect(depois.json<{ modelos: { slug: string }[] }>().modelos.some((item) => item.slug === modelo.slug)).toBe(false);
  });
});
