#!/usr/bin/env node
/**
 * MCP `koda-dev-logs` — o painel de logs que a IA consulta para diagnosticar o que o
 * Painel Dev abriu.
 *
 * ## Por que existe, e o que ele junta
 *
 * O MCP `koda-dev-browser` abre a página e **vê** o console e a rede. Isso responde "o que o
 * navegador reclamou" — e só isso. A falha que derruba um site de verdade quase nunca mora
 * ali: um `fetch` que volta 500, uma query que estoura, um `Traceback` no servidor. O console
 * mostra o sintoma (a tela vazia); a causa está do outro lado.
 *
 * Este servidor junta as duas pontas numa lista só:
 *
 * - **navegador** — o feed que o `koda-dev-browser` publica em `data/dev-browser-logs.json`
 *   (console de erro/aviso, exceções, HTTP 4xx/5xx e requisições que falharam);
 * - **servidor** — o log do processo de trás (uvicorn/vite/node), lido do arquivo.
 *
 * ## As três regras que o pedido exige, e como cada uma está feita
 *
 * 1. **Só erros, sem spam.** O feed do navegador já chega filtrado. Aqui tudo passa por uma
 *    **assinatura** (`_assinatura`): mensagens que só diferem em número, id ou hash viram
 *    **uma** entrada com contador. Um laço que loga 10.000 vezes aparece como uma linha com
 *    `ocorrencias: 10000` — não 10.000 linhas.
 * 2. **Sem duplicação nem ciclo.** Além da assinatura, há teto de saída (`LIMITE_PADRAO`) e a
 *    marca `repetindo` a partir de `REPETINDO_LIMITE`. E a resposta **nunca é vazia por
 *    engano**: quando não há erro, ele diz "nenhum erro" — que é a resposta honesta, e é o que
 *    a IA precisa ouvir para saber que a correção pegou.
 * 3. **Sem inventar diagnóstico.** O que ele devolve é o que **está** no arquivo: mensagem,
 *    arquivo e linha quando existem; quando não existem, ele escreve que não existem. Não há
 *    heurística que "adivinhe" causa.
 *
 * ## O baseline — o que faz a verificação valer
 *
 * `marcar` fixa um instante. Depois disso, `erros {desde: "baseline"}` devolve **só** o que
 * apareceu de novo. É esse o mecanismo que transforma "corrigi" em "corrigi e os logs
 * concordam": sem ele, a IA releria os erros antigos e não teria como distinguir o que já
 * existia do que a correção introduziu.
 *
 * ## Protocolo
 *
 * MCP sobre stdio: um objeto JSON por linha no `stdin`, um por linha no `stdout`. O `stdout`
 * é **só** do protocolo — qualquer diagnóstico vai para o `stderr`.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// ---------------------------------------------------------------- utilidades

const log = (...partes) => process.stderr.write(`[dev-logs] ${partes.join(' ')}\n`)

/** Onde ficam os arquivos publicados. Mesma escolha do `koda-dev-browser` — têm de casar. */
function pastaDeDados() {
  const candidatos = [
    process.env.KODA_DATA_DIR,
    join(process.cwd(), 'data'),
    join(process.cwd(), 'backend', 'data'),
  ].filter(Boolean)
  for (const candidato of candidatos) {
    if (existsSync(candidato)) return candidato
  }
  mkdirSync(candidatos[0], { recursive: true })
  return candidatos[0]
}

const DADOS = pastaDeDados()

//: Quantas entradas, no máximo, uma leitura devolve. Acima disto a lista deixa de ser
//: diagnóstica e vira parede de texto — quem precisa de mais pede com `limite`.
const LIMITE_PADRAO = 40

//: A partir de quantas ocorrências a mesma assinatura é marcada `repetindo`. É o sinal de
//: laço: erro que se repete sem parar quase sempre é o mesmo defeito batendo de novo.
const REPETINDO_LIMITE = 10

//: Teto do log de servidor lido por varredura, em bytes, a partir do fim do arquivo. Um log de
//: horas atrás não ajuda a diagnosticar o que acabou de quebrar, e ler 200 MB a cada tique
//: custaria caro por nada.
const TAIL_BYTES = 256 * 1024

// ---------------------------------------------------------------- estado

/** O baseline: instante a partir do qual "novo" passa a significar alguma coisa. */
let baseline = 0

