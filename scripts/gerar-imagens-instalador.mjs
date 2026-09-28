/**
 * Gera as imagens da marca do instalador NSIS:
 *
 *   src-tauri/installer/sidebar.bmp  164×314  (Bem-vindo e Concluído)
 *   src-tauri/installer/header.bmp   150×57   (faixa das páginas internas)
 *
 * O Tauri lê os dois caminhos de `bundle.windows.nsis` no `tauri.conf.json`, e o NSIS
 * (MUI2) só aceita **BMP 24 bits sem compressão** — daí não ser PNG. Como no
 * `gerar-icone.mjs`, o arquivo sai escrito à mão: nenhuma dependência de imagem.
 *
 * A marca é a mesma do app: a coroa roxa (#b040d0) sobre o fundo escuro do tema, com um
 * brilho suave atrás dela. O texto é um tipo de letra 5×7 desenhado aqui dentro, porque não
 * existe fonte no Node — em duas cores fixas ele fica legível e nada de sistema entra no
 * visual do instalador. Rode com `node scripts/gerar-imagens-instalador.mjs`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..')
const DESTINO = join(RAIZ, 'src-tauri', 'installer')

/** Cor da marca: a mesma do `KodaLogo` e do ícone. */
const COROA = [176, 64, 208]
/** Fundo do tema, do topo para a base (mesma paleta do `gerar-icone.mjs`). */
const FUNDO_TOPO = [30, 29, 37]
const FUNDO_BASE = [10, 10, 13]
/** Branco levemente quente do texto, o mesmo `koda-fg` da interface. */
const TEXTO = [231, 229, 238]

/** Coroa da logo (viewBox 810×580) na posição e no tamanho pedidos. */
function coroa(x, y, largura) {
  const escala = largura / 810
  const pontos = [
    [0, 520], [160, 520], [60, 140], [270, 310], [400, 80],
    [530, 310], [740, 140], [640, 520], [800, 520],
  ].map(([px, py]) => [x + px * escala, y + py * escala])
  return { pontos, altura: 580 * escala }
}

