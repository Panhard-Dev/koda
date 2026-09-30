#!/usr/bin/env node
/**
 * Lê o `.env` (o mesmo modelo do `.env.example`) e:
 *   node scripts/gerar-env.mjs               -> escreve `.dev.vars` para o `wrangler dev`
 *   node scripts/gerar-env.mjs --segredos    -> envia os SEGREDOS para o Worker (wrangler secret bulk)
 *
 * Variáveis de configuração (NODE_ENV, CORS_ORIGIN, RATE_LIMIT_*) vivem em
 * `wrangler.jsonc`; segredo é segredo: só chega ao Worker por `wrangler secret`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const SEGREDOS = [
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'ADMIN_PASSWORD_HASH',
  'TOTP_ENCRYPTION_KEY',
  // Chave que o host local apresenta para usar a API de modelos. Fica no env do
  // Worker de proposito: o binario do host nao carrega segredo nenhum.
  'SERVE_LIZ_CLIENT_KEY',
];
const CAMINHO_ENV = '.env';

if (!existsSync(CAMINHO_ENV)) {
  console.error('crie o .env a partir do .env.example antes de rodar (npm run hash gera os segredos)');
  process.exit(1);
}

const valores = {};
for (const linha of readFileSync(CAMINHO_ENV, 'utf8').split(/\r?\n/)) {
  const limpa = linha.trim();
  if (limpa === '' || limpa.startsWith('#')) continue;
  const separador = limpa.indexOf('=');
  if (separador === -1) continue;
  const chave = limpa.slice(0, separador).trim();
  const valor = limpa.slice(separador + 1).trim().replace(/^["']|["']$/g, '');
  if (chave !== '') valores[chave] = valor;
}

const faltando = SEGREDOS.filter((chave) => !valores[chave]);
if (faltando.length > 0) {
  console.error(`segredos ausentes no .env: ${faltando.join(', ')}`);
  console.error('rode `npm run hash -- --gerar` e cole o resultado no .env');
  process.exit(1);
}

if (process.argv.includes('--segredos')) {
  const json = JSON.stringify(Object.fromEntries(SEGREDOS.map((chave) => [chave, valores[chave]])));
  // `shell: true` porque no Windows `npx` é um .cmd (execFileSync não resolve).
  const resultado = spawnSync('npx wrangler secret bulk', {
    input: json,
    stdio: ['pipe', 'inherit', 'inherit'],
    shell: true,
  });
  if (resultado.status !== 0) {
    console.error('falha ao enviar os segredos');
    process.exit(resultado.status ?? 1);
  }
  console.log('segredos enviados para o Worker');
  process.exit(0);
}

const linhas = [
  '# Gerado por scripts/gerar-env.mjs — NAO versionar (o .gitignore ja cobre)',
  ...Object.entries(valores).map(([chave, valor]) => `${chave}=${valor}`),
];
writeFileSync('.dev.vars', `${linhas.join('\n')}\n`, 'utf8');
console.log(`.dev.vars escrito com ${Object.keys(valores).length} variaveis (inclui ${SEGREDOS.length} segredos)`);
