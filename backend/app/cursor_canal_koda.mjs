/** Canal HTTP/2 do agente Cursor. Credenciais e quadros chegam somente pelo stdin. */
import http2 from 'node:http2'
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'

const ORIGEM = 'https://agent.api5.cursor.sh'
const CAMINHO = '/agent.v1.AgentService/Run'
const MAX_LINHA = 16 * 1024 * 1024

export function criarCanal({ conectar = http2.connect, enviar, encerrar }) {
  let cliente, pedido, iniciado = false, finalizado = false
  const emitir = dado => { if (!finalizado) enviar(dado) }
  const fechar = () => {
    if (finalizado) return
    finalizado = true
    pedido?.destroy()
    cliente?.close()
    encerrar()
  }
  const falhar = () => { emitir({ tipo: 'erro', detalhe: 'falha na conexão HTTP/2 com o Cursor' }); fechar() }
  function receber(linha) {
    let dado
    try { dado = JSON.parse(linha) } catch { falhar(); return }
    if (!iniciado) {
      if (dado?.tipo !== 'iniciar' || !dado.headers || typeof dado.headers !== 'object' ||
          Object.entries(dado.headers).some(([k, v]) => k.startsWith(':') || typeof v !== 'string' || /[\r\n]/.test(k + v)) ||
          typeof dado.frame !== 'string' || dado.frame.length > MAX_LINHA) { falhar(); return }
      iniciado = true
      try {
        cliente = conectar(ORIGEM)
        cliente.on('error', falhar)
        pedido = cliente.request({ ':method': 'POST', ':path': CAMINHO, ...dado.headers })
        pedido.on('error', falhar)
        pedido.on('response', headers => emitir({ tipo: 'status', status: Number(headers[':status'] || 0) }))
        pedido.on('data', chunk => emitir({ tipo: 'dados', dados: Buffer.from(chunk).toString('base64') }))
        pedido.on('end', () => { emitir({ tipo: 'fim' }); fechar() })
        pedido.write(Buffer.from(dado.frame, 'base64'))
      } catch { falhar() }
      return
    }
    if (dado?.tipo === 'quadro' && typeof dado.frame === 'string' && dado.frame.length <= MAX_LINHA) {
      try { pedido.write(Buffer.from(dado.frame, 'base64')) } catch { falhar() }
    } else if (dado?.tipo === 'fechar') fechar()
    else falhar()
  }
  return { receber, fechar }
}

async function main() {
  const linhas = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  const canal = criarCanal({ enviar: dado => process.stdout.write(JSON.stringify(dado) + '\n'), encerrar: () => linhas.close() })
  const prazo = setTimeout(() => { process.stdout.write(JSON.stringify({ tipo: 'erro', detalhe: 'Cursor demorou para responder' }) + '\n'); canal.fechar() }, 180000)
  try {
    for await (const linha of linhas) {
      if (linha.length > MAX_LINHA) { canal.fechar(); break }
      canal.receber(linha)
    }
  } finally { clearTimeout(prazo); canal.fechar() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