/** True se (x, y) cai dentro do polígono (ray casting). */
function dentro(x, y, pontos) {
  let dentro = false
  for (let i = 0, j = pontos.length - 1; i < pontos.length; j = i++) {
    const [xi, yi] = pontos[i]
    const [xj, yj] = pontos[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dentro = !dentro
  }
  return dentro
}

/**
 * Cobertura do polígono no pixel (0..1), com 3×3 amostras.
 *
 * Sem isso a borda da coroa sai serrilhada: em 164 px de largura o degrau de 1 pixel
 * aparece. São 78 px de polígono contra 9 amostras — instantâneo, e a borda fica limpa.
 */
function cobertura(x, y, pontos) {
  let acertos = 0
  for (let sy = 0; sy < 3; sy += 1) {
    for (let sx = 0; sx < 3; sx += 1) {
      if (dentro(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3, pontos)) acertos += 1
    }
  }
  return acertos / 9
}

/** Tela de pintura: RGB de cima para baixo, como o olho lê (o BMP inverte na hora de sair). */
class Tela {
  constructor(largura, altura) {
    this.largura = largura
    this.altura = altura
    this.pixels = new Float64Array(largura * altura * 3)
  }

  pinta(x, y, [r, g, b]) {
    if (x < 0 || y < 0 || x >= this.largura || y >= this.altura) return
    const i = (y * this.largura + x) * 3
    this.pixels[i] = r
    this.pixels[i + 1] = g
    this.pixels[i + 2] = b
  }

  /** Mistura a cor sobre o que já está no pixel. */
  mistura(x, y, cor, alfa) {
    const i = (y * this.largura + x) * 3
    for (let c = 0; c < 3; c += 1) {
      this.pixels[i + c] = this.pixels[i + c] * (1 - alfa) + cor[c] * alfa
    }
  }

  /** Degradê vertical do topo para a base. */
  fundo() {
    for (let y = 0; y < this.altura; y += 1) {
      const t = y / (this.altura - 1)
      const cor = FUNDO_TOPO.map((topo, c) => topo + (FUNDO_BASE[c] - topo) * t)
      for (let x = 0; x < this.largura; x += 1) this.pinta(x, y, cor)
    }
  }

  /** Brilho radial que dá profundidade atrás da coroa. */
  brilho(cx, cy, raio, forca) {
    for (let y = 0; y < this.altura; y += 1) {
      for (let x = 0; x < this.largura; x += 1) {
        const d = Math.hypot(x - cx, y - cy)
        if (d > raio) continue
        const queda = 1 - d / raio
        this.mistura(x, y, COROA, queda * queda * forca)
      }
    }
  }

  /** Coroa com borda suave. Devolve a altura desenhada. */
  desenhaCoroa(x, y, largura, alfa = 1) {
    const { pontos, altura } = coroa(x, y, largura)
    for (let py = Math.floor(y); py <= Math.ceil(y + altura); py += 1) {
      for (let px = Math.floor(x); px <= Math.ceil(x + largura); px += 1) {
        const c = cobertura(px, py, pontos)
        if (c > 0) this.mistura(px, py, COROA, c * alfa)
      }
    }
    return altura
  }

  /** Um traço reto horizontal. */
  traco(x, y, largura, espessura, cor, alfa = 1) {
    for (let py = y; py < y + espessura; py += 1) {
      for (let px = x; px < x + largura; px += 1) this.mistura(px, py, cor, alfa)
    }
  }
}

// ---- tipo de letra 5×7 -----------------------------------------------------
// Só as quatro letras do nome da marca. Cada string é uma linha, de cima para baixo.
const LETRAS = {
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
}
const LETRA_LARGURA = 5
const LETRA_ALTURA = 7
/** Espaço entre letras, em pixels do desenho (antes da escala). */
const LETRA_ESPACO = 2

/** Largura total de um texto, no desenho sem escala. */
function larguraTexto(texto, espaco = LETRA_ESPACO) {
  return texto.length * LETRA_LARGURA + (texto.length - 1) * espaco
}

/** Escreve o texto com pixels quadrados de lado `escala`. Devolve a largura desenhada. */
function escreve(tela, texto, x, y, escala, cor, espaco = LETRA_ESPACO) {
  let cursor = x
  for (const caractere of texto) {
    const linhas = LETRAS[caractere]
    if (!linhas) {
      cursor += (LETRA_LARGURA + espaco) * escala
      continue
    }
    for (let ly = 0; ly < LETRA_ALTURA; ly += 1) {
      for (let lx = 0; lx < LETRA_LARGURA; lx += 1) {
        if (linhas[ly][lx] !== '1') continue
        for (let py = 0; py < escala; py += 1) {
          for (let px = 0; px < escala; px += 1) {
            tela.pinta(cursor + lx * escala + px, y + ly * escala + py, cor)
          }
        }
      }
    }
    cursor += (LETRA_LARGURA + espaco) * escala
  }
  return cursor - x - espaco * escala
}

// ---- BMP -------------------------------------------------------------------
/**
 * BMP 24 bits sem compressão (BITMAPINFOHEADER, linhas de baixo para cima).
 *
 * As linhas têm que terminar em múltiplo de 4 bytes: 164 px de largura fecham sozinhas
 * (492), 150 px pedem 2 bytes de enchimento (452).
 */
function bmp(tela) {
  const { largura, altura } = tela
  const passo = Math.ceil((largura * 3) / 4) * 4
  const dados = Buffer.alloc(passo * altura)
  for (let y = 0; y < altura; y += 1) {
    const destino = (altura - 1 - y) * passo
    for (let x = 0; x < largura; x += 1) {
      const i = (y * largura + x) * 3
      // BMP guarda BGR.
      dados[destino + x * 3] = Math.round(Math.min(255, Math.max(0, tela.pixels[i + 2])))
      dados[destino + x * 3 + 1] = Math.round(Math.min(255, Math.max(0, tela.pixels[i + 1])))
      dados[destino + x * 3 + 2] = Math.round(Math.min(255, Math.max(0, tela.pixels[i])))
    }
  }

  const cabecalho = Buffer.alloc(14)
  cabecalho.write('BM', 0, 'ascii')
  cabecalho.writeUInt32LE(14 + 40 + dados.length, 2)
  cabecalho.writeUInt32LE(54, 10) // onde os pixels começam

  const info = Buffer.alloc(40)
  info.writeUInt32LE(40, 0)
  info.writeInt32LE(largura, 4)
  info.writeInt32LE(altura, 8)
  info.writeUInt16LE(1, 12) // planos
  info.writeUInt16LE(24, 14) // bits por pixel
  info.writeUInt32LE(0, 16) // sem compressão
  info.writeUInt32LE(dados.length, 20)
  info.writeInt32LE(2835, 24) // 72 dpi, tanto na horizontal quanto na vertical
  info.writeInt32LE(2835, 28)

  return Buffer.concat([cabecalho, info, dados])
}

// ---- as duas imagens -------------------------------------------------------

/** Painel da lateral (164×314): coroa grande, brilho atrás e o nome embaixo. */
function lateral() {
  const largura = 164
  const altura = 314
  const tela = new Tela(largura, altura)
  tela.fundo()
  tela.brilho(largura / 2, 136, 104, 0.3)

  const escala = 2
  const texto = larguraTexto('KODA')
  const coroaLargura = 84
  const vao = 20
  const bloco = coroaLargura * (580 / 810) + vao + LETRA_ALTURA * escala
  const topo = Math.round((altura - bloco) / 2)
  const alturaCoroa = tela.desenhaCoroa((largura - coroaLargura) / 2, topo, coroaLargura)
  escreve(
    tela,
    'KODA',
    Math.round((largura - texto * escala) / 2),
    Math.round(topo + alturaCoroa + vao),
    escala,
    TEXTO,
  )

  // Fio roxo no pé do painel, para o quadrado não terminar sem assinatura.
  tela.traco(0, altura - 3, largura, 3, COROA, 0.9)
  return tela
}

/** Faixa do cabeçalho (150×57): coroa menor ao lado do nome, sobre a mesma base escura. */
function cabecalho() {
  const largura = 150
  const altura = 57
  const tela = new Tela(largura, altura)
  tela.fundo()
  tela.brilho(38, altura / 2, 60, 0.22)

  const escala = 2
  const texto = larguraTexto('KODA') * escala
  const coroaLargura = 32
  const coroaAltura = coroaLargura * (580 / 810)
  const vao = 11
  const inicio = Math.round((largura - (coroaLargura + vao + texto)) / 2)
  // O centro da coroa é o centro do texto: sem isso a coroa fica boiando acima da linha.
  const meio = altura / 2
  tela.desenhaCoroa(inicio, meio - coroaAltura / 2, coroaLargura)
  escreve(
    tela,
    'KODA',
    inicio + coroaLargura + vao,
    Math.round(meio - (LETRA_ALTURA * escala) / 2),
    escala,
    TEXTO,
  )

  // Fio roxo no pé: amarra a faixa ao painel lateral e à cor da marca.
  tela.traco(0, altura - 3, largura, 3, COROA, 0.9)
  return tela
}

mkdirSync(DESTINO, { recursive: true })
for (const [nome, imagem] of [
  ['sidebar.bmp', lateral()],
  ['header.bmp', cabecalho()],
]) {
  const arquivo = bmp(imagem)
  const caminho = join(DESTINO, nome)
  writeFileSync(caminho, arquivo)
  console.log(`imagem do instalador gerada em ${caminho} (${imagem.largura}×${imagem.altura}, ${arquivo.length} bytes)`)
}
