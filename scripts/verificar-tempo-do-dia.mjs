/**
 * Prova a aritmética do relógio do dia (`src/tempo.ts`) — o número da aba da caixa.
 *
 * A regra é a do dono, e é básica: **restante = horas do plano − tempo gasto**. Usou 1 h de
 * um plano de 8 h, a aba diz `07:00:00`; usou 4 min, desconta 4 min. E vale para **todos** os
 * planos — por isso a bancada roda a mesma bateria sobre Free (1 h), Base (2 h), Plus (4 h) e
 * Pro (8 h), lendo os números de `src/plano.ts`, que é a fonte única deles.
 *
 * O defeito que esta bancada tranca: `sincronizar()` reapontava o gasto para o número do
 * servidor **para baixo**. O servidor soma o `elapsed_ms` das respostas **já gravadas** — a
 * rodada em curso não está lá —, então no meio de uma rodada longa o mostrador voltava para
 * perto do cheio: 1 h gasta de 8 h virava `07:58:58` em vez de `07:00:00`.
 *
 * Roda com `node scripts/verificar-tempo-do-dia.mjs` (o esbuild vem com o Vite).
 */

import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'koda-tempo-'))
const saida = join(dir, 'tempo.cjs')

// Uma entrada sintética só para expor os dois módulos de uma vez: o `tempo.ts` importa o
// `plano.ts`, mas não o reexporta, e os números dos planos têm de vir da fonte, não de
// constantes copiadas para dentro do teste.
buildSync({
  stdin: {
    contents: [
      "export * as tempo from './src/tempo.ts'",
      "export * as plano from './src/plano.ts'",
    ].join('\n'),
    resolveDir: process.cwd(),
    sourcefile: 'entrada-da-bancada.ts',
    loader: 'ts',
  },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: saida,
  logLevel: 'silent',
})

// `window.localStorage` é lido na carga do módulo (`gastos = carregar()`), então precisa
// existir antes do require — é o mesmo cuidado de quem testa a coisa pelo lado de fora.
const memoria = new Map()
globalThis.window = {
  localStorage: {
    getItem: (chave) => (memoria.has(chave) ? memoria.get(chave) : null),
    setItem: (chave, valor) => memoria.set(chave, String(valor)),
  },
}

const require = createRequire(import.meta.url)
const { tempo, plano } = require(saida)

const falhas = []

function checar(rotulo, obtido, esperado) {
  const ok = obtido === esperado
  console.log(`[${ok ? 'OK ' : 'FALHA'}] ${rotulo} -> ${obtido}${ok ? '' : ` (esperado ${esperado})`}`)
  if (!ok) falhas.push(rotulo)
}

const hora = (segundos) => tempo.tempoEmTexto(segundos)
const restante = () => hora(tempo.ler())

const PLANOS = [plano.PLANO_FREE, ...plano.PLANOS_PAGOS]

console.log(`Planos lidos de src/plano.ts: ${PLANOS.map((p) => `${p.nome} ${p.horasPorDia}h`).join(' · ')}`)
console.log()

for (const p of PLANOS) {
  const cheio = p.horasPorDia * 3600
  // Conta nova por plano: o rascunho do dia é por conta, e a chave nova garante o zero.
  tempo.definirConta(`bancada-${p.nome}`)
  tempo.definirHorasDoDia(p.horasPorDia)

  checar(`${p.nome} (${p.horasPorDia} h): nada gasto`, restante(), hora(cheio))

  tempo.sincronizar(240) // usou 4 min
  checar(`${p.nome}: usou 4 min`, restante(), hora(cheio - 240))

  tempo.sincronizar(0) // a sonda de sessão rodou no meio da rodada, sem ela gravada
  checar(`${p.nome}: atraso do servidor NÃO devolve a hora`, restante(), hora(cheio - 240))

  tempo.sincronizar(3600) // usou 1 h
  checar(`${p.nome}: usou 1 h`, restante(), hora(Math.max(0, cheio - 3600)))

  console.log()
}

// Trocar de plano no meio do dia: o gasto fica, o teto muda.
tempo.definirConta('bancada-troca')
tempo.definirHorasDoDia(2) // Base
tempo.sincronizar(7200) // 2 h gastas
checar('Base com 2 h gastas zera', restante(), '00:00:00')
tempo.definirHorasDoDia(8) // subiu para Pro
checar('subir para Pro devolve o que faltava', restante(), '06:00:00')
tempo.definirHorasDoDia(1) // caiu para Free
checar('cair para Free zera de novo', restante(), '00:00:00')

console.log()
if (falhas.length) {
  console.log(`RESULTADO: ${falhas.length} falha(s): ${falhas.join('; ')}`)
  process.exit(1)
}
console.log(`RESULTADO: tudo verde em ${PLANOS.length} planos`)