/**
 * Assinaturas já vistas e quantas vezes. Serve para a marca `novo` e para não reprocessar o
 * mesmo texto quando a mesma assinatura chega por dois caminhos (ex.: erro de rede aparece no
 * console **e** na aba Network).
 */
const vistas = new Map()

/**
 * A assinatura de um erro — o que faz dois relatos serem o mesmo problema.
 *
 * Tira o que muda a cada repetição (números, hashes, ids, query string) e mantém o que
 * identifica. É a mesma receita do lado do navegador, e tem de ser: as duas listas são
 * cruzadas, e assinaturas diferentes para o mesmo erro fariam a contagem mentir.
 */
function assinatura(fonte, tipo, texto, onde) {
  const limpo = String(texto ?? '')
    .toLowerCase()
    .replace(/https?:\/\/[^\s)'"]+/g, (u) => u.replace(/[?#].*$/, ''))
    .replace(/0x[0-9a-f]+/g, '0x')
    .replace(/[0-9a-f]{8,}/gi, 'h')
    .replace(/\d+/g, 'n')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
  const lugar = String(onde ?? '').replace(/:\d+$/, '')
  return `${fonte}|${tipo}|${limpo}|${lugar}`
}

// ---------------------------------------------------------------- fontes

/** O feed que o `koda-dev-browser` publica. Ausente enquanto ninguém abriu o navegador. */
function lerFeedNavegador() {
  const caminho = join(DADOS, 'dev-browser-logs.json')
  if (!existsSync(caminho)) {
    return { ok: false, caminho, motivo: 'o MCP do Painel Dev ainda não abriu nenhuma página' }
  }
  try {
    const dados = JSON.parse(readFileSync(caminho, 'utf8'))
    const erros = Array.isArray(dados?.erros) ? dados.erros : []
    return { ok: true, caminho, url: dados?.url ?? null, erros }
  } catch (erro) {
    return { ok: false, caminho, motivo: `o feed do navegador está ilegível (${erro.message})` }
  }
}

/**
 * Os arquivos de log do servidor que este MCP considera.
 *
 * `KODA_DEV_SERVER_LOG` (aceita vários, separados por `;` ou `,`) manda; sem ele, olha só o
 * lugar convencionado: `data/dev-server.log` (e `data/server.log`). **Não varre o projeto.**
 *
 * A primeira versão procurava `dev.log`/`backend-dev.log` na raiz e o efeito foi o oposto do
 * pedido: um `dev.log` de semanas atrás entrou na lista e o painel encheu de erro de Vite que
 * não tinha nada a ver com o que estava sendo diagnosticado. Log de servidor é **o do alvo**
 * — quem sabe qual é é quem subiu o alvo, e é ele quem aponta a variável. Sem isso, "nenhum
 * log de servidor" é a resposta honesta.
 */
function arquivosDeServidor() {
  const doAmbiente = String(process.env.KODA_DEV_SERVER_LOG ?? '')
    .split(/[;,]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolve(p))
  if (doAmbiente.length) return doAmbiente

  const candidatos = [join(DADOS, 'dev-server.log'), join(DADOS, 'server.log')]
  return [...new Set(candidatos)].filter((c) => existsSync(c))
}

/**
 * Lê só o **fim** de um arquivo. Um log de servidor de horas pode ter centenas de MB, e ler
 * tudo a cada tique para aproveitar as últimas linhas é desperdício que trava o processo.
 */
function lerFim(caminho, bytes) {
  const tamanho = statSync(caminho).size
  const comeco = Math.max(0, tamanho - bytes)
  const quanto = tamanho - comeco
  if (quanto <= 0) return ''
  const buffer = Buffer.alloc(quanto)
  const fd = openSync(caminho, 'r')
  try {
    readSync(fd, buffer, 0, quanto, comeco)
  } finally {
    closeSync(fd)
  }
  return buffer.toString('utf8')
}

//: O que faz uma linha ser **início** de erro. Deliberadamente estreito: marcar toda linha com
//: a palavra "error" encheria o painel de falso positivo, e um painel que grita à toa é
//: ignorado — que é pior do que não ter painel.
const PADROES_ERRO = [
  /^\s*Traceback \(most recent call last\)/,
  /^\s*(ERROR|CRITICAL|FATAL|SEVERE)\b/,
  /\b(ERROR|CRITICAL|FATAL)\b\s*[:\-]/,
  /^\s*[A-Za-z_][A-Za-z0-9_.]*(Error|Exception)\s*:/,
  /\b(Unhandled|Uncaught)\b/i,
  /\b(TypeError|ReferenceError|SyntaxError|RangeError|KeyError|AttributeError|IndexError|ZeroDivisionError|ConnectionError|TimeoutError|OperationalError|IntegrityError|ProgrammingError)\b/,
  /HTTP\/1\.[01]"\s+5\d\d/,
  /\bstatus(?:_code)?["'\s:=]{1,4}5\d\d\b/i,
  /\[vite\].*\b(error|failed)\b/i,
  /\bError:\s/,
]

/** Uma linha de continuação: stack trace, `at ...`, `File "..."`, indentação de traceback. */
function ehContinuacao(linha) {
  if (!linha) return false
  if (/^\s+at\s/.test(linha)) return true
  if (/^\s+File\s+"/.test(linha)) return true
  if (/^\s{2,}\S/.test(linha)) return true
  return false
}

/** Tira arquivo e linha de um stack trace — Python (`File "x", line N`) ou JS (`at ... x:N:C`). */
function extrairLugar(texto) {
  const py = texto.match(/File\s+"([^"]+)",\s+line\s+(\d+)/)
  if (py) return { arquivo: py[1], linha: Number(py[2]) }
  const js = texto.match(/\(?([^\s()]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|vue|svelte)):(\d+):\d+\)?/)
  if (js) return { arquivo: js[1], linha: Number(js[2]) }
  return { arquivo: null, linha: null }
}

/**
 * Varre o log do servidor e devolve **só** os blocos de erro, agrupados.
 *
 * O bloco começa numa linha que casa um padrão de erro e engole as continuações (o stack
 * trace). É isso que dá o "arquivo e linha quando disponíveis" sem inventar: se o trace não
 * estiver no arquivo, `arquivo` sai nulo e a ferramenta diz que não veio.
 */
function varrerServidor() {
  const arquivos = arquivosDeServidor()
  if (!arquivos.length) {
    return {
      ok: false,
      motivo:
        'nenhum log de servidor encontrado — aponte KODA_DEV_SERVER_LOG para o arquivo, ou ' +
        'suba o servidor redirecionando a saída para data/dev-server.log',
      entradas: [],
      arquivos: [],
    }
  }

  // Agrupado **dentro da varredura**: o mesmo erro repetido 200 vezes no arquivo vira uma
  // entrada com `ocorrencias: 200`. Sem isto, uma falha em laço viraria 200 blocos e o painel
  // deixaria de ser legível — que é o defeito que este MCP existe para não ter.
  const porAssinatura = new Map()
  const lidos = []
  for (const caminho of arquivos) {
    let conteudo
    try {
      conteudo = lerFim(caminho, TAIL_BYTES)
    } catch {
      continue
    }
    lidos.push({ caminho, bytes: statSync(caminho).size })
    const linhas = conteudo.split(/\r?\n/)
    for (let i = 0; i < linhas.length; i++) {
      const linha = linhas[i]
      if (!PADROES_ERRO.some((p) => p.test(linha))) continue
      const bloco = [linha]
      let j = i + 1
      // No máximo 25 linhas de trace: o suficiente para a causa, longe de engolir o arquivo.
      while (j < linhas.length && bloco.length < 25 && ehContinuacao(linhas[j])) {
        bloco.push(linhas[j])
        j++
      }
      i = j - 1
      const texto = bloco.join('\n')
      const lugar = extrairLugar(texto)
      const horario = texto.match(/^\[?(\d{2}:\d{2}:\d{2})\]?/)
      const onde = lugar.arquivo ? `${lugar.arquivo}:${lugar.linha ?? '?'}` : ''
      const chave = assinatura('servidor', 'log', texto, onde)
      const existente = porAssinatura.get(chave)
      if (existente) {
        existente.ocorrencias += 1
        if (horario) existente.horario = horario[1]
        continue
      }
      porAssinatura.set(chave, {
        fonte: 'servidor',
        tipo: 'log',
        // Bloco de erro de servidor é grave por definição: ele só entrou aqui porque casou um
        // padrão de falha. A distinção leve/grave é do lado do navegador (aviso × erro).
        severidade: 'grave',
        texto: texto.slice(0, 1200),
        onde,
        arquivo: lugar.arquivo,
        linha: lugar.linha,
        horario: horario ? horario[1] : null,
        ocorrencias: 1,
        caminho_log: caminho,
      })
    }
  }
  return { ok: true, entradas: [...porAssinatura.values()], arquivos: lidos }
}

// ---------------------------------------------------------------- consolidação

/**
 * A "chave fraca": o mesmo problema visto por dois ângulos.
 *
 * O navegador relata uma falha de recurso **duas vezes** — uma no console ("Failed to load
 * resource: … status of 404") e outra na rede ("404 GET …"). São a mesma coisa, e mostrá-las
 * separadas é a duplicação que o pedido proíbe. Esta chave casa as duas pelo endereço, e a
 * entrada final fica com a da rede, que traz o status.
 */
function chaveFraca(item) {
  const texto = String(item.texto ?? '')
  const url = String(item.onde ?? '').trim() || (texto.match(/https?:\/\/[^\s)'"]+/) ?? [''])[0]
  if (!url) return null
  const status = (texto.match(/status of (\d{3})/) ?? texto.match(/\b(\d{3})\b/) ?? [])[1] ?? ''
  return `recurso|${url.replace(/[?#].*$/, '')}|${status}`
}

/**
 * Junta as duas fontes numa lista só, já sem repetição.
 *
 * Cada assinatura aparece **uma vez**, com `ocorrencias` somadas. `primeiro`/`ultimo` marcam a
 * janela em que o erro esteve acontecendo, e `novo` diz se ele nasceu depois do baseline — que
 * é a pergunta "a correção pegou?".
 */
function consolidar() {
  const feed = lerFeedNavegador()
  const servidor = varrerServidor()

  const mapa = new Map()
  const fracas = new Map()

  /** A memória entre chamadas: quando este MCP viu a assinatura pela primeira vez. */
  const anotarMemoria = (chave, primeiro) => {
    const memoria = vistas.get(chave)
    if (!memoria) vistas.set(chave, { primeiro })
    else if (primeiro < memoria.primeiro) memoria.primeiro = primeiro
  }

  const registrar = (item) => {
    const chave = assinatura(item.fonte, item.tipo, item.texto, item.onde)
    const ocorrencias = item.ocorrencias ?? 1
    const memoria = vistas.get(chave)
    // O `primeiro` do navegador é dele — ele sabe quando o erro nasceu. O do servidor não
    // existe no arquivo de forma confiável, então vale a primeira vez que **este** MCP o viu.
    const primeiro = item.primeiro ?? memoria?.primeiro ?? Date.now()
    const ultimo = item.ultimo ?? Date.now()

    const existente = mapa.get(chave)
    if (existente) {
      existente.ocorrencias += ocorrencias
      existente.primeiro = Math.min(existente.primeiro, primeiro)
      existente.ultimo = Math.max(existente.ultimo, ultimo)
      return
    }

    // O mesmo problema por outro ângulo não abre linha nova — soma na que já existe.
    const fraca = chaveFraca(item)
    if (fraca && fracas.has(fraca)) {
      const dono = mapa.get(fracas.get(fraca))
      if (dono) {
        dono.ocorrencias += ocorrencias
        dono.ultimo = Math.max(dono.ultimo, ultimo)
        // A da rede é mais informativa (traz o status); se ela chegar depois, ela manda.
        if (item.fonte === 'rede' && dono.fonte !== 'rede') {
          dono.fonte = item.fonte
          dono.tipo = item.tipo
          dono.severidade = item.severidade
          dono.texto = item.texto
          dono.onde = item.onde ?? dono.onde
        }
        return
      }
    }

    mapa.set(chave, {
      chave,
      fonte: item.fonte,
      tipo: item.tipo,
      severidade: item.severidade ?? 'grave',
      texto: item.texto,
      onde: item.onde ?? '',
      arquivo: item.arquivo ?? null,
      linha: item.linha ?? null,
      primeiro,
      ultimo,
      ocorrencias,
    })
    if (fraca) fracas.set(fraca, chave)
    anotarMemoria(chave, primeiro)
  }

  if (feed.ok) {
    for (const e of feed.erros) {
      registrar({
        fonte: e.fonte === 'rede' ? 'rede' : 'navegador',
        tipo: e.tipo,
        severidade: e.severidade,
        texto: e.texto,
        onde: e.onde,
        primeiro: e.primeiro,
        ultimo: e.ultimo,
        ocorrencias: e.ocorrencias,
      })
    }
  }
  for (const e of servidor.entradas) registrar(e)

  const erros = [...mapa.values()].map((e) => ({
    ...e,
    // `novo` = nasceu depois da marca. Vem do `primeiro` **da entrada**, não da memória: numa
    // recarga o feed do navegador devolve um `primeiro` novo para o erro que reapareceu, e é
    // isso que diz "o defeito continua aí" depois de uma correção.
    novo: e.primeiro > baseline,
    repetindo: e.ocorrencias >= REPETINDO_LIMITE,
  }))
  erros.sort((a, b) => b.ultimo - a.ultimo)
  return { erros, feed, servidor }
}

// ---------------------------------------------------------------- formatação

const ICONE = { grave: '✖', leve: '▲' }

function linhaDeErro(e, indice) {
  const marca = `${ICONE[e.severidade] ?? '•'} [${e.severidade}] ${e.fonte}/${e.tipo}`
  const contagem = e.ocorrencias > 1 ? `  ×${e.ocorrencias}${e.repetindo ? ' (repetindo — possível laço)' : ''}` : ''
  const novo = e.novo ? '  ⟵ novo' : ''
  const lugar = e.onde || (e.arquivo ? `${e.arquivo}:${e.linha ?? '?'}` : '')
  const corpo = String(e.texto).split('\n').slice(0, 6).join('\n    ')
  return `${indice}. ${marca}${contagem}${novo}\n    ${corpo}${lugar ? `\n    ↳ ${lugar}` : ''}`
}

function resumoTexto(erros) {
  const grave = erros.filter((e) => e.severidade === 'grave').length
  const leve = erros.filter((e) => e.severidade === 'leve').length
  const novos = erros.filter((e) => e.novo).length
  return `${erros.length} erro(s) — ${grave} grave(s), ${leve} leve(s)${baseline ? `, ${novos} novo(s) desde a marca` : ''}`
}

// ---------------------------------------------------------------- ferramentas

const FERRAMENTAS = [
  {
    name: 'erros',
    description:
      'A lista de erros do que o Painel Dev abriu, já **sem repetição**: console, exceções, ' +
      'HTTP 4xx/5xx, requisições que falharam **e** o log do servidor. Cada linha é uma ' +
      'assinatura única com contador (`×N`), então um erro em laço aparece uma vez. ' +
      '`desde: "baseline"` devolve só o que apareceu depois de `marcar` — é assim que se ' +
      'confere se a correção pegou. Se não houver erro, responde "nenhum erro" (e isso é ' +
      'resultado, não falha).',
    inputSchema: {
      type: 'object',
      properties: {
        fonte: {
          type: 'string',
          description: 'navegador | rede | servidor | todos (padrão: todos)',
        },
        severidade: { type: 'string', description: 'grave | leve | todas (padrão: todas)' },
        desde: { type: 'string', description: 'baseline = só o que é novo desde `marcar`' },
        limite: { type: 'number', description: `Máximo de entradas (padrão ${LIMITE_PADRAO}).` },
      },
    },
    async run(args) {
      const { erros, feed, servidor } = consolidar()
      const fonte = String(args?.fonte ?? 'todos').toLowerCase()
      const sev = String(args?.severidade ?? 'todas').toLowerCase()
      const limite = Math.min(Math.max(Number(args?.limite) || LIMITE_PADRAO, 1), 200)

      let uteis = erros
      if (fonte !== 'todos') uteis = uteis.filter((e) => e.fonte === fonte)
      if (sev === 'grave' || sev === 'leve') uteis = uteis.filter((e) => e.severidade === sev)
      if (String(args?.desde ?? '').toLowerCase() === 'baseline') uteis = uteis.filter((e) => e.novo)

      const cabecalho = []
      cabecalho.push(`fontes: navegador ${feed.ok ? 'ok' : 'ausente'} · servidor ${servidor.ok ? servidor.arquivos.length + ' arquivo(s)' : 'ausente'}`)
      if (!feed.ok) cabecalho.push(`  navegador: ${feed.motivo}`)
      if (!servidor.ok) cabecalho.push(`  servidor: ${servidor.motivo}`)

      if (!uteis.length) {
        const porque = String(args?.desde ?? '').toLowerCase() === 'baseline'
          ? 'nenhum erro **novo** desde a marca'
          : 'nenhum erro'
        return `${cabecalho.join('\n')}\n\n${porque}.`
      }
      const mostrados = uteis.slice(0, limite)
      const rodape = uteis.length > mostrados.length
        ? `\n\n… e mais ${uteis.length - mostrados.length} — refine com \`fonte\`/\`severidade\` ou aumente \`limite\`.`
        : ''
      return `${cabecalho.join('\n')}\n\n${resumoTexto(uteis)}\n\n${mostrados
        .map((e, i) => linhaDeErro(e, i + 1))
        .join('\n\n')}${rodape}`
    },
  },

  {
    name: 'resumo',
    description:
      'O retrato curto: quantos erros graves, quantos leves, quantos são novos desde a marca, ' +
      'e se alguma assinatura está repetindo (sinal de laço). Use antes de mergulhar na lista — ' +
      'responde "ainda tem erro?" com uma linha.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const { erros, feed, servidor } = consolidar()
      const grave = erros.filter((e) => e.severidade === 'grave').length
      const leve = erros.filter((e) => e.severidade === 'leve').length
      const novos = erros.filter((e) => e.novo).length
      const repetindo = erros.filter((e) => e.repetindo).length
      const estado = erros.length === 0 ? 'LIMPO — nenhum erro nas fontes lidas' : 'COM ERROS'
      return [
        `estado: ${estado}`,
        `graves: ${grave} · leves: ${leve} · total: ${erros.length}`,
        baseline ? `novos desde a marca: ${novos}` : 'sem marca — use `marcar` para separar o novo do antigo',
        repetindo ? `repetindo (possível laço): ${repetindo}` : 'nenhuma assinatura em laço',
        `navegador: ${feed.ok ? `${feed.erros.length} no feed` : feed.motivo}`,
        `servidor: ${servidor.ok ? servidor.arquivos.map((a) => a.caminho).join(', ') : servidor.motivo}`,
      ].join('\n')
    },
  },

  {
    name: 'servidor',
    description:
      'Só a ponta do servidor: os blocos de erro do log de trás (uvicorn/vite/node), com ' +
      'arquivo e linha quando o trace traz. É o que o console do navegador **não** mostra. ' +
      'Sem `filtro`, devolve tudo que casou; com `filtro`, só os blocos que contêm o texto.',
    inputSchema: {
      type: 'object',
      properties: {
        filtro: { type: 'string', description: 'Só blocos que contêm este texto.' },
        limite: { type: 'number', description: 'Máximo de blocos (padrão 20).' },
      },
    },
    async run(args) {
      const servidor = varrerServidor()
      if (!servidor.ok) return `servidor: ${servidor.motivo}`
      const filtro = String(args?.filtro ?? '').toLowerCase()
      const limite = Math.min(Math.max(Number(args?.limite) || 20, 1), 100)
      const uteis = servidor.entradas.filter(
        (e) => !filtro || e.texto.toLowerCase().includes(filtro),
      )
      if (!uteis.length) {
        return filtro
          ? `nenhum bloco de erro no log do servidor contendo "${filtro}".`
          : 'nenhum bloco de erro no log do servidor.'
      }
      const mostrados = uteis.slice(-limite)
      return `${uteis.length} bloco(s) — arquivos: ${servidor.arquivos
        .map((a) => a.caminho)
        .join(', ')}\n\n${mostrados
        .map((e, i) => {
          // O bloco já costuma começar com o próprio `[hora]`; repetir o horário aqui daria
          // `[12:51] [12:49] ERROR…`, que confunde mais do que informa.
          const cabeca = e.horario && !/^\s*\[/.test(e.texto) ? `[${e.horario}] ` : ''
          return `${i + 1}. ${cabeca}${e.texto.split('\n').slice(0, 8).join('\n    ')}`
        })
        .join('\n\n')}`
    },
  },

  {
    name: 'correlacionar',
    description:
      'Cruza as duas pontas: pega uma falha do navegador (a que você passar em `url`, ou a ' +
      'última falha de rede do feed) e procura o mesmo caminho no log do servidor. Responde ' +
      'se a falha tem causa no back ou se ela é **só do cliente** — e diz quando não achou ' +
      'nada em vez de chutar. É o passo que separa "o front quebrou" de "o servidor devolveu erro".',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL/path da requisição a correlacionar.' },
        status: { type: 'number', description: 'Status HTTP visto no front, se souber.' },
      },
    },
    async run(args) {
      const { erros, feed } = consolidar()
      // Prefere uma falha **grave** como alvo padrão: o 404 de favicon é o mais recente quase
      // sempre, e correlacioná-lo por padrão levaria a IA a investigar o que não importa.
      const deRede = erros.filter((e) => e.fonte === 'rede')
      const graves = deRede.filter((e) => e.severidade === 'grave')
      let url = String(args?.url ?? '').trim()
      let alvo = null
      if (!url) {
        alvo = graves[0] ?? deRede[0] ?? null
        if (!alvo) {
          return 'não há falha de rede no feed do navegador para correlacionar — passe `url` à mão se souber qual requisição falhou.'
        }
        const m = alvo.texto.match(/(?:https?:\/\/\S+|\/[^\s]*)/)
        url = m ? m[0] : ''
      }
      if (!url) return 'não consegui extrair uma URL — passe `url` explicitamente.'

      let caminho = url
      try {
        caminho = new URL(url, 'http://localhost').pathname
      } catch {
        /* já é um path */
      }
      const servidor = varrerServidor()
      const noServidor = servidor.ok
        ? servidor.entradas.filter((e) => e.texto.includes(caminho) || e.texto.includes(url))
        : []

      const cabeca = [
        `falha do navegador: ${alvo ? alvo.texto : url}`,
        `caminho procurado no servidor: ${caminho}`,
      ]
      if (!servidor.ok) {
        cabeca.push(`servidor: ${servidor.motivo}`)
        return `${cabeca.join('\n')}\n\nNão dá para correlacionar sem o log do servidor.`
      }
      if (!noServidor.length) {
        cabeca.push(
          '',
          'Nenhum bloco do log do servidor menciona esse caminho. Leitura honesta: a falha ' +
            'pode ser **só do cliente** (JS, CORS, rede, 4xx de contrato) — ou o servidor não ' +
            'registra esse caminho. Não conclua causa daqui; confira o log inteiro com `servidor`.',
        )
        return cabeca.join('\n')
      }
      cabeca.push('', `${noServidor.length} bloco(s) do servidor batem com o caminho:`)
      return (
        cabeca.join('\n') +
        '\n\n' +
        noServidor
          .slice(0, 10)
          .map((e, i) => `${i + 1}. ${e.horario ? `[${e.horario}] ` : ''}${e.texto.split('\n').slice(0, 6).join('\n    ')}`)
          .join('\n\n')
      )
    },
  },

  {
    name: 'marcar',
    description:
      'Fixa o baseline agora. Depois disto, `erros {desde: "baseline"}` mostra **só** o que ' +
      'apareceu depois — é o passo que prova que uma correção pegou. Marque **antes** de ' +
      'aplicar a correção (ou logo depois de reiniciar), nunca antes de reproduzir o erro.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      // **Antes** de fixar a marca: a semeadura do "já visto" tem de acontecer com o relógio
      // ainda atrás do baseline. Se fosse depois, o primeiro avistamento de um erro antigo
      // cairia à frente da marca e ele apareceria como "novo" — e a verificação mentiria.
      consolidar()
      baseline = Date.now()
      return `marca fixada em ${new Date(baseline).toISOString()}. A partir de agora, \`erros {desde: "baseline"}\` mostra só o que for novo.`
    },
  },

  {
    name: 'limpar',
    description:
      'Zera a memória deste MCP (assinaturas vistas e baseline). O feed do navegador e o log do ' +
      'servidor **não** são apagados — eles são de outros donos. Serve para recomeçar a contagem ' +
      'numa investigação nova.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      vistas.clear()
      baseline = 0
      return 'memória limpa: assinaturas e baseline zerados. As fontes continuam intactas.'
    },
  },

  {
    name: 'config',
    description:
      'De onde este MCP está lendo — caminhos, se existem, tamanho e idade. Use quando ' +
      '"nenhum erro" parecer suspeito: é assim que se descobre que o log do servidor não está ' +
      'apontado, em vez de concluir que o servidor está limpo.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const feed = lerFeedNavegador()
      const arquivos = arquivosDeServidor()
      const linhas = [`pasta de dados: ${DADOS}`, '', 'navegador (feed do koda-dev-browser):']
      if (feed.ok) {
        const idade = Math.round((Date.now() - statSync(feed.caminho).mtimeMs) / 1000)
        linhas.push(`  ok  ${feed.caminho}  (${feed.erros.length} erro(s), atualizado há ${idade}s)`)
      } else {
        linhas.push(`  ausente  ${feed.caminho}`)
        linhas.push(`  motivo: ${feed.motivo}`)
      }
      linhas.push('', 'servidor:')
      if (!arquivos.length) {
        linhas.push('  nenhum arquivo encontrado')
        linhas.push('  aponte KODA_DEV_SERVER_LOG, ou suba o servidor com a saída em data/dev-server.log')
      } else {
        for (const a of arquivos) {
          const t = statSync(a)
          linhas.push(`  ok  ${a}  (${Math.round(t.size / 1024)} KB)`)
        }
      }
      return linhas.join('\n')
    },
  },
]

