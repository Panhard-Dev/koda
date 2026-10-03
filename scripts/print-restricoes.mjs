/**
 * Tira os prints dos cenários de restrição, na bancada de conversa (`chat.html`).
 *
 * A bancada monta a conversa com os **mesmos componentes** do app, e aceita `?cenario=` para
 * renderizar um só. Aqui o Chrome é dirigido pelo DevTools Protocol (sem Playwright): abre o
 * cenário, espera a conversa montar e salva o PNG.
 *
 *   node scripts/print-restricoes.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORTA = 9400 + Math.floor(Math.random() * 400)
const BASE = process.env.KODA_CHAT ?? 'http://localhost:5173/chat.html'
const CHROME =
  process.env.KODA_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const DESTINO = process.env.KODA_PRINTS ?? 'src-tauri/target'

const CENARIOS = [
  { nome: 'restricao-antes', arquivo: 'restricao-antes.png' },
  { nome: 'restricao-depois', arquivo: 'restricao-depois.png' },
]

const espera = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORTA}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'koda-print-'))}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1100,760',
    '--force-device-scale-factor=2',
    '--hide-scrollbars',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

async function alvo() {
  for (let tentativa = 0; tentativa < 60; tentativa += 1) {
    try {
      const abas = await (await fetch(`http://127.0.0.1:${PORTA}/json/list`)).json()
      const aba = abas.find((item) => item.type === 'page')
      if (aba?.webSocketDebuggerUrl) return aba.webSocketDebuggerUrl
    } catch {
      // ainda subindo
    }
    await espera(250)
  }
  throw new Error('o Chrome não abriu a porta de depuração')
}

const ws = new WebSocket(await alvo())
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

let proximo = 1
const pendentes = new Map()
ws.addEventListener('message', (evento) => {
  const dados = JSON.parse(evento.data)
  const esperando = pendentes.get(dados.id)
  if (esperando) {
    pendentes.delete(dados.id)
    esperando(dados)
  }
})

const enviar = (method, params = {}) => {
  const id = proximo++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => pendentes.set(id, resolve))
}

const js = async (expressao) => {
  const resposta = await enviar('Runtime.evaluate', {
    expression: expressao,
    returnByValue: true,
    awaitPromise: true,
  })
  return resposta.result?.result?.value
}

try {
  await enviar('Page.enable')
  await enviar('Runtime.enable')

  for (const cenario of CENARIOS) {
    const url = `${BASE}?cenario=${cenario.nome}`
    let montou = false
    for (let tentativa = 1; tentativa <= 3 && !montou; tentativa += 1) {
      if (tentativa === 1) await enviar('Page.navigate', { url })
      else await enviar('Page.reload')
      for (let i = 0; i < 100 && !montou; i += 1) {
        montou = Boolean(await js('document.querySelector("[data-cenario]") !== null'))
        if (!montou) await espera(200)
      }
      if (!montou) console.log(`  (${cenario.nome}: não montou na tentativa ${tentativa})`)
    }
    if (!montou) throw new Error(`${cenario.nome} não montou`)

    // O cartão de ferramenta nasce recolhido (`<details>`); para o print ele precisa estar
    // aberto — é o conteúdo dele que prova o vazamento.
    await js('[...document.querySelectorAll("details")].forEach((d) => { d.open = true })')
    await espera(400)

    const foto = await enviar('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    })
    const caminho = join(DESTINO, cenario.arquivo)
    writeFileSync(caminho, Buffer.from(foto.result.data, 'base64'))
    const texto = await js('document.querySelector("[data-cenario]").innerText.slice(0, 120)')
    console.log(`  ${cenario.nome} -> ${caminho}`)
    console.log(`     ${JSON.stringify(String(texto).replace(/\s+/g, ' ').slice(0, 110))}`)
  }
} finally {
  ws.close()
  chrome.kill()
}
