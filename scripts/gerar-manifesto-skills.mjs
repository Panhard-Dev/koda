/**
 * Gera `skills/skills.json` — o catálogo das skills que o Koda traz.
 *
 * Por que existe um catálogo, se as pastas já dizem tudo: o app precisa saber **quais** skills
 * viajaram no pacote, e um arquivo é a lista explícita disso — dá para ler num lugar só, e
 * `skills.listar` não precisa varrer pasta às cegas. A **ordem** do arquivo é a ordem em que
 * as skills aparecem.
 *
 * O conteúdo continua vindo do `SKILL.md` de cada pasta — é ele que o agente lê. O
 * `name`/`description` daqui é para leitura humana; se divergir do arquivo, o arquivo ganha,
 * porque é ele que o modelo segue. Este script é o que impede os dois de divergirem: ele
 * reescreve o catálogo a partir das pastas.
 *
 * Rode com `node scripts/gerar-manifesto-skills.mjs` **depois de mexer nas skills**.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..')
const PASTA = join(RAIZ, 'skills')
const DESTINO = join(PASTA, 'skills.json')

/** `name` e `description` da frente do SKILL.md, com escalar de bloco. */
function frente(texto) {
  const campos = {}
  const bloco = texto.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!bloco) return campos
  const linhas = bloco[1].split(/\r?\n/)
  for (let i = 0; i < linhas.length; i++) {
    const corte = linhas[i].indexOf(':')
    if (corte < 0) continue
    const chave = linhas[i].slice(0, corte).trim()
    let valor = linhas[i].slice(corte + 1).trim()
    if (chave !== 'name' && chave !== 'description') continue
    if (['>', '>-', '>+', '|', '|-', '|+'].includes(valor)) {
      const corpo = []
      while (i + 1 < linhas.length && (!linhas[i + 1].trim() || /^[ \t]/.test(linhas[i + 1]))) {
        corpo.push(linhas[++i].trim())
      }
      valor = corpo.filter(Boolean).join(valor.startsWith('|') ? '\n' : ' ')
    }
    campos[chave] = valor.replace(/^['"]|['"]$/g, '')
  }
  return campos
}

if (!existsSync(PASTA)) {
  console.error(`não achei ${PASTA}`)
  process.exit(2)
}

const itens = []
for (const nome of readdirSync(PASTA).sort()) {
  const arquivo = join(PASTA, nome, 'SKILL.md')
  if (!existsSync(arquivo) || !statSync(arquivo).isFile()) continue
  const campos = frente(readFileSync(arquivo, 'utf8'))
  itens.push({
    pasta: nome,
    name: campos.name || nome,
    description: campos.description || '',
  })
}

if (!itens.length) {
  console.error(`nenhuma skill com SKILL.md em ${PASTA}`)
  process.exit(3)
}

writeFileSync(DESTINO, JSON.stringify(itens, null, 2) + '\n', 'utf8')
console.log(`${itens.length} skill(s) em ${DESTINO}:`)
for (const item of itens) console.log(`  ${item.pasta.padEnd(24)} ${item.name}`)
