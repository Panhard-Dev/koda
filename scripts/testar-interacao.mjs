/**
 * A interação funciona? — teste direto, sem depender de estrutura frágil.
 *
 * Mede o que importa: cada tipo desenha, o balão aparece no hover com o valor certo, o
 * clique destaca, o Esc limpa. Os seletores são por texto e por presença, não por posição.
 */
import { spawn } from 'node:child_process'
const p = spawn('node', ['mcp/dev-browser/server.mjs'], { cwd: process.cwd() })
let buf = ''
let id = 0
const pend = new Map()
p.stdout.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!l) continue
    try {
      const o = JSON.parse(l)
      const r = pend.get(o.id)
      if (r) {
        pend.delete(o.id)
        r(o)
      }
    } catch {}
  }
})
p.stderr.on('data', () => {})
const pedir = (m, pa) =>
  new Promise((ok) => {
    const n = ++id
    pend.set(n, ok)
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method: m, params: pa }) + '\n')
    setTimeout(() => ok({ timeout: true }), 60000)
  })
const chamar = async (n, a) => {
  const r = await pedir('tools/call', { name: n, arguments: a })
  return (r.result?.content ?? []).map((x) => x.text ?? '').join('\n')
}
const js = (c) => chamar('executar_js', { codigo: c })
const espera = (ms) => new Promise((r) => setTimeout(r, ms))

await pedir('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 't', version: '1' },
})
await chamar('abrir', { url: 'http://127.0.0.1:4180/blocos.html' })
await espera(7000)

const tipos = JSON.parse(
  await js(`JSON.stringify([...document.querySelectorAll('nav button')].map(b=>b.textContent.trim()))`),
)
console.log(`tipos na lista: ${tipos.length}\n`)

/** Clica num tipo da lista e devolve o que o preview desenhou. */
async function abrirTipo(nome, indice) {
  await js(
    `[...document.querySelectorAll('nav button')].find(b=>b.textContent.trim()===${JSON.stringify(nome)}).dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}))`,
  )
  await espera(900)
  const r = await js(`
    (() => {
      const previa = [...document.querySelectorAll('section')].pop()
      if (!previa) return JSON.stringify({erro:'sem preview'})
      const fig = previa.querySelector('figure')
      const caixa = previa.querySelector('.text-amber-200')
      return JSON.stringify({
        desenhou: !!fig,
        nos: fig ? fig.querySelectorAll('*').length : 0,
        svg: fig ? fig.querySelectorAll('svg').length : 0,
        paths: fig ? fig.querySelectorAll('path').length : 0,
        titulo: fig ? (fig.querySelector('figcaption')?.textContent || '') : '',
        aviso: caixa ? caixa.innerText.slice(0,70) : null,
      })
    })()`)
  return { nome, indice, ...JSON.parse(r) }
}

console.log('=== 1. TODOS OS TIPOS DESENHAM? ===')
const resultados = []
for (let i = 0; i < tipos.length; i += 1) {
  const r = await abrirTipo(tipos[i], i)
  resultados.push(r)
  const marca = r.aviso ? 'ERRO' : r.desenhou ? 'ok  ' : 'VAZIO'
  console.log(
    `  ${marca} ${r.nome.padEnd(22)} nós=${String(r.nos).padStart(3)} svg=${r.svg} path=${r.paths}${r.aviso ? ' -> ' + r.aviso : ''}`,
  )
}
const falhas = resultados.filter((r) => !r.desenhou || r.aviso)
console.log(`\n  ${resultados.length - falhas.length}/${resultados.length} desenharam`)

console.log('\n=== 2. HOVER: o balão aparece? ===')
await abrirTipo('Pizza', tipos.indexOf('Pizza'))
const hover = await js(`
  (() => {
    const previa = [...document.querySelectorAll('section')].pop()
    const alvos = previa.querySelectorAll('path, circle, rect, li, tr')
    if (!alvos.length) return JSON.stringify({erro:'nada para apontar'})
    const alvo = [...alvos].find(e => e.tagName === 'path') || alvos[0]
    const r = alvo.getBoundingClientRect()
    const o = { clientX: r.x + r.width/2, clientY: r.y + r.height/2, bubbles: true, cancelable: true, view: window }
    alvo.dispatchEvent(new MouseEvent('mouseover', o))
    alvo.dispatchEvent(new MouseEvent('mouseenter', o))
    alvo.dispatchEvent(new MouseEvent('mousemove', o))
    return JSON.stringify({alvo: alvo.tagName, x: Math.round(o.clientX), y: Math.round(o.clientY)})
  })()`)
console.log('  disparado em:', hover)
await espera(700)
console.log(
  '  balão:',
  await js(
    `(()=>{const b=document.querySelector('[role=tooltip]');return b ? 'SIM -> ' + b.innerText.replace(/\\n/g,' | ') : 'NÃO APARECEU'})()`,
  ),
)

console.log('\n=== 3. CLIQUE: destaca e apaga o resto? ===')
console.log(
  await js(`
  (() => {
    const previa = [...document.querySelectorAll('section')].pop()
    const alvos = [...previa.querySelectorAll('path, li[class*="cursor"], tr, div[class*="cursor"]')]
    if (!alvos.length) return 'nada clicável'
    alvos[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return 'clicou em ' + alvos.length + ' alvos possíveis'
  })()`),
)
await espera(700)
console.log(
  await js(`
  (() => {
    const previa = [...document.querySelectorAll('section')].pop()
    const todos = [...previa.querySelectorAll('path, li, tr')]
    const ops = todos.map(e => getComputedStyle(e).opacity).filter(o => o !== '1')
    const botao = [...document.querySelectorAll('button')].find(b => /limpar/.test(b.textContent))
    return JSON.stringify({ elementosApagados: ops.length, botaoLimpar: botao ? botao.textContent : 'SEM BOTÃO' })
  })()`),
)

console.log('\n=== 4. ESC limpa? ===')
await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
await espera(600)
console.log(
  await js(`
  (() => {
    const previa = [...document.querySelectorAll('section')].pop()
    const todos = [...previa.querySelectorAll('path, li, tr')]
    const ops = todos.map(e => getComputedStyle(e).opacity).filter(o => o !== '1')
    const botao = [...document.querySelectorAll('button')].find(b => /limpar/.test(b.textContent))
    return JSON.stringify({ aindaApagados: ops.length, botaoSumiu: !botao })
  })()`),
)

console.log('\n=== 5. erros ===')
const c = await chamar('console', {})
const ruins = c.split('\n').filter((l) => /\[error\]|EXC/i.test(l) && !/favicon/.test(l))
console.log(ruins.length ? ruins.slice(0, 6).join('\n') : '(nenhum)')

await chamar('fechar', {})
p.kill()
process.exit(0)
