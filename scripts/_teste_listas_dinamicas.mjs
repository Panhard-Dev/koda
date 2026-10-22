/**
 * A lista dinâmica e as ações de lista — as duas lacunas que faltavam.
 *
 * Roda com node:
 *     node --experimental-strip-types scripts/_teste_listas_dinamicas.mjs
 */

import { parseUi } from '../src/components/UiGenerativa/parser.ts'
import { avaliar } from '../src/components/UiGenerativa/avaliador.ts'

let passou = 0
let falhou = 0
const checar = (nome, cond) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${nome}`)
  cond ? passou++ : falhou++
}

console.log('\n=== useList extrai um array do estado ===')
const LISTA = `{@body const [perguntas, setPerguntas] = DIL.useList(["Quanto é 5+5?", "Capital do Brasil?", "Maior estado?"])}
<box padding={3}>
  <title>Quiz</title>
  <repeat itens={perguntas} />
</box>`
const l = parseUi(LISTA)
checar('estado extraiu uma lista', Array.isArray(l.estado.perguntas))
checar('a lista tem 3 itens', l.estado.perguntas.length === 3)
checar('item 1 é o texto certo', l.estado.perguntas[0].texto === 'Quanto é 5+5?')
checar('tem o <repeat> na árvore', l.arvore[0].filhos.some((f) => f.nome === 'repeat'))

console.log('\n=== {lista.length} conta os itens ===')
checar('length conta', avaliar('perguntas.length', l.estado) === 3)
checar('length em expressão', avaliar('"Total: " + perguntas.length', l.estado) === 'Total: 3')

console.log('\n=== lista vazia e lista com 1 ===')
const vazia = parseUi('{@body const [x, setX] = DIL.useList([])}<box></box>')
checar('useList([]) dá array vazio', Array.isArray(vazia.estado.x) && vazia.estado.x.length === 0)
const um = parseUi('{@body const [x, setX] = DIL.useList(["só um"])}<box></box>')
checar('useList com 1 item', um.estado.x.length === 1)

console.log('\n=== itens com campos e linha repetida ===')
const OBJETOS = `{@body const [tarefas, setTarefas] = DIL.useList([{id: 1, texto: "Ler, revisar", feito: false}, {id: 2, texto: "Enviar", feito: true}])}
<repeat itens={tarefas} item="tarefa" indice="i"><texto valor={tarefa.texto} /></repeat>`
const o = parseUi(OBJETOS)
checar('useList preserva objetos', o.estado.tarefas[0].id === 1 && o.estado.tarefas[0].feito === false)
checar('vírgula no texto não divide o objeto', o.estado.tarefas[0].texto === 'Ler, revisar')
const repetir = o.arvore[0]
checar('repeat recebe nome local do item', repetir.props.item?.tipo === 'literal' && repetir.props.item.valor === 'tarefa')
checar('filho pode referenciar campo da linha', repetir.filhos[0].props.valor?.corpo === 'tarefa.texto')
checar(
  'campo da linha resolve para o objeto atual',
  avaliar(repetir.filhos[0].props.valor.corpo, { ...o.estado, tarefa: o.estado.tarefas[0] }) === 'Ler, revisar',
)

console.log('\n=== estado + lista juntos (dashboard completo) ===')
const COMPLETO = `{@body const [usuarios, setUsuarios] = DIL.useState(1000)}
{@body const [tarefas, setTarefas] = DIL.useList(["Ler", "Escrever", "Revisar"])}
<box padding={3}>
  <stat rotulo="Usuários" valor={usuarios} />
  <title>{"Tarefas: " + tarefas.length}</title>
  <repeat itens={tarefas} />
</box>`
const c = parseUi(COMPLETO)
checar('tem o estado numérico', c.estado.usuarios === 1000)
checar('tem a lista', Array.isArray(c.estado.tarefas) && c.estado.tarefas.length === 3)
checar('os dois coexistem', Object.keys(c.estado).length === 2)
checar('expressão mistura estado e lista', avaliar('usuarios * tarefas.length', c.estado) === 3000)

console.log('\n=== segurança: lista não vira vetor de fuga ===')
checar('length de lista desconhecida é undefined', avaliar('outra.length', c.estado) === undefined)
checar('lista em expressão devolve a lista (não executa)', typeof avaliar('tarefas', c.estado) === 'object')

console.log(`\n${passou} passaram, ${falhou} falharam`)
process.exit(falhou ? 1 : 0)
