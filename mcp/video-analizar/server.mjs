#!/usr/bin/env node
/**
 * MCP `video-analizar` — a análise de vídeo que a IA consulta.
 *
 * ## O que ele entrega, e o que não entrega
 *
 * Duas ferramentas: `analisar_video` (tudo) e `transcrever_video` (só a fala). As duas
 * devolvem **texto** — é o que o cliente do Koda sabe carregar de um MCP (ele traduz
 * `image` do resultado para `[imagem: mime]`, um marcador, então mandar quadro aqui
 * não faria o modelo ver nada).
 *
 * Por isso a divisão de Responsibility é esta:
 *
 * - **ver** o vídeo (quadro por quadro) → a pessoa **anexa** o vídeo na conversa; os
 *   quadros entram como imagem no contexto. É o caminho rico.
 * - **falar** do vídeo que está no disco → este MCP: transcrição com timestamps,
 *   metadados e os momentos (segundo + o que era falado ali).
 *
 * O texto de resposta sempre termina lembrando essa divisão. Não é enfeite: sem ela a
 * IA promete descrever um quadro que ela não viu.
 *
 * ## O motor é python
 *
 * Este servidor não implementa nada de vídeo: ele chama `elementos.py` nesta pasta,
 * que importa o motor do backend (`app/video.py`). Duas implementações de ffmpeg +
 * Whisper seriam duas implementações para divergir.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const AQUI = dirname(fileURLToPath(import.meta.url))
const RAIZ = resolve(AQUI, '..', '..')
const MOTOR = join(AQUI, 'elementos.py')
const BACKEND = join(RAIZ, 'backend')

const log = (...partes) => process.stderr.write(`[video-analizar] ${partes.join(' ')}\n`)

/**
 * O marcador que carrega um quadro até o contexto do modelo.
 *
 * O cliente do Koda lê este prefixo no resultado de qualquer ferramenta e troca a linha
 * por uma parte `image_url` de verdade no pedido do modelo — é assim que a IA **vê** o
 * quadro, em vez de receber o caminho de um JPG que ela não consegue abrir. O mesmo
 * marcador serve a qualquer MCP que queira devolver imagem.
 */
const MARCADOR_QUADRO = 'KODA_QUADRO:'

/** O python do venv do backend — o que tem faster-whisper instalado. */
function python() {
  const candidatos = [
    process.env.KODA_PYTHON,
    join(BACKEND, '.venv', 'Scripts', 'python.exe'),
    join(BACKEND, '.venv', 'bin', 'python'),
    'python',
  ].filter(Boolean)
  for (const candidato of candidatos) {
    if (candidato === 'python' || existsSync(candidato)) return candidato
  }
  return 'python'
}

/**
 * Roda o motor e devolve o resultado já como JSON.
 *
 * O pedido entra pelo `stdin` do filho e o resultado sai no `stdout` — o `stderr` do
 * motor (avisos do huggingface, barra de progresso) fica no `stderr` daqui, longe do
 * protocolo.
 */
function rodarMotor(pedido) {
  return new Promise((pronta, falha) => {
    const filho = spawn(python(), [MOTOR], { cwd: BACKEND })
    let saida = ''
    let erro = ''
    filho.stdout.on('data', (pedaco) => {
      saida += pedaco
    })
    filho.stderr.on('data', (pedaco) => {
      erro += pedaco
    })
    filho.on('error', (e) => falha(new Error(`não consegui rodar o motor: ${e.message}`)))
    filho.on('close', (codigo) => {
      if (codigo !== 0) {
        const linhas = erro
          .split('\n')
          .filter((l) => l && !l.includes('sitecustomize') && !l.includes('PermissionError'))
          .slice(-3)
          .join(' | ')
        return falha(new Error(linhas || `o motor caiu (código ${codigo})`))
      }
      try {
        pronta(JSON.parse(saida))
      } catch {
        falha(new Error('o motor devolveu o que não é JSON'))
      }
    })
    filho.stdin.end(JSON.stringify(pedido))
  })
}

