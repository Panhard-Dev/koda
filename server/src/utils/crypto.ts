/**
 * Primitivas de criptografia sobre a Web Crypto (disponível no runtime e no
 * workerd dos testes). Nada aqui depende de biblioteca externa.
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binario = '';
  for (const byte of bytes) binario += String.fromCharCode(byte);
  return btoa(binario).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(texto: string): Uint8Array {
  const normalizado = texto.replace(/-/g, '+').replace(/_/g, '/');
  const preenchido = normalizado + '='.repeat((4 - (normalizado.length % 4)) % 4);
  const binario = atob(preenchido);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i += 1) bytes[i] = binario.charCodeAt(i);
  return bytes;
}

export function toBase64(bytes: Uint8Array): string {
  let binario = '';
  for (const byte of bytes) binario += String.fromCharCode(byte);
  return btoa(binario);
}

export function fromBase64(texto: string): Uint8Array {
  const binario = atob(texto);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i += 1) bytes[i] = binario.charCodeAt(i);
  return bytes;
}

export function toHex(bytes: Uint8Array): string {
  let saida = '';
  for (const byte of bytes) saida += byte.toString(16).padStart(2, '0');
  return saida;
}

export function fromHex(texto: string): Uint8Array {
  const limpo = texto.length % 2 === 0 ? texto : `0${texto}`;
  const bytes = new Uint8Array(limpo.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(limpo.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export const utf8 = (texto: string): Uint8Array => encoder.encode(texto);
export const deUtf8 = (bytes: ArrayBuffer | Uint8Array): string =>
  decoder.decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));

export async function sha256Hex(texto: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', utf8(texto));
  return toHex(new Uint8Array(digest));
}

export async function sha256Base64(texto: string | Uint8Array): Promise<string> {
  const dados = typeof texto === 'string' ? utf8(texto) : texto;
  // `crypto.subtle.digest` exige ArrayBuffer com tipo específico no workerd.
  const buffer = dados.slice().buffer as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return toBase64(new Uint8Array(digest));
}

export async function hmacSha256(chave: Uint8Array, dados: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', chave.slice().buffer as ArrayBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const assinatura = await crypto.subtle.sign('HMAC', key, dados.slice().buffer as ArrayBuffer);
  return new Uint8Array(assinatura);
}

export async function hmacSha1(chave: Uint8Array, dados: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', chave.slice().buffer as ArrayBuffer, { name: 'HMAC', hash: 'SHA-1' }, false, [
    'sign',
  ]);
  const assinatura = await crypto.subtle.sign('HMAC', key, dados.slice().buffer as ArrayBuffer);
  return new Uint8Array(assinatura);
}

export function randomBytes(tamanho = 32): Uint8Array {
  const bytes = new Uint8Array(tamanho);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function randomHex(bytes = 32): string {
  return toHex(randomBytes(bytes));
}

export function randomBase64Url(bytes = 32): string {
  return toBase64Url(randomBytes(bytes));
}

/** UUID v4 a partir de bytes aleatórios (ids de recurso). */
export function uuid(): string {
  const bytes = randomBytes(16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Comparação de tempo constante para strings (nunca use `===` em segredo). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bytesA = utf8(a);
  const bytesB = utf8(b);
  // O tamanho não é segredo; o conteúdo é. Sempre percorre o mesmo número de bytes.
  let diferenca = bytesA.length ^ bytesB.length;
  const tamanho = Math.max(bytesA.length, bytesB.length);
  for (let i = 0; i < tamanho; i += 1) {
    diferenca |= (bytesA[i] ?? 0) ^ (bytesB[i] ?? 0);
  }
  return diferenca === 0;
}

export async function aesGcmEncrypt(textoPuro: string, chaveBase64: string): Promise<string> {
  const chave = await crypto.subtle.importKey('raw', fromBase64(chaveBase64).slice().buffer as ArrayBuffer, 'AES-GCM', false, [
    'encrypt',
  ]);
  const iv = randomBytes(12);
  const cifrado = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.slice().buffer as ArrayBuffer },
    chave,
    utf8(textoPuro).slice().buffer as ArrayBuffer,
  );
  return `${toBase64(iv)}.${toBase64(new Uint8Array(cifrado))}`;
}

export async function aesGcmDecrypt(payload: string, chaveBase64: string): Promise<string> {
  const [ivBase64, dadosBase64] = payload.split('.');
  if (!ivBase64 || !dadosBase64) throw new Error('payload cifrado invalido');
  const chave = await crypto.subtle.importKey('raw', fromBase64(chaveBase64).slice().buffer as ArrayBuffer, 'AES-GCM', false, [
    'decrypt',
  ]);
  const claro = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(ivBase64).slice().buffer as ArrayBuffer },
    chave,
    fromBase64(dadosBase64).slice().buffer as ArrayBuffer,
  );
  return deUtf8(claro);
}

const ALFABETO_BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(entrada: string): Uint8Array {
  const limpo = entrada.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let valor = 0;
  const saida: number[] = [];
  for (const caractere of limpo) {
    const indice = ALFABETO_BASE32.indexOf(caractere);
    if (indice === -1) throw new Error('base32 invalido');
    valor = (valor << 5) | indice;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      saida.push((valor >>> bits) & 0xff);
    }
  }
  return new Uint8Array(saida);
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let valor = 0;
  let saida = '';
  for (const byte of bytes) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      saida += ALFABETO_BASE32[(valor >>> bits) & 0x1f];
    }
  }
  if (bits > 0) saida += ALFABETO_BASE32[(valor << (5 - bits)) & 0x1f];
  return saida;
}

/** Embaralha bytes por índice: usado para senhas temporárias de recuperação. */
export function sortearCaracteres(alfabeto: string, quantidade: number): string {
  const bytes = randomBytes(quantidade);
  let saida = '';
  for (const byte of bytes) saida += alfabeto[byte % alfabeto.length];
  return saida;
}
