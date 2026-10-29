/**
 * Empacota o transporte e os tradutores do 9router para o backend do Koda.
 * O bundle usa o código MIT do 9router; veja engine_9router.LICENSE.
 * Uso: node scripts/build-9router-engine.mjs C:/caminho/9router-master
 */
import { build } from 'esbuild'
import { resolve, join } from 'node:path'

if (!process.argv[2]) throw new Error('Informe a pasta do 9router')
const origem = resolve(process.argv[2])
const raiz = resolve()
const codigo = `
import { handleChatCore } from 'open-sse/handlers/chatCore.js';
import { resolveZedModels } from 'open-sse/shared/zedAuth.js';
console.log = (...args) => process.stderr.write(args.map(String).join(' ') + '\\n');
let entrada = '';
for await (const pedaco of process.stdin) entrada += pedaco;
try {
  const pedido = JSON.parse(entrada);
  const id = pedido.provider;
  const credenciais = pedido.credentials || {};
  if (pedido.action === 'models' && id === 'zed') {
    const catalogo = await resolveZedModels(credenciais, { forceRefresh: true });
    process.stdout.write('KODA_RESULT:' + JSON.stringify({ ok: true, status: 200, body: JSON.stringify({ models: catalogo?.models || [] }) }));
  } else {
  const resultado = await handleChatCore({
    body: { model: pedido.model, messages: pedido.messages, tools: pedido.tools || undefined, stream: false, max_tokens: pedido.maxTokens || 64 },
    modelInfo: { provider: id, model: pedido.model },
    credentials: credenciais,
    sourceFormatOverride: 'openai',
    connectionId: credenciais.id || null,
  });
  const resposta = resultado.response;
  process.stdout.write('KODA_RESULT:' + JSON.stringify({ ok: resultado.success === true, status: resposta.status, body: await resposta.text() }));
  }
} catch (erro) {
  process.stdout.write('KODA_RESULT:' + JSON.stringify({ ok: false, status: 0, error: String(erro?.stack || erro) }));
  process.exitCode = 1;
}
`

await build({
  stdin: { contents: codigo, resolveDir: origem, sourcefile: 'koda-9router-entry.mjs', loader: 'js' },
  outfile: join(raiz, 'backend', 'app', 'engine_9router.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: 'import { createRequire as kodaCreateRequire } from "node:module"; const require = kodaCreateRequire(import.meta.url);' },
  nodePaths: [join(raiz, 'node_modules')],
  external: ['@aws-sdk/credential-providers', 'better-sqlite3', 'bun:sqlite', 'sql.js'],
  plugins: [{
    name: 'koda-9router-aliases',
    setup(b) {
      b.onResolve({ filter: /^open-sse\// }, (args) => ({ path: join(origem, args.path) }))
      b.onResolve({ filter: /^@\/lib\/usageDb\.js$/ }, () => ({ path: 'usage', namespace: 'koda-stub' }))
      b.onResolve({ filter: /^@\/lib\/dataDir\.js$/ }, () => ({ path: 'data', namespace: 'koda-stub' }))
      b.onResolve({ filter: /src\/lib\/oauth\/kiroExternalIdp\.js$/ }, () => ({ path: 'kiro-idp', namespace: 'koda-stub' }))
      b.onResolve({ filter: /src\/lib\/oauth\/services\/xai\.js$/ }, () => ({ path: 'xai-refresh', namespace: 'koda-stub' }))
      b.onResolve({ filter: /src\/lib\/oauth\/providers\.js$/ }, () => ({ path: 'kiro-profile', namespace: 'koda-stub' }))
      b.onResolve({ filter: /src\/lib\/db\/helpers\/kvStore\.js$/ }, () => ({ path: 'kv', namespace: 'koda-stub' }))
      b.onLoad({ filter: /.*/, namespace: 'koda-stub' }, ({ path }) => ({
        contents: path === 'usage'
          ? 'export function trackPendingRequest() {} export async function appendRequestLog() {} export async function saveRequestDetail() {} export async function saveRequestUsage() {}'
          : path === 'data' ? 'export const DATA_DIR = process.env.KODA_DATA_DIR || process.cwd();'
          : path === 'kiro-idp' ? 'export function buildExternalIdpRefreshParams() { throw new Error("Kiro IDP refresh unavailable in this engine"); }'
          : path === 'xai-refresh' ? 'export class XaiService { async refreshAccessToken() { throw new Error("xAI refresh unavailable in this engine"); } }'
          : path === 'kv' ? 'const m = new Map(); export function makeKv(scope) { return { async get(k) { return m.get(scope+":"+k); }, async set(k,v) { m.set(scope+":"+k,v); }, async remove(k) { m.delete(scope+":"+k); }, async getAll() { return {}; } }; }'
          : 'export async function fetchKiroProfileArn() { return null; }',
        loader: 'js',
      }))
    },
  }],
  logLevel: 'warning',
})
console.log('Motor do 9router empacotado em backend/app/engine_9router.mjs')
