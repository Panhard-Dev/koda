/**
 * Importa somente os provedores com autenticação por conta do 9router.
 *
 * Uso: node scripts/importar-9router-login.mjs C:/caminho/9router-master
 * Fonte: 9router (licença MIT, copyright 2024-2026 decolua e colaboradores).
 * O JSON gerado é distribuído com o Koda; o projeto de origem não é necessário em runtime.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const origem = resolve(process.argv[2] || '')
if (!process.argv[2]) throw new Error('Informe a pasta do 9router')
const registro = join(origem, 'open-sse', 'providers', 'registry')
const auth = join(origem, 'src', 'lib', 'oauth', 'providers')
const { PROVIDER_OAUTH } = await import(pathToFileURL(join(origem, 'open-sse', 'providers', 'index.js')).href)
const { GOOGLE_OAUTH_CLIENT, ANTIGRAVITY_OAUTH_CLIENT } = await import(
  pathToFileURL(join(origem, 'open-sse', 'providers', 'shared.js')).href,
)
const configurados = new Set(
  readdirSync(auth).filter((name) => name.endsWith('.js') &&
    !['index.js', '_shared.js', 'minimax-code-shared.js'].includes(name))
    .map((name) => name.slice(0, -3)),
)

function campo(texto, nome) {
  return texto.match(new RegExp(`\\b${nome}:\\s*["']([^"']+)["']`))?.[1] ?? null
}

function listaDeModelos(texto) {
  const inicio = texto.indexOf('models: [')
  if (inicio < 0) return []
  let nivel = 0
  let fim = -1
  let aspas = null
  let comentario = null
  for (let i = inicio + 8; i < texto.length; i++) {
    const c = texto[i], seguinte = texto[i + 1]
    if (comentario === '//') { if (c === '\n') comentario = null; continue }
    if (comentario === '/*') { if (c === '*' && seguinte === '/') { comentario = null; i++ }; continue }
    if (aspas) { if (c === '\\') { i++; continue }; if (c === aspas) aspas = null; continue }
    if (c === '/' && seguinte === '/') { comentario = '//'; i++; continue }
    if (c === '/' && seguinte === '*') { comentario = '/*'; i++; continue }
    if (c === '"' || c === "'" || c === '`') { aspas = c; continue }
    if (c === '[') nivel++
    if (c === ']' && --nivel === 0) { fim = i; break }
  }
  if (fim < 0) return []
  const trecho = texto.slice(inicio + 9, fim)
  const modelos = []
  for (const match of trecho.matchAll(/\{\s*id:\s*["']([^"']+)["']\s*,\s*name:\s*["']([^"']+)["']([^}]*?)\}/gs)) {
    if (/\bkind:\s*["'](image|stt|tts|embedding|video|music)["']/.test(match[3])) continue
    modelos.push({ id: match[1], nome: match[2] })
  }
  return modelos
}

const especiais = { claude: 'anthropic', codex: 'openai' }
const provedores = []
for (const arquivo of readdirSync(registro).filter((name) => name.endsWith('.js'))) {
  const fonteId = arquivo.slice(0, -3)
  const texto = readFileSync(join(registro, arquivo), 'utf8')
  const definicao = (await import(pathToFileURL(join(registro, arquivo)).href)).default
  const categoria = definicao.category
  if (!configurados.has(fonteId) && categoria !== 'webCookie') continue
  const nome = definicao.display?.name || fonteId
  const website = definicao.display?.website || ''
  const fluxoTexto = configurados.has(fonteId)
    ? readFileSync(join(auth, `${fonteId}.js`), 'utf8') : ''
  const fluxo = campo(fluxoTexto, 'flowType') ||
    (fonteId.startsWith('minimax-code') ? 'device_code' :
      fonteId === 'qoder-cn' ? 'device_code' :
        fonteId === 'xiaomi-mimo' ? 'encrypted_callback' : 'custom')
  const id = especiais[fonteId] || fonteId
  const oauth = { ...(fonteId === 'gemini-cli' ? GOOGLE_OAUTH_CLIENT : {}),
    ...(fonteId === 'antigravity' ? ANTIGRAVITY_OAUTH_CLIENT : {}),
    ...(PROVIDER_OAUTH[fonteId] || {}) }
  provedores.push({
    id, fonteId, nome, sigla: nome.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase(),
    cli: fonteId === 'claude' ? 'Anthropic' : fonteId === 'codex' ? 'OpenAI' :
      categoria === 'webCookie' ? 'Login no navegador' : 'Conta do provedor',
    website, tipo: categoria === 'webCookie' ? 'web_cookie' : fluxo,
    ...(definicao.authHint ? { authHint: definicao.authHint } : {}),
    ...(Object.keys(oauth).length ? { oauth } : {}),
    modelos: (definicao.serviceKinds && !definicao.serviceKinds.includes('llm')) ? [] :
      (definicao.models || []).filter(modelo => !modelo.kind || modelo.kind === 'llm')
        .map(modelo => ({ id: modelo.id, nome: modelo.name || modelo.id })),
  })
}

provedores.sort((a, b) => a.fonteId === 'claude' ? -1 : b.fonteId === 'claude' ? 1 :
  a.fonteId === 'codex' ? -1 : b.fonteId === 'codex' ? 1 :
    a.nome.localeCompare(b.nome, 'pt-BR'))
const saida = resolve('backend/app/provedores_9router.json')
writeFileSync(saida, JSON.stringify({
  _licenca: '9router MIT; copyright 2024-2026 decolua and contributors',
  _origem: 'open-sse/providers/registry e src/lib/oauth/providers do 9router',
  provedores,
}, null, 2) + '\n')
console.log(`Importados ${provedores.length} provedores via login para ${saida}`)
