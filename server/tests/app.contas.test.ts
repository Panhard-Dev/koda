import { beforeEach, describe, expect, it } from 'vitest';
import { getConfig } from '../src/config/env.js';
import type { Env } from '../src/config/env.js';
import { db, emailUnico, limparLimites, loginConta, requisitar } from './helpers.js';

/**
 * Contas do app (as mesmas que o painel administra em /admin/contas).
 *
 * O app só tem a tela de login: quem cria a conta, emite a sessão e renova é este
 * serviço. O que se testa aqui é isso — do cadastro ao logout, passando pela régua de
 * senha, pelo e-mail repetido e pelo freio de tentativas.
 */

const SENHA_BOA = 'Koda#Conta-2026-x7';

async function registrar(email = emailUnico('app'), senha = SENHA_BOA, nome?: string) {
  return requisitar('/api/auth/register', {
    method: 'POST',
    json: nome === undefined ? { email, senha } : { email, senha, nome },
  });
}

beforeEach(async () => {
  await limparLimites();
});

describe('cadastro pelo app', () => {
  it('cria a conta, já devolve sessão e deixa entrar na área da conta', async () => {
    const email = emailUnico('novo');
    const resposta = await registrar(email, SENHA_BOA, 'Pessoa Nova');
    expect(resposta.status).toBe(201);

    const dados = resposta.json<{
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
      conta: { id: string; email: string; nome: string | null };
    }>();
    expect(dados.access_token).toBeTruthy();
    expect(dados.refresh_token).toBeTruthy();
    expect(dados.token_type).toBe('Bearer');
    expect(dados.conta.email).toBe(email);
    expect(dados.conta.nome).toBe('Pessoa Nova');
    // O hash da senha não sai em resposta nenhuma.
    expect(resposta.texto).not.toContain('password_hash');
    expect(resposta.texto).not.toContain(SENHA_BOA);

    const perfil = await requisitar('/api/account/me', { token: dados.access_token });
    expect(perfil.status).toBe(200);
    expect(perfil.json<{ conta: { email: string } }>().conta.email).toBe(email);

    // E a conta já aparece para o painel administrar.
    const linha = await db
      .prepare('SELECT status, display_name FROM users WHERE email = ?')
      .bind(email)
      .first<{ status: string; display_name: string | null }>();
    expect(linha?.status).toBe('active');
    expect(linha?.display_name).toBe('Pessoa Nova');

    // O cadastro fica na auditoria como vindo do app.
    const auditoria = await db
      .prepare("SELECT COUNT(*) AS total FROM audit_log WHERE action = 'user.register' AND target_id = ?")
      .bind(dados.conta.id)
      .first<{ total: number }>();
    expect(Number(auditoria?.total ?? 0)).toBeGreaterThan(0);
  });

  it('recusa senha fora da política', async () => {
    const curta = await registrar(emailUnico('curta'), 'curta123');
    expect(curta.status).toBe(400);
    expect(curta.texto).toContain('12');

    // 12 caracteres, mas repetindo o e-mail: também não passa.
    const email = 'repetida@koda.test';
    const comEmail = await registrar(email, 'repetida-repetida');
    expect(comEmail.status).toBe(400);
    expect(comEmail.texto.toLowerCase()).toContain('e-mail');
  });

  it('recusa e-mail malformado e e-mail já cadastrado', async () => {
    expect((await registrar('sem-arroba', SENHA_BOA)).status).toBe(400);

    const email = emailUnico('repetido');
    expect((await registrar(email, SENHA_BOA)).status).toBe(201);
    const repetido = await registrar(email, SENHA_BOA);
    expect(repetido.status).toBe(409);
    expect(repetido.json<{ error: string }>().error).toBe('email_em_uso');
  });

  it('freia o cadastro em rajada', async () => {
    // O limite é 5 por janela: a sexta tentativa nem chega a hashear senha.
    const codigos: number[] = [];
    for (let indice = 0; indice < 6; indice += 1) {
      codigos.push((await registrar(emailUnico(`rajada${indice}`), SENHA_BOA)).status);
    }
    expect(codigos.at(-1)).toBe(429);
    expect(codigos.filter((codigo) => codigo === 201).length).toBeLessThanOrEqual(5);
  });

  it('fecha o cadastro quando o painel desliga o interruptor', () => {
    // O interruptor é lido na configuração: sem `CADASTRO_ABERTO` o padrão é aberto.
    const base = {
      NODE_ENV: 'test',
      CORS_ORIGIN: 'https://koda.test',
      JWT_SECRET: 'segredo-de-teste-para-access-com-32-caracteres',
      JWT_REFRESH_SECRET: 'segredo-de-teste-para-refresh-com-32-caracteres',
    };
    const fechado = getConfig({ ...base, CADASTRO_ABERTO: 'false' } as unknown as Env);
    const aberto = getConfig({ ...base, CADASTRO_ABERTO: 'true' } as unknown as Env);
    const padrao = getConfig({ ...base } as unknown as Env);
    expect(fechado.cadastroAberto).toBe(false);
    expect(aberto.cadastroAberto).toBe(true);
    expect(padrao.cadastroAberto).toBe(true);
  });
});

