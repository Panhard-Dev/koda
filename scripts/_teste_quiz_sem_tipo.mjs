/**
 * Prova do conserto do chat antigo: o JSON de quiz **sem `tipo`** (exatamente como o
 * `base.py` manda a IA escrever, e como está no chat antigo) tem que virar o Quiz
 * desenhado — não o cartão amarelo «não conheço o tipo "visual"».
 *
 * Roda com node, sem servidor:
 *     node scripts/_teste_quiz_sem_tipo.mjs
 */
import { readFileSync } from 'node:fs'

// O despachante é TSX; aqui a gente não importa React. O que se prova é a REGRA de
// decisão (quiz por conteúdo), reproduzida com o parser de verdade do arquivo.
const fonte = readFileSync('src/components/BlocosVisuais.tsx', 'utf8')

// Os JSONs que estavam no chat antigo (print do dono) — sem o campo `tipo`.
const QUIZ_1 =
  '{"pergunta": "Qual é o capital do Brasil?", "opcoes": ["São Paulo", ' +
  '"Rio de Janeiro", "Brasília", "Salvador"], "correta": 2, "explicacao": ' +
  '"Brasília virou capital em 1960, substituindo o Rio de Janeiro."}'
const QUIZ_2 =
  '{"pergunta": "Qual é o maior estado do Brasil em área territorial?", "opcoes": ' +
  '["Pará", "Mato Grosso", "Minas Gerais", "Amazonas"], "correta": 3, "explicacao": ' +
  '"O Amazonas tem mais de 1,5 milhão de km², é o maior estado do país."}'

// A regra nova, copiada do arquivo (é o que o `desenhar` calcula).
function tipoFinal(dados, linguagem) {
  const tipo = String(dados.tipo ?? dados.type ?? linguagem.replace(/^koda-/, '')).toLowerCase()
  const temOpcoes = Array.isArray(dados.opcoes ?? dados.alternativas)
  const ehQuiz =
    tipo === 'quiz' || tipo === 'pergunta' || (temOpcoes && (dados.pergunta ?? dados.enunciado) != null)
  return ehQuiz ? 'quiz' : tipo
}

let passou = 0
let falhou = 0
const checar = (nome, cond) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${nome}`)
  cond ? passou++ : falhou++
}

console.log('\n=== quiz sem `tipo` vira quiz (não mais "visual") ===')
checar('JSON do print 1 é reconhecido como quiz', tipoFinal(JSON.parse(QUIZ_1), 'koda-visual') === 'quiz')
checar('JSON do print 2 é reconhecido como quiz', tipoFinal(JSON.parse(QUIZ_2), 'koda-visual') === 'quiz')

console.log('=== regressão: os outros tipos seguem intactos ===')
checar(
  'tabela com tipo continua tabela',
  tipoFinal({ tipo: 'tabela', colunas: [], linhas: [] }, 'koda-visual') === 'tabela',
)
checar(
  'barras sem tipo continua "visual" (não é quiz)',
  tipoFinal({ dados: [{ rotulo: 'a', valor: 1 }] }, 'koda-visual') === 'visual',
)
checar('quiz COM tipo continua quiz', tipoFinal({ tipo: 'quiz', pergunta: 'x', opcoes: ['a', 'b'] }, 'koda-visual') === 'quiz')

console.log('\n=== a regra está no arquivo ===')
checar('BlocosVisuais.tsx tem o comentário do conserto', fonte.includes('Quiz por conteúdo, e não só por'))
checar('BlocosVisuais.tsx calcula ehQuiz', fonte.includes('const ehQuiz ='))
checar('BlocosVisuais.tsx usa tipoFinal', fonte.includes('const tipoFinal = ehQuiz'))

console.log(`\n${passou} passaram, ${falhou} falharam`)
process.exit(falhou ? 1 : 0)
