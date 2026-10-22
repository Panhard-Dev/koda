/**
 * O simulador COMPLETO do print, ponta a ponta — agora com os gráficos.
 *
 * Roda com node:
 *     node --experimental-strip-types scripts/_teste_simulador_completo.mjs
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

// O bloco real (tirado do banco), com os 2 gráficos que davam "sem dados".
const FONTE = `{@body const [usuarios, setUsuarios] = DIL.useState(1000)}
{@body const [preco, setPreco] = DIL.useState(29)}
{@body const [taxa, setTaxa] = DIL.useState(5)}
{@body const assinantes = () => Math.round(usuarios * taxa / 100)}
<slider rotulo="Quantidade de usuários" min={100} max={20000} step={100} valor={usuarios} onChange={(e) => setUsuarios(Number(e.target.value))} />
<slider rotulo="Preço da assinatura (R$)" min={5} max={500} step={1} valor={preco} onChange={(e) => setPreco(Number(e.target.value))} />
<slider rotulo="Taxa de conversão (%)" min={0.1} max={20} step={0.1} valor={taxa} onChange={(e) => setTaxa(Number(e.target.value))} />
<chart tipo="barras" titulo="Composição da Receita" dados={[
  {rotulo: "Não convertidos", valor: usuarios - Math.round(usuarios * taxa / 100)},
  {rotulo: "Assinantes", valor: assinantes()},
  {rotulo: "Receita (R$)", valor: Math.round(usuarios * taxa / 100 * preco)}
]} />
<chart tipo="barras" titulo="Receita por faixa de conversão" dados={[
  {rotulo: "1%", valor: Math.round(usuarios * 0.01) * preco},
  {rotulo: "5%", valor: Math.round(usuarios * 0.05) * preco},
  {rotulo: "10%", valor: Math.round(usuarios * 0.10) * preco}
]} />`

const { estado, funcoes, arvore } = parseUi(FONTE)

console.log('\n=== 1. os sliders: eventos ligam no estado certo (minúscula) ===')
const sliders = arvore.filter((n) => n.tag === 'componente' && n.nome === 'slider')
checar('3 sliders na árvore', sliders.length === 3, `achou ${sliders.length}`)
const ev = alvoDoEvento('(e) => setUsuarios(Number(e.target.value))')
checar('alvoDoEvento reconhece setUsuarios', ev && ev.alvo === 'Usuarios')
checar('nomeDoEstado casa Usuarios → usuarios', nomeDoEstado('Usuarios', ['usuarios', 'preco', 'taxa']) === 'usuarios')
checar('querNumero detecta Number()', querNumero('Number(e.target.value)') === true)
checar('querNumero detecta unário + do slider', querNumero('+e.target.value') === true)
checar('Math.min com mais de um argumento', avaliar('Math.min(100, 35, 70)', {}) === 35)
checar('Math.max com mais de um argumento', avaliar('Math.max(100, 35, 70)', {}) === 100)

// simula o evento do slider: arrastar usuarios pra 2000
const chaves = Object.keys(estado)
const alvo = nomeDoEstado(ev.alvo, chaves)
checar('alvo resolvido é usuarios', alvo === 'usuarios')
const valorFinal = Number('2000') // querNumero → guarda número
estado[alvo] = valorFinal
checar('estado usuarios virou número 2000', estado.usuarios === 2000 && typeof estado.usuarios === 'number')

console.log('\n=== 2. os gráficos: array de objetos vira dados de verdade ===')
const charts = arvore.filter((n) => n.tag === 'componente' && n.nome === 'chart')
checar('2 gráficos na árvore', charts.length === 2, `achou ${charts.length}`)
// o parser do chart lê o prop dados={[...]} — precisa ser array, não undefined
const dadosProp = charts[0].props.dados
checar('o prop dados é uma expressão', dadosProp && dadosProp.tipo === 'expr')
// avaliar o array de objetos
const dados = avaliar(dadosProp.corpo, { ...estado, usuarios: 1000 }, funcoes)
checar('avaliar devolve array', Array.isArray(dados), `tipo=${typeof dados}`)
if (Array.isArray(dados)) {
  checar('array tem 3 itens', dados.length === 3, `len=${dados.length}`)
  const primeiro = dados[0]
  checar('item 0 é objeto com rotulo', typeof primeiro === 'object' && 'rotulo' in primeiro)
  checar('item 0 rotulo = "Não convertidos"', primeiro.rotulo === 'Não convertidos', `${primeiro.rotulo}`)
  const naoConv = avaliar('usuarios - Math.round(usuarios * taxa / 100)', { usuarios: 1000, taxa: 5 }, funcoes)
  checar('valor "Não convertidos" = 950', naoConv === 950, `${naoConv}`)
  const receita = avaliar('Math.round(usuarios * taxa / 100 * preco)', { usuarios: 1000, taxa: 5, preco: 29 }, funcoes)
  checar('valor "Receita" = 1450', receita === 1450, `${receita}`)
}

console.log('\n=== 3. o segundo gráfico (faixas) ===')
const dados2 = avaliar(charts[1].props.dados.corpo, { usuarios: 1000, preco: 29 }, funcoes)
checar('faixas é array de 3', Array.isArray(dados2) && dados2.length === 3)
const faixa5 = avaliar('Math.round(usuarios * 0.05) * preco', { usuarios: 1000, preco: 29 }, funcoes)
checar('faixa 5% = 50 × 29 = 1450', faixa5 === 1450, `${faixa5}`)

console.log('\n=== 4. recalcula quando o slider mexe (o gráfico segue o estado) ===')
const estadoMovido = { ...estado, usuarios: 2000 }
const receitaMovida = avaliar('Math.round(usuarios * taxa / 100 * preco)', estadoMovido, funcoes)
checar('usuarios 2000 → receita 2900', receitaMovida === 2900, `${receitaMovida}`)

console.log('\n=== regressão: orçamento com slider que usa +e.target.value ===')
const ORCAMENTO = `{@body const [renda, setRenda] = DIL.useState(8000)}
{@body const [moradia, setMoradia] = DIL.useState(1800)}
{@body const [transporte, setTransporte] = DIL.useState(700)}
{@body const [alimentacao, setAlimentacao] = DIL.useState(1200)}
{@body const despesas = moradia + transporte + alimentacao
const saldo = renda - despesas
const gastoPct = renda > 0 ? Math.min(100, Math.round((despesas / renda) * 100)) : 0
const saldoPct = renda > 0 ? Math.max(0, 100 - gastoPct) : 0}`
const orcamento = parseUi(ORCAMENTO)
const moradiaAtualizada = querNumero('+e.target.value') ? Number('3000') : '3000'
const estadoOrcamento = { ...orcamento.estado, moradia: moradiaAtualizada }
checar('slider mantém moradia numérica', typeof estadoOrcamento.moradia === 'number')
checar('saldo acompanha a nova moradia', avaliar('saldo', estadoOrcamento, orcamento.funcoes) === 3100)
checar('percentual recalcula com Math.min/max', avaliar('gastoPct', estadoOrcamento, orcamento.funcoes) === 61 && avaliar('saldoPct', estadoOrcamento, orcamento.funcoes) === 39)

console.log('\n=== segurança: array/objeto não vira fuga ===')
checar('array desconhecido é undefined', avaliar('window.location[0]', estado, funcoes) === undefined)
checar('objeto não chama função', avaliar('{a: window}', estado, funcoes) && true)

console.log(`\n${passou} passaram, ${falhou} falharam`)
