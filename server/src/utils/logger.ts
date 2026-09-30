/**
 * Log estruturado em JSON (aparece no `wrangler tail` / observabilidade).
 * Antes de sair, todo campo passa pelo redator: senha, token, hash, cookie e
 * segredo nunca aparecem em log.
 */
export type Nivel = 'debug' | 'info' | 'warn' | 'error';

const CHAVE_SENSIVEL = /(senha|password|secret|segredo|token|authorization|cookie|hash|totp|jwt)/i;
const LIMITE_TEXTO = 2_000;

export function redigir(valor: unknown, profundidade = 0, chave = ''): unknown {
  if (profundidade > 4) return '[profundo]';
  if (CHAVE_SENSIVEL.test(chave)) return '[redigido]';
  if (valor === null || valor === undefined) return valor;
  if (typeof valor === 'string') return valor.length > LIMITE_TEXTO ? `${valor.slice(0, LIMITE_TEXTO)}…` : valor;
  if (typeof valor === 'number' || typeof valor === 'boolean') return valor;
  if (valor instanceof Error) {
    return { nome: valor.name, mensagem: redigir(valor.message, profundidade + 1, 'mensagem') };
  }
  if (Array.isArray(valor)) {
    return valor.slice(0, 50).map((item) => redigir(item, profundidade + 1, chave));
  }
  if (typeof valor === 'object') {
    const saida: Record<string, unknown> = {};
    for (const [chaveInterna, item] of Object.entries(valor as Record<string, unknown>)) {
      saida[chaveInterna] = redigir(item, profundidade + 1, chaveInterna);
    }
    return saida;
  }
  return String(valor);
}

export function log(nivel: Nivel, evento: string, dados: Record<string, unknown> = {}): void {
  const registro = {
    nivel,
    evento,
    momento: new Date().toISOString(),
    ...(redigir(dados) as Record<string, unknown>),
  };
  const texto = JSON.stringify(registro);
  if (nivel === 'error') console.error(texto);
  else if (nivel === 'warn') console.warn(texto);
  else console.log(texto);
}

export const logger = {
  debug: (evento: string, dados?: Record<string, unknown>) => log('debug', evento, dados),
  info: (evento: string, dados?: Record<string, unknown>) => log('info', evento, dados),
  warn: (evento: string, dados?: Record<string, unknown>) => log('warn', evento, dados),
  error: (evento: string, dados?: Record<string, unknown>) => log('error', evento, dados),
};
