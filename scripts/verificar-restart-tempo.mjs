/**
 * Prova que o relógio do dia sobrevive ao restart (`src/tempo.ts`).
 *
 * O relato do dono: usou, a aba mostrou `07:59:56`, reiniciou e voltou a `08:00:00` —
 * com o backend **tendo** o gasto gravado (a mensagem está no banco, com o `elapsed_ms`
 * e a conta dele). O que zerou foi o rascunho local. A bancada tranca os três caminhos
 * por onde ele se perdia:
 *
 * 1. **conta resolvendo depois da resposta**: a sonda de sessão leva um tempo, e os
 *    segundos contados antes dela ficavam na chave de «ninguém» — quando a conta chegava,
 *    `definirConta` carregava a chave **dela** (vazia) e o mostrador voltava ao cheio;
 * 2. **restart com o rascunho na chave genérica**: o init lê a chave de «ninguém», e a
 *    conta que chegava depois descartava o que estava lá;
 * 3. **sonda atrasada no restart**: `sincronizar(0)` (sem conta = cota de ninguém) não
 *    pode apagar o que a sessão já contou.
 *
 * E o que **não** pode quebrar: trocar de conta de verdade (A → B) continua mostrando o
 * rascunho de cada uma — o gasto de A é fechado na chave de A antes de B ser carregada.
 *
 * Roda com `node scripts/verificar-restart-tempo.mjs` (o esbuild vem com o Vite).
 */

import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'koda-tempo-restart-'))
const saida = join(dir, 'tempo.cjs')

