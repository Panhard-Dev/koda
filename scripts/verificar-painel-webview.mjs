/**
 * Prova o fechamento do navegador do Painel Dev (`src/components/PainelLateral.tsx`).
 *
 * O defeito: o webview filho do Tauri nasce **assíncrono** — `new Webview` dispara o
 * `invoke` da criação e não espera; a confirmação é o evento `tauri://created`. Ele
 * também é janela nativa por cima do HTML, então webview que escapa do fechamento
 * fica na tela, na frente de tudo, até o app ser reiniciado. O `close()` do cleanup
 * chegava antes de o Rust registrar o rótulo, não achava nada e falhava em silêncio
 * — o webview nascia depois e ficava lá. Corrida, por isso "às vezes".
 *
 * Esta bancada renderiza o painel de verdade (jsdom) contra um Tauri de mentira que
 * obedece às mesmas regras do Rust: criar leva tempo; fechar rótulo inexistente
 * falha; listar devolve só o que existe. O que ela tranca:
 *
 * A. a corrida — fechar o painel antes da criação terminar fecha assim mesmo, e o
 *    close acontece **depois** da criação (não antes);
 * B. o controle — o algoritmo velho (fechar na hora) deixa o webview órfão: prova
 *    que a bancada enxerga o defeito;
 * C. o caminho normal — criado, fechado depois, sem sobra;
 * D. a varredura — órfão `painel-dev-*` de sessão anterior é fechado na montagem;
 * E. a criação que morre — endereço recusado não pendura o fechamento nem suja a
 *    tela (e some rápido, sem esperar o teto de 8 s);
 * F. a navegação — trocar de página fecha o webview anterior e o novo fica único.
 *
 * Roda com `node scripts/verificar-painel-webview.mjs` (esbuild vem com o Vite;
 * jsdom entra com `npm i --no-save jsdom` se não estiver instalado).
 */

import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'

// ── ambiente: jsdom como se fosse o webview do app ─────────────────────────────

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url: 'https://koda.local',
  pretendToBeVisual: true,
})

globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// jsdom devolve zero em getBoundingClientRect; o painel mede a caixa para criar o
// webview — sem isto a medição daria 0×0 e nada seria criado.
dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
  left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, x: 0, y: 0,
  toJSON() {},
})
dom.window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = dom.window.ResizeObserver

// ── o Tauri de mentira ────────────────────────────────────────────────────────

const registro = new Map() // label -> { url }: só o que o Rust conheceria
const fechados = [] // rótulos que passaram por webview_close com sucesso
const eventos = [] // { t, tipo, label, seq }: a linha do tempo das corridas
let sequencia = 0 // ordem exata dos fatos (o tempo em ms colide entre microtasks)
let atrasoDaCriacao = 150 // quanto o Rust demora para criar (ms)
let criarFalha = false // criação morre (endereço recusado, permissão)
let urlDoNavegador = 'https://exemplo.test'
let chamadasDoNavegador = 0

const agora = () => Number(process.hrtime.bigint() / 1000000n)
const dormir = (ms) => new Promise((r) => setTimeout(r, ms))

const invoke = async (cmd, args = {}) => {
  const label = args.label ?? args.options?.label
  if (cmd === 'plugin:webview|create_webview') {
    eventos.push({ t: agora(), tipo: 'criar-despachado', label, seq: sequencia++ })
    await dormir(atrasoDaCriacao)
    if (criarFalha) {
      eventos.push({ t: agora(), tipo: 'criar-morreu', label, seq: sequencia++ })
      throw new Error('endereço recusado pelo webview')
    }
    registro.set(label, { url: args.options?.url })
    eventos.push({ t: agora(), tipo: 'criar-existindo', label, seq: sequencia++ })
    return 1
  }
  if (cmd === 'plugin:webview|webview_close') {
    // Regra do Rust: rótulo que ele não conhece é erro — e o `.catch(() => {})` do
    // código velho engolia esse erro. É exatamente aí que nascia o órfão.
    if (!registro.has(label)) {
      eventos.push({ t: agora(), tipo: 'fechar-nao-achou', label, seq: sequencia++ })
      throw new Error(`webview not found: ${label}`)
    }
    registro.delete(label)
    fechados.push(label)
    eventos.push({ t: agora(), tipo: 'fechar-ok', label, seq: sequencia++ })
    return
  }
  if (cmd === 'plugin:webview|get_all_webviews') {
    return Array.from(registro.keys()).map((l) => ({ windowLabel: 'main', label: l }))
  }
  if (
    cmd === 'plugin:webview|set_webview_position' ||
    cmd === 'plugin:webview|set_webview_size' ||
    cmd === 'plugin:webview|set_webview_focus'
  ) {
    if (!registro.has(label)) throw new Error(`webview not found: ${label}`)
    return
  }
  return null
}

