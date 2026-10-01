import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')
const host = join(raiz, 'host', 'c-host.exe')

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

console.log(`Host do instalador conferido: ${host} (${(statSync(host).size / 1048576).toFixed(1)} MB)`)
