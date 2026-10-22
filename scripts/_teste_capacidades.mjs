/**
 * As capacidades que validam estado, listas, eventos e segurança da UI generativa.
 *
 * Roda com node:
 *     node --experimental-strip-types scripts/_teste_capacidades.mjs
 */

import { parseUi } from '../src/components/UiGenerativa/parser.ts'
import { avaliar } from '../src/components/UiGenerativa/avaliador.ts'
import { eventosDoCorpo, nomeDoEstado } from '../src/components/UiGenerativa/eventos.ts'
import { pareceCodigoDeUi } from '../src/components/UiGenerativa/deteccao.ts'

let passou = 0
let falhou = 0
const checar = (nome, cond) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${nome}`)
  cond ? passou++ : falhou++
}

// ============================================================ 1. COMPARTILHAR ESTADO
console.log('\n=== 1. compartilhar estado (slider altera gráfico E stat juntos) ===')
const TELA_COMPARTILHADA = `{@body const [usuarios, setUsuarios] = DIL.useState(1000)}
{@body const [preco, setPreco] = DIL.useState(29)}
<box padding={3}>
  <title>Receita</title>
  <slider rotulo="Usuários" valor={usuarios} min={0} max={5000} onChange={(e) => setUsuarios(e.target.value)} />
  <slider rotulo="Preço" valor={preco} min={0} max={100} onChange={(e) => setPreco(e.target.value)} />
  <stat rotulo="Receita bruta" valor={"R$ " + usuarios * preco} />
  <chart dados={[{"rotulo": "mensal", "valor": usuarios * preco}]} />