dom.window.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
  transformCallback: () => 0,
  unregisterCallback: () => {},
  convertFileSrc: (p) => p,
  invoke,
}

// ── o painel de verdade, empacotado ───────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'koda-painel-'))
const saida = join(dir, 'painel.cjs')

// Só o PainelLateral interessa; o que ele importa e não está sob prova vira stub.
// `WindowControls` precisa mandar `DENTRO_DO_TAURI = true` — é o que faz o painel
// usar o webview filho em vez do iframe.
const stubs = {
  'stub-windowcontrols': 'export const DENTRO_DO_TAURI = true',
  'stub-client':
    'export const estadoDoNavegador = async () => globalThis.__estadoDoNavegador()\n' +
    'export const estadoDosLogs = async () => ({ vivo: false, erros: [], resumo: {} })',
  'stub-codigo': 'export function AbaCodigo() { return null }',
  'stub-subs': 'export default function Subs() { return null }',
}

const stubPlugin = {
  name: 'stubs',
  setup(construir) {
    construir.onResolve({ filter: /^\.\/WindowControls$/ }, () => ({
      path: 'stub-windowcontrols',
      namespace: 'stub',
    }))
    construir.onResolve({ filter: /^\.\.\/api\/client$/ }, () => ({
      path: 'stub-client',
      namespace: 'stub',
    }))
    construir.onResolve({ filter: /^\.\/PainelCodigo$/ }, () => ({
      path: 'stub-codigo',
      namespace: 'stub',
    }))
    construir.onResolve({ filter: /^\.\/Subs$/ }, () => ({ path: 'stub-subs', namespace: 'stub' }))
    construir.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
      contents: stubs[args.path],
      loader: 'tsx',
    }))
  },
}

const entrada = `
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { PainelLateral } from './src/components/PainelLateral'

let root = null

const painel = (aberto) =>
  createElement(PainelLateral, { aberto, onFechar: () => {}, projeto: null })

export function abrir() {
  const alvo = document.getElementById('app')
  if (!alvo) return
  if (!root) root = createRoot(alvo)
  act(() => { root.render(painel(true)) })
}

export function fechar() {
  if (!root) return
  // aberto:false é o caminho real do X/Esc/clique fora: o asideSome e os filhos
  // desmontam (o efeito do navegador roda o cleanup).
  act(() => { root.render(painel(false)) })
}

export const esperar = (ms) =>
  act(async () => { await new Promise((r) => setTimeout(r, ms)) })

export function texto() { return document.getElementById('app')?.textContent ?? '' }
`

await build({
  stdin: {
    contents: entrada,
    resolveDir: process.cwd(),
    sourcefile: 'entrada-da-bancada.tsx',
    loader: 'tsx',
  },
  bundle: true,
  format: 'cjs',
  // O projeto usa o runtime automático de JSX (sem import React nos arquivos).
  jsx: 'automatic',
  // browser: o bundle é DOM (react, tauri, lucide) renderizado no jsdom; os builtins de
  // node (fs, path) são do bench, não do bundle.
  platform: 'browser',
  outfile: saida,
  plugins: [stubPlugin],
  logLevel: 'silent',
})

