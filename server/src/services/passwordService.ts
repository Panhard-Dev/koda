import { compare, genSalt, hash } from 'bcryptjs';
import { fromBase64, randomBytes, sha256Hex, toBase64, timingSafeEqualStr, utf8 } from '../utils/crypto.js';

export interface OpcoesSenha {
  algo: 'bcrypt' | 'pbkdf2';
  bcryptCost: number;
  pbkdf2Iterations: number;
}

const PREFIXO_BCRYPT = '$bcrypt$';
const PREFIXO_PBKDF2 = '$pbkdf2-sha256$';
const SENHAS_COMUNS = new Set([
  'senha1234567',
  'password1234',
  '123456789012',
  'qwertyuiop12',
  'koda12345678',
  'adminadmin12',
  'trocar123456',
  'senhasenha12',
]);

/** Devolve o motivo da recusa ou `null` quando a senha é aceitável. */
export function politicaDeSenha(senha: string, opcoes?: { minimo?: number; email?: string | null }): string | null {
  const minimo = opcoes?.minimo ?? 12;
  if (typeof senha !== 'string') return 'senha deve ser texto';
  if (senha.length < minimo) return `senha deve ter ao menos ${minimo} caracteres`;
  // Acima de 72 bytes o bcrypt trunca silenciosamente; melhor recusar.
  if (utf8(senha).length > 72) return 'senha deve ter no maximo 72 bytes';
  if (new Set(senha).size < 5) return 'senha repetitiva demais';
  if (SENHAS_COMUNS.has(senha.toLowerCase())) return 'senha comum demais';
  if (opcoes?.email && senha.toLowerCase().includes(opcoes.email.split('@')[0]?.toLowerCase() ?? '\u0000')) {
    return 'senha nao pode conter o e-mail';
  }
  return null;
}

export async function gerarSenhaAleatoria(tamanho = 24): Promise<string> {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*-_';
  const bytes = randomBytes(tamanho);
  let saida = '';
  for (const byte of bytes) saida += alfabeto[byte % alfabeto.length];
  return saida;
}

export async function hashSenha(senha: string, opcoes: OpcoesSenha): Promise<string> {
  if (opcoes.algo === 'pbkdf2') {
    const salt = randomBytes(16);
    const derivado = await derivarPbkdf2(senha, salt, opcoes.pbkdf2Iterations);
    return `${PREFIXO_PBKDF2}${opcoes.pbkdf2Iterations}$${toBase64(salt)}$${derivado}`;
  }
  const salt = await genSalt(opcoes.bcryptCost);
  const hashBcrypt = await hash(senha, salt);
  // bcryptjs devolve `$2b$...`; o prefixo deixa explícito qual algoritmo gerou.
  return `${PREFIXO_BCRYPT}${hashBcrypt}`;
}

/**
 * Verifica contra o formato guardado. O prefixo diz o algoritmo — o que permite
 * trocar de bcrypt para PBKDF2 (ou aumentar o custo) sem invalidar senhas.
 */
export async function verificarSenha(senha: string, armazenado: string): Promise<boolean> {
  if (typeof senha !== 'string' || senha === '' || typeof armazenado !== 'string' || armazenado === '') return false;

  if (armazenado.startsWith(PREFIXO_PBKDF2)) {
    const partes = armazenado.split('$');
    // ['', 'pbkdf2-sha256', '<iter>', '<salt>', '<hash>']
    const iteracoes = Number(partes[2]);
    const salt = partes[3];
    const esperado = partes[4];
    if (!Number.isFinite(iteracoes) || iteracoes <= 0 || !salt || !esperado) return false;
    const derivado = await derivarPbkdf2(senha, fromBase64(salt), iteracoes);
    return timingSafeEqualStr(derivado, esperado);
  }

  if (armazenado.startsWith(PREFIXO_BCRYPT)) {
    try {
      return await compare(senha, armazenado.slice(PREFIXO_BCRYPT.length));
    } catch {
      return false;
    }
  }

  // Formato bcrypt cru ($2a$/$2b$/$2y$) — aceito para não quebrar base antiga.
  if (armazenado.startsWith('$2')) {
    try {
      return await compare(senha, armazenado);
    } catch {
      return false;
    }
  }
  return false;
}

/** `true` quando o hash guardado está mais fraco que a configuração atual. */
export function precisaRehash(armazenado: string, opcoes: OpcoesSenha): boolean {
  if (opcoes.algo === 'pbkdf2') {
    if (!armazenado.startsWith(PREFIXO_PBKDF2)) return true;
    const iteracoes = Number(armazenado.split('$')[2]);
    return !Number.isFinite(iteracoes) || iteracoes < opcoes.pbkdf2Iterations;
  }
  if (!armazenado.startsWith(PREFIXO_BCRYPT)) return true;
  const custo = Number(armazenado.slice(PREFIXO_BCRYPT.length).split('$')[2]);
  return !Number.isFinite(custo) || custo < opcoes.bcryptCost;
}

async function derivarPbkdf2(senha: string, salt: Uint8Array, iteracoes: number): Promise<string> {
  const chave = await crypto.subtle.importKey('raw', utf8(senha).slice().buffer as ArrayBuffer, 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt.slice().buffer as ArrayBuffer, iterations: iteracoes },
    chave,
    256,
  );
  const bytes = new Uint8Array(bits);
  let saida = '';
  for (const byte of bytes) saida += byte.toString(16).padStart(2, '0');
  return saida;
}

/** Usado em teste/CLI: confere que o hash do .env corresponde à senha digitada. */
export async function conferirHash(senha: string, hashGuardado: string): Promise<boolean> {
  return verificarSenha(senha, hashGuardado);
}

export const impressaoDigital = async (texto: string): Promise<string> => sha256Hex(texto);