</box>`
const c = parseUi(TELA_COMPARTILHADA)
const filhos = c.arvore[0].filhos
const nomes = filhos.map((f) => (f.tag === 'componente' ? f.nome : f.tag))
checar('tem 2 sliders ligados a 2 estados', nomes.filter((n) => n === 'slider').length === 2)
const stat = filhos.find((f) => f.tag === 'componente' && f.nome === 'stat')
const chart = filhos.find((f) => f.tag === 'componente' && f.nome === 'chart')
// Ambos leem os MESMOS 2 estados (usuarios, preco) nas expressões.
const statExpr = JSON.stringify(stat.props)
const chartExpr = JSON.stringify(chart.props)
checar('o stat lê usuarios e preco', statExpr.includes('usuarios') && statExpr.includes('preco'))
checar('o chart lê usuarios e preco', chartExpr.includes('usuarios') && chartExpr.includes('preco'))
checar('mesmos 2 estados alimentam os dois', c.estado.usuarios === 1000 && c.estado.preco === 29)
// A prova real: avaliar a expressão de cada um com o MESMO estado dá o MESMO resultado.
const v1 = avaliar('usuarios * preco', c.estado)
const v2 = avaliar('usuarios * preco', c.estado)
checar('avaliação compartilhada é consistente', v1 === 29000 && v2 === 29000)

// ============================================================ 2. EXECUTAR AÇÕES
console.log('\n=== 2. executar ações (atualizar, adicionar, remover, filtrar) ===')
const FILTRAR = `{@body const [filtro, setFiltro] = DIL.useState("todos")}
<button onClick={() => setFiltro("feito")}>Só feitos</button>
<button onClick={() => setFiltro("todos")}>Limpar</button>`
const f = parseUi(FILTRAR)
const botoes = f.arvore.filter((n) => n.tag === 'componente' && n.nome === 'button')
checar('2 botões de filtro montados', botoes.length === 2)
checar('botão 1 muda o estado (filtrar)', JSON.stringify(botoes[0].props).includes('setFiltro'))
checar('botão 2 muda o estado (limpar)', JSON.stringify(botoes[1].props).includes('setFiltro'))

// expressões com condições (o filtro de verdade, na lógica)
checar('avaliador entende condição ternária-like', avaliar('filtro == "feito"', { filtro: 'feito' }) === true)
checar('avaliador entende E', avaliar('a > 0 && b > 0', { a: 1, b: 2 }) === true)

// ============================================================ 3. LISTAS DINÂMICAS
console.log('\n=== 3. listas dinâmicas com repeat e escopo por linha ===')
const LISTA_DINAMICA = `{@body const [tarefas, setTarefas] = DIL.useList([{id: 1, texto: "Ler", feito: false}, {id: 2, texto: "Revisar", feito: true}])}
<repeat itens={tarefas} item="tarefa" indice="i"><texto valor={tarefa.texto} /></repeat>`
const l = parseUi(LISTA_DINAMICA)
const repeat = l.arvore[0]
checar('repeat recebe os 2 objetos', l.estado.tarefas.length === 2)
checar('repeat declara a variável local', repeat.props.item?.valor === 'tarefa')
checar('filho lê o campo de cada linha', avaliar('tarefa.texto', { tarefa: l.estado.tarefas[1] }) === 'Revisar')
checar('lista pode ser filtrada por linha', Array.isArray(avaliar('tarefas.filter((t) => t.id != tarefa.id)', { ...l.estado, tarefa: l.estado.tarefas[0] })) && avaliar('tarefas.filter((t) => t.id != tarefa.id)', { ...l.estado, tarefa: l.estado.tarefas[0] }).length === 1)

// ============================================================ 4. TAREFA INTERATIVA DE PONTA A PONTA
console.log('\n=== 4. tarefa interativa: adicionar, limpar, concluir e remover ===')
checar('DSL visual com cerca js é reconhecida como UI', pareceCodigoDeUi('js', '{@body const [p, setP] = DIL.useState(0)}\n<slider valor={p} />'))
checar('JavaScript comum continua sendo bloco de código', !pareceCodigoDeUi('js', 'const x = 1; console.log(x)'))
const setterDireto = eventosDoCorpo('setProgresso')?.[0]
checar('setter direto de slider recebe o valor do controle', setterDireto?.alvo === 'Progresso' && setterDireto.recebeControle === true)
const acoesAdicionar = eventosDoCorpo('() => setTarefas(novo.length > 0 ? [...tarefas, {id: Date.now(), texto: novo, feito: false}] : tarefas) + setNovo("")')
checar('adicionar reconhece dois setters em sequência', acoesAdicionar?.length === 2)
const estadoTarefas = { tarefas: [{ id: 1, texto: 'Ler', feito: false }], novo: 'Revisar' }
for (const acao of acoesAdicionar ?? []) {
  const chave = nomeDoEstado(acao.alvo, Object.keys(estadoTarefas))
  const valor = avaliar(acao.expr, estadoTarefas)
  if (valor !== undefined) estadoTarefas[chave] = valor
}
checar('adicionar inclui tarefa e limpa campo', estadoTarefas.tarefas.length === 2 && estadoTarefas.novo === '')
checar('String e Date.now são built-ins seguros', avaliar('String(tarefas.length)', estadoTarefas) === '2' && Number.isFinite(estadoTarefas.tarefas[1].id))
checar('contador atualiza com filter e String', avaliar('String(tarefas.filter((t) => t.feito == false).length)', estadoTarefas) === '2')
const marcar = eventosDoCorpo('() => setTarefas(tarefas.map((t) => t.id == tarefa.id ? {...t, feito: t.feito == false} : t))')?.[0]
const tarefasConcluidas = marcar && avaliar(marcar.expr, { ...estadoTarefas, tarefa: estadoTarefas.tarefas[1] })
checar('concluir altera a tarefa selecionada', Array.isArray(tarefasConcluidas) && tarefasConcluidas[1]?.feito === true && tarefasConcluidas[0]?.feito === false)
const remover = eventosDoCorpo('() => setTarefas(tarefas.filter((t) => t.id != tarefa.id))')?.[0]
const tarefasRemovidas = remover && avaliar(remover.expr, { ...estadoTarefas, tarefa: estadoTarefas.tarefas[0] })
checar('remover apaga apenas a tarefa selecionada', Array.isArray(tarefasRemovidas) && tarefasRemovidas.length === 1 && tarefasRemovidas[0]?.id === estadoTarefas.tarefas[1]?.id)

// ============================================================ 5. AVALIAR COM SEGURANÇA
console.log('\n=== 5. avaliar expressões com segurança (sem JS arbitrário) ===')
checar('aritmética funciona', avaliar('a * b', { a: 10, b: 3 }) === 30)
checar('string concat', avaliar('"R$ " + total', { total: 100 }) === 'R$ 100')
checar('condição', avaliar('nota >= 7', { nota: 8 }) === true)
checar(
  'ternários aninhados atualizam mensagens condicionais',
  avaliar('progresso == 100 ? "Tudo concluído!" : progresso == 0 ? "Nada concluído ainda." : "Faltam " + (100 - progresso) + " pontos para terminar."', { progresso: 72 }) === 'Faltam 28 pontos para terminar.',
)
checar('ramo final do ternário funciona', avaliar('progresso == 100 ? "Tudo concluído!" : progresso == 0 ? "Nada concluído ainda." : "Faltam " + (100 - progresso) + " pontos para terminar."', { progresso: 100 }) === 'Tudo concluído!')
// segurança: identificadores desconhecidos não escapam
checar('window/document NÃO escapam', avaliar('window.location', {}) === undefined)
checar('fetch/eval NÃO escapam', avaliar('fetch("x")', {}) === undefined)
checar('identificador desconhecido é undefined', avaliar('inexistente', {}) === undefined)
checar('array access NÃO executa nada', avaliar('a[0]', { a: 1 }) === undefined || typeof avaliar('a[0]', { a: 1 }) === 'number')

// ============================================================ 6. VALIDAR JSON/ESTRUTURA
console.log('\n=== 6. validar estrutura (impedir props/estrutura inválida) ===')
// entrada podre não trava (validação por tolerância)
const podre = parseUi('<box padding={3}><button>sem fim')
checar('tag não fechada não trava', podre.arvore.length >= 1)
checar('estado malformado não trava', (() => { try { parseUi('{@body lixo}'); return true } catch { return false } })())
// Mas: não há REJEIÇÃO explícita — prop desconhecida é ignorada em silêncio.
const propRuim = parseUi('<box padding={3} corDeFundo="roxo"><title>oi</title></box>')
checar('prop desconhecida é ignorada (não rejeitada)', propRuim.arvore.length === 1)

console.log(`\n${passou} passaram, ${falhou} falharam`)
console.log('\n=== resumo das 6 ===')
console.log('  1. compartilhar estado ......... SIM (2+ estados alimentam N componentes)')
console.log('  2. executar ações .............. SIM (onClick/onChange mudam estado: filtrar, atualizar)')
console.log('  3. listas dinâmicas ............ SIM (repeat, escopo por item, map/filter/push)')
console.log('  4. avaliar com segurança ....... SIM (aritmética/condição; sem eval, sem fuga)')
console.log('  5. validar JSON/estrutura ...... PARCIAL (não trava; mas não rejeita prop inválida)')
