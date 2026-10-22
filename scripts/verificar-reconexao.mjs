/**
 * Prova a reconexão da conversa (`src/reconectar.ts` + o laço do `App.tsx`).
 *
 * A regra do dono: **qualquer** erro reconecta — rede, 5xx, fluxo fechado no meio,
 * silêncio estourado e até os erros de pedido (401/422/404). Acertando, o contexto
 * continua; batendo 10 tentativas, a rodada para e **diz o erro**. Esta bancada
 * tranca as partes:
 *
 * 1. o que ainda **não** é falha de conexão — `ehFalhaDeConexao` só decide marcar o
 *    backend como fora e a frase do fim (a repetição agora é sempre);
 * 2. a espera entre tentativas — sobe de um em um segundo e trava em 8 s;
 * 3. o sinal de vida (`lerComSinalDeVida`) — silêncio estoura, atividade reinicia,
 *    falha de leitura atravessa;
 * 4. o laço — falhar nove vezes e acertar na décima continua a rodada (com `resume`,
 *    sem repetir a pergunta); falhar dez encerra com o erro dito; e agora **todo**
 *    erro (inclusive 401/422/404) passa pelas dez tentativas antes de morrer.
 *
 * O laço simulado aqui espelha o `for` dentro de `handleSend` (App.tsx): o que a
 * bancada prova é o contrato dos helpers e o desfecho, com um `streamChat` de
 * mentira que falha até a vez certa.
 *
 * Roda com `node scripts/verificar-reconexao.mjs` (o esbuild vem com o Vite).
 */

import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'koda-reconexao-'))
const saida = join(dir, 'reconectar.cjs')

// O `reconectar.ts` não importa mais nada do app — o bundle sai limpo, sem stub. O
// `ApiError` da bancada é uma classe local com `status`, que é tudo que os testes
// precisam para exercitar a classificação.
class ApiError extends Error {
  constructor(status) {
    super(`stub ${status}`)
    this.status = status
  }
}

await build({
  stdin: {
    contents: "export * as reconectar from './src/reconectar.ts'",
    resolveDir: process.cwd(),
    sourcefile: 'entrada-da-bancada.ts',
    loader: 'ts',
  },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: saida,
  logLevel: 'silent',
})

const require = createRequire(import.meta.url)
const { reconectar } = require(saida)
const {
  TENTATIVAS_DE_RECONEXAO,
  esperaDaTentativa: espera,
  ehFalhaDeConexao,
  ErroDoServico,
  QuedaDeConexao,
  dormir,
  lerComSinalDeVida,
  ESPERA_DO_PRIMEIRO_BYTE_MS,
  INATIVIDADE_MS,
} = reconectar

const falhas = []
const checar = (nome, ok, detalhe = '') => {
  if (!ok) falhas.push(`${nome}${detalhe ? ` — ${detalhe}` : ''}`)
}

// 1. classificação (o que marca o backend como fora / escolhe a frase) -----------

checar('são 10 tentativas', TENTATIVAS_DE_RECONEXAO === 10)
const verdadeiros = [
  ['rede: TypeError do fetch', new TypeError('Failed to fetch')],
  ['serviço: 500', new ApiError(500)],
  ['serviço: 502', new ApiError(502)],
  ['serviço: 503', new ApiError(503)],
  ['fluxo fechou no meio', new QuedaDeConexao()],
  ['silêncio estourado', new QuedaDeConexao('a conexão ficou 60s sem enviar nada')],
]
const falsos = [
  ['erro do serviço (o backend respondeu)', new ErroDoServico('cota esgotada')],
  ['credencial: 401', new ApiError(401)],
  ['pedido inválido: 422', new ApiError(422)],
  ['serviço errado: 404', new ApiError(404)],
  ['erro genérico', new Error('qualquer coisa')],
  ['texto solto', 'não é erro'],
]
for (const [nome, erro] of verdadeiros) checar(`conexão: ${nome}`, ehFalhaDeConexao(erro) === true)
for (const [nome, erro] of falsos)
  checar(`serviço de pé: ${nome}`, ehFalhaDeConexao(erro) === false)

// 2. espera entre tentativas ----------------------------------------------------

const esperas = Array.from({ length: 10 }, (_, i) => espera(i + 1))
checar(
  'espera sobe 1..8s e trava em 8s',
  JSON.stringify(esperas) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 8, 8].map((s) => s * 1000)),
  JSON.stringify(esperas),
)

// 3. dormir ----------------------------------------------------------------------

