import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')
const tauri = join(raiz, 'src-tauri')

function exigir(caminho, descricao) {
  if (!existsSync(caminho) || !statSync(caminho).isFile() || statSync(caminho).size === 0) {
    throw new Error(`${descricao} ausente ou vazio: ${caminho}`)
  }
  return caminho
}

function config(nome) {
  return JSON.parse(readFileSync(join(tauri, nome), 'utf8'))
}

const base = config('tauri.conf.json')
const linux = config('tauri.linux.conf.json')
const windows = config('tauri.windows.conf.json')

const servidor = exigir(join(raiz, 'link', 'server.py'), 'Servidor do link')
const paginaCelular = exigir(join(raiz, 'mobile', 'index.html'), 'Página do celular')
const scriptCelular = exigir(join(raiz, 'mobile', 'mobile.js'), 'Aplicativo do celular')
const cloudflaredLinux = exigir(
  join(tauri, 'runtime-linux', 'bin', 'cloudflared'),
  'cloudflared Linux',
)
const cloudflaredWindows = exigir(
  join(tauri, 'runtime', 'bin', 'cloudflared.exe'),
  'cloudflared Windows',
)
exigir(join(tauri, 'runtime-linux', 'backend', 'python', 'bin', 'python3'), 'Python Linux')
exigir(join(tauri, 'runtime-linux', 'node', 'node'), 'Node Linux')
exigir(join(tauri, 'runtime', 'backend', 'python', 'python.exe'), 'Python Windows')
exigir(join(tauri, 'runtime', 'node', 'node.exe'), 'Node Windows')

accessSync(cloudflaredLinux, constants.X_OK)

const recursosBase = base.bundle?.resources ?? {}
const recursosLinux = linux.bundle?.resources ?? {}
const recursosWindows = windows.bundle?.resources ?? {}
if (recursosBase['../link'] !== 'link') {
  throw new Error('tauri.conf.json não empacota ../link como recurso obrigatório')
}
if (recursosBase['../mobile'] !== 'mobile') {
  throw new Error('tauri.conf.json não empacota ../mobile como recurso obrigatório')
}
if (recursosLinux['runtime-linux/bin'] !== 'bin') {
  throw new Error('tauri.linux.conf.json não empacota o cloudflared Linux')
}
if (recursosWindows['runtime/bin'] !== 'bin') {
  throw new Error('tauri.windows.conf.json não empacota o cloudflared Windows')
}

const elf = readFileSync(cloudflaredLinux).subarray(0, 4)
if (!elf.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
  throw new Error(`cloudflared Linux não é um ELF válido: ${cloudflaredLinux}`)
}
const pe = readFileSync(cloudflaredWindows).subarray(0, 2)
if (!pe.equals(Buffer.from('MZ'))) {
  throw new Error(`cloudflared Windows não é um executável PE válido: ${cloudflaredWindows}`)
}

if (process.platform === 'linux') {
  execFileSync(cloudflaredLinux, ['--version'], { encoding: 'utf8', timeout: 10_000 })
}

console.log(
  `Cloudflare obrigatório: ${servidor} + ${paginaCelular} + ${scriptCelular} + ` +
    `${cloudflaredLinux} + ${cloudflaredWindows}`,
)
