/**
 * Reproduz o TODO app do print — o {@body} está vazando como texto cru.
 * Testa também uma leva de apps diferentes pra achar os bugs de uma vez.
 *
 * node --experimental-strip-types scripts/_teste_leva.mjs
 */
import { parseUi } from '../src/components/UiGenerativa/parser.ts'

let passou = 0
let falhou = 0
const checar = (nome, cond, extra = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${nome}${extra ? ' — ' + extra : ''}`)
  cond ? passou++ : falhou++
}

// O bloco do print (TODO app) — o {@body} vazou como texto.
const TODO = `{@body const [novo, setNovo] = DIL.useState(""); const [itens, setItens] = DIL.useList([]); const [log, setLog] = DIL.useList([]); const [feitas, setFeitas] = DIL.useState(1); const [resumo, setResumo] = DIL.useState("");}
<box padding={3}>
  <title>Lista de tarefas</title>
  <input placeholder="O que precisa ser feito?" valor={novo} onChange={(e) => setNovo(e.target.value)} />
  <button onClick={() => setNovo("")}>Adicionar</button>
</box>`

console.log('\n=== TODO app (o do print) ===')
const { estado, funcoes, arvore } = parseUi(TODO)
checar('extraiu estado novo', estado.novo === '', `novo=${JSON.stringify(estado.novo)}`)
checar('extraiu lista itens', Array.isArray(estado.itens))
checar('NÃO sobrou texto {@body} cru', !JSON.stringify(arvore).includes('DIL.useState'))
checar('árvore tem box', arvore.length >= 1 && arvore[0].tag === 'componente')

// onde o parse quebrou?
if (JSON.stringify(arvore).includes('DIL')) {
  console.log('  !! VAZOU. árvore:', JSON.stringify(arvore).slice(0, 300))
}

console.log('\n=== leva de apps diferentes ===')
const apps = [
  ['contador simples', '{@body const [count, setCount] = DIL.useState(0)}<box><title>{count}</title><button onClick={() => setCount(count + 1)}>+1</button></box>'],
  ['input + estado', '{@body const [nome, setNome] = DIL.useState("")}<box><input valor={nome} onChange={(e) => setNome(e.target.value)} /><title>{nome}</title></box>'],
  ['slider + stat', '{@body const [x, setX] = DIL.useState(10)}<box><slider valor={x} min={0} max={100} onChange={(e) => setX(Number(e.target.value))} /><stat rotulo="x" valor={x} /></box>'],
  ['dois estados', '{@body const [a, setA] = DIL.useState(1)}{@body const [b, setB] = DIL.useState(2)}<box><stat valor={a * b} /></box>'],
  ['lista useList', '{@body const [l, setL] = DIL.useList(["a","b"])}<box><repeat itens={l} /></box>'],
  ['chart + slider', '{@body const [v, setV] = DIL.useState(5)}<box><slider valor={v} onChange={(e) => setV(Number(e.target.value))} /><chart dados={[{rotulo:"a", valor: v}]} /></box>'],
  ['função =>', '{@body const [u, setU] = DIL.useState(100)}{@body const dobro = () => u * 2}<box><stat valor={dobro()} /></box>'],
  ['checkbox', '{@body const [on, setOn] = DIL.useState(false)}<box><checkbox valor={on} rotulo="liga" onChange={(e) => setOn(e.target.value)} /></box>'],
  ['select', '{@body const [c, setC] = DIL.useState("a")}<box><select valor={c} opcoes={["a","b"]} onChange={(e) => setC(e.target.value)} /></box>'],
  ['grid + cards', '<box><grid cols={2}><card titulo="A"><title>a</title></card><card titulo="B"><title>b</title></card></grid></box>'],
  ['steps', '<box><steps itens={["um","dois","tres"]} /></box>'],
  ['tabs', '<box><tabs itens={["Tab A","Tab B"]} /></box>'],
  ['toggle', '<box><toggle rotulo="modo" /></box>'],
  ['ternario', '{@body const [n, setN] = DIL.useState(8)}<box><title>{n >= 7 ? "aprovado" : "reprovado"}</title></box>'],
  ['template string', '{@body const [u, setU] = DIL.useState(1000)}<box><label>{`${u} usuários`}</label></box>'],
  ['stat variacao concat', '{@body const [v, setV] = DIL.useState(50)}<box><stat rotulo="R" valor={v} variacao={"+" + v + "%"} /></box>'],
  ['toLocaleString', '{@body const [v, setV] = DIL.useState(7350)}<box><stat valor={v.toLocaleString("pt-BR", {minimumFractionDigits: 2})} /></box>'],
  ['Math.round encadeado', '{@body const [v, setV] = DIL.useState(150)}<box><stat valor={Math.round(v * 1.05).toLocaleString("pt-BR")} /></box>'],
  ['constante derivada', '{@body const [u, setU] = DIL.useState(100)}{@body const r = u * 2}<box><stat valor={r} /></box>'],
  ['DOIS consts no mesmo body', '{@body const [a, setA] = DIL.useState(1); const [b, setB] = DIL.useState(2)}<box><stat valor={a + b} /></box>'],
  ['const + lista no mesmo body', '{@body const [n, setN] = DIL.useState(""); const [l, setL] = DIL.useList([])}<box><input valor={n} onChange={(e) => setN(e.target.value)} /><repeat itens={l} /></box>'],
  ['progress + slider', '{@body const [p, setP] = DIL.useState(40)}<box><slider valor={p} onChange={(e) => setP(Number(e.target.value))} /><progress valor={p} /></box>'],
  ['badge + alert', '<box><badge valor="ok" tom="ok" /><alert valor="tudo certo" /></box>'],
  ['table', '<box><table colunas={["A","B"]} linhas={[["1","2"]]} /></box>'],
  ['list itens', '<box><list itens={["x","y","z"]} /></box>'],
]
for (const [nome, fonte] of apps) {
  const r = parseUi(fonte)
  const vazou = JSON.stringify(r.arvore).includes('DIL.') || JSON.stringify(r.arvore).includes('useState')
  const okArvore = r.arvore.length >= 1
  checar(`${nome}: não vaza {@body}`, !vazou)
  checar(`${nome}: monta árvore`, okArvore)
  if (vazou) console.log(`     VAZOU: ${JSON.stringify(r.arvore).slice(0,200)}`)
}

console.log(`\n${passou} passaram, ${falhou} falharam`)