const require = createRequire(import.meta.url)
const painel = require(saida)

// O que a "IA" publica: o painel segue essa URL e cria o webview com ela.
globalThis.__estadoDoNavegador = () => {
  chamadasDoNavegador += 1
  return { vivo: true, url: urlDoNavegador, rolagem: null }
}

// ── os testes ─────────────────────────────────────────────────────────────────

const falhas = []
const checar = (nome, ok, detalhe = '') => {
  const marca = ok ? '✓' : '✗'
  console.log(`  ${marca} ${nome}${detalhe ? ` — ${detalhe}` : ''}`)
  if (!ok) falhas.push(`${nome}${detalhe ? ` — ${detalhe}` : ''}`)
}

const evento = (tipo, label) => eventos.find((e) => e.tipo === tipo && e.label === label)
const ateQue = async (condicao, teto = 3000) => {
  const t0 = Date.now()
  for (;;) {
    if (condicao()) return true
    if (Date.now() - t0 > teto) return false
    await painel.esperar(10)
  }
}
const limparRegistro = async () => {
  for (const l of Array.from(registro.keys())) {
    await invoke('plugin:webview|webview_close', { label: l }).catch(() => {})
  }
}

/** Estado de fábrica entre testes: painel fechado, registro limpo, tempos zerados. */
const zerar = async () => {
  painel.fechar()
  await painel.esperar(200)
  await limparRegistro()
  fechados.length = 0
  eventos.length = 0
  atrasoDaCriacao = 150
  criarFalha = false
  urlDoNavegador = 'https://exemplo.test'
  chamadasDoNavegador = 0
}

console.log('\nPainel Dev — fechamento do webview filho\n')

// A. a corrida: fechar antes da criação existir ────────────────────────────────

console.log('A. fechar no meio da criação (o "às vezes não fecha")')
await zerar()
painel.abrir()
const despachouA = await ateQue(() => eventos.some((e) => e.tipo === 'criar-despachado'))
checar('o painel criou o webview ao abrir', despachouA)
const rotuloA = eventos.find((e) => e.tipo === 'criar-despachado')?.label ?? ''
painel.fechar() // o X chega aqui: criação ainda no ar (atraso = 150 ms)
// Espera o ciclo COMPLETO: a criação terminar (aos 150 ms) e o close acontecer
// depois dela — é essa a prova. Conferir antes disso é conferir o vácuo.
const cicloA = await ateQue(() => evento('fechar-ok', rotuloA), 2500)
const criarA = evento('criar-existindo', rotuloA)
const fecharA = evento('fechar-ok', rotuloA)
checar('o webview foi fechado mesmo assim (sem órfão)', cicloA && !registro.has(rotuloA))
checar('o close aconteceu depois da criação existir', Boolean(criarA && fecharA && fecharA.seq > criarA.seq))
checar('nenhum "fechar-não-achou" para o webview do painel', !eventos.some((e) => e.tipo === 'fechar-nao-achou' && e.label === rotuloA))
checar('o registro ficou vazio', registro.size === 0)

// B. o controle: o algoritmo velho vaza ────────────────────────────────────────

console.log('\nB. controle — o algoritmo velho (fechar na hora)')
await zerar()
const rotuloVelho = 'painel-dev-controle-1'
void invoke('plugin:webview|create_webview', {
  windowLabel: 'main',
  options: { label: rotuloVelho, url: 'https://controle.test' },
}).catch(() => {})
// O que o cleanup fazia: close() na hora, exceção engolida.
await invoke('plugin:webview|webview_close', { label: rotuloVelho }).catch(() => {})
await painel.esperar(300) // a criação termina sozinha — é o webview órfão nascendo
checar('o webview nasceu e ficou órfão (o defeito é real)', registro.has(rotuloVelho))
await invoke('plugin:webview|webview_close', { label: rotuloVelho }).catch(() => {}) // limpeza
await zerar()

// C. o caminho normal: criado, fechado depois ──────────────────────────────────

