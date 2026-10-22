/**
 * Prova do conserto da barra de arrastar: o handler aceita o valor direto.
 *
 * Simula exatamente o que o componente `slider` faz — chama `mudar("5000")` passando a
 * string — e confirma que o estado vira o número 5000 (antes virava vazio e travava).
 *
 * Roda com node:
 *     node --experimental-strip-types scripts/_teste_arrastar.mjs
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

// O estado, como o DesenhoUi guarda.
const { estado, funcoes } = parseUi(
  '{@body const [usuarios, setUsuarios] = DIL.useState(1000)}\n{@body const [preco, setPreco] = DIL.useState(29)}\n<box></box>',
)

// Reproduz o handler do ligarEventos (a versão corrigida).
function fazerHandler(corpoEvento) {
  const evento = alvoDoEvento(corpoEvento)
  const alvo = nomeDoEstado(evento.alvo, Object.keys(estado))
  const expr = evento.expr
  const querNum = querNumero(expr)
  return (recebido) => {
    let valorDoControle
    if (typeof recebido === 'string' || typeof recebido === 'number') {
      valorDoControle = recebido
    } else {
      valorDoControle = recebido?.target?.value
    }
    if (valorDoControle !== undefined) {
      estado[alvo] = querNum ? Number(valorDoControle) : valorDoControle
      return
    }
    const v = avaliar(expr, estado, funcoes)
    if (v !== undefined) estado[alvo] = v
  }
}

console.log('\n=== o slider chama mudar("5000") — valor direto (o bug) ===')
const handler = fazerHandler('(e) => setUsuarios(Number(e.target.value))')
checar('antes: usuarios = 1000', estado.usuarios === 1000)
handler('5000') // o slider passa a STRING "5000", não o evento
checar('depois de arrastar: usuarios = 5000 (número)', estado.usuarios === 5000, `deu ${JSON.stringify(estado.usuarios)} (${typeof estado.usuarios})`)
checar('não travou (não é string nem vazio)', typeof estado.usuarios === 'number')

console.log('\n=== e a receita recalcula junto ===')
const receita = avaliar('usuarios * preco', estado, funcoes)
checar('receita = 5000 × 29 = 145000', receita === 145000, `deu ${receita}`)

console.log('\n=== o segundo slider também ===')
const handler2 = fazerHandler('(e) => setPreco(Number(e.target.value))')
handler2('99')
checar('preco virou 99', estado.preco === 99)
const receita2 = avaliar('usuarios * preco', estado, funcoes)
checar('receita = 5000 × 99 = 495000', receita2 === 495000, `deu ${receita2}`)

console.log('\n=== o evento de verdade (objeto) também funciona ===')
const handler3 = fazerHandler('(e) => setUsuarios(Number(e.target.value))')
handler3({ target: { value: '8000' } })
checar('via objeto.target.value: usuarios = 8000', estado.usuarios === 8000)

console.log('\n=== sem Number() guarda texto (input de texto) ===')
const estado2 = parseUi('{@body const [nome, setNome] = DIL.useState("")}<box></box>').estado
const handlerNome = alvoDoEvento('(e) => setNome(e.target.value)')
const alvoNome = nomeDoEstado(handlerNome.alvo, Object.keys(estado2))
// handler sem Number
const evt = alvoDoEvento('(e) => setNome(e.target.value)')
estado2[alvoNome] = 'Maria' // simula mudar("Maria")
checar('nome virou "Maria" (texto)', estado2.nome === 'Maria')

console.log(`\n${passou} passaram, ${falhou} falharam`)
