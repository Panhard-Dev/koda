import { env, SELF } from 'cloudflare:test';

export const ORIGEM = 'https://koda.test';
export const EMAIL_ADMIN = 'admin@koda.test';
export const SENHA_ADMIN = 'SenhaDeTeste#Koda2026';
export const SENHA_CONTA = 'SenhaDeConta#2026';

export interface Resposta {
  status: number;
  headers: Headers;
  texto: string;
  json: <T = Record<string, unknown>>() => T;
  cookies: string;
}

export interface OpcoesRequisicao {
  method?: string;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  token?: string | null;
  csrf?: string | null;
  cookie?: string | null;
  ip?: string;
}

function juntarCookies(resposta: Response): string {
  const bruto = typeof resposta.headers.getSetCookie === 'function' ? resposta.headers.getSetCookie() : [];
  return bruto.map((item) => item.split(';')[0] ?? '').filter((item) => item !== '').join('; ');
}

export async function requisitar(caminho: string, opcoes: OpcoesRequisicao = {}): Promise<Resposta> {
  const headers = new Headers(opcoes.headers ?? {});
  if (opcoes.token) headers.set('authorization', `Bearer ${opcoes.token}`);
  if (opcoes.csrf) headers.set('x-koda-csrf', opcoes.csrf);
  if (opcoes.cookie) headers.set('cookie', opcoes.cookie);
  // O IP vem do cabeçalho do Cloudflare na vida real; nos testes ele é fixo
  // (ou informado) para que login, lockout e auditoria fiquem determinísticos.
  const ip = opcoes.ip ?? '198.51.100.10';
  headers.set('cf-connecting-ip', ip);
  headers.set('x-real-ip', ip);

  const metodo = (opcoes.method ?? 'GET').toUpperCase();
  let corpo: BodyInit | undefined = opcoes.body;
  // GET/HEAD não podem carregar corpo: o `json` é ignorado nesses métodos.
  if (opcoes.json !== undefined && metodo !== 'GET' && metodo !== 'HEAD') {
    headers.set('content-type', 'application/json');
    corpo = JSON.stringify(opcoes.json);
  }

  const resposta = await SELF.fetch(new URL(caminho, ORIGEM).toString(), {
    method: metodo,
    headers,
    // `manual`: os testes precisam ver o 303 e o Location do painel.
    redirect: 'manual',
    ...(corpo === undefined ? {} : { body: corpo }),
  });
  const texto = await resposta.text();
  return {
    status: resposta.status,
    headers: resposta.headers,
    texto,
    json: <T,>() => JSON.parse(texto) as T,
    cookies: juntarCookies(resposta),
  };
}

export interface SessaoAdmin {
  token: string;
  refresh: string;
  csrf: string;
  cookies: string;
  id: string;
  email: string;
}

export async function loginAdmin(opcoes: { senha?: string; ip?: string } = {}): Promise<SessaoAdmin> {
  const resposta = await requisitar('/admin/auth/login', {
    method: 'POST',
    ip: opcoes.ip ?? '198.51.100.10',
    json: { email: EMAIL_ADMIN, senha: opcoes.senha ?? SENHA_ADMIN },
  });
  if (resposta.status !== 200) throw new Error(`login do admin falhou: ${resposta.status} ${resposta.texto}`);
  const dados = resposta.json<{
    access_token: string;
    refresh_token: string;
    csrf_token: string;
    admin: { id: string; email: string };
  }>();
  return {
    token: dados.access_token,
    refresh: dados.refresh_token,
    csrf: dados.csrf_token,
    cookies: resposta.cookies,
    id: dados.admin.id,
    email: dados.admin.email,
  };
}

export function emailUnico(prefixo = 'conta'): string {
  return `${prefixo}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@koda.test`;
}

export async function criarConta(
  email = emailUnico(),
  senha = SENHA_CONTA,
  admin?: SessaoAdmin,
): Promise<{ id: string; email: string; senha: string }> {
  const sessao = admin ?? (await loginAdmin());
  const resposta = await requisitar('/admin/api/accounts', {
    method: 'POST',
    token: sessao.token,
    json: { email, senha, nome: 'Conta de teste' },
  });
  if (resposta.status !== 201) throw new Error(`criar conta falhou: ${resposta.status} ${resposta.texto}`);
  const dados = resposta.json<{ conta: { id: string } }>();
  return { id: dados.conta.id, email, senha };
}

export async function loginConta(email: string, senha = SENHA_CONTA, ip = '198.51.100.20') {
  return requisitar('/api/auth/login', { method: 'POST', ip, json: { email, senha } });
}

/** Zera contadores de limite: cada teste começa com a janela limpa. */
export async function limparLimites(): Promise<void> {
  await env.DB.prepare('DELETE FROM rate_limits').run();
}

export async function zerarFalhasAdmin(): Promise<void> {
  await env.DB.prepare('UPDATE admins SET failed_attempts = 0, locked_until = NULL').run();
}

export const db = env.DB;
