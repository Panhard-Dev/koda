import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { criarCanal } from '../app/cursor_canal_koda.mjs'

test('canal envia e recebe quadros em uma conexão HTTP/2 fixa', () => {
  const eventos = [], escritas = []
  const pedido = new EventEmitter()
  pedido.write = bytes => escritas.push(Buffer.from(bytes))
  pedido.destroy = () => {}
  const cliente = new EventEmitter()
  cliente.request = headers => { assert.equal(headers[':path'], '/agent.v1.AgentService/Run'); return pedido }
  cliente.close = () => {}
  let fechado = false
  const canal = criarCanal({ conectar: origem => { assert.equal(origem, 'https://agent.api5.cursor.sh'); return cliente },
    enviar: dado => eventos.push(dado), encerrar: () => { fechado = true } })
  canal.receber(JSON.stringify({ tipo: 'iniciar', headers: { authorization: 'Bearer teste' }, frame: Buffer.from('inicio').toString('base64') }))
  pedido.emit('response', { ':status': 200 })
  pedido.emit('data', Buffer.from('resposta'))
  canal.receber(JSON.stringify({ tipo: 'quadro', frame: Buffer.from('continua').toString('base64') }))
  pedido.emit('end')
  assert.deepEqual(escritas.map(x => x.toString()), ['inicio', 'continua'])
  assert.deepEqual(eventos.map(x => x.tipo), ['status', 'dados', 'fim'])
  assert.equal(fechado, true)
})

test('recusa sobrescrita do destino HTTP/2', () => {
  const eventos = []
  const canal = criarCanal({ conectar: () => assert.fail('não deve conectar'), enviar: x => eventos.push(x), encerrar: () => {} })
  canal.receber(JSON.stringify({ tipo: 'iniciar', headers: { ':path': '/outro' }, frame: '' }))
  assert.equal(eventos[0].tipo, 'erro')
})
