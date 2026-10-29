import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')
const host = join(raiz, 'host', 'c-host.exe')
const kodahost = join(raiz, 'host', 'kodahost1.exe')
const hooks = join(raiz, 'src-tauri', 'installer', 'hooks.nsh')

if (!existsSync(host) || !statSync(host).isFile()) {
  throw new Error(
    `O instalador precisa do serviço de modelos, mas não encontrou ${host}. ` +
      'Coloque o c-host.exe fornecido pela distribuição oficial em host/ e gere o instalador novamente.',
  )
}

const assinatura = readFileSync(host).subarray(0, 2).toString('ascii')
if (assinatura !== 'MZ') {
  throw new Error(`O arquivo ${host} não parece ser um executável válido do Windows (assinatura ${JSON.stringify(assinatura)}).`)
}

if (!existsSync(kodahost) || !statSync(kodahost).isFile()) {
  throw new Error(`O failover precisa do kodahost1.exe, mas não encontrou ${kodahost}.`)
}
if (readFileSync(kodahost).subarray(0, 2).toString('ascii') !== 'MZ') {
  throw new Error(`O arquivo ${kodahost} não parece ser um executável válido do Windows.`)
}

const tamanhoDeclarado = Number.parseInt(
  readFileSync(hooks, 'utf8').match(/^!define KODA_HOST_BYTES (\d+)$/m)?.[1] ?? '', 10,
)
if (tamanhoDeclarado !== statSync(host).size) {
  throw new Error(`Atualize KODA_HOST_BYTES em ${hooks}: host tem ${statSync(host).size} bytes.`)
}

console.log(`Hosts conferidos: c-host (${(statSync(host).size / 1048576).toFixed(1)} MB) e kodahost1 (${(statSync(kodahost).size / 1048576).toFixed(1)} MB)`)
