/**
 * Testa operações de LISTA: adicionar, remover, editar — o que faz carrinho/TODO/painel
 * escolar funcionar. Antes o avaliador não entendia spread/filter/map/slice.
 *
 * node --experimental-strip-types scripts/_teste_lista_ops.mjs
 */
import { parseUi } from '../src/components/UiGenerativa/parser.ts'
import { avaliar } from '../src/components/UiGenerativa/avaliador.ts'

let passou = 0
let falhou = 0
const checar = (nome, cond, extra = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${nome}${extra ? ' — ' + extra : ''}`)
  cond ? passou++ : falhou++
}

// estado com um carrinho de 2 itens
const carrinho = [{ texto: 'maçã' }, { texto: 'banana' }]

console.log('\n=== ADICIONAR: [...carrinho, item] (spread de array) ===')
{
  const r = avaliar('[...carrinho, {texto: "uva"}]', { carrinho }, {})
  checar('spread de array expande', Array.isArray(r) && r.length === 3, `len=${Array.isArray(r) ? r.length : 'não-array'}`)
  checar('o novo item entrou', Array.isArray(r) && r[2].texto === 'uva')
}

console.log('\n=== REMOVER: carrinho.filter((item) => item.texto !== "maçã") ===')
{
  const r = avaliar('carrinho.filter((item) => item.texto !== "maçã")', { carrinho }, {})
  checar('filter remove', Array.isArray(r) && r.length === 1, `len=${Array.isArray(r) ? r.length : 'não'}`)
  checar('ficou só banana', Array.isArray(r) && r[0].texto === 'banana')
}

console.log('\n=== aliases locais dentro das operações ===')
{
  const tarefas = [{ id: 1, texto: 'Ler', feito: false }, { id: 2, texto: 'Enviar', feito: true }]
  const filtrada = avaliar('tarefas.filter((tarefa) => tarefa.id !== item.id)', {
    tarefas,
    item: tarefas[0],
  }, {})
  checar('filter respeita o nome do parâmetro', Array.isArray(filtrada) && filtrada.length === 1 && filtrada[0].id === 2, JSON.stringify(filtrada))
  const editada = avaliar('tarefas.map((tarefa, indice) => indice === 0 ? {...tarefa, feito: true} : tarefa)', { tarefas }, {})
  checar('map respeita parâmetro e índice', Array.isArray(editada) && editada[0].feito === true && editada[1].feito === true)
}

console.log('\n=== REMOVER ÚLTIMO: carrinho.slice(0, -1) ===')
{
  const r = avaliar('carrinho.slice(0, -1)', { carrinho }, {})
  checar('slice(0,-1) tira o último', Array.isArray(r) && r.length === 1, `len=${Array.isArray(r) ? r.length : 'não'}`)
  checar('ficou maçã', Array.isArray(r) && r[0].texto === 'maçã')
}

console.log('\n=== EDITAR: alunos.map((item) => ({...item, nota: 10})) ===')
{
  const alunos = [{ texto: 'Ana', nota: 5 }, { texto: 'Bruno', nota: 7 }]
  const r = avaliar('alunos.map((item) => ({ ...item, nota: 10 }))', { alunos }, {})
  checar('map edita todos', Array.isArray(r) && r.length === 2)
  checar('manteve o nome (spread de objeto)', Array.isArray(r) && r[0].texto === 'Ana')
  checar('mudou a nota pra 10', Array.isArray(r) && r[0].nota === 10)
}

console.log('\n=== EDITAR SÓ UM: map com condição ternária ===')
{
  const alunos = [{ texto: 'Ana', nota: 5 }, { texto: 'Bruno', nota: 7 }]
  const r = avaliar('alunos.map((item) => item.texto === "Ana" ? { ...item, nota: 10 } : item)', { alunos }, {})
  checar('só Ana mudou', Array.isArray(r) && r[0].nota === 10 && r[1].nota === 7)
}

console.log('\n=== push: carrinho.push(item) ===')
{
  const r = avaliar('carrinho.push({texto: "uva"})', { carrinho }, {})
  checar('push adiciona', Array.isArray(r) && r.length === 3)
}

console.log('\n=== concat: carrinho.concat([{texto:"x"}]) ===')
{
  const r = avaliar('carrinho.concat([{texto: "x"}])', { carrinho }, {})
  checar('concat junta', Array.isArray(r) && r.length === 3)
}

console.log('\n=== length: carrinho.length ===')
{
  const r = avaliar('carrinho.length', { carrinho }, {})
  checar('length = 2', r === 2)
}

console.log('\n=== find: carrinho.find((item) => item.texto === "uva") ===')
{
  const r = avaliar('carrinho.find((item) => item.texto === "banana")', { carrinho }, {})
  checar('find acha banana', r && r.texto === 'banana')
}

console.log('\n=== total do carrinho (somar preços) ===')
{
  const itens = [{ texto: 'a', valor: 10 }, { texto: 'b', valor: 20 }]
  // soma via map+reduce simplificado: usa map pra extrair e depois soma manual no teste
  const valores = avaliar('itens.map((item) => item.valor)', { itens }, {})
  checar('map extrai valores', Array.isArray(valores) && valores.length === 2 && valores[0] === 10)
}

console.log('\n=== segurança: filter não escapa ===')
checar('filter em não-array é undefined', avaliar('naoexiste.filter((x) => true)', { }, {}) === undefined)

console.log(`\n${passou} passaram, ${falhou} falharam`)