console.log('\nC. fechar normalmente, depois de criado')
await zerar()
atrasoDaCriacao = 30
painel.abrir()
const criouC = await ateQue(() => eventos.some((e) => e.tipo === 'criar-existindo'))
const rotuloC = eventos.find((e) => e.tipo === 'criar-existindo')?.label ?? ''
checar('o webview apareceu', criouC)
painel.fechar()
const sumiuC = await ateQue(() => !registro.has(rotuloC), 2000)
checar('fechou e não deixou sobra', sumiuC && fechados.includes(rotuloC))

// D. a varredura de órfãos ─────────────────────────────────────────────────────

console.log('\nD. varredura de órfãos de sessão anterior')
await zerar()
registro.set('painel-dev-joao-123', { url: 'https://orfao.test' }) // vazou antes
painel.abrir()
const varreu = await ateQue(() => fechados.includes('painel-dev-joao-123'), 2000)
checar('o órfão painel-dev-* foi fechado na montagem', varreu)
checar('o registro não tem o órfão', !registro.has('painel-dev-joao-123'))
painel.fechar()
const rotuloD = eventos.find((e) => e.tipo === 'criar-despachado')?.label ?? ''
const sumiuD = await ateQue(() => registro.size === 0, 2000)
checar('e o webview da sessão atual também fechou', sumiuD && !registro.has(rotuloD))

// E. a criação que morre ───────────────────────────────────────────────────────

console.log('\nE. criação que morre (endereço recusado)')
await zerar()
criarFalha = true
const rejeicoes = []
const aoRejeitar = (r) => rejeicoes.push(r)
process.on('unhandledRejection', aoRejeitar)
painel.abrir()
const morreuE = await ateQue(() => eventos.some((e) => e.tipo === 'criar-morreu'), 2000)
await painel.esperar(200)
checar('a criação morreu e foi registrada', morreuE)
checar('nada ficou no registro', registro.size === 0)
checar('nada de rejeição sem tratamento', rejeicoes.length === 0)
const telaE = painel.texto()
checar('o painel avisa que não subiu', telaE.includes('Não consegui abrir o navegador embutido'))
painel.fechar()
await painel.esperar(300)
checar('fechar depois da morte não faz nada nem trava', registro.size === 0 && rejeicoes.length === 0)
process.off('unhandledRejection', aoRejeitar)

// F. a navegação recria ────────────────────────────────────────────────────────

console.log('\nF. navegar (trocar de página)')
await zerar()
atrasoDaCriacao = 30
painel.abrir()
const criouF1 = await ateQue(() => eventos.some((e) => e.tipo === 'criar-existindo'))
const rotuloF1 = eventos.find((e) => e.tipo === 'criar-existindo')?.label ?? ''
checar('a primeira página apareceu', criouF1)
urlDoNavegador = 'https://outra.test' // a IA muda de página
const criouF2 = await ateQue(
  () => eventos.filter((e) => e.tipo === 'criar-existindo').length >= 2,
  3000,
)
const rotuloF2 = eventos.filter((e) => e.tipo === 'criar-existindo').at(-1)?.label ?? ''
checar('a página nova apareceu', criouF2 && rotuloF2 !== rotuloF1)
await painel.esperar(300)
checar('a página anterior foi fechada', !registro.has(rotuloF1) && fechados.includes(rotuloF1))
checar('só a nova está viva', registro.size === 1 && registro.has(rotuloF2))
painel.fechar()
const sumiuF = await ateQue(() => registro.size === 0, 2000)
checar('fechar o painel fechou a página nova', sumiuF)

// ── fim ───────────────────────────────────────────────────────────────────────

await painel.esperar(100)
console.log('')
if (falhas.length) {
  console.log(`FALHOU ${falhas.length}:`)
  for (const f of falhas) console.log(`  — ${f}`)
  process.exit(1)
}
console.log('tudo verde — o navegador do painel fecha sempre, inclusive no meio da criação.\n')
// O jsdom (pretendToBeVisual) segura um timer de rAF que impede a saída natural.
process.exit(0)
