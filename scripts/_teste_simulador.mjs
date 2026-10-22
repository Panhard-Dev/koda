/**
 * O simulador do print, ponta a ponta: sliders mexem, stats calculam.
 *
 * Roda com node:
 *     node --experimental-strip-types scripts/_teste_simulador.mjs
 */

import { parseUi } from '../src/components/UiGenerativa/parser.ts'
import { avaliar } from '../src/components/UiGenerativa/avaliador.ts'

let passou = 0
let falhou = 0
const checar = (nome, cond, extra = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${nome}${extra ? ' — ' + extra : ''}`)
  cond ? passou++ : falhou++
}

// O bloco que a IA mandou de verdade (tirado do banco), simplificado pro essencial:
// 3 sliders + a função assinantes() + os 3 stats com toLocaleString.
const FONTE = `{@body const [usuarios, setUsuarios] = DIL.useState(1000)}
{@body const [preco, setPreco] = DIL.useState(29)}
{@body const [taxa, setTaxa] = DIL.useState(5)}
{@body const assinantes = () => Math.round(usuarios * taxa / 100)}
<stat rotulo="Total" valor={Math.round(usuarios * taxa / 100).toLocaleString('pt-BR')} />
<stat rotulo="Total" valor={"R$ " + (usuarios * taxa / 100 * preco).toLocaleString('pt-BR', {minimumFractionDigits: 2, maximumFractionDigits: 2})} />
<stat rotulo="12 meses" valor={"R$ " + (assinantes() * preco * 12).toLocaleString('pt-BR', {minimumFractionDigits: 2, maximumFractionDigits: 2})} />`

const { estado, funcoes } = parseUi(FONTE)

console.log('\n=== estados extraídos ===')
checar('usuarios = 1000', estado.usuarios === 1000)
checar('preco = 29', estado.preco === 29)
checar('taxa = 5', estado.taxa === 5)
checar('função assinantes foi declarada', typeof funcoes.assinantes === 'function')

console.log('\n=== a função assinantes() calcula com o estado ===')
checar('assinantes(1000,5%) = 50', funcoes.assinantes(estado) === 50, `deu ${funcoes.assinantes(estado)}`)

console.log('\n=== Math.round + toLocaleString (o que tava R$ 0) ===')
const assinantes = avaliar('Math.round(usuarios * taxa / 100)', estado, funcoes)
checar('Math.round(usuarios*taxa/100) = 50', assinantes === 50, `deu ${assinantes}`)
const formatado = avaliar('Math.round(usuarios * taxa / 100).toLocaleString("pt-BR")', estado, funcoes)
checar('formatado pt-BR = "50"', formatado === '50', `deu "${formatado}"`)

console.log('\n=== receita mensal (o stat que mostrava R$ 0) ===')
const mensal = avaliar('"R$ " + (usuarios * taxa / 100 * preco).toLocaleString("pt-BR", {minimumFractionDigits: 2, maximumFractionDigits: 2})', estado, funcoes)
checar('receita mensal = "R$ 1.450,00"', mensal === 'R$ 1.450,00', `deu "${mensal}"`)

console.log('\n=== receita anual, com a função assinantes() dentro ===')
const anual = avaliar('"R$ " + (assinantes() * preco * 12).toLocaleString("pt-BR", {minimumFractionDigits: 2, maximumFractionDigits: 2})', estado, funcoes)
checar('receita anual = "R$ 17.400,00"', anual === 'R$ 17.400,00', `deu "${anual}"`)

console.log('\n=== e quando o slider muda o estado, tudo recalcula ===')
const estado2 = { ...estado, usuarios: 2000 }
const mensal2 = avaliar('"R$ " + (usuarios * taxa / 100 * preco).toLocaleString("pt-BR", {minimumFractionDigits: 2, maximumFractionDigits: 2})', estado2, funcoes)
checar('usuarios 2000 → receita mensal "R$ 2.900,00"', mensal2 === 'R$ 2.900,00', `deu "${mensal2}"`)
const anual2 = avaliar('"R$ " + (assinantes() * preco * 12).toLocaleString("pt-BR", {minimumFractionDigits: 2, maximumFractionDigits: 2})', estado2, funcoes)
checar('usuarios 2000 → anual "R$ 34.800,00"', anual2 === 'R$ 34.800,00', `deu "${anual2}"`)

console.log('\n=== ternário (outra coisa que a IA usa) ===')
checar('cond ? a : b verdadeiro', avaliar('nota >= 7 ? "aprovado" : "reprovado"', { nota: 8 }) === 'aprovado')
checar('cond ? a : b falso', avaliar('nota >= 7 ? "aprovado" : "reprovado"', { nota: 5 }) === 'reprovado')

console.log('\n=== segurança: função não declarada não escapa ===')
checar('função inexistente é undefined', avaliar('window.location()', estado, funcoes) === undefined)
checar('eval não escapa', avaliar('eval("1")', estado, funcoes) === undefined)

console.log(`\n${passou} passaram, ${falhou} falharam`)