// ---------------------------------------------------------------- espelho do painel

/**
 * Escreve `data/dev-logs.json` — o que o Painel Dev desenha na aba **Logs**.
 *
 * Em laço próprio, e não só quando a IA pergunta: o painel precisa da lista viva mesmo
 * enquanto ninguém chama ferramenta nenhuma. `unref()` para o relógio não segurar o processo —
 * quem manda nele é o `stdin` do MCP.
 */
function publicar() {
  try {
    const { erros, feed, servidor } = consolidar()
    writeFileSync(
      join(DADOS, 'dev-logs.json'),
      JSON.stringify(
        {
          atualizado: Date.now(),
          fontes: {
            navegador: feed.ok
              ? { ok: true, caminho: feed.caminho, url: feed.url ?? null }
              : { ok: false, caminho: feed.caminho, motivo: feed.motivo },
            servidor: servidor.ok
              ? { ok: true, arquivos: servidor.arquivos.map((a) => a.caminho) }
              : { ok: false, motivo: servidor.motivo },
          },
          resumo: {
            grave: erros.filter((e) => e.severidade === 'grave').length,
            leve: erros.filter((e) => e.severidade === 'leve').length,
            total: erros.length,
            novos: erros.filter((e) => e.novo).length,
            repetindo: erros.filter((e) => e.repetindo).length,
          },
          erros: erros.slice(0, 100).map((e) => ({
            chave: e.chave,
            fonte: e.fonte,
            tipo: e.tipo,
            severidade: e.severidade,
            texto: e.texto.slice(0, 600),
            onde: e.onde,
            primeiro: e.primeiro,
            ultimo: e.ultimo,
            ocorrencias: e.ocorrencias,
            repetindo: e.repetindo,
            novo: e.novo,
          })),
        },
        null,
        2,
      ),
      'utf8',
    )
  } catch (erro) {
    log('não consegui publicar os logs:', erro.message)
  }
}

