/**
 * Testa a lógica do menu de comandos do prompt box, sem navegador.
 *
 * O contrato é curto de propósito: o menu **completa** o comando na caixa e não manda nada.
 * Quem escreve a mensagem é quem usa, e o que vai para o modelo é o que estiver escrito —
 * nada de texto pré-definido. Filtro e reconhecimento são funções puras em `src/comandos.ts`,
 * então dá para provar cada uma sem abrir o app.
 *
 *   node --experimental-strip-types scripts/testar-comandos.mjs
 */

import {
  COMANDOS,
  filtrarComandos,
  textoDoComando,
  tokenDigitado,
} from '../src/comandos.ts'

let falhas = 0

function checar(condicao, frase) {
  console.log((condicao ? '  OK   ' : '  FALHA') + ' — ' + frase)
  if (!condicao) falhas += 1
}

function secao(titulo) {
  console.log('\n' + '='.repeat(66) + '\n' + titulo + '\n' + '='.repeat(66))
}

// ------------------------------------------------------------------ lista
secao('A lista de comandos')

const nomes = COMANDOS.map((item) => item.nome)
console.log('  ' + nomes.join('  '))
checar(COMANDOS.length > 0, 'a lista não está vazia')
checar(
  COMANDOS.every((item) => item.descricao.trim().length > 0),
  'todo comando tem descrição (o menu precisa dizer o que o token quer dizer)',
)
checar(
  COMANDOS.every((item) => Object.keys(item).sort().join(',') === 'descricao,nome'),
  'o comando é só nome + descrição: nenhum texto pré-definido escondido no dado',
)

// ------------------------------------------------------------------ menu abre/fecha
secao('Quando o menu abre')

checar(tokenDigitado('/') === '', 'digitar só "/" abre o menu (token vazio)')
checar(tokenDigitado('/pl') === 'pl', '"/pl" filtra por "pl"')
checar(tokenDigitado('/PLAN') === 'plan', 'não importa a caixa: "/PLAN" vira "plan"')
checar(tokenDigitado('/plan ') === null, 'o espaço fecha o menu (o comando já foi escolhido)')
checar(
  tokenDigitado('/plan refatorar o modulo X') === null,
  'com o texto depois, o menu continua fechado',
)
checar(tokenDigitado('oi') === null, 'texto normal não abre o menu')
checar(tokenDigitado('') === null, 'caixa vazia não abre o menu')

// ------------------------------------------------------------------ busca
secao('A busca filtra a lista')

checar(filtrarComandos('').length === COMANDOS.length, 'sem filtro, a lista inteira')
checar(
  filtrarComandos('pl').map((item) => item.nome).join(',') === '/plan',
  '"pl" sobra só o /plan',
)
checar(
  filtrarComandos('ini').map((item) => item.nome).join(',') === '/init',
  '"ini" sobra só o /init',
)
checar(
  filtrarComandos('agents').map((item) => item.nome).join(',') === '/init',
  'a busca olha a descrição também ("agents" acha o /init)',
)
checar(filtrarComandos('zzz').length === 0, 'filtro sem casamento devolve lista vazia')

// ------------------------------------------------------------------ completar
secao('Escolher completa a caixa (o pedido do dono)')

checar(
  textoDoComando({ nome: '/plan', descricao: '' }) === '/plan ',
  'escolher o /plan escreve "/plan " na caixa — só o token, com espaço para continuar',
)
checar(
  textoDoComando(COMANDOS[0]) === '/init ',
  'e o /init escreve "/init "',
)
checar(
  COMANDOS.every((item) => textoDoComando(item).length <= item.nome.length + 1),
  'nenhum comando escreve mais do que o próprio token (nada de texto pronto)',
)
checar(
  tokenDigitado(textoDoComando(COMANDOS[1])) === null,
  'depois de completar, o menu fecha sozinho (o texto já passou do nome)',
)

// ------------------------------------------------------------------ resultado
console.log('\n' + '='.repeat(66))
if (falhas > 0) {
  console.log(`  ${falhas} FALHA(S)`)
  process.exit(1)
}
console.log('  TODAS AS CHECAGENS PASSARAM')
