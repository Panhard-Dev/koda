/**
 * Testa o DesenhoUi de verdade, num DOM (jsdom), com eventos.
 *
 * Roda com node:
 *     node --experimental-strip-types scripts/_teste_dom.mjs
 */
import { JSDOM } from 'jsdom'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { DesenhoUi } from '../src/components/UiGenerativa/index.tsx'

const dom = new JSDOM('<!doctype html><div id="r"></div>')
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const FONTE = [
  '{@body const [usuarios, setUsuarios] = DIL.useState(1000)}',
  '<slider rotulo="Usuários" min={0} max={20000} step={100} valor={usuarios} onChange={(e) => setUsuarios(Number(e.target.value))} />',
  '<stat rotulo="Total" valor={usuarios} />',
].join('\n')

const container = document.getElementById('r')
const root = createRoot(container)
await act(async () => {
  root.render(React.createElement(DesenhoUi, { fonte: FONTE }))
})

const html = container.innerHTML
console.log('=== HTML gerado ===')
console.log(html.slice(0, 800))

const input = container.querySelector('input[type="range"]')
console.log('\n=== input range encontrado? ===', !!input)
if (input) {
  console.log('value:', input.value)
  console.log('min:', input.min, 'max:', input.max)

  // simula arrastar
  await act(async () => {
    input.value = '5000'
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  console.log('\n=== depois de arrastar pra 5000 ===')
  const stat = container.querySelector('span')
  console.log('HTML depois:', container.innerHTML.slice(0, 500))
}
