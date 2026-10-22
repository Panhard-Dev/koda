/**
 * Testa a página "só o chat" com Edge de verdade.
 *
 * Confere que ela monta, que o Composer aparece, e que uma mensagem enviada volta com
 * resposta do modelo — o caminho inteiro, sem login.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORTA = 9340
const perfil = mkdtempSync(join(tmpdir(), 'koda-chat-'))
const EDGE =
  process.env.EDGE ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const URL_ALVO = process.argv[2] ?? 'http://127.0.0.1:5173/chat.html'

const edge = spawn(
  EDGE,
  [
    '--headless=new',
    `--remote-debugging-port=${PORTA}`,
    `--user-data-dir=${perfil}`,
    '--no-first-run',
    '--disable-gpu',
    '--window-size=1280,860',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const espera = (ms) => new Promise((r) => setTimeout(r, ms))

async function ws_alvo() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const pag = (await (await fetch(`http://127.0.0.1:${PORTA}/json/list`)).json()).find(
        (t) => t.type === 'page',
      )
      if (pag?.webSocketDebuggerUrl) return pag.webSocketDebuggerUrl
    } catch {}
    await espera(250)
  }
  throw new Error('CDP não subiu')
}

const ws = new WebSocket(await ws_alvo())
await new Promise((ok, erro) => {
  ws.onopen = ok
  ws.onerror = erro
})

let seq = 0
const pend = new Map()
const erros = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m)
    pend.delete(m.id)
    return
  }
  if (m.method === 'Runtime.exceptionThrown') {
    erros.push((m.params.exceptionDetails.exception?.description ?? '').slice(0, 300))
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    erros.push(m.params.args.map((a) => a.value ?? '').join(' ').slice(0, 300))
  }
}
const cmd = (method, params = {}) =>
  new Promise((ok) => {
    const n = ++seq
    pend.set(n, ok)
    ws.send(JSON.stringify({ id: n, method, params }))
    setTimeout(() => {
      if (pend.has(n)) {
        pend.delete(n)
        ok({ timeout: true })
      }
    }, 40000)
  })

await cmd('Runtime.enable')
await cmd('Page.enable')
await cmd('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 860,
  deviceScaleFactor: 2,
  mobile: false,
})

const av = async (expr) => {
  const r = await cmd('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    // `awaitPromise` só vale para promessas; com ele ligado numa expressão simples o
    // resultado volta `undefined`. Aqui o valor é medido como veio.
    awaitPromise: false,
  })
  if (r.timeout) return 'TIMEOUT'
  if (r.result?.exceptionDetails) {
    return 'EXC: ' + (r.result.exceptionDetails.exception?.description ?? '').slice(0, 250)
  }
  const v = r.result?.result?.value
  return v === undefined ? `(undefined) type=${r.result?.result?.type} desc=${r.result?.result?.description ?? ''}` : v
}

console.log('abrindo', URL_ALVO)
await cmd('Page.navigate', { url: URL_ALVO })
await espera(6000)

console.log('\n[1] montou?')
console.log(
  await av(`
  JSON.stringify({
    root: document.getElementById('root')?.innerHTML.length ?? -1,
    temTextarea: !!document.querySelector('textarea'),
    titulo: document.title,
    texto: document.body.innerText.slice(0, 120).replace(/\\n/g, ' / '),
  }, null, 2)`),
)

console.log('\n[2] enviando uma mensagem')
console.log(
  await av(`
  (() => {
    const ta = document.querySelector('textarea')
    if (!ta) return 'SEM TEXTAREA'
    const set = (el, v) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    set(ta, 'Diga apenas: ola mundo')
    // O Enter manda: é o caminho da pessoa.
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    return 'enviado'
  })()`),
)

for (const s of [4, 8, 14, 22]) {
  await espera(s * 1000)
  const t = await av(`document.body.innerText.replace(/\\n/g, ' / ').slice(0, 260)`)
  console.log(`  t≈${s}s: ${t}`)
}

console.log('\n[3] print')
const shot = await cmd('Page.captureScreenshot', { format: 'png' })
if (shot.result?.data) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync('chat-solto.png', Buffer.from(shot.result.data, 'base64'))
  console.log('  salvo em chat-solto.png')
}

console.log('\n[4] erros no console')
console.log(erros.length ? erros.slice(0, 6).join('\n') : '(nenhum)')

ws.close()
edge.kill()
process.exit(0)