/** O texto que a IA lê. Cada momento carrega o **frame como imagem**, via marcador. */
function formatar(resultado, comMomentos) {
  const linhas = []
  linhas.push(`VÍDEO: ${resultado.caminho}`)
  linhas.push(
    `Duração: ${resultado.duracao_s}s · ${resultado.largura}x${resultado.altura} · ${resultado.fps} fps`,
  )
  if (resultado.pergunta) linhas.push(`PERGUNTA da pessoa: ${resultado.pergunta}`)
  linhas.push('')

  const falas = resultado.transcricao ?? []
  if (falas.length) {
    linhas.push('TRANSCRIÇÃO do que é falado:')
    for (const f of falas) {
      linhas.push(`${Math.round(f.inicio)}s - ${Math.round(f.fim)}s: ${f.texto}`)
    }
  } else {
    linhas.push('TRANSCRIÇÃO: nenhuma fala reconhecida no áudio deste vídeo.')
  }

  if (comMomentos && Array.isArray(resultado.momentos)) {
    linhas.push('')
    linhas.push(`QUADROS (${resultado.momentos.length} — você está VENDO cada um deles):`)
    for (const m of resultado.momentos) {
      linhas.push(`- ${m.tempo_s}s${m.fala ? ` — fala: "${m.fala}"` : ''}`)
      // O marcador é o que faz o backend trocar isto por uma imagem de verdade no contexto
      // do modelo. **O `data:` URL tem de vir inteiro**: o `jpeg` que o motor devolve é o
      // base64 cru, e sem o prefixo `data:image/jpeg;base64,` o cliente não reconhece a
      // linha como imagem — ela sobrava como texto e o modelo via um bloco de base64 que
      // não consegue abrir (e ia tentar Pillow, ffmpeg, gravar arquivo…).
      // O mesmo vale para qualquer MCP que queira devolver imagem.
      if (m.jpeg) {
        const url = m.jpeg.startsWith('data:')
          ? m.jpeg
          : `data:image/jpeg;base64,${m.jpeg}`
        linhas.push(`${MARCADOR_QUADRO}${url}`)
      }
    }
  }

  linhas.push('')
  linhas.push(
    comMomentos
      ? 'Os quadros acima estão no seu contexto como imagem: descreva o que você VÊ em ' +
          'cada um, ligado ao segundo e à fala. Não diga que não consegue ver.'
      : 'Para VÊ-LOS, use `analisar_video` — ele traz os quadros como imagem.',
  )
  return linhas.join('\n')
}

const FERRAMENTAS = [
  {
    name: 'analisar_video',
    description:
      'Analisa um vídeo do disco de ponta a ponta: metadados, a transcrição do que é ' +
      'falado (com timestamps) e os QUADROS — cada um volta como IMAGEM no seu contexto, ' +
      'com o segundo dele e a fala daquele instante. Você VÊ os quadros: descreva o que ' +
      'aparece em cada um. Use quando a pessoa apontar um vídeo no disco e quiser saber ' +
      'o que é dito, o que acontece, ou pedir qualquer análise do conteúdo. ' +
      'Passos opcionais: "quadros" (quantos, 1-24, padrão 16 — mais quadros cobrem melhor ' +
      'o vídeo) e "pergunta" (o que a pessoa quer com o vídeo — volta amarrado no resultado).',
    inputSchema: {
      type: 'object',
      properties: {
        caminho: { type: 'string', description: 'caminho do vídeo no disco' },
        quadros: {
          type: 'integer',
          description: 'quantos quadros gerar (padrão 16, máx 24)',
        },
        pergunta: { type: 'string', description: 'o que a pessoa quer com o vídeo' },
      },
      required: ['caminho'],
    },
    run: async (args) => formatar(await rodarMotor({ ...args, so_transcricao: false }), true),
  },
  {
    name: 'transcrever_video',
    description:
      'Só a transcrição do que é falado num vídeo do disco, com timestamps. Mais barato ' +
      'que analisar_video (não gera quadros). Use quando a pergunta é apenas sobre o ' +
      'que é dito: "o que ele fala", "resume o vídeo", "o que é falado sobre X".',
    inputSchema: {
      type: 'object',
      properties: {
        caminho: { type: 'string', description: 'caminho do vídeo no disco' },
      },
      required: ['caminho'],
    },
    run: async (args) => formatar(await rodarMotor({ ...args, so_transcricao: true }), false),
  },
]

// ---------------------------------------------------------------- protocolo MCP

const responder = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
const responderErro = (id, message) =>
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message } }) + '\n',
  )

async function tratar(mensagem) {
  const { id, method, params } = mensagem

  if (method === 'initialize') {
    responder(id, {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'koda-video-analizar', version: '1.0.0' },
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
      tools: FERRAMENTAS.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
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

//: As chamadas em andamento. O `tools/call` é async — o motor python leva minutos — e
//: sair no `end` do stdin mataria a resposta no meio. Foi exatamente o defeito da
//: primeira versão: o `initialize` respondia na hora e passava, o `tools/call` morria
//: calado quando o pipe fechava.
const pendentes = new Set()

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
    const tarefa = tratar(mensagem)
    pendentes.add(tarefa)
    void tarefa.finally(() => pendentes.delete(tarefa))
  }
})

// O stdin fechou: espera o que está no ar. Sem pendência, o evento SOME sozinho.
process.stdin.on('end', () => {
  void Promise.allSettled([...pendentes]).then(() => process.exit(0))
})
process.on('SIGTERM', () => process.exit(0))

log('servidor pronto')
