/**
 * Verifica o menu de comandos do "/" num navegador de verdade, pelo DevTools Protocol.
 *
 * O contrato que este script protege: o menu **completa** o comando na caixa e não manda
 * nada sozinho. Escolher `/plan` deixa `/plan ` escrito e o cursor depois dele; a mensagem
 * que sai é exatamente a que a pessoa escreveu — nunca um texto pronto do app.
 *
 * Sem dependência: usa o WebSocket que já existe no Node 22 e o Chrome instalado na máquina.
 * Exige o Vite no ar (`npm run dev`) e abre o harness de desenvolvimento, que roda sem login.
 *
 *   node scripts/verificar-menu-comandos.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Porta sorteada: uma sobra de execução anterior na porta fixa faria este script conversar
// com o Chrome errado (uma aba em `about:blank`) e a página nunca apareceria.
const PORTA = 9300 + Math.floor(Math.random() * 500)
const PAGINA = process.env.KODA_HARNESS ?? 'http://localhost:5173/harness.html'
const CHROME =
  process.env.KODA_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PERFIL = mkdtempSync(join(tmpdir(), 'koda-cdp-'))

let falhas = 0
const checar = (condicao, frase) => {
  console.log((condicao ? '  OK   ' : '  FALHA') + ' — ' + frase)
  if (!condicao) falhas += 1
}

const espera = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORTA}`,
    `--user-data-dir=${PERFIL}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1000,900',
    '--force-device-scale-factor=1',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

async function alvo() {
  for (let tentativa = 0; tentativa < 40; tentativa += 1) {
    try {
      const resposta = await fetch(`http://127.0.0.1:${PORTA}/json/list`)
      const abas = await resposta.json()
      const aba = abas.find((item) => item.type === 'page')
      if (aba?.webSocketDebuggerUrl) return aba.webSocketDebuggerUrl
    } catch {
      // O Chrome ainda está subindo.
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

function enviar(method, params = {}) {
  const id = proximo++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => pendentes.set(id, resolve))
}

/** Roda JS na página e devolve o valor. */
async function js(expressao) {
  const resposta = await enviar('Runtime.evaluate', {
    expression: expressao,
    returnByValue: true,
    awaitPromise: true,
  })
  if (resposta.result?.exceptionDetails) {
    throw new Error(resposta.result.exceptionDetails.text + ' ' + expressao)
  }
  return resposta.result?.result?.value
}

/** O código físico e o virtual-key de cada caractere, como o navegador espera. */
function teclaInfo(caractere) {
  if (/^[a-z]$/i.test(caractere)) {
    const maiuscula = caractere.toUpperCase()
    return { code: `Key${maiuscula}`, keyCode: maiuscula.charCodeAt(0) }
  }
  if (caractere === '/') return { code: 'Slash', keyCode: 191 }
  if (caractere === ' ') return { code: 'Space', keyCode: 32 }
  return { code: 'Unidentified', keyCode: caractere.charCodeAt(0) }
}

