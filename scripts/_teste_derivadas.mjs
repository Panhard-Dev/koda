/**
 * O simulador NOVO do print: constantes derivadas (receita, assinantes) recalculam.
 *
 * Roda com node:
 *     node --experimental-strip-types scripts/_teste_derivadas.mjs
 */
import { parseUi } from '../src/components/UiGenerativa/parser.ts'
import { avaliar } from '../src/components/UiGenerativa/avaliador.ts'
import { alvoDoEvento, nomeDoEstado, querNumero } from '../src/components/UiGenerativa/eventos.ts'

let passou = 0
let falhou = 0
const checar = (nome, cond, extra = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${nome}${extra ? ' — ' + extra : ''}`)
  cond ? passou++ : falhou++
}
// O bloco real (tirado do banco), com as constantes derivadas.
const FONTE = [
  '{@body const [usuarios, setUsuarios] = DIL.useState(5000)}',
  '{@body const [preco, setPreco] = DIL.useState(49)}',
  '{@body const [conversao, setConversao] = DIL.useState(3)}',
  '{@body const assinantes = usuarios * conversao / 100}',
  '{@body const receita = assinantes * preco}',
  '<stat rotulo="Assinantes" valor={assinantes.toFixed(0)} variacao={conversao + "% da base"} />',
  '<stat rotulo="Receita mensal" valor={"R$ " + receita.toFixed(2)} variacao="recorrente" />',
].join('\n')

const { estado, funcoes } = parseUi(FONTE)

console.log('\n=== estados ===')
checar('usuarios = 5000', estado.usuarios === 5000)
checar('preco = 49', estado.preco === 49)
checar('conversao = 3', estado.conversao === 3)

console.log('\n=== constantes derivadas recalculam com o estado ===')
checar('assinantes virou função derivada', typeof funcoes.assinantes === 'function')
checar('receita virou função derivada', typeof funcoes.receita === 'function')
const assin = funcoes.assinantes(estado)
checar('assinantes = 5000×3/100 = 150', assin === 150, `deu ${assin}`)
const receita = funcoes.receita(estado)
checar('receita = 150×49 = 7350', receita === 7350, `deu ${receita}`)

console.log('\n=== o stat que mostrava R$ 0 agora calcula ===')
const statReceita = avaliar('"R$ " + receita.toFixed(2)', estado, funcoes)
checar('stat receita = "R$ 7350.00"', statReceita === 'R$ 7350.00', `deu "${statReceita}"`)
const statAssin = avaliar('assinantes.toFixed(0)', estado, funcoes)
checar('stat assinantes = "150"', statAssin === '150', `deu "${statAssin}"`)

console.log('\n=== quando o slider mexe, as derivadas recalculam ===')
// simula arrastar usuarios pra 26600 (o valor do print)
const estadoMovido = { ...estado, usuarios: 26600 }
const receitaMovida = funcoes.receita(estadoMovido)
// 26600 × 3/100 × 49 = 39102
checar('usuarios 26600 → receita 39102', receitaMovida === 39102, `deu ${receitaMovida}`)
const statReceitaMovida = avaliar('"R$ " + receita.toFixed(2)', estadoMovido, funcoes)
checar('stat receita = "R$ 39102.00"', statReceitaMovida === 'R$ 39102.00', `deu "${statReceitaMovida}"`)

// mexe preco também
const estadoMovido2 = { ...estadoMovido, preco: 354 }
const receitaMovida2 = funcoes.receita(estadoMovido2)
checar('preco 354 → receita 26600×0.03×354', receitaMovida2 === Math.round(26600 * 0.03 * 354), `deu ${receitaMovida2}`)

console.log(`\n${passou} passaram, ${falhou} falharam`)