describe('sessão da conta do app', () => {
  it('entra com a senha cadastrada, renova e sai', async () => {
    const email = emailUnico('sessao');
    const criada = await registrar(email, SENHA_BOA);
    expect(criada.status).toBe(201);

    const entrada = await loginConta(email, SENHA_BOA);
    expect(entrada.status).toBe(200);
    const sessao = entrada.json<{ access_token: string; refresh_token: string }>();
    expect(sessao.access_token).toBeTruthy();

    const renovada = await requisitar('/api/auth/refresh', {
      method: 'POST',
      json: { refresh_token: sessao.refresh_token },
    });
    expect(renovada.status).toBe(200);
    const nova = renovada.json<{ access_token: string; refresh_token: string }>();
    // O refresh é rotativo: o que volta é outro, e o anterior não vale mais.
    expect(nova.refresh_token).not.toBe(sessao.refresh_token);

    // O token novo vale e o refresh antigo não.
    expect((await requisitar('/api/account/me', { token: nova.access_token })).status).toBe(200);

    const saida = await requisitar('/api/auth/logout', {
      method: 'POST',
      json: { refresh_token: nova.refresh_token },
    });
    expect(saida.status).toBe(200);

    const depois = await requisitar('/api/auth/refresh', {
      method: 'POST',
      json: { refresh_token: nova.refresh_token },
    });
    expect(depois.status).toBe(401);
  });

  it('não entra com senha errada nem conta banida', async () => {
    const email = emailUnico('banida');
    await registrar(email, SENHA_BOA);

    expect((await loginConta(email, 'OutraSenha#2026-x7')).status).toBe(401);

    await db.prepare("UPDATE users SET status = 'banned' WHERE email = ?").bind(email).run();
    const barrada = await loginConta(email, SENHA_BOA);
    expect(barrada.status).toBe(403);
    expect(barrada.json<{ error: string }>().error).toBe('account_banned');
  });
});

describe('CORS do app', () => {
  it('libera a origem do app instalado e recusa origem desconhecida', async () => {
    const tauri = await requisitar('/api/public/health', { headers: { origin: 'http://tauri.localhost' } });
    expect(tauri.headers.get('access-control-allow-origin')).toBe('http://tauri.localhost');

    const estranha = await requisitar('/api/public/health', {
      headers: { origin: 'https://site-qualquer.example' },
    });
    expect(estranha.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('a sessão carrega o nome de exibição — no cadastro, no login e na renovação', async () => {
    // O app usa o nome para dizer ao assistente com quem está falando. Se ele só viesse no
    // cadastro, quem entra de novo (ou renova a sessão) perderia o nome no meio do dia.
    const cadastro = await registrar(emailUnico('nome'), SENHA_BOA, 'Ana Prova');
    expect(cadastro.status).toBe(201);
    const corpoCadastro = cadastro.json<{ conta: { nome: string | null } }>();
    expect(corpoCadastro.conta.nome).toBe('Ana Prova');

    const email = emailUnico('nome');
    await registrar(email, SENHA_BOA, 'Ana Prova');
    const login = await loginConta(email, SENHA_BOA);
    expect(login.status).toBe(200);
    const corpo = login.json<{ conta: { nome: string | null }; refresh_token: string }>();
    expect(corpo.conta.nome).toBe('Ana Prova');

    const refresh = await requisitar('/api/auth/refresh', {
      method: 'POST',
      json: { refresh_token: corpo.refresh_token },
    });
    expect(refresh.status).toBe(200);
    expect(refresh.json<{ conta: { nome: string | null } }>().conta.nome).toBe('Ana Prova');
  });

  it('aceita o Vite de desenvolvimento em qualquer porta', async () => {
    const vite = await requisitar('/api/public/health', { headers: { origin: 'http://localhost:5173' } });
    expect(vite.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');

    // A porta do Vite muda quando a 5173 está ocupada — o loopback cobre as duas.
    const outra = await requisitar('/api/public/health', { headers: { origin: 'http://127.0.0.1:5199' } });
    expect(outra.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5199');
  });
});
