/**
 * Quantas interfaces distintas a UI generativa consegue montar?
 *
 * A conta não é "7 componentes" — é a explosão combinatória dos 7 blocos com estado,
 * aninhamento, atributos e eventos. Aqui a conta é feita com número: cada eixo de
 * variação multiplica, e a resposta é finita por eixo, mas astronômica no conjunto.
 *
 * Roda com node:
 *     node scripts/_teste_combinatoria.mjs
 */

// Os 7 componentes existentes (componentes.tsx).
const COMPONENTES = ['box', 'title', 'texto', 'button', 'slider', 'grid', 'chart']

// Atributos que a IA pode ligar em cada componente (props reais + eventos).
const PROPS = {
  box: ['padding'],
  title: ['valor'],
  texto: ['valor'],
  button: ['onClick', 'valor'],
  slider: ['rotulo', 'min', 'max', 'step', 'valor', 'onChange'],
  grid: ['cols'],
  chart: ['dados', 'titulo'],
}

// Faixas de valor que a IA costuma usar (e o avaliador aceita).
const FAIXAS = {
  padding: [0, 1, 2, 3, 4, 5, 6, 7, 8], // 9
  min: [0, -10, -100, 1],
  max: [100, 10, 1000, 50, 5],
  step: [1, 2, 0.5, 5, 10],
  cols: [1, 2, 3, 4, 6],
}

// O avaliador sabe estas operações — e cada estado pode ser combinado com qualquer uma.
const OPERACOES = ['+', '-', '*', '/', '>=', '<=', '>', '<', '==', '!=']
const FORMAS = [
  'a + b',
  'a - b',
  'a * b',
  'a / b',
  '"R$ " + a * b',
  '(a + b) * 2',
  'a >= b',
  'a.toFixed(2)',
  'b.toFixed(0)',
  'a * b - a',
  '"total: " + a * b',
]

console.log('\n=== 1. só a escolha de componentes por posição ===')
// Uma tela com até N nós; cada nó é 1 dos 7 componentes.
for (const nos of [2, 3, 4, 5]) {
  const combos = 7 ** nos
  console.log(`  tela com ${nos} nós: ${combos.toLocaleString('pt-BR')} combinações de componentes`)
}

console.log('\n=== 2. um único slider, só variando os atributos ===')
const umSlider = FAIXAS.min.length * FAIXAS.max.length * FAIXAS.step.length * FAIXAS.cols.length
console.log(`  slider (min × max × step): ${umSlider.toLocaleString('pt-BR')} configurações`)

console.log('\n=== 3. uma expressão com 2 estados (a lógica sem eval) ===')
const duasVars = 11 * 11 * 11 // cada var: 1 dos 11 estados/valores típicos × 11 × 11... simplificado
console.log(`  2 estados × 11 formas × 10 operadores: ~${(duasVars * 10).toLocaleString('pt-BR')} comportamentos`)

console.log('\n=== 4. tela de 3 nós, com estado e expressão (o caso real) ===')
// 7³ componentes × um estado entre ~6 valores × uma das 11 formas
const tela3 = 7 ** 3 * 6 * 11
console.log(`  ~${tela3.toLocaleString('pt-BR')} telas de 3 nós distintas`)

console.log('\n=== 5. com aninhamento (box dentro de box) e 2 eventos ===')
// profundidade 3, cada nível 7 opções, × 2 estados independentes × expressão
const aninhado = 7 ** 3 * 7 * 2 * 11
console.log(`  ~${aninhado.toLocaleString('pt-BR')} com aninhamento e 2 controles`)

console.log('\n=== a resposta ===')
const total = 7 ** 5 * 6 * 11 * 11 * 6 // tela de 5 nós: componentes × estados × expressões × eventos
console.log(`  tela de 5 nós, estados e expressões: ~${total.toLocaleString('pt-BR')}`)
console.log(`  (e cresce 7× a cada nó que a IA acrescentar)`)

console.log('\n=== os eixos que multiplicam ===')
console.log('  1. quais componentes (7)')
console.log('  2. em que ordem e aninhamento (7^profundidade)')
console.log('  3. quantos estados useState (quantos quiser)')
console.log('  4. que expressão liga cada estado (11 formas × 10 operadores)')
console.log('  5. que evento chama cada estado (onClick, onChange)')
console.log('  6. os valores dos atributos (slider: milhares de configs)')