const relogio = setInterval(publicar, 2000)
relogio.unref?.()
publicar()

// ---------------------------------------------------------------- protocolo MCP

const responder = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
const responderErro = (id, message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message } }) + '\n')

async function tratar(mensagem) {
  const { id, method, params } = mensagem

  if (method === 'initialize') {
    responder(id, {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'koda-dev-logs', version: '1.0.0' },
    })
    return
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (method === 'ping') {
    responder(id, {})
    return
  }
  if (method === 'tools/list') {
    responder(id, {
      tools: FERRAMENTAS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    })
    return
  }
  if (method === 'tools/call') {
    const ferramenta = FERRAMENTAS.find((f) => f.name === params?.name)
    if (!ferramenta) {
      responder(id, {
        content: [{ type: 'text', text: `não conheço a ferramenta "${params?.name}"` }],
        isError: true,
      })
      return
    }
    try {
      const texto = await ferramenta.run(params?.arguments ?? {})
      responder(id, { content: [{ type: 'text', text: String(texto) }] })
    } catch (erro) {
      responder(id, { content: [{ type: 'text', text: erro.message }], isError: true })
    }
    return
  }
  if (id !== undefined) responderErro(id, `método não suportado: ${method}`)
}

let sobra = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (pedaco) => {
  sobra += pedaco
  let quebra
  while ((quebra = sobra.indexOf('\n')) >= 0) {
    const linha = sobra.slice(0, quebra).trim()
    sobra = sobra.slice(quebra + 1)
    if (!linha) continue
    let mensagem
    try {
      mensagem = JSON.parse(linha)
    } catch {
      log('linha que não é JSON, ignorada')
      continue
    }
    void tratar(mensagem)
  }
})

process.stdin.on('end', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))

log('servidor pronto')
