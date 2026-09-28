/**
 * Gera `assets/icon.png` (1024×1024) — a coroa do Koda sobre um quadrado escuro
 * arredondado, no mesmo estilo da interface. PNG escrito à mão (RGBA + zlib):
 * nenhuma dependência de imagem, roda com `node scripts/gerar-icone.mjs`.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LADO = 1024
const RAIO = 190
const COROA = '#b040d0'
// Fundo com um degradê sutil, do topo para a base.
const FUNDO_TOPO = [28, 27, 34]
const FUNDO_BASE = [16, 15, 20]

// Coroa da logo (viewBox 810×580), centralizada e escalada para ~62% da largura.
const COROA_PONTOS = [
  [0, 520],
  [160, 520],
  [60, 140],
  [270, 310],
  [400, 80],
  [530, 310],
  [740, 140],
  [640, 520],
  [800, 520],
].map(([x, y]) => {
  const escala = (LADO * 0.62) / 810
  const largura = 810 * escala
  const altura = 580 * escala
  const desfazX = (LADO - largura) / 2
  const desfazY = (LADO - altura) / 2 - LADO * 0.02
  return [x * escala + desfazX, y * escala + desfazY]
})

const cor = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
]

/** True se o ponto está dentro do polígono (ray casting). */
function dentroDoPoligono(x, y, poligono) {
  let dentro = false
  for (let i = 0, j = poligono.length - 1; i < poligono.length; j = i++) {
    const [xi, yi] = poligono[i]
    const [xj, yj] = poligono[j]
    const cruza = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (cruza) dentro = !dentro
  }
  return dentro
}

/** Cobertura do quadrado arredondado no ponto (0..1), para as bordas suaves. */
function coberturaQuadrado(x, y) {
  const metade = LADO / 2
  const dx = Math.abs(x - metade) - (metade - RAIO)
  const dy = Math.abs(y - metade) - (metade - RAIO)
  const foraX = Math.max(dx, 0)
  const foraY = Math.max(dy, 0)
  const distFora = Math.hypot(foraX, foraY)
  const distDentro = Math.min(Math.max(dx, dy), 0)
  const distancia = distFora + distDentro - RAIO
  // 1 pixel de transição suave na borda.
  return Math.min(1, Math.max(0, 0.5 - distancia))
}

const pixels = Buffer.alloc(LADO * LADO * 4)
const [cr, cg, cb] = cor(COROA)

for (let y = 0; y < LADO; y += 1) {
  const fundoMix = y / (LADO - 1)
  for (let x = 0; x < LADO; x += 1) {
    const indice = (y * LADO + x) * 4
    const fundo = FUNDO_TOPO.map((topo, canal) =>
      Math.round(topo + (FUNDO_BASE[canal] - topo) * fundoMix),
    )
    const alfa = Math.round(coberturaQuadrado(x + 0.5, y + 0.5) * 255)

    let r = fundo[0]
    let g = fundo[1]
    let b = fundo[2]
    if (dentroDoPoligono(x + 0.5, y + 0.5, COROA_PONTOS)) {
      r = cr
      g = cg
      b = cb
    }

    pixels[indice] = r
    pixels[indice + 1] = g
    pixels[indice + 2] = b
    pixels[indice + 3] = alfa
  }
}

// ---- PNG (chunks IHDR/IDAT/IEND com CRC32) ---------------------------------
const tabelaCrc = (() => {
  const tabela = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let valor = n
    for (let k = 0; k < 8; k += 1) {
      valor = valor & 1 ? 0xedb88320 ^ (valor >>> 1) : valor >>> 1
    }
    tabela[n] = valor >>> 0
  }
  return tabela
})()

function crc32(dados) {
  let crc = 0xffffffff
  for (const byte of dados) crc = tabelaCrc[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(tipo, dados) {
  const corpo = Buffer.concat([Buffer.from(tipo, 'ascii'), dados])
  const tamanho = Buffer.alloc(4)
  tamanho.writeUInt32BE(dados.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(corpo))
  return Buffer.concat([tamanho, corpo, crc])
}

const larguraAltura = Buffer.alloc(8)
larguraAltura.writeUInt32BE(LADO, 0)
larguraAltura.writeUInt32BE(LADO, 4)

const ihdr = Buffer.concat([
  larguraAltura,
  Buffer.from([8, 6, 0, 0, 0]), // profundidade 8, RGBA, sem entrelaço
])

// Cada linha começa com o byte de filtro (0 = nenhum).
const brutas = Buffer.alloc(LADO * (LADO * 4 + 1))
for (let y = 0; y < LADO; y += 1) {
  pixels.copy(brutas, y * (LADO * 4 + 1) + 1, y * LADO * 4, (y + 1) * LADO * 4)
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(brutas, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

const destino = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icon.png')
mkdirSync(dirname(destino), { recursive: true })
writeFileSync(destino, png)
console.log(`ícone gerado em ${destino} (${png.length} bytes)`)
