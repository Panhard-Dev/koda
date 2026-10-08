/**
 * Copia o `node.exe` para dentro do instalador.
 *
 * Os dois servidores MCP que o app traz (`navegador` e `logs`) são programas **Node**, e o
 * instalador promete que não é preciso instalar mais nada. Sem este passo o app instalado
 * subiria sem ferramenta nenhuma do Painel Dev, e a única pista seria o `stderr` de um
 * servidor que não nasceu.
 *
 *   src-tauri/runtime/node/node.exe
 *
 * e o `tauri.conf.json` leva essa pasta para `resources/node/`. Do backend, `Settings.node_path`
 * acha o arquivo (`backend/app/config.py`), e o gerenciador de MCP troca o `"command": "node"`
 * do `mcps.json` por ele — quem instalar não precisa ter Node.
 *
 * A fonte é o Node que **roda este script** (`process.execPath`), ou o caminho em
 * `KODA_NODE`. Um Node que não seja o mesmo que monta o pacote seria uma segunda variável
 * para dar errado.
 *
 * **O que ficou no pacote é conferido, e não só o que saiu da origem.** Um `node.exe` que
 * existe mas não inicia — cópia truncada, antivírus no meio, arquitetura errada — não aparece
 * como "não encontrei o arquivo": o `Popen` sobe o processo e ele morre logo depois. Por isso
 * o que foi copiado é medido: **arquitetura** (do cabeçalho PE) e **hash** (contra a origem).
 *
 * Executar o binário copiado seria a prova mais direta, e é tentado — mas só quando dá: há
 * ambiente que recusa `spawn` a partir do Node (`EBUSY`), e aí a falta dessa prova é **aviso**,
 * não erro. O que não pode passar em silêncio é hash ou arquitetura diferente.
 *
 * Rode com `node scripts/gerar-runtime-node.mjs` (o `npm run app:build` faz isso).
 */
import { closeSync, copyFileSync, mkdirSync, openSync, readSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..')
const DESTINO = join(RAIZ, 'src-tauri', 'runtime', 'node')

/** Os servidores usam `fetch` e `WebSocket` globais: abaixo disto eles nem sobem. */
const MINIMO = 22

/** O app é empacotado para x64. Um binário de outra arquitetura só falha na máquina do dono. */
const ARQUITETURA = 'x64'

/**
 * A arquitetura, lida do cabeçalho PE sem carregar o arquivo inteiro (são ~90 MB).
 *
 * Também serve para saber se o arquivo **é** um executável: um HTML de página de erro de
 * proxy salvo como `node.exe` tem o tamanho errado e nenhuma assinatura `PE\0\0`.
 */
function lerCabecalho(caminho) {
  const fd = openSync(caminho, 'r')
  try {
    const cabecalho = Buffer.alloc(0x10000)
    const lidos = readSync(fd, cabecalho, 0, cabecalho.length, 0)
    if (lidos < 0x40 || cabecalho.toString('ascii', 0, 2) !== 'MZ') {
      throw new Error(`${caminho} não é um executável do Windows (sem assinatura MZ)`)
    }
    const e_lfanew = cabecalho.readUInt32LE(0x3c)
    if (e_lfanew + 6 > lidos || cabecalho.toString('ascii', e_lfanew, e_lfanew + 4) !== 'PE\0\0') {
      throw new Error(`${caminho} não é um executável do Windows (sem assinatura PE)`)
    }
    const maquina = cabecalho.readUInt16LE(e_lfanew + 4)
    return { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'x86' }[maquina] ?? `0x${maquina.toString(16)}`
  } finally {
    closeSync(fd)
  }
}

/** O hash do arquivo, em pedaços — são dezenas de MB, e não cabe tudo na memória à toa. */
function hash(caminho) {
  const fd = openSync(caminho, 'r')
  try {
    const resumo = createHash('sha256')
    const pedaco = Buffer.alloc(1 << 20)
    let lido
    while ((lido = readSync(fd, pedaco, 0, pedaco.length, null)) > 0) {
      resumo.update(pedaco.subarray(0, lido))
    }
    return resumo.digest('hex')
  } finally {
    closeSync(fd)
  }
}

const origem = process.env.KODA_NODE || process.execPath
// A versão de quem roda este script já está em `process.version`: não há por que perguntar ao
// binário. Perguntar seria pior — no Windows, executar o mesmo arquivo que está rodando pode
// voltar `EBUSY`. Com `KODA_NODE` a origem é outro arquivo, e aí sim se pergunta.
const versao = process.env.KODA_NODE
  ? execFileSync(origem, ['-v'], { encoding: 'utf8' }).trim()
  : process.version
const principal = Number.parseInt(versao.replace(/^v/, '').split('.')[0], 10)

if (!Number.isFinite(principal) || principal < MINIMO) {
  throw new Error(
    `o Node em ${origem} é ${versao}, e os servidores MCP do Koda precisam de ${MINIMO}+ ` +
      `(usam \`fetch\` e \`WebSocket\` globais). Aponte um Node mais novo em KODA_NODE.`
  )
}

const arq = lerCabecalho(origem)
if (arq !== ARQUITETURA) {
  throw new Error(
    `o Node em ${origem} é ${arq}, e o Koda é empacotado para ${ARQUITETURA}. ` +
      `Aponte um Node ${ARQUITETURA} em KODA_NODE.`
  )
}

mkdirSync(DESTINO, { recursive: true })
const alvo = join(DESTINO, 'node.exe')
copyFileSync(origem, alvo)

// O que **ficou** tem de ser o que saiu: bytes copiados não garantem um executável íntegro.
const hashOrigem = hash(origem)
const hashAlvo = hash(alvo)
if (hashOrigem !== hashAlvo) {
  throw new Error(
    `o node.exe copiado para ${alvo} não é igual à origem (${hashAlvo.slice(0, 16)} != ` +
      `${hashOrigem.slice(0, 16)}). Confira espaço em disco e antivírus, e rode de novo.`
  )
}

// A prova mais direta — que ele **inicia** — quando o ambiente deixa. Um `EBUSY`/`EPERM` aqui
// é do ambiente (sandbox, antivírus, arquivo em uso), não do binário: hash e arquitetura já
// conferem, então vira aviso em vez de derrubar o build.
try {
  const versaoCopiada = execFileSync(alvo, ['-v'], { encoding: 'utf8' }).trim()
  if (versaoCopiada !== versao) {
    throw new Error(`o node.exe copiado respondeu ${versaoCopiada}, e a origem respondeu ${versao}`)
  }
} catch (erro) {
  if (erro.status !== undefined && erro.status !== null) {
    throw new Error(
      `o node.exe copiado para ${alvo} não inicia (código ${erro.status}). ` +
        `Confira antivírus e espaço em disco, e rode de novo.`
    )
  }
  console.warn(
    `[koda] aviso: não deu para executar o node.exe copiado para confirmar que inicia ` +
      `(${erro.code ?? erro.message}). Hash e arquitetura conferem.`
  )
}

const mb = (statSync(alvo).size / 1048576).toFixed(1)
console.log(`[koda] node ${versao} (${arq}) empacotado em runtime/node/node.exe (${mb} MB)`)
