/**
 * Testa a INTERAÇÃO dos componentes — simula clique, digitação, arraste.
 * Não é só parse: prova que dá pra mexer de verdade.
 *
 * node --experimental-strip-types scripts/_teste_interacao.mjs
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

// Replica o handler do ligarEventos (a versão corrigida e tolerante).
function handlers(fonte) {
  const { estado, funcoes } = parseUi(fonte)
  const chaves = Object.keys(estado)
  const out = { estado, funcoes, eventos: {} }
  // Acha todos os onChange/onClick nos nós
  function varrer(no) {
    if (no.tag !== 'componente') { no.filhos?.forEach(varrer); return }
    for (const [nome, valor] of Object.entries(no.props)) {
      if (valor.tipo !== 'expr') continue
      if (nome !== 'onClick' && nome !== 'onChange') continue
      const ev = alvoDoEvento(valor.corpo)
      if (!ev) continue
      const alvo = nomeDoEstado(ev.alvo, chaves)
      const expr = ev.expr
      const qn = querNumero(expr)
      out.eventos[`${no.nome}.${nome}`] = (recebido) => {
        let vc
        if (typeof recebido === 'string' || typeof recebido === 'number') vc = recebido
        else vc = recebido?.target?.value
        if (vc !== undefined) {
          out.estado[alvo] = qn ? Number(vc) : vc
          return
        }
        const v = avaliar(expr, out.estado, out.funcoes)
        if (v !== undefined) out.estado[alvo] = v
      }
    }
    no.filhos?.forEach(varrer)
  }
  parseUi(fonte).arvore.forEach(varrer)
  return out
}

console.log('\n=== BUTTON: clicar executa ação ===')
{
  const h = handlers('{@body const [n, setN] = DIL.useState(0)}<button onClick={() => setN(n + 1)}>+1</button>')
  h.eventos['button.onClick']()
  checar('clique incrementa', h.estado.n === 1)
  h.eventos['button.onClick']()
  checar('clique de novo vai a 2', h.estado.n === 2)
}

console.log('\n=== INPUT: digitar muda ===')
{
  const h = handlers('{@body const [t, setT] = DIL.useState("")}<input valor={t} onChange={(e) => setT(e.target.value)} />')
  h.eventos['input.onChange']('Maria')
  checar('digitou "Maria"', h.estado.t === 'Maria')
  h.eventos['input.onChange']('Maria Silva')
  checar('redigitou', h.estado.t === 'Maria Silva')
}

console.log('\n=== SLIDER: arrastar muda (Number) ===')
{
  const h = handlers('{@body const [v, setV] = DIL.useState(0)}<slider valor={v} onChange={(e) => setV(Number(e.target.value))} />')
  h.eventos['slider.onChange']('5000')
  checar('arrastou pra 5000 (número)', h.estado.v === 5000 && typeof h.estado.v === 'number')
}

console.log('\n=== CHECKBOX: marcar/desmarcar ===')
{
  const h = handlers('{@body const [on, setOn] = DIL.useState(false)}<checkbox valor={on} onChange={(e) => setOn(e.target.value)} />')
  // o checkbox chama mudar('true') ao marcar — simula o valor que ele manda
  h.eventos['checkbox.onChange']('true')
  checar('marcou', h.estado.on === 'true' || h.estado.on === true)
}

console.log('\n=== SELECT: escolher opção ===')
{
  const h = handlers('{@body const [c, setC] = DIL.useState("a")}<select valor={c} opcoes={["a","b","c"]} onChange={(e) => setC(e.target.value)} />')
  h.eventos['select.onChange']('b')
  checar('escolheu "b"', h.estado.c === 'b')
}

console.log('\n=== RADIO: escolher alternativa ===')
{
  const h = handlers('{@body const [r, setR] = DIL.useState("x")}<radio valor={r} opcoes={["x","y"]} onChange={(e) => setR(e.target.value)} />')
  h.eventos['radio.onChange']('y')
  checar('radio escolheu "y"', h.estado.r === 'y')
}

console.log('\n=== SEGMENTED: alternar ===')
{
  const h = handlers('{@body const [s, setS] = DIL.useState("um")}<segmented valor={s} opcoes={["um","dois"]} onChange={(e) => setS(e.target.value)} />')
  h.eventos['segmented.onChange']('dois')
  checar('segmented alternou pra "dois"', h.estado.s === 'dois')
}

console.log('\n=== TEXTAREA: escrever longo ===')
{
  const h = handlers('{@body const [txt, setTxt] = DIL.useState("")}<textarea valor={txt} onChange={(e) => setTxt(e.target.value)} />')
  h.eventos['textarea.onChange']('linha1\nlinha2')
  checar('escreveu multiline', h.estado.txt === 'linha1\nlinha2')
}

console.log('\n=== DATE: escolher data ===')
{
  const h = handlers('{@body const [d, setD] = DIL.useState("")}<date valor={d} onChange={(e) => setD(e.target.value)} />')
  h.eventos['date.onChange']('2026-01-15')
  checar('escolheu data', h.estado.d === '2026-01-15')
}

console.log('\n=== PRESSABLE: clicar área ===')
{
  const h = handlers('{@body const [n, setN] = DIL.useState(0)}<pressable onClick={() => setN(n + 5)}>x</pressable>')
  h.eventos['pressable.onClick']()
  checar('pressable clicou', h.estado.n === 5)
}

console.log('\n=== estado compartilhado: 2 controles, 1 stat recalcula ===')
{
  const h = handlers('{@body const [a, setA] = DIL.useState(10)}{@body const [b, setB] = DIL.useState(3)}<slider valor={a} onChange={(e) => setA(Number(e.target.value))} /><input valor={b} onChange={(e) => setB(e.target.value)} /><stat valor={a * b} />')
  h.eventos['slider.onChange']('100')
  h.eventos['input.onChange']('7')
  checar('ambos mexidos → a=100, b=7', h.estado.a === 100 && h.estado.b === 7)
  checar('stat recalcula 700', avaliar('a * b', h.estado, h.funcoes) === 700)
}

console.log(`\n${passou} passaram, ${falhou} falharam`)
