/**
 * Prova do motor de UI generativa: parser + avaliador, sem React.
 *
 * Roda com node (transpila o TS na hora):
 *     node --experimental-strip-types scripts/_teste_ui_generativa.mjs
 */

import { readFileSync } from 'node:fs'
import { avaliar } from '../src/components/UiGenerativa/avaliador.ts'
import { parseUi } from '../src/components/UiGenerativa/parser.ts'

let passou = 0
let falhou = 0
const checar = (nome, cond) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${nome}`)
  cond ? passou++ : falhou++
}

console.log('\n=== avaliador (a lógica sem eval) ===')
const est = { count: 5, usuarios: 1000, preco: 29 }
checar('soma', avaliar('count + 1', est) === 6)
checar('multiplicação', avaliar('usuarios * preco', est) === 29000)
checar('concatena string', avaliar('"R$ " + usuarios * preco', est) === 'R$ 29000')
checar('comparação >=', avaliar('count >= 7', est) === false)
checar('comparação >', avaliar('count > 4', est) === true)
checar('toFixed', avaliar('preco.toFixed(2)', est) === '29.00')
checar('parênteses', avaliar('(count + 1) * 2', est) === 12)
checar('identificador desconhecido vira undefined (não fuga)', avaliar('window.location', est) === undefined)
checar('não acessa eval/fetch', avaliar('eval("1")', est) === undefined)

console.log('\n=== parser (o contador do dono) ===')
const CONTADOR = `{@body const [count, setCount] = DIL.useState(0)}
<box padding={3}>
  <title>{count}</title>
  <button onClick={() => setCount(count + 1)}>
    Aumentar
  </button>
</box>`

const { estado, arvore } = parseUi(CONTADOR)
checar('estado extraiu count = 0', estado.count === 0)
checar('árvore tem 1 nó (o box)', arvore.length === 1)
checar('o box tem filhos (title + button)', arvore[0].filhos.length === 2)
checar('o button tem onClick com setCount', JSON.stringify(arvore[0].filhos[1]).includes('setCount'))

console.log('\n=== parser (o quiz da foto, JSON com perguntas) ===')
// O quiz da foto é JSON puro; a IA manda como bloco koda-visual (já funciona).
// Aqui provamos que o koda-ui também monta estrutura aninhada.
const QUIZ_UI = `<box padding={3}>
  <title>Aula de JavaScript</title>
  <box>Quanto é 5 + 5?</box>
  <button>8</button>
  <button onClick={() => setResp(10)}>10</button>
</box>`
const q = parseUi(QUIZ_UI)
checar('quiz-ui tem box externo', q.arvore[0].tag === 'componente')
checar('quiz-ui aninhou os botões', q.arvore[0].filhos.length === 4)

console.log('\n=== parser (o simulador da foto) ===')
const SIM = `{@body const [usuarios, setUsuarios] = DIL.useState(1000)}
{@body const [preco, setPreco] = DIL.useState(29)}
<box padding={3}>
  <title>Simulador de receita</title>
  <slider rotulo="Usuários mensais" valor={usuarios} min={0} max={5000} onChange={(e) => setUsuarios(e.target.value)} />
  <title>{"R$ " + usuarios * preco}</title>
</box>`
const s = parseUi(SIM)
checar('simulador extraiu 2 estados', Object.keys(s.estado).length === 2)
checar('usuarios = 1000', s.estado.usuarios === 1000)
checar('preco = 29', s.estado.preco === 29)
checar('tem slider', s.arvore[0].filhos.some((f) => f.tag === 'componente' && f.nome === 'slider'))

console.log('\n=== segurança: entrada podre não trava ===')
checar('tag não fechada não lança', (() => { try { parseUi('<box>sem fim'); return true } catch { return false } })())
checar('lixo não lança', (() => { try { parseUi('(((({{{}}}'); return true } catch { return false } })())
checar('vazio dá vazio', parseUi('').arvore.length === 0)

console.log(`\n${passou} passaram, ${falhou} falharam`)
process.exit(falhou ? 1 : 0)
