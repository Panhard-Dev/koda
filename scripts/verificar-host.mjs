import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')
const proxy = join(raiz, 'LizProxy.py')
if (!existsSync(proxy) || !statSync(proxy).isFile()) throw new Error('LizProxy.py ausente')
console.log('Proxy encontrado')
