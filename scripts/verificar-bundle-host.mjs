import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')
const versao = JSON.parse(readFileSync(join(raiz, 'src-tauri', 'tauri.conf.json'), 'utf8')).version
const instalador = join(raiz, 'src-tauri', 'target', 'release', 'bundle', 'nsis', `Koda_${versao}_x64-setup.exe`)
const scriptNsis = join(raiz, 'src-tauri', 'target', 'release', 'nsis', 'x64', 'installer.nsi')

if (!existsSync(scriptNsis)) {
  throw new Error(`O Tauri não gerou o script NSIS esperado: ${scriptNsis}`)
}

const conteudoNsis = readFileSync(scriptNsis, 'utf8')
if (!/File \/a "\/oname=host\\c-host\.exe" "[^"]*host[\\/]c-host\.exe"/i.test(conteudoNsis)) {
  throw new Error(`O script NSIS não inclui host/c-host.exe: ${scriptNsis}`)
}

if (!existsSync(instalador) || !statSync(instalador).isFile()) {
  throw new Error(`O instalador NSIS não foi gerado: ${instalador}`)
}
const launcher = readFileSync(instalador)
if (!launcher.includes(Buffer.from('KODA_TEMP_OVERRIDE_WRAPPER_V1'))) {
  throw new Error(`O instalador de distribuição não tem o lançador que corrige TEMP/TMP: ${instalador}`)
}

console.log(
  `Instalador ${versao} conferido: NSIS inclui host/c-host.exe e o lançador corrige TEMP/TMP; ` +
    `${(statSync(instalador).size / 1048576).toFixed(1)} MB em ${instalador}`,
)