/** Uma tecla de verdade, como se viesse do teclado. */
async function tecla(caractere) {
  const { code, keyCode } = teclaInfo(caractere)
  const base = {
    key: caractere,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  }
  await enviar('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
  await enviar('Input.dispatchKeyEvent', {
    type: 'char',
    text: caractere,
    unmodifiedText: caractere,
    ...base,
  })
  await enviar('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  await espera(80)
}

async function teclaEspecial(key, code, keyCode) {
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await enviar('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await enviar('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  await espera(120)
}

async function digitar(texto) {
  for (const caractere of texto) {
    await tecla(caractere)
  }
}

/**
 * Espera uma expressão virar verdadeira. A primeira carga do Vite compila o grafo inteiro
 * de módulos e demora; um `setTimeout` fixo ora passa, ora falha.
 */
async function esperarPor(expressao, limite = 20000) {
  const fim = Date.now() + limite
  while (Date.now() < fim) {
    try {
      if (await js(expressao)) return true
    } catch {
      // A página ainda está carregando.
    }
    await espera(200)
  }
  return false
}

/**
 * Abre a página e espera ela montar, tentando de novo se preciso.
 *
 * Na primeira carga o Vite compila ~1900 módulos; de vez em quando o navegador pega a
 * página no meio disso e o `#root` fica vazio para sempre — não há erro, o módulo
 * simplesmente nunca terminou de chegar. Recarregar resolve, e é o que um humano faria.
 */
async function abrirPagina(expressao) {
  for (let tentativa = 1; tentativa <= 3; tentativa += 1) {
    if (tentativa === 1) await enviar('Page.navigate', { url: PAGINA })
    else await enviar('Page.reload', { ignoreCache: false })
    if (await esperarPor(expressao)) return tentativa
    console.log(`  (a página não montou na tentativa ${tentativa}; recarregando)`)
  }
  return 0
}

const secao = (titulo) => console.log('\n' + '='.repeat(66) + '\n' + titulo + '\n' + '='.repeat(66))

try {
  await enviar('Page.enable')
  await enviar('Runtime.enable')

  const caixa = 'document.querySelector("#koda-input")'
  const valor = `${caixa}.value`
  const menu = 'document.querySelector(\'[role="listbox"]\')'
  const itens = `[...document.querySelectorAll('[role="option"]')].map((i) => i.textContent.trim())`
  const ativo = `(document.querySelector('[role="option"][aria-selected="true"]') || {}).textContent`
  const enviados = `[...document.querySelectorAll('[data-enviado]')].map((i) => i.textContent)`

  /** Escreve na caixa pelo setter nativo — é o caminho que o React escuta. */
  const escrever = (texto) => js(`(() => {
    const caixa = document.querySelector('#koda-input')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(caixa, ${JSON.stringify(texto)})
    caixa.dispatchEvent(new Event('input', { bubbles: true }))
    return caixa.value
  })()`)

  secao('0) A página do harness carregou')

  const tentativa = await abrirPagina(`${caixa} !== null`)
  checar(tentativa > 0, 'a caixa de mensagem existe (harness sem login)')
  if (tentativa === 0) {
    const onde = await js('location.href + " | " + document.title')
    console.log(`  a página está em: ${onde}`)
    throw new Error('a página do harness não montou — Vite no ar? erro de runtime na tela?')
  }
  checar(await js(`${menu} === null`), 'o menu começa fechado')

  secao('1) Digitar "/" abre o menu')

  await js(`${caixa}.focus()`)
  await digitar('/')
  checar(await js(`${menu} !== null`), 'o menu abriu ao digitar "/"')
  console.log('  itens: ' + JSON.stringify(await js(itens)))
  checar((await js(itens)).length === 2, 'a lista tem os dois comandos')
  checar(String(await js(ativo)).startsWith('/init'), 'o primeiro item já está sob o cursor')

  secao('2) A busca filtra (era o "a pesquisa não funciona")')

  await digitar('i')
  const soInit = await js(itens)
  checar(soInit.length === 1 && soInit[0].startsWith('/init'), '"/i" deixa só o /init')

  await digitar('n')
  const aindaInit = await js(itens)
  checar(
    aindaInit.length === 1 && aindaInit[0].startsWith('/init'),
    '"/in" continua só o /init (o filtro refina a cada tecla)',
  )

  await escrever('/')
  await digitar('ag')
  const porDescricao = await js(itens)
  checar(
    porDescricao.length === 1 && porDescricao[0].startsWith('/init'),
    '"/ag" acha o /init pela descrição (AGENTS.md)',
  )

  secao('3) As setas andam pela lista (era o "scroll não funciona")')

  await escrever('/')
  const antes = String(await js(ativo))
  await teclaEspecial('ArrowDown', 'ArrowDown', 40)
  const depois = String(await js(ativo))
  console.log(
    `  cursor: ${JSON.stringify(antes.slice(0, 12))} -> ${JSON.stringify(depois.slice(0, 12))}`,
  )
  checar(antes.startsWith('/init') && depois.startsWith('/plan'), '↓ move o cursor para o /plan')
  await teclaEspecial('ArrowDown', 'ArrowDown', 40)
  checar(String(await js(ativo)).startsWith('/init'), '↓ no fim volta para o começo')
  await teclaEspecial('ArrowUp', 'ArrowUp', 38)
  checar(String(await js(ativo)).startsWith('/plan'), '↑ volta para o /plan')

  secao('4) Enter COMPLETA o comando e não manda nada (o pedido do dono)')

  // Cursor no /plan; Enter tem de escrever o token na caixa e parar por aí.
  await teclaEspecial('Enter', 'Enter', 13)
  const depoisDoEnter = await js(valor)
  console.log('  a caixa ficou: ' + JSON.stringify(depoisDoEnter))
  checar(depoisDoEnter === '/plan ', 'o Enter escreveu "/plan " na caixa')
  checar((await js(enviados)).length === 0, 'NADA foi enviado ao modelo')
  checar(await js(`${menu} === null`), 'o menu fechou depois de completar')

  secao('5) Você escreve o resto, e é isso que sai')

  await digitar('refatorar o modulo X')
  const escrito = await js(valor)
  console.log('  a caixa ficou: ' + JSON.stringify(escrito))
  checar(escrito === '/plan refatorar o modulo X', 'o texto digitado entrou depois do comando')
  checar((await js(enviados)).length === 0, 'digitar depois do comando também não envia nada')

  await teclaEspecial('Enter', 'Enter', 13)
  const mandado = (await js(enviados))[0]
  console.log('  o que a caixa mandou: ' + JSON.stringify(mandado))
  checar(mandado === '/plan refatorar o modulo X', 'saiu exatamente o que foi escrito — nada pronto')
  checar((await js(valor)) === '', 'e a caixa esvaziou, como em qualquer envio')

  secao('6) Comando sem nada escrito')

  await js(`${caixa}.focus()`)
  await digitar('/init')
  await teclaEspecial('Enter', 'Enter', 13)
  checar((await js(valor)) === '/init ', 'escolher o /init deixa "/init " na caixa')
  checar((await js(enviados)).length === 1, 'e não manda nada (a lista de enviados não cresceu)')

  secao('7) O Esc fecha o menu sem apagar')

  await escrever('/')
  checar(await js(`${menu} !== null`), 'o menu abriu')
  await teclaEspecial('Escape', 'Escape', 27)
  checar(await js(`${menu} === null`), 'o Esc fecha o menu')
  checar((await js(valor)) === '/', 'e o Esc não apaga o que foi digitado')

  secao('8) O corretor ortográfico está desligado (era a "cor diferente")')

  checar(
    (await js(`${caixa}.spellcheck`)) === false,
    'spellcheck desligado na caixa (era ele que pintava o /pla de vermelho)',
  )

  secao('9) Um comando que não existe não vira comando')

  await escrever('/goal')
  const semItem = await js(itens)
  checar(semItem.length === 0, '"/goal" não casa com nenhum comando da lista')
  checar(
    (await js('document.body.innerText')).includes('Nenhum comando'),
    'e a lista diz que não há comando com esse nome',
  )
  await teclaEspecial('Enter', 'Enter', 13)
  checar(
    (await js(enviados)).length === 2 && (await js(enviados))[1] === '/goal',
    'texto com "/" que não é comando sai como mensagem normal',
  )

  // Uma foto do menu aberto, para conferir o desenho.
  await escrever('/')
  await espera(250)
  const foto = await enviar('Page.captureScreenshot', { format: 'png' })
  const destino = 'src-tauri/target/menu-comandos.png'
  writeFileSync(destino, Buffer.from(foto.result.data, 'base64'))
  console.log(`\n  foto do menu aberto: ${destino}`)
} finally {
  try {
    ws.close()
  } catch {
    // já fechou
  }
  chrome.kill()
}

console.log('\n' + '='.repeat(66))
if (falhas > 0) {
  console.log(`  ${falhas} FALHA(S)`)
  process.exit(1)
}
console.log('  TODAS AS CHECAGENS PASSARAM')