{
  const t0 = Date.now()
  await dormir(40, new AbortController().signal)
  const esperou = Date.now() - t0
  checar('dormir espera o tempo pedido', esperou >= 30 && esperou < 200, `${esperou}ms`)

  const controlador = new AbortController()
  controlador.abort()
  const t1 = Date.now()
  await dormir(30_000, controlador.signal)
  checar('dormir para na hora com o sinal abortado', Date.now() - t1 < 100)
}

// 4. sinal de vida ----------------------------------------------------------------

checar(
  'o primeiro byte espera o dobro do silêncio no meio',
  ESPERA_DO_PRIMEIRO_BYTE_MS === INATIVIDADE_MS * 2,
  `${ESPERA_DO_PRIMEIRO_BYTE_MS} vs ${INATIVIDADE_MS}`,
)

{
  // Silêncio total: o limite estoura e vira queda de conexão.
  const mudo = { read: () => new Promise(() => {}) }
  let pegou = null
  try {
    await lerComSinalDeVida(mudo, 30)
  } catch (erro) {
    pegou = erro
  }
  checar('silêncio estoura em QuedaDeConexao', pegou instanceof QuedaDeConexao, String(pegou))
  checar(
    'a fala da queda diz quanto tempo (ms quando não dá 1s)',
    pegou instanceof QuedaDeConexao && pegou.message.includes('30ms'),
    pegou?.message,
  )
}

{
  // Fluxo vivo: cada pedaço chega dentro do limite — a leitura segue, sem estourar.
  const vivo = {
    n: 0,
    read() {
      this.n += 1
      return new Promise((resolve) =>
        setTimeout(() => resolve({ done: this.n >= 3, value: new Uint8Array([this.n]) }), 5),
      )
    },
  }
  const lidos = []
  let estourou = false
  try {
    for (let i = 0; i < 3; i++) lidos.push(await lerComSinalDeVida(vivo, 200))
  } catch {
    estourou = true
  }
  checar('atividade constante não estoura', !estourou && lidos.length === 3)
  checar('o último pedaço veio com done', lidos[2]?.done === true)
}

{
  // A rede cai com a leitura pendente: o erro atravessa como veio.
  const quebrado = { read: () => Promise.reject(new TypeError('network error')) }
  let pegou = null
  try {
    await lerComSinalDeVida(quebrado, 5000)
  } catch (erro) {
    pegou = erro
  }
  checar('falha de leitura atravessa', pegou instanceof TypeError, String(pegou))
}

// 5. o laço (o formato do `for` em handleSend, App.tsx) ---------------------------

/**
 * Roda o laço com um `streamChat` de mentira e devolve o que a rodada teria
 * mostrado. Opções:
 *
 * - `falhasDeRede`: quantas tentativas falham antes de começar (`fetch` não entrega
 *   resposta — `TypeError`);
 * - `quedasNoMeio`: quantas tentativas começam e fecham sem `done`/`error`
 *   (`QuedaDeConexao`);
 * - `silencios`: quantas tentativas morrem por silêncio estourado (o sinal de vida
 *   do cliente: `QuedaDeConexao` com a fala do tempo);
 * - `erroSempre`: um erro que insiste em **todas** as tentativas (401/422/404, ou a
 *   fala do backend pelo evento `error`) — o laço tem de morrer na décima dizendo
 *   esse erro.
 *
 * O formato é o do `for` dentro de `handleSend` (App.tsx), com o `dormir` trocado
 * por um que só registra o tempo pedido. **Todo** erro vai para a tentativa
 * seguinte — a única saída sem tentativa é o Parar, que o laço de verdade checa
 * pelo sinal abortado.
 */
async function rodarLaço({
  falhasDeRede = 0,
  quedasNoMeio = 0,
  silencios = 0,
  erroSempre = null,
} = {}) {
  const chamadas = []
  const esperasPedidas = []
  let textoErro = null
  let comecouEmAlgumaTentativa = false
  const dormirFalso = (ms) => {
    esperasPedidas.push(ms)
    return Promise.resolve()
  }
  for (let tentativa = 1; tentativa <= TENTATIVAS_DE_RECONEXAO; tentativa++) {
    const retomando = tentativa > 1 && comecouEmAlgumaTentativa
    try {
      chamadas.push({ retomando })
      comecouEmAlgumaTentativa = true
      if (erroSempre) throw erroSempre
      if (tentativa <= falhasDeRede) throw new TypeError('Failed to fetch')
      if (tentativa <= falhasDeRede + quedasNoMeio) throw new QuedaDeConexao()
      if (tentativa <= falhasDeRede + quedasNoMeio + silencios)
        throw new QuedaDeConexao('a conexão ficou 60s sem enviar nada')
      return { chamadas, esperasPedidas, textoErro: null }
    } catch (error) {
      if (tentativa >= TENTATIVAS_DE_RECONEXAO) {
        textoErro =
          error instanceof QuedaDeConexao
            ? error.message
            : error instanceof ErroDoServico
              ? error.message
              : error instanceof ApiError
                ? `serviço respondeu ${error.status}`
                : 'o serviço local não respondeu'
        return { chamadas, esperasPedidas, textoErro }
      }
      await dormirFalso(espera(tentativa))
    }
  }
  return { chamadas, esperasPedidas, textoErro }
}