await build({
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

const require = createRequire(import.meta.url)

// O localStorage fake, compartilhado entre "sessões" — é o disco do navegador.
const memoria = new Map()

function novaSessao() {
  globalThis.window = {
    localStorage: {
      getItem: (k) => (memoria.has(k) ? memoria.get(k) : null),
      setItem: (k, v) => memoria.set(k, String(v)),
      removeItem: (k) => memoria.delete(k),
    },
  }
  delete require.cache[saida]
  return require(saida).tempo
}

/** Quatro tiques de relógio — os segundos que a resposta levou. */
const quatroTiques = async (t) => {
  t.ligar(true)
  await new Promise((r) => setTimeout(r, 4200))
  t.ligar(false)
}

const falhas = []
const checar = (rotulo, obtido, esperado) => {
  const ok = obtido === esperado
  const extra = ok ? '' : ` (esperado ${esperado})`
  console.log(`[${ok ? 'OK ' : 'FALHA'}] ${rotulo} -> ${obtido}${extra}`)
  if (!ok) falhas.push(rotulo)
}
const restante = (t) => t.tempoEmTexto(t.ler())

console.log('--- 1. conta resolvendo DEPOIS da resposta (o caso comprovado) ---')
{
  memoria.clear()
  const t = novaSessao()
  t.definirHorasDoDia(8) // o plano da conta chegou, a conta ainda não
  await quatroTiques(t) // 4 s contados com "ninguém" logado
  checar('contou 4 s antes da conta', restante(t), '07:59:56')

  t.definirConta('gabrielluxpanhard@gmail.com') // a sonda cai
  checar('a conta que chega NÃO zera', restante(t), '07:59:56')
}

console.log()
console.log('--- 2. restart com a conta resolvida desde o início ---')
{
  memoria.clear()
  const t = novaSessao()
  t.definirConta('gabrielluxpanhard@gmail.com')
  t.definirHorasDoDia(8)
  await quatroTiques(t)
  checar('sessão 1 contou 4 s', restante(t), '07:59:56')

  const t2 = novaSessao() // "reiniciei"
  // A ordem do App no mount: sincronizar (uso) → plano → conta.
  t2.sincronizar(4631 / 1000) // o que o servidor tem desta conta
  t2.definirHorasDoDia(8)
  t2.definirConta('gabrielluxpanhard@gmail.com')
  checar('após restart', restante(t2), '07:59:56')
}

console.log()
console.log('--- 3. restart com o rascunho na chave genérica (conta chegou tarde na 1) ---')
{
  memoria.clear()
  const t = novaSessao()
  t.definirHorasDoDia(8)
  await quatroTiques(t) // gravou na chave de "ninguém" (a conta nunca chegou)
  checar('sessão 1 contou 4 s sem conta', restante(t), '07:59:56')

  const t2 = novaSessao()
  t2.sincronizar(0) // sonda atrasada: sem conta, o servidor diz zero
  t2.definirHorasDoDia(8)
  t2.definirConta('gabrielluxpanhard@gmail.com')
  checar('após restart o gasto sem dono é adotado', restante(t2), '07:59:56')
}

console.log()
console.log('--- 4. sonda atrasada no meio da rodada NÃO devolve a hora ---')
{
  memoria.clear()
  const t = novaSessao()
  t.definirConta('gabrielluxpanhard@gmail.com')
  t.definirHorasDoDia(8)
  t.sincronizar(240) // usou 4 min
  t.sincronizar(0) // a sonda rodou com a rodada no ar
  checar('sincronizar(0) não zera', restante(t), '07:56:00')
}

console.log()
console.log('--- 5. trocar de conta continua separado (não regride) ---')
{
  memoria.clear()
  const t = novaSessao()
  t.definirHorasDoDia(8)
  t.definirConta('uma@pessoa.com')
  await quatroTiques(t)
  checar('conta A com 4 s', restante(t), '07:59:56')

  t.definirConta('outra@pessoa.com') // troca de verdade
  checar('conta B vê o dela (zero)', restante(t), '08:00:00')
  t.definirConta('uma@pessoa.com') // volta
  checar('conta A reencontra os 4 s', restante(t), '07:59:56')
}

console.log()
console.log('--- 6. turno longo: leitura atrasada do servidor NÃO devolve a hora ---')
{
  memoria.clear()
  const EMAIL = 'gabrielluxpanhard@gmail.com'
  const t = novaSessao()
  t.definirConta(EMAIL)
  t.definirHorasDoDia(8)
  t.sincronizar(7200) // o painel sabe de 2 h gastas
  checar('2 h gastas = 6 h na aba', restante(t), '06:00:00')
  // A sonda de uso roda no meio da rodada: o painel ainda não gravou a resposta em curso
  // e devolve um número menor. A aba NÃO pode pular para perto de 7 h.
  t.sincronizar(3600)
  checar('leitura atrasada não sobe o restante', restante(t), '06:00:00')
  t.sincronizar(0) // e nem uma consulta que tropeçou
  checar('uso zerado não sobe o restante', restante(t), '06:00:00')
  t.ligar(true)
  await new Promise((r) => setTimeout(r, 2200)) // 2 s da rodada em curso
  t.ligar(false)
  t.sincronizar(7202) // a rodada fechou: o painel finalmente sabe
  checar('a verdade volta quando a rodada fecha', restante(t), '05:59:58')
}

console.log()
console.log('--- 7. reload com o gasto dividido entre as chaves ---')
{
  memoria.clear()
  const EMAIL = 'gabrielluxpanhard@gmail.com'
  const t = novaSessao()
  t.definirHorasDoDia(8)
  t.sincronizar(3600) // 1 h contada antes de a conta ser conhecida
  t.definirConta(EMAIL) // a conta chega e adota
  t.sincronizar(7200) // o painel já sabe das 2 h
  checar('sessão 1 com 2 h', restante(t), '06:00:00')

  const t2 = novaSessao() // reload
  t2.sincronizar(7200) // a sonda de uso do mount
  t2.definirHorasDoDia(8)
  t2.definirConta(EMAIL)
  checar('reload recupera as 2 h', restante(t2), '06:00:00')
}

console.log()
console.log('--- 8. virada da meia-noite com o app aberto ---')
{
  memoria.clear()
  const EMAIL = 'gabrielluxpanhard@gmail.com'
  const DataReal = globalThis.Date
  // Um relógio de mentira: o módulo lê `new Date()` para saber o dia.
  const comData = (iso, fn) => {
    class DataFalsa extends DataReal {
      constructor(...args) {
        super(...(args.length ? args : [iso]))
      }
      static now() {
        return new DataReal(iso).getTime()
      }
    }
    globalThis.Date = DataFalsa
    try {
      return fn()
    } finally {
      globalThis.Date = DataReal
    }
  }

  comData('2026-10-10T23:30:00', () => {
    const t = novaSessao()
    t.definirConta(EMAIL)
    t.definirHorasDoDia(8)
    t.sincronizar(7200)
    checar('ontem Gastou 2 h', restante(t), '06:00:00')
    comData('2026-10-11T00:00:30', () => {
      t.sincronizar(4.631) // o dia virou e o servidor tem 4,6 s de hoje
      checar('meia-noite zera o dia anterior', restante(t), '07:59:56')
    })
  })
}

if (falhas.length) {
  console.log(`RESULTADO: ${falhas.length} falha(s): ${falhas.join('; ')}`)
  process.exit(1)
}
console.log('RESULTADO: o relógio sobrevive ao restart e ao turno longo em todos os caminhos')
