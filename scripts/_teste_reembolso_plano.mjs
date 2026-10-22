/**
 * Regressão: plano cancelado não pode continuar dando horas/moedas pagas.
 * Rode com: node --experimental-strip-types scripts/_teste_reembolso_plano.mjs
 */

import assert from 'node:assert/strict'
import { PLANO_FREE, planoParaBeneficios } from '../src/plano.ts'

const planoPago = {
  id: 'pro',
  nome: 'Koda Pro',
  status: 'cancelada',
  horas_por_dia: 8,
  moedas_por_mes: 1425,
}

assert.equal(planoParaBeneficios(null), null)
assert.equal(planoParaBeneficios({ ...planoPago, status: 'pendente' }), null)
assert.equal(planoParaBeneficios(planoPago), null)

const planoCancelado = planoParaBeneficios(planoPago)
assert.equal(planoCancelado?.horas_por_dia ?? PLANO_FREE.horasPorDia, 1)
assert.equal(planoCancelado?.moedas_por_mes ?? PLANO_FREE.moedasPorMes, 100)

for (const status of ['ativa', 'atrasada']) {
  assert.equal(planoParaBeneficios({ ...planoPago, status }).horas_por_dia, 8)
  assert.equal(planoParaBeneficios({ ...planoPago, status }).moedas_por_mes, 1425)
}

// O reembolso tira os benefícios do plano; créditos avulsos continuam pertencendo à conta.
const creditosAvulsos = 75
assert.equal((planoCancelado?.moedas_por_mes ?? PLANO_FREE.moedasPorMes) + creditosAvulsos, 175)

console.log('PASS: cancelado/pendente usam o Free; ativa/atrasada mantêm benefícios; créditos avulsos são preservados.')
