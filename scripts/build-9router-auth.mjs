/** Empacota os fluxos de login MIT do 9router para o backend do Koda. */
import { build } from 'esbuild'
import { join, resolve } from 'node:path'

if (!process.argv[2]) throw new Error('Informe a pasta do 9router')
const origem = resolve(process.argv[2])
const raiz = resolve()
const codigo = `
import { generateAuthData, requestDeviceCode, pollForToken, exchangeTokens, getProvider } from './src/lib/oauth/providers/index.js';
console.log = (...args) => process.stderr.write(args.map(String).join(' ') + '\\n');
let entrada = '';
for await (const pedaco of process.stdin) entrada += pedaco;
try {
  const p = JSON.parse(entrada);
  const config = getProvider(p.provider);
  let result;
  if (p.action === 'prepare') result = { flowType: config.flowType, fixedPort: config.fixedPort || 0, callbackPath: config.callbackPath || '/callback' };
  else if (p.action === 'authorize') result = await generateAuthData(p.provider, p.redirectUri, p.meta);
  else if (p.action === 'device-code') result = await requestDeviceCode(p.provider, undefined, p.options);
  else if (p.action === 'poll') result = await pollForToken(p.provider, p.deviceCode, p.codeVerifier, p.extraData);
  else if (p.action === 'exchange') result = await exchangeTokens(p.provider, p.code, p.redirectUri, p.codeVerifier, p.state, p.meta);
  else throw new Error('ação de autenticação desconhecida');
  process.stdout.write('KODA_RESULT:' + JSON.stringify({ ok: true, result }));
} catch (erro) {
  process.stdout.write('KODA_RESULT:' + JSON.stringify({ ok: false, error: String(erro?.message || erro) }));
  process.exitCode = 1;
}
`
await build({
  stdin: { contents: codigo, resolveDir: origem, sourcefile: 'koda-9router-auth-entry.mjs', loader: 'js' },
  outfile: join(raiz, 'backend', 'app', 'auth_9router.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  banner: { js: 'import { createRequire as kodaCreateRequire } from "node:module"; const require = kodaCreateRequire(import.meta.url);' },
  nodePaths: [join(raiz, 'node_modules')],
  external: ['@aws-sdk/credential-providers'],
  plugins: [{
    name: 'koda-9router-aliases',
    setup(b) {
      b.onResolve({ filter: /^open-sse\/index\.js$/ }, () => ({ path: 'empty', namespace: 'koda-stub' }))
      b.onResolve({ filter: /^open-sse\// }, (args) => ({ path: join(origem, args.path) }))
      b.onResolve({ filter: /^@\/lib\/usageDb\.js$/ }, () => ({ path: 'usage', namespace: 'koda-stub' }))
      b.onResolve({ filter: /^@\/lib\/dataDir\.js$/ }, () => ({ path: 'data', namespace: 'koda-stub' }))
      b.onResolve({ filter: /^@\/lib\/localDb$/ }, () => ({ path: 'localdb', namespace: 'koda-stub' }))
      b.onResolve({ filter: /src\/lib\/db\/helpers\/kvStore\.js$/ }, () => ({ path: 'kv', namespace: 'koda-stub' }))
      b.onLoad({ filter: /.*/, namespace: 'koda-stub' }, ({ path }) => ({
        contents: path === 'empty' ? ''
          : path === 'usage' ? 'export function trackPendingRequest() {} export async function appendRequestLog() {} export async function saveRequestDetail() {} export async function saveRequestUsage() {}'
          : path === 'data' ? 'export const DATA_DIR = process.env.KODA_DATA_DIR || process.cwd();'
          : path === 'localdb' ? 'export async function getProviderConnections() { return []; } export async function updateProviderConnection() {}'
          : 'const m = new Map(); export function makeKv(scope) { return { async get(k) { return m.get(scope+":"+k); }, async set(k,v) { m.set(scope+":"+k,v); }, async remove(k) { m.delete(scope+":"+k); }, async getAll() { return {}; } }; }',
        loader: 'js',
      }))
    },
  }],
  logLevel: 'warning',
})
console.log('Fluxos de login do 9router empacotados em backend/app/auth_9router.mjs')
