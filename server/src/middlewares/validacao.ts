import type { Context } from 'hono';
import type { ZodType } from 'zod';
import type { Aplicacao } from '../types.js';
import { requisicaoInvalida } from '../utils/errors.js';

export const CORPO_MAXIMO_PADRAO = 64 * 1024;
export const CORPO_MAXIMO_FORM = 32 * 1024;

function falha(erro: { issues: { path: PropertyKey[]; message: string }[] }): never {
  // Só o nome do campo e a regra: o valor digitado nunca volta na resposta.
  const detalhe = erro.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.map((parte) => String(parte)).join('.') || 'corpo'}: ${issue.message}`)
    .join('; ');
  throw requisicaoInvalida(detalhe);
}

export function validar<T>(esquema: ZodType<T>, dados: unknown): T {
  const resultado = esquema.safeParse(dados);
  if (!resultado.success) falha(resultado.error);
  return resultado.data as T;
}

function tamanhoDeclarado(c: Context<Aplicacao>): number | null {
  const cabecalho = c.req.header('content-length');
  if (!cabecalho) return null;
  const valor = Number(cabecalho);
  return Number.isFinite(valor) ? valor : null;
}

async function lerTexto(c: Context<Aplicacao>, limite: number): Promise<string> {
  const declarado = tamanhoDeclarado(c);
  if (declarado !== null && declarado > limite) {
    throw requisicaoInvalida(`corpo maior que o limite de ${limite} bytes`);
  }
  const texto = await c.req.text();
  if (texto.length > limite) throw requisicaoInvalida(`corpo maior que o limite de ${limite} bytes`);
  return texto;
}

/** JSON já validado: parse + zod, com teto de tamanho antes de alocar memória. */
export async function corpoJson<T>(c: Context<Aplicacao>, esquema: ZodType<T>, limite = CORPO_MAXIMO_PADRAO): Promise<T> {
  const texto = await lerTexto(c, limite);
  let dados: unknown;
  try {
    dados = texto.trim() === '' ? {} : JSON.parse(texto);
  } catch {
    throw requisicaoInvalida('corpo nao e JSON valido');
  }
  return validar(esquema, dados);
}

/** Formulário do painel (application/x-www-form-urlencoded). */
export async function corpoForm<T>(
  c: Context<Aplicacao>,
  esquema: ZodType<T>,
  limite = CORPO_MAXIMO_FORM,
): Promise<T> {
  const texto = await lerTexto(c, limite);
  const parametros = new URLSearchParams(texto);
  const dados: Record<string, string | string[]> = {};
  for (const chave of new Set(parametros.keys())) {
    const valores = parametros.getAll(chave);
    dados[chave] = valores.length > 1 ? valores : (valores[0] ?? '');
  }
  return validar(esquema, dados);
}

export function consulta<T>(c: Context<Aplicacao>, esquema: ZodType<T>): T {
  const url = new URL(c.req.url);
  const dados: Record<string, string | string[]> = {};
  for (const chave of new Set(url.searchParams.keys())) {
    const valores = url.searchParams.getAll(chave);
    dados[chave] = valores.length > 1 ? valores : (valores[0] ?? '');
  }
  return validar(esquema, dados);
}

export function parametros<T>(c: Context<Aplicacao>, esquema: ZodType<T>): T {
  return validar(esquema, c.req.param());
}
