import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')

function lerJson(relativo) {
  return JSON.parse(readFileSync(join(raiz, relativo), 'utf8'))
}

function versaoPython(relativo) {
  const texto = readFileSync(join(raiz, relativo), 'utf8')
  const achada = texto.match(/^__version__\s*=\s*["']([^"']+)["']/m)
  if (!achada) throw new Error(`versão ausente em ${relativo}`)
  return achada[1]
}

function versaoCargo() {
  const texto = readFileSync(join(raiz, 'src-tauri', 'Cargo.toml'), 'utf8')
  const achada = texto.match(/^version\s*=\s*["']([^"']+)["']/m)
  if (!achada) throw new Error('versão ausente em src-tauri/Cargo.toml')
  return achada[1]
}

const versao = lerJson('package.json').version
const fontes = {
  'package-lock.json': lerJson('package-lock.json').version,
  'package-lock.json/packages/': lerJson('package-lock.json').packages?.['']?.version,
  'src-tauri/tauri.conf.json': lerJson('src-tauri/tauri.conf.json').version,
  'src-tauri/Cargo.toml': versaoCargo(),
  'backend/app/__init__.py': versaoPython('backend/app/__init__.py'),
}

for (const relativo of [
  'src-tauri/runtime/backend/app/__init__.py',
  'src-tauri/runtime-linux/backend/app/__init__.py',
]) {
  if (existsSync(join(raiz, relativo))) fontes[relativo] = versaoPython(relativo)
}

const divergentes = Object.entries(fontes).filter(([, valor]) => valor !== versao)
if (divergentes.length > 0) {
  throw new Error(
    `versões divergentes; esperado ${versao}: ` +
      divergentes.map(([arquivo, valor]) => `${arquivo}=${valor}`).join(', '),
  )
}

console.log(`Versão obrigatória consistente: ${versao}`)
