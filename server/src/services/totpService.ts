import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  base32Decode,
  base32Encode,
  fromBase64Url,
  hmacSha1,
  randomBytes,
  sha256Hex,
  timingSafeEqualStr,
  toBase64Url,
  utf8,
} from '../utils/crypto.js';

const DIGITOS = 6;
const PASSO_S = 30;

export function gerarSegredoTotp(): string {
  return base32Encode(randomBytes(20));
}

export function urlOtpauth(email: string, segredo: string, emissor = 'Koda'): string {
  const rotulo = encodeURIComponent(`${emissor}:${email}`);
  const parametros = new URLSearchParams({
    secret: segredo,
    issuer: emissor,
    algorithm: 'SHA1',
    digits: String(DIGITOS),
    period: String(PASSO_S),
  });
  return `otpauth://totp/${rotulo}?${parametros.toString()}`;
}

export function codigoAtual(segredo: string, agoraMs = Date.now()): Promise<string> {
  return codigoParaContador(segredo, Math.floor(agoraMs / 1000 / PASSO_S));
}

/**
 * Confere o código aceitando uma janela de ±1 passo (relógio do celular e do
 * servidor raramente batem no segundo). Comparação em tempo constante.
 */
export async function codigoValido(
  segredo: string,
  codigo: string,
  opcoes: { janela?: number; agoraMs?: number } = {},
): Promise<boolean> {
  const limpo = (codigo ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(limpo)) return false;
  const janela = opcoes.janela ?? 1;
  const contador = Math.floor((opcoes.agoraMs ?? Date.now()) / 1000 / PASSO_S);
  for (let deslocamento = -janela; deslocamento <= janela; deslocamento += 1) {
    const esperado = await codigoParaContador(segredo, contador + deslocamento);
    if (timingSafeEqualStr(esperado, limpo)) return true;
  }
  return false;
}

async function codigoParaContador(segredo: string, contador: number): Promise<string> {
  const chave = base32Decode(segredo);
  const buffer = new ArrayBuffer(8);
  const visao = new DataView(buffer);
  // Contador é big-endian de 64 bits; o JS só controla 53 bits, o suficiente aqui.
  visao.setUint32(0, Math.floor(contador / 2 ** 32));
  visao.setUint32(4, contador % 2 ** 32);
  const digest = await hmacSha1(chave, new Uint8Array(buffer));
  const deslocamento = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binario =
    (((digest[deslocamento] ?? 0) & 0x7f) << 24) |
    (((digest[deslocamento + 1] ?? 0) & 0xff) << 16) |
    (((digest[deslocamento + 2] ?? 0) & 0xff) << 8) |
    ((digest[deslocamento + 3] ?? 0) & 0xff);
  return String(binario % 10 ** DIGITOS).padStart(DIGITOS, '0');
}

export interface CodigoRecuperacao {
  codigo: string;
  hash: string;
}

export async function gerarCodigosRecuperacao(quantidade = 8): Promise<CodigoRecuperacao[]> {
  const saida: CodigoRecuperacao[] = [];
  for (let i = 0; i < quantidade; i += 1) {
    const codigo = toBase64Url(randomBytes(10));
    saida.push({ codigo, hash: await sha256Hex(`recuperacao:${codigo}`) });
  }
  return saida;
}

/** Consome o código de recuperação: o usado sai da lista (uso único). */
export async function consumirCodigoRecuperacao(
  hashesArmazenados: string[],
  codigo: string,
): Promise<{ valido: boolean; restantes: string[] }> {
  const alvo = await sha256Hex(`recuperacao:${(codigo ?? '').trim()}`);
  for (const hashGuardado of hashesArmazenados) {
    if (timingSafeEqualStr(hashGuardado, alvo)) {
      return { valido: true, restantes: hashesArmazenados.filter((item) => item !== hashGuardado) };
    }
  }
  return { valido: false, restantes: hashesArmazenados };
}

/**
 * Segredo TOTP nunca é gravado em claro: AES-GCM com a chave de
 * TOTP_ENCRYPTION_KEY (32 bytes em base64).
 */
export async function cifrarSegredo(segredo: string, chaveBase64: string | null): Promise<string> {
  if (!chaveBase64) throw new Error('TOTP_ENCRYPTION_KEY ausente');
  return aesGcmEncrypt(segredo, chaveBase64);
}

export async function decifrarSegredo(payload: string, chaveBase64: string | null): Promise<string> {
  if (!chaveBase64) throw new Error('TOTP_ENCRYPTION_KEY ausente');
  return aesGcmDecrypt(payload, chaveBase64);
}

/** Lê os hashes de recuperação guardados como JSON, tolerando lixo. */
export function lerRecuperacao(valor: string | null): string[] {
  if (!valor) return [];
  try {
    const dados = JSON.parse(valor) as unknown;
    if (!Array.isArray(dados)) return [];
    return dados.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

export const _interno = { fromBase64Url, utf8 };
