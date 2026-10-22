#!/usr/bin/env node
/**
 * Gera o hash da senha do admin e segredos aleatórios.
 *
 *   node scripts/hash-senha.mjs "MinhaSenhaForteAqui!"        -> hash da senha
 *   node scripts/hash-senha.mjs --gerar                        -> senha nova + hash + segredos
 *   node scripts/hash-senha.mjs "senha" --algo=pbkdf2          -> hash PBKDF2-SHA256
 *   node scripts/hash-senha.mjs --conferir "senha" "hash"      -> confere um hash existente
 *
 * A senha em texto puro nunca é gravada em arquivo nem enviada ao servidor:
 * o que vai para o `.env` é apenas o hash.
 */
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*-_';

function senhaAleatoria(tamanho = 24) {
  const bytes = randomBytes(tamanho);
  let saida = '';
  for (const byte of bytes) saida += ALFABETO[byte % ALFABETO.length];
  return saida;
}

const segredo = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** Mesmo formato usado pelo backend: `$bcrypt$...` para o algoritmo do bcryptjs. */
async function hashBcrypt(senha, custo = 12) {
  const salt = await bcrypt.genSalt(custo);
  return `$bcrypt$${await bcrypt.hash(senha, salt)}`;
}

/** PBKDF2-SHA256 (Web Crypto), alternativa para ambientes sem bcrypt. */
async function hashPbkdf2(senha, iteracoes = 600_000) {
  const salt = randomBytes(16);
  const chave = await crypto.subtle.importKey('raw', new TextEncoder().encode(senha), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iteracoes },
    chave,
    256,
  );
  const digest = Buffer.from(bits).toString('hex');
  return `$pbkdf2-sha256$${iteracoes}$${Buffer.from(salt).toString('base64')}$${digest}`;
}

async function conferir(senha, hash) {
  if (hash.startsWith('$bcrypt$')) return bcrypt.compare(senha, hash.slice('$bcrypt$'.length));
  if (hash.startsWith('$2')) return bcrypt.compare(senha, hash);
  if (hash.startsWith('$pbkdf2-sha256$')) {
    const [, , iteracoes, salt, esperado] = hash.split('$');
    const chave = await crypto.subtle.importKey('raw', new TextEncoder().encode(senha), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: Buffer.from(salt, 'base64'), iterations: Number(iteracoes) },
      chave,
      256,
    );
    return Buffer.from(bits).toString('hex') === esperado;
  }
  return false;
}

function politica(senha) {
  if (senha.length < 12) return 'senha precisa de ao menos 12 caracteres';
  if (new Set(senha).size < 5) return 'senha repetitiva demais';
  return null;
}

const argumentos = process.argv.slice(2);
const usaAlgoPbkdf2 = argumentos.includes('--algo=pbkdf2');
const posicionais = argumentos.filter((item) => !item.startsWith('--'));

if (argumentos.includes('--conferir')) {
  const [senha, hash] = posicionais;
  if (!senha || !hash) {
    console.error('uso: node scripts/hash-senha.mjs --conferir "senha" "hash"');
    process.exit(1);
  }
  console.log((await conferir(senha, hash)) ? 'OK: o hash corresponde a senha.' : 'FALHOU: hash nao corresponde.');
  process.exit(0);
}

if (argumentos.includes('--gerar') || posicionais.length === 0) {
  const senha = senhaAleatoria(24);
  const hash = usaAlgoPbkdf2 ? await hashPbkdf2(senha) : await hashBcrypt(senha, 12);
  console.log('=== Senha do admin (guarde agora, nao sera mostrada de novo) ===');
  console.log(`ADMIN_EMAIL=studios.ai.brasil@gmail.com`);
  console.log(`ADMIN_PASSWORD_HASH=${hash}`);
  console.log('');
  console.log('=== Segredos para o .env ===');
  console.log(`JWT_SECRET=${segredo(48)}`);
  console.log(`JWT_REFRESH_SECRET=${segredo(48)}`);
  console.log(`TOTP_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`);
  console.log('');
  console.log(`(senha usada no hash: ${senha})`);
  process.exit(0);
}

const senha = posicionais[0];
const motivo = politica(senha);
if (motivo) {
  console.error(`senha recusada: ${motivo}`);
  process.exit(1);
}
console.log(usaAlgoPbkdf2 ? await hashPbkdf2(senha) : await hashBcrypt(senha, 12));