{
  // Cai três vezes e volta: a quarta tentativa é a certa, e ela retoma o contexto.
  const r = await rodarLaço({ falhasDeRede: 3 })
  checar('quedas repetidas reconectam', r.textoErro === null && r.chamadas.length === 4)
  checar(
    'a retomada não repete a pergunta',
    r.chamadas[0].retomando === false && r.chamadas[3].retomando === true,
  )
  checar(
    'esperas entre as três quedas: 1s, 2s, 3s',
    JSON.stringify(r.esperasPedidas) === JSON.stringify([1000, 2000, 3000]),
    JSON.stringify(r.esperasPedidas),
  )
}

{
  // Começa e cai no meio duas vezes: também é reconexão, e a terceira acerta.
  const r = await rodarLaço({ quedasNoMeio: 2 })
  checar('fluxo fechado no meio reconecta', r.textoErro === null && r.chamadas.length === 3)
  checar(
    'duas quedas no meio pedem 1s e 2s de espera',
    JSON.stringify(r.esperasPedidas) === JSON.stringify([1000, 2000]),
    JSON.stringify(r.esperasPedidas),
  )
}

{
  // O backend trava calado duas vezes (o host engasga): o sinal de vida estoura e a
  // terceira tentativa acerta — é o «para e não responde mais»:
  const r = await rodarLaço({ silencios: 2 })
  checar('silêncio estourado reconecta', r.textoErro === null && r.chamadas.length === 3)
  checar(
    'os dois silêncios pedem 1s e 2s de espera',
    JSON.stringify(r.esperasPedidas) === JSON.stringify([1000, 2000]),
    JSON.stringify(r.esperasPedidas),
  )
}

{
  // O backend responde que não deu (cota, provedor estourado): também entra no laço
  // e, se não passar, morre dizendo a fala do backend.
  const r = await rodarLaço({ erroSempre: new ErroDoServico('a cota do host esgotou') })
  checar('erro do serviço também tenta', r.chamadas.length === 10 && r.esperasPedidas.length === 9)
  checar(
    'a fala do backend chega ao fim da rodada',
    r.textoErro === 'a cota do host esgotou',
    String(r.textoErro),
  )
}

{
  // Nunca volta: para na 10ª e diz o erro.
  const r = await rodarLaço({ falhasDeRede: 10 })
  checar('sem serviço, tenta 10 vezes', r.chamadas.length === 10 && r.esperasPedidas.length === 9)
  checar('décima falha encerra com o erro', typeof r.textoErro === 'string' && r.textoErro.length > 0)
  checar(
    'as 10 tentativas pedem 9 esperas: 1..8s e 8s',
    JSON.stringify(r.esperasPedidas) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 8].map((s) => s * 1000)),
    JSON.stringify(r.esperasPedidas),
  )
}

{
  // Os erros de pedido agora **também** passam pelas dez antes de morrer — regra do
  // dono: todo erro tenta. (Antes morriam na primeira.)
  for (const [nome, erro] of [
    ['422', new ApiError(422)],
    ['401', new ApiError(401)],
    ['404', new ApiError(404)],
  ]) {
    const r = await rodarLaço({ erroSempre: erro })
    checar(`${nome} vira laço de 10`, r.chamadas.length === 10 && r.esperasPedidas.length === 9)
    checar(`${nome} morre dizendo o status`, r.textoErro === `serviço respondeu ${erro.status}`)
  }
}

if (falhas.length > 0) {
  console.error(`reconexão: ${falhas.length} falha(s)`)
  for (const f of falhas) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(
  'reconexão: tudo verde (classificação, espera, dormir, sinal de vida e o laço de 10 tentativas para todo erro)',
)
