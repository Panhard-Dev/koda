/**
 * Os blocos visuais do Koda no celular.
 *
 * ## O problema
 *
 * O PC desenha `koda-grafico`, `koda-visual`, `koda-plano` e companhia com
 * `src/components/BlocosVisuais.tsx`. O celular recebia o mesmo SSE e mostrava o JSON cru
 * dentro de um `<pre>` — a resposta estava certa e parecia um erro.
 *
 * ## O contrato é o mesmo do PC
 *
 * A IA manda DADOS, não desenho: um bloco ```koda-*``` com um JSON dentro. Aqui o JSON vira
 * SVG/HTML de verdade, com a mesma leitura tolerante do renderizador do PC (chave faltando,
 * número como texto, JSON com rabicho depois do `}`). O que muda é a largura: tudo nasce
 * pensado para ~320px de bolha, com tabela rolando na horizontal e gráfico de barras
 * deitando sozinho quando o rótulo não cabe.
 *
 * ## Sem `innerHTML`
 *
 * Todo texto do modelo entra por `textContent`. Um `innerHTML` aqui transformaria a resposta
 * da IA em HTML executável dentro do app — exatamente o risco que o PC evita ao desenhar com
 * React. O desenho é montado nó a nó, e o que a IA escreve nunca vira marcação.
 */

const NS = 'http://www.w3.org/2000/svg'

/** Um nó HTML com classe e texto. Texto do modelo só entra por aqui. */
function no(tag, classe, texto) {
  const elemento = document.createElement(tag)
  if (classe) elemento.className = classe
  if (texto !== undefined && texto !== null) elemento.textContent = String(texto)
  return elemento
}

/** Um nó SVG com atributos. `class` também é atributo. */
function s(tag, atributos = {}) {
  const elemento = document.createElementNS(NS, tag)
  for (const [chave, valor] of Object.entries(atributos)) {
    if (valor !== null && valor !== undefined) elemento.setAttribute(chave, String(valor))
  }
  return elemento
}

// ---------------------------------------------------------------- leitura tolerante

function texto(valor, padrao = '') {
  if (valor === null || valor === undefined) return padrao
  if (typeof valor === 'string') return valor
  if (typeof valor === 'number' || typeof valor === 'boolean') return String(valor)
  return padrao
}

/** Número de um valor que pode ter vindo como texto ("1.200", "45%", "R$ 30"). */
function numero(valor) {
  if (typeof valor === 'number' && Number.isFinite(valor)) return valor
  if (typeof valor === 'string') {
    const limpo = valor.replace(/\s|%|R\$/g, '')
    const normalizado =
      limpo.includes(',') && limpo.includes('.')
        ? limpo.replace(/\./g, '').replace(',', '.')
        : limpo.replace(',', '.')
    const n = Number(normalizado)
    if (Number.isFinite(n)) return n
  }
  return 0
}

function pontos(bruto) {
  if (bruto && typeof bruto === 'object' && !Array.isArray(bruto)) {
    // Listas paralelas: {labels: [...], values: [...]} (o modelo manda dos dois jeitos).
    const rotulos = bruto.labels ?? bruto.rotulos
    const valores = bruto.values ?? bruto.valores
    if (Array.isArray(rotulos) && Array.isArray(valores)) {
      return rotulos
        .map((rotulo, indice) => ({ rotulo: texto(rotulo), valor: numero(valores[indice]) }))
        .filter((item) => item.rotulo !== '' || item.valor !== 0)
    }
    // Ou a lista embutida num objeto: {valores: [...]} etc.
    for (const chave of ['valores', 'values', 'items', 'series', 'dados', 'data', 'pontos', 'points']) {
      if (Array.isArray(bruto[chave])) {
        const achou = pontos(bruto[chave])
        if (achou.length) return achou
      }
    }
    return []
  }
  // Listas paralelas de duas colunas: [[rotulo, valor], ...]
  if (Array.isArray(bruto) && bruto.length && Array.isArray(bruto[0])) {
    return bruto
      .map((item) => ({ rotulo: texto(item[0]), valor: numero(item[1]) }))
      .filter((item) => item.rotulo !== '' || item.valor !== 0)
  }
  if (!Array.isArray(bruto)) return []
  const saida = []
  for (const item of bruto) {
    if (typeof item !== 'object' || item === null) continue
    /** @type {{ rotulo: string, valor: number, valor2?: number, tamanho?: number, grupo?: string }} */
    const ponto = {
      rotulo: texto(item.rotulo ?? item.label ?? item.nome ?? item.name ?? item.x),
      valor: numero(item.valor ?? item.value ?? item.y ?? item.total),
    }
    if (item.valor2 !== undefined || item.y2 !== undefined) {
      ponto.valor2 = numero(item.valor2 ?? item.y2)
    }
    if (item.tamanho !== undefined || item.size !== undefined) {
      ponto.tamanho = numero(item.tamanho ?? item.size)
    }
    const grupo = texto(item.grupo ?? item.group ?? item.serie ?? item.categoria)
    if (grupo) ponto.grupo = grupo
    if (ponto.rotulo !== '' || ponto.valor !== 0) saida.push(ponto)
  }
  return saida
}

function ramos(bruto, profundidade = 0) {
  if (!Array.isArray(bruto) || profundidade > 6) return []
  return bruto
    .map((item) => {
      if (typeof item === 'string') return { texto: item }
      if (typeof item !== 'object' || item === null) return null
      const filhos = ramos(item.filhos ?? item.children ?? item.itens, profundidade + 1)
      const nome = texto(item.texto ?? item.label ?? item.nome ?? item.name ?? item.titulo)
      return nome ? { texto: nome, ...(filhos.length ? { filhos } : {}) } : null
    })
    .filter(Boolean)
}

function elos(bruto) {
  if (!Array.isArray(bruto)) return []
  return bruto
    .map((item) => {
      if (typeof item !== 'object' || item === null) return null
      const de = texto(item.de ?? item.from ?? item.origem ?? item.source)
      const para = texto(item.para ?? item.to ?? item.destino ?? item.target)
      if (!de || !para) return null
      return { de, para, valor: numero(item.valor ?? item.value ?? item.peso ?? item.weight) }
    })
    .filter(Boolean)
}

function fmt(valor) {
  return Number(valor || 0).toLocaleString('pt-BR')
}

function cor(i) {
  return `kb-tom-${i % 8}`
}

// ---------------------------------------------------------------- interação

/**
 * Toque para acender um elemento e apagar o resto.
 *
 * No PC isso é o `useInteracao`; aqui é só uma classe no `<figure>` — o CSS apaga os
 * irmãos. Um segundo toque devolve tudo. Não é enfeite: num gráfico de pizza de 320px, o
 * toque é a única forma de dizer "é esta fatia".
 */
function destacavel(fig, elemento) {
  elemento.classList.add('kb-item')
  elemento.addEventListener('click', (evento) => {
    evento.stopPropagation()
    elemento.classList.toggle('kb-item--aceso')
    fig.classList.toggle('kb--tem-aceso', Boolean(fig.querySelector('.kb-item--aceso')))
  })
}

// ---------------------------------------------------------------- moldura

function moldura(titulo, legenda, corpo) {
  const fig = no('figure', 'kb')
  if (titulo) fig.append(no('figcaption', 'kb__titulo', titulo))
  const caixa = no('div', 'kb__corpo')
  caixa.append(corpo)
  fig.append(caixa)
  if (legenda) fig.append(no('p', 'kb__legenda', legenda))
  return fig
}

function naoEntendi(motivo, bruto) {
  const caixa = no('div', 'kb-erro')
  caixa.append(no('p', 'kb-erro__titulo', `Não consegui desenhar este bloco: ${motivo}`))
  if (bruto) {
    const pre = no('pre', 'kb-erro__bruto', String(bruto).slice(0, 300))
    caixa.append(pre)
  }
  return caixa
}

// ---------------------------------------------------------------- barras

function barras(dados, horizontal) {
  const fig = no('figure', 'kb')
  const corpo = no('div', 'kb__corpo')
  fig.append(corpo)

  const maximo = Math.max(...dados.map((d) => Math.abs(d.valor)), 1)
  // No celular a barra em pé só funciona com rótulo curto e pouca série. Rótulo longo
  // vira três letras e reticências; deitada, ele cabe inteiro. O PC não precisa disso
  // porque tem 700px de largura.
  const maiorRotulo = Math.max(...dados.map((d) => d.rotulo.length), 0)
  const deitado = horizontal === true || dados.length > 7 || maiorRotulo > 9

  if (deitado) {
    const lista = no('div', 'kb-hbarras')
    dados.forEach((ponto, i) => {
      const linha = no('div', 'kb-hbarras__linha')
      const rotulo = no('span', 'kb-hbarras__rotulo', ponto.rotulo)
      rotulo.title = ponto.rotulo
      const trilha = no('span', 'kb-hbarras__trilha')
      const barra = no('span', `kb-hbarras__barra ${cor(i)}`)
      barra.style.width = `${Math.max((Math.abs(ponto.valor) / maximo) * 100, 1.5)}%`
      trilha.append(barra)
      const valor = no('span', 'kb-hbarras__valor', fmt(ponto.valor))
      linha.append(rotulo, trilha, valor)
      destacavel(fig, linha)
      lista.append(linha)
    })
    corpo.append(lista)
    return fig
  }

  const linha = no('div', 'kb-barras')
  dados.forEach((ponto, i) => {
    const coluna = no('div', 'kb-barras__col')
    coluna.append(no('span', 'kb-barras__valor', fmt(ponto.valor)))
    const trilha = no('div', 'kb-barras__trilha')
    const barra = no('div', `kb-barras__barra ${cor(i)}`)
    barra.style.height = `${Math.max((Math.abs(ponto.valor) / maximo) * 100, 2)}%`
    trilha.append(barra)
    const rotulo = no('span', 'kb-barras__rotulo', ponto.rotulo)
    rotulo.title = ponto.rotulo
    coluna.append(trilha, rotulo)
    destacavel(fig, coluna)
    linha.append(coluna)
  })
  corpo.append(linha)
  return fig
}

// ---------------------------------------------------------------- empilhadas

function empilhadas(dados, series) {
  const fig = no('figure', 'kb')
  const corpo = no('div', 'kb__corpo')
  fig.append(corpo)

  const totais = dados.map((d) => Math.abs(d.valor) + Math.abs(d.valor2 ?? 0))
  const maximo = Math.max(...totais, 1)
  const linha = no('div', 'kb-barras')

  dados.forEach((ponto, i) => {
    const coluna = no('div', 'kb-barras__col')
    const trilha = no('div', 'kb-barras__trilha kb-barras__trilha--empilhada')
    const partes = [Math.abs(ponto.valor), Math.abs(ponto.valor2 ?? 0)]
    // A série 0 fica embaixo, como no PC: o topo é a segunda.
    for (let k = partes.length - 1; k >= 0; k -= 1) {
      const fatia = no('div', `kb-barras__fatia ${cor(k)}`)
      fatia.style.height = `${(partes[k] / maximo) * 100}%`
      trilha.append(fatia)
    }
    const rotulo = no('span', 'kb-barras__rotulo', ponto.rotulo)
    rotulo.title = ponto.rotulo
    coluna.append(no('span', 'kb-barras__valor', fmt(totais[i])), trilha, rotulo)
    destacavel(fig, coluna)
    linha.append(coluna)
  })
  corpo.append(linha)

  if (series.length) {
    const legenda = no('ul', 'kb-legenda')
    series.forEach((nome, k) => {
      const item = no('li', 'kb-legenda__item')
      item.append(no('span', `kb-legenda__ponto ${cor(k)}`), document.createTextNode(nome))
      legenda.append(item)
    })
    corpo.append(legenda)
  }
  return fig
}

// ---------------------------------------------------------------- linhas e área

let sequenciaGradiente = 0

function linhas(dados, area) {
  if (dados.length < 2) return barras(dados, true)

  const fig = no('figure', 'kb')
  const corpo = no('div', 'kb__corpo')
  fig.append(corpo)

  const L = 100
  const A = 40
  const valores = dados.map((d) => d.valor)
  const menor = Math.min(...valores, 0)
  const maior = Math.max(...valores, 1)
  const faixa = maior - menor || 1
  const x = (i) => (i / (dados.length - 1)) * L
  const y = (v) => A - ((v - menor) / faixa) * (A - 6) - 3
  const caminho = dados
    .map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)} ${y(d.valor).toFixed(2)}`)
    .join(' ')
  const fecho = `${caminho} L${L} ${A} L0 ${A} Z`

  const desenho = s('svg', {
    viewBox: `-1 -3 ${L + 2} ${A + 4}`,
    class: 'kb-svg kb-svg--linhas',
  })

  const id = `kb-area-${(sequenciaGradiente += 1)}`
  const defs = s('defs')
  const gradiente = s('linearGradient', { id, x1: '0', y1: '0', x2: '0', y2: '1' })
  gradiente.append(
    s('stop', { offset: '0%', 'stop-color': '#a78bfa', 'stop-opacity': '0.32' }),
    s('stop', { offset: '100%', 'stop-color': '#a78bfa', 'stop-opacity': '0' }),
  )
  defs.append(gradiente)
  desenho.append(defs)

  for (const fracao of [0, 0.25, 0.5, 0.75, 1]) {
    desenho.append(
      s('line', {
        x1: 0,
        x2: L,
        y1: y(menor + faixa * fracao),
        y2: y(menor + faixa * fracao),
        stroke: 'rgb(255 255 255 / 10%)',
        'stroke-width': 0.4,
        'stroke-dasharray': '1.5 1.5',
      }),
    )
  }

  if (area !== false) desenho.append(s('path', { d: fecho, fill: `url(#${id})` }))
  desenho.append(
    s('path', {
      d: caminho,
      fill: 'none',
      stroke: '#a78bfa',
      'stroke-width': 1.6,
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
      'vector-effect': 'non-scaling-stroke',
    }),
  )
  dados.forEach((ponto, i) => {
    const marcador = s('circle', {
      cx: x(i),
      cy: y(ponto.valor),
      r: 1.9,
      fill: '#a78bfa',
      'vector-effect': 'non-scaling-stroke',
    })
    const titulo = s('title')
    titulo.textContent = `${ponto.rotulo}: ${fmt(ponto.valor)}`
    marcador.append(titulo)
    desenho.append(marcador)
    // No PC o valor exato aparece no balão do mouse. No celular não há mouse: com poucos
    // pontos, o número fica escrito acima da bolinha.
    if (dados.length <= 8) {
      const valor = s('text', {
        x: x(i),
        y: y(ponto.valor) - 2.6,
        'font-size': 3.2,
        'text-anchor': 'middle',
        class: 'kb-svg__medio',
      })
      valor.textContent = fmt(ponto.valor)
      desenho.append(valor)
    }
  })
  corpo.append(desenho)

  const rotulos = no('div', 'kb-eixo-x')
  dados.forEach((ponto) => {
    const rotulo = no('span', 'kb-eixo-x__rotulo', ponto.rotulo)
    rotulo.title = ponto.rotulo
    rotulos.append(rotulo)
  })
  corpo.append(rotulos)
  return fig
}

// ---------------------------------------------------------------- pizza / rosca

function pizza(dados, rosca) {
  const total = dados.reduce((soma, d) => soma + Math.abs(d.valor), 0)
  if (total <= 0) return barras(dados, true)

  const fig = no('figure', 'kb')
  const corpo = no('div', 'kb__corpo kb__corpo--pizza')
  fig.append(corpo)

  let angulo = -90
  const fatias = dados.map((ponto, i) => {
    const fatia = (Math.abs(ponto.valor) / total) * 360
    const inicio = angulo
    angulo += fatia
    const rad = (grau) => (grau * Math.PI) / 180
    const x1 = 50 + 48 * Math.cos(rad(inicio))
    const y1 = 50 + 48 * Math.sin(rad(inicio))
    const x2 = 50 + 48 * Math.cos(rad(angulo))
    const y2 = 50 + 48 * Math.sin(rad(angulo))
    const grande = fatia > 180 ? 1 : 0
    const caminho =
      fatia >= 359.9
        ? 'M50 2 A48 48 0 1 1 49.99 2 Z'
        : `M50 50 L${x1.toFixed(2)} ${y1.toFixed(2)} A48 48 0 ${grande} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`
    return { caminho, ponto, fracao: Math.abs(ponto.valor) / total, i }
  })

  const desenho = s('svg', { viewBox: '0 0 100 100', class: 'kb-svg kb-svg--pizza' })
  fatias.forEach((fatia) => {
    const caminho = s('path', {
      d: fatia.caminho,
      class: `${cor(fatia.i)} kb-pizza__fatia`,
      fill: 'currentColor',
    })
    destacavel(fig, caminho)
    desenho.append(caminho)
  })
  if (rosca) {
    desenho.append(s('circle', { cx: 50, cy: 50, r: 26, class: 'kb-pizza__miolo' }))
  }
  corpo.append(desenho)

  const legenda = no('ul', 'kb-legenda kb-legenda--pizza')
  fatias.forEach((fatia) => {
    const item = no('li', 'kb-legenda__item')
    const nome = no('span', 'kb-legenda__nome', fatia.ponto.rotulo)
    nome.title = fatia.ponto.rotulo
    item.append(
      no('span', `kb-legenda__ponto ${cor(fatia.i)}`),
      nome,
      no('span', 'kb-legenda__porcento', `${(fatia.fracao * 100).toFixed(1)}%`),
    )
    destacavel(fig, item)
    legenda.append(item)
  })
  corpo.append(legenda)
  return fig
}

// ---------------------------------------------------------------- dispersão e bolha

function dispersao(dados, bolha) {
  if (dados.length < 2) return barras(dados, true)

  const fig = no('figure', 'kb')
  const corpo = no('div', 'kb__corpo')
  fig.append(corpo)

  const xs = dados.map((d) => d.valor)
  const ys = dados.map((d) => d.valor2 ?? 0)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const fx = maxX - minX || 1
  const fy = maxY - minY || 1
  const tam = dados.map((d) => Math.abs(d.tamanho ?? 1))
  const maxTam = Math.max(...tam, 1)

  const px = (v) => 4 + ((v - minX) / fx) * 92
  const py = (v) => 46 - ((v - minY) / fy) * 42
  const pr = (v) => (bolha ? 2 + (Math.abs(v) / maxTam) * 5 : 2.4)

  const desenho = s('svg', { viewBox: '0 0 100 50', class: 'kb-svg kb-svg--dispersao' })
  for (const fracao of [0, 0.5, 1]) {
    desenho.append(
      s('line', {
        x1: 4,
        x2: 96,
        y1: py(minY + fy * fracao),
        y2: py(minY + fy * fracao),
        stroke: 'rgb(255 255 255 / 10%)',
        'stroke-width': 0.3,
        'stroke-dasharray': '1.5 1.5',
      }),
      s('line', {
        x1: px(minX + fx * fracao),
        x2: px(minX + fx * fracao),
        y1: 4,
        y2: 46,
        stroke: 'rgb(255 255 255 / 10%)',
        'stroke-width': 0.3,
        'stroke-dasharray': '1.5 1.5',
      }),
    )
  }
  dados.forEach((ponto, i) => {
    const circulo = s('circle', {
      cx: px(ponto.valor),
      cy: py(ponto.valor2 ?? 0),
      r: pr(tam[i]),
      class: `${cor(i)} kb-ponto`,
      fill: 'currentColor',
      'fill-opacity': 0.85,
    })
    const titulo = s('title')
    titulo.textContent = `${ponto.rotulo} · x: ${fmt(ponto.valor)} · y: ${fmt(ponto.valor2 ?? 0)}`
    circulo.append(titulo)
    destacavel(fig, circulo)
    desenho.append(circulo)
  })
  corpo.append(desenho)
  corpo.append(
    no(
      'div',
      'kb-eixos',
      `x: ${fmt(minX)} … ${fmt(maxX)} · y: ${fmt(minY)} … ${fmt(maxY)}`,
    ),
  )
  return fig
}

// ---------------------------------------------------------------- radar

function radar(dados) {
  if (dados.length < 3) return barras(dados, true)

  const fig = no('figure', 'kb')
  const corpo = no('div', 'kb__corpo kb__corpo--centro')
  fig.append(corpo)

  const maximo = Math.max(...dados.map((d) => Math.abs(d.valor)), 1)
  const n = dados.length
  const centro = 50
  const raio = 38
  const anguloDe = (i) => (i / n) * Math.PI * 2 - Math.PI / 2
  const pontoDe = (i, fracao) => {
    const a = anguloDe(i)
    return [centro + Math.cos(a) * raio * fracao, centro + Math.sin(a) * raio * fracao]
  }
  const caminho =
    'M' +
    dados
      .map((d, i) => {
        const [x, y] = pontoDe(i, Math.abs(d.valor) / maximo)
        return `${x.toFixed(2)},${y.toFixed(2)}`
      })
      .join(' L') +
    ' Z'

  const desenho = s('svg', { viewBox: '0 0 100 100', class: 'kb-svg kb-svg--radar' })
  for (const fracao of [0.25, 0.5, 0.75, 1]) {
    desenho.append(
      s('polygon', {
        points: dados
          .map((_, i) => pontoDe(i, fracao).map((v) => v.toFixed(2)).join(','))
          .join(' '),
        fill: 'none',
        stroke: 'rgb(255 255 255 / 12%)',
        'stroke-width': 0.4,
      }),
    )
  }
  dados.forEach((_, i) => {
    const [x, y] = pontoDe(i, 1)
    desenho.append(
      s('line', {
        x1: centro,
        y1: centro,
        x2: x,
        y2: y,
        stroke: 'rgb(255 255 255 / 12%)',
        'stroke-width': 0.4,
      }),
    )
  })
  desenho.append(
    s('path', {
      d: caminho,
      fill: '#a78bfa',
      'fill-opacity': 0.22,
      stroke: '#a78bfa',
      'stroke-width': 1.2,
    }),
  )
  dados.forEach((ponto, i) => {
    const [x, y] = pontoDe(i, Math.abs(ponto.valor) / maximo)
    const [lx, ly] = pontoDe(i, 1.18)
    desenho.append(s('circle', { cx: x, cy: y, r: 2.2, fill: '#a78bfa' }))
    const rotulo = s('text', {
      x: lx,
      y: ly,
      'font-size': 4,
      'text-anchor': 'middle',
      'dominant-baseline': 'middle',
      class: 'kb-svg__fraco',
    })
    rotulo.textContent = ponto.rotulo.slice(0, 12)
    desenho.append(rotulo)
  })
  corpo.append(desenho)
  return fig
}

// ---------------------------------------------------------------- timeline

function timeline(dados) {
  if (!dados.length) return barras(dados, true)

  const fig = no('figure', 'kb')
  const corpo = no('div', 'kb__corpo')
  fig.append(corpo)

  const lista = no('ol', 'kb-timeline')
  dados.forEach((ponto, i) => {
    const item = no('li', 'kb-timeline__item')
    item.append(no('span', `kb-timeline__ponto ${cor(i)}`))
    const texto_ = no('div', 'kb-timeline__texto')
    texto_.append(no('p', 'kb-timeline__rotulo', ponto.rotulo))
    if (ponto.grupo) texto_.append(no('p', 'kb-timeline__grupo', ponto.grupo))
    item.append(texto_)
    if (ponto.valor) item.append(no('span', 'kb-timeline__valor', fmt(ponto.valor)))
    destacavel(fig, item)
    lista.append(item)
  })
  corpo.append(lista)
  return fig
}

// ---------------------------------------------------------------- sankey

function sankey(fluxos) {
  if (!fluxos.length) return naoEntendi('não achei fluxos', '')

  const fig = no('figure', 'kb')
  const corpo = no('div', 'kb__corpo')
  fig.append(corpo)

  const origens = [...new Set(fluxos.map((f) => f.de))]
  const destinos = [...new Set(fluxos.map((f) => f.para))]
  const total = fluxos.reduce((soma, f) => soma + Math.abs(f.valor), 0) || 1
  const altura = Math.max(origens.length, destinos.length) * 26 + 10

  const alturaDe = (nome, lado) => {
    const soma = fluxos
      .filter((f) => (lado === 'de' ? f.de === nome : f.para === nome))
      .reduce((s, f) => s + Math.abs(f.valor), 0)
    return Math.max((soma / total) * (altura - 20), 6)
  }

  let yOrigem = 0
  const caixasOrigem = origens.map((nome) => {
    const h = alturaDe(nome, 'de')
    const caixa = { nome, y: yOrigem, h }
    yOrigem += h + 8
    return caixa
  })
  let yDestino = 0
  const caixasDestino = destinos.map((nome) => {
    const h = alturaDe(nome, 'para')
    const caixa = { nome, y: yDestino, h }
    yDestino += h + 8
    return caixa
  })

  const usadoOrigem = {}
  const usadoDestino = {}
  const fitas = fluxos.map((fluxo, i) => {
    const o = caixasOrigem.find((c) => c.nome === fluxo.de)
    const d = caixasDestino.find((c) => c.nome === fluxo.para)
    const espessura = (Math.abs(fluxo.valor) / total) * (altura - 20)
    const yo = o.y + (usadoOrigem[fluxo.de] ?? 0)
    const yd = d.y + (usadoDestino[fluxo.para] ?? 0)
    usadoOrigem[fluxo.de] = (usadoOrigem[fluxo.de] ?? 0) + espessura
    usadoDestino[fluxo.para] = (usadoDestino[fluxo.para] ?? 0) + espessura
    const x1 = 34
    const x2 = 66
    const caminho = `M${x1} ${yo} C${(x1 + x2) / 2} ${yo}, ${(x1 + x2) / 2} ${yd}, ${x2} ${yd} L${x2} ${yd + espessura} C${(x1 + x2) / 2} ${yd + espessura}, ${(x1 + x2) / 2} ${yo + espessura}, ${x1} ${yo + espessura} Z`
    return { caminho, fluxo, i }
  })

  const desenho = s('svg', {
    viewBox: `0 0 100 ${altura}`,
    class: 'kb-svg kb-svg--sankey',
  })

  caixasOrigem.forEach((caixa, i) => {
    desenho.append(
      s('rect', {
        x: 16,
        y: caixa.y,
        width: 18,
        height: caixa.h,
        rx: 1.5,
        class: cor(i),
        fill: 'currentColor',
      }),
    )
    const rotulo = s('text', {
      x: 14,
      y: caixa.y + caixa.h / 2,
      'font-size': 3.4,
      'text-anchor': 'end',
      'dominant-baseline': 'middle',
      class: 'kb-svg__medio',
    })
    rotulo.textContent = caixa.nome.slice(0, 18)
    desenho.append(rotulo)
  })
  fitas.forEach((fita) => {
    const caminho = s('path', {
      d: fita.caminho,
      class: `${cor(fita.i)} kb-fita`,
      fill: 'currentColor',
    })
    const titulo = s('title')
    titulo.textContent = `${fita.fluxo.de} → ${fita.fluxo.para}: ${fmt(fita.fluxo.valor)}`
    caminho.append(titulo)
    destacavel(fig, caminho)
    desenho.append(caminho)
  })
  caixasDestino.forEach((caixa, i) => {
    desenho.append(
      s('rect', {
        x: 66,
        y: caixa.y,
        width: 18,
        height: caixa.h,
        rx: 1.5,
        class: cor(i + 1),
        fill: 'currentColor',
      }),
    )
    const rotulo = s('text', {
      x: 86,
      y: caixa.y + caixa.h / 2,
      'font-size': 3.4,
      'dominant-baseline': 'middle',
      class: 'kb-svg__medio',
    })
    rotulo.textContent = caixa.nome.slice(0, 18)
    desenho.append(rotulo)
  })
  corpo.append(desenho)
  return fig
}

// ---------------------------------------------------------------- mapa mental

function mapaMental(raiz, lista) {
  const fig = no('figure', 'kb')
  const corpo = no('div', 'kb__corpo')
  fig.append(corpo)

  const topo = no('div', 'kb-mapa__raiz')
  topo.append(no('span', 'kb-mapa__ponto'), no('span', 'kb-mapa__titulo', raiz.texto))
  corpo.append(topo)

  const galho = (ramo, nivel) => {
    const item = no('li', 'kb-mapa__item')
    const linha = no('div', 'kb-mapa__linha')
    linha.append(no('span', `kb-mapa__bolinha ${cor(nivel)}`))
    linha.append(no('span', nivel === 0 ? 'kb-mapa__texto' : 'kb-mapa__texto kb-mapa__texto--filho', ramo.texto))
    item.append(linha)
    destacavel(fig, linha)
    if (ramo.filhos?.length) {
      const filhos = no('ul', 'kb-mapa__filhos')
      ramo.filhos.forEach((filho) => filhos.append(galho(filho, nivel + 1)))
      item.append(filhos)
    }
    return item
  }

  if (lista.length) {
    const arvore = no('ul', 'kb-mapa')
    lista.forEach((ramo) => arvore.append(galho(ramo, 0)))
    corpo.append(arvore)
  }
  return fig
}

// ---------------------------------------------------------------- passos

function passos(lista) {
  const fig = no('figure', 'kb')
  const corpo = no('div', 'kb__corpo')
  fig.append(corpo)

  const ordenada = no('ol', 'kb-passos')
  lista.forEach((passo, i) => {
    const item = no('li', 'kb-passos__item')
    const marcador = no('div', 'kb-passos__marcador')
    marcador.append(no('span', 'kb-passos__numero', i + 1))
    if (i < lista.length - 1) marcador.append(no('span', 'kb-passos__fio'))
    const conteudo = no('div', 'kb-passos__conteudo')
    conteudo.append(no('p', 'kb-passos__titulo', passo.titulo))
    if (passo.texto) conteudo.append(no('p', 'kb-passos__texto', passo.texto))
    item.append(marcador, conteudo)
    destacavel(fig, item)
    ordenada.append(item)
  })
  corpo.append(ordenada)
  return fig
}

// ---------------------------------------------------------------- comparação

const NOMES_DO_ITEM = ['nome', 'titulo', 'label', 'produto', 'modelo', 'item']
const FICHAS_DO_ITEM = ['valores', 'especificacoes', 'ficha', 'atributos', 'dados', 'caracteristicas']

function valorDaFicha(valor) {
  if (typeof valor === 'string') return valor
  if (typeof valor === 'number' || typeof valor === 'boolean') return String(valor)
  return ''
}

function itensComparados(bruto) {
  if (!Array.isArray(bruto)) return []
  const itens = []
  bruto.forEach((item, i) => {
    if (typeof item === 'string') {
      const nome = item.trim()
      if (nome) itens.push({ nome, valores: {}, recomendado: false })
      return
    }
    if (typeof item !== 'object' || item === null) return
    const nome =
      NOMES_DO_ITEM.map((campo) => texto(item[campo]).trim()).find(Boolean) || `Opção ${i + 1}`
    const valores = {}
    for (const campo of FICHAS_DO_ITEM) {
      const dentro = item[campo]
      if (typeof dentro !== 'object' || dentro === null || Array.isArray(dentro)) continue
      for (const [atributo, valor] of Object.entries(dentro)) {
        const lido = valorDaFicha(valor)
        if (atributo.trim() && lido) valores[atributo.trim()] = lido
      }
    }
    for (const [campo, valor] of Object.entries(item)) {
      if (NOMES_DO_ITEM.includes(campo) || FICHAS_DO_ITEM.includes(campo)) continue
      if (campo === 'recomendado' || campo === 'melhor' || campo === 'destaque') continue
      const lido = valorDaFicha(valor)
      if (lido && !(campo in valores)) valores[campo] = lido
    }
    const recomendado = item.recomendado === true || item.melhor === true || item.destaque === true
    itens.push({ nome, valores, recomendado })
  })
  return itens
}

function atributosDe(pedidos, itens) {
  const lista = Array.isArray(pedidos) ? pedidos.map((item) => texto(item).trim()).filter(Boolean) : []
  const todos = [...new Set(itens.flatMap((item) => Object.keys(item.valores)))]
  if (!lista.length) return todos
  return [...new Set([...lista, ...todos])]
}

function destaquesDe(bruto, itens) {
  if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) return {}
  const saida = {}
  for (const [atributo, alvo] of Object.entries(bruto)) {
    const nome = typeof alvo === 'number' ? itens[alvo]?.nome ?? '' : texto(alvo).trim()
    if (nome) saida[atributo.trim()] = nome
  }
  return saida
}

function tabelaComparativa(itens, atributos, destaques) {
  const fig = no('figure', 'kb')
  const corpo = no('div', 'kb__corpo')
  fig.append(corpo)

  const rolagem = no('div', 'kb-rolagem')
  const tabela = no('table', 'kb-tabela kb-tabela--comparativa')
  const cabecalho = no('thead')
  const linhaCabecalho = no('tr')
  linhaCabecalho.append(no('th', 'kb-tabela__canto', `${itens.length} opções`))
  itens.forEach((item) => {
    const celula = no('th', `kb-tabela__coluna${item.recomendado ? ' kb-tabela__coluna--recomendada' : ''}`)
    celula.append(no('span', 'kb-tabela__nome', item.nome))
    if (item.recomendado) celula.append(no('span', 'kb-tabela__selo', 'recomendado'))
    linhaCabecalho.append(celula)
  })
  cabecalho.append(linhaCabecalho)

  const corpoTabela = no('tbody')
  atributos.forEach((atributo) => {
    const linha = no('tr')
    linha.append(no('th', 'kb-tabela__atributo', atributo))
    itens.forEach((item) => {
      const venceu = destaques[atributo] === item.nome
      const celula = no(
        'td',
        `kb-tabela__celula${venceu ? ' kb-tabela__celula--venceu' : ''}${item.recomendado ? ' kb-tabela__celula--recomendada' : ''}`,
        item.valores[atributo] ?? '—',
      )
      linha.append(celula)
    })
    corpoTabela.append(linha)
  })
  tabela.append(cabecalho, corpoTabela)
  rolagem.append(tabela)
  corpo.append(rolagem)
  return fig
}

function comparacaoColunas(colunas) {
  const fig = no('figure', 'kb')
  const corpo = no('div', 'kb__corpo')
  fig.append(corpo)

  const grade = no('div', 'kb-comparacao')
  colunas.forEach((coluna, i) => {
    const caixa = no('div', 'kb-comparacao__coluna')
    caixa.append(no('p', `kb-comparacao__titulo ${cor(i)}`, coluna.titulo))
    const lista = no('ul', 'kb-comparacao__lista')
    coluna.itens.forEach((item) => {
      const li = no('li', 'kb-comparacao__item')
      li.append(no('span', 'kb-comparacao__bolinha'), no('span', '', item))
      lista.append(li)
    })
    caixa.append(lista)
    destacavel(fig, caixa)
    grade.append(caixa)
  })
  corpo.append(grade)
  return fig
}

function comparacao(dados) {
  const cru = dados.itens ?? dados.produtos ?? dados.opcoes ?? dados.colunas ?? dados.dados
  const itens = itensComparados(cru)
  const atributos = atributosDe(dados.atributos ?? dados.campos ?? dados.linhas, itens)
  if (itens.length && atributos.length) {
    return tabelaComparativa(
      itens,
      atributos,
      destaquesDe(dados.destaques ?? dados.melhores ?? dados.vencedores, itens),
    )
  }

  const colunas = Array.isArray(cru)
    ? cru
        .map((item) => {
          if (typeof item !== 'object' || item === null) return null
          const dentro = item.itens ?? item.contents ?? item.lista
          const lista = Array.isArray(dentro) ? dentro.map((x) => texto(x)) : []
          return { titulo: texto(item.titulo ?? item.label ?? item.nome), itens: lista }
        })
        .filter(Boolean)
    : []
  if (!colunas.length) return naoEntendi('não achei `itens` nem `colunas`', '')
  return comparacaoColunas(colunas)
}

// ---------------------------------------------------------------- tabela

function tabela(colunas, linhas) {
  const fig = no('figure', 'kb')
  const corpo = no('div', 'kb__corpo')
  fig.append(corpo)

  const rolagem = no('div', 'kb-rolagem')
  const tabela_ = no('table', 'kb-tabela')
  const cabecalho = no('thead')
  const linhaCabecalho = no('tr')
  colunas.forEach((coluna) => linhaCabecalho.append(no('th', '', coluna)))
  cabecalho.append(linhaCabecalho)
  const corpoTabela = no('tbody')
  linhas.forEach((linha) => {
    const tr = no('tr')
    linha.forEach((celula) => tr.append(no('td', '', celula)))
    corpoTabela.append(tr)
  })
  tabela_.append(cabecalho, corpoTabela)
  rolagem.append(tabela_)
  corpo.append(rolagem)
  return fig
}

// ---------------------------------------------------------------- diagrama

const GLIFO_CAIXA = /[─│┌┐└┘├┤┬┴┼╭╮╰╯═║╔╗╚╝╠╣╦╩╬|]/
const GLIFO_SETA = /[→←↑↓▼▲◀▶►◄]/

function tipoDoGlifo(caractere) {
  if (GLIFO_CAIXA.test(caractere)) return 'caixa'
  if (GLIFO_SETA.test(caractere)) return 'seta'
  return 'texto'
}

/** O desenho de traço que a IA já manda pronto: o traço ganha cor, o texto ganha peso. */
function diagramaDeTexto(fonte) {
  const fig = no('figure', 'kb')
  const corpo = no('div', 'kb__corpo')
  fig.append(corpo)
  const bloco = no('div', 'kb-diagrama')
  const linhas = String(fonte).replace(/\n+$/, '').split('\n')
  linhas.forEach((linha, indice) => {
    const div = no('div', 'kb-diagrama__linha')
    let atual = ''
    let tipoAtual = null
    const despejar = () => {
      if (!atual) return
      if (tipoAtual === 'texto') div.append(document.createTextNode(atual))
      else div.append(no('span', `kb-diagrama__${tipoAtual}`, atual))
      atual = ''
    }
    for (const caractere of linha) {
      const tipo = tipoDoGlifo(caractere)
      if (tipo !== tipoAtual) {
        despejar()
        tipoAtual = tipo
      }
      atual += caractere
    }
    despejar()
    if (indice < linhas.length - 1) div.append(document.createTextNode('\n'))
    bloco.append(div)
  })
  corpo.append(bloco)
  return fig
}

function caixasDoDiagrama(bruto) {
  if (!Array.isArray(bruto)) return []
  return bruto
    .map((item) => {
      if (typeof item === 'string') {
        const titulo = item.trim()
        return titulo ? { titulo, linhas: [], tom: 'neutro' } : null
      }
      if (typeof item !== 'object' || item === null) return null
      const cru = item.linhas ?? item.itens ?? item.texto ?? item.detalhe ?? item.descricao
      const linhas = Array.isArray(cru)
        ? cru.map((linha) => texto(linha)).filter(Boolean)
        : texto(cru)
            .split('\n')
            .map((linha) => linha.trim())
            .filter(Boolean)
      const tom = texto(item.tom ?? item.estado ?? item.nivel ?? item.cor).toLowerCase()
      return {
        titulo: texto(item.titulo ?? item.nome ?? item.label),
        linhas,
        tom: ['ok', 'bom', 'verde', 'sucesso'].includes(tom)
          ? 'ok'
          : ['erro', 'ruim', 'vermelho', 'falha'].includes(tom)
            ? 'erro'
            : ['atencao', 'atenção', 'aviso', 'alerta'].includes(tom)
              ? 'atencao'
              : 'neutro',
      }
    })
    .filter(Boolean)
}

function colunasDoDiagrama(bruto) {
  if (!Array.isArray(bruto)) return []
  return bruto
    .map((item, i) => {
      if (typeof item !== 'object' || item === null) return null
      const caixas = caixasDoDiagrama(item.blocos ?? item.caixas ?? item.itens ?? item.dados)
      if (!caixas.length) return null
      return { titulo: texto(item.titulo ?? item.label ?? item.nome, `coluna ${i + 1}`), caixas }
    })
    .filter(Boolean)
}

function caixaDoDiagrama(caixa) {
  const div = no('div', `kb-caixa kb-caixa--${caixa.tom}`)
  if (caixa.titulo) {
    const titulo = no('p', 'kb-caixa__titulo')
    if (caixa.tom === 'ok') titulo.append(no('span', 'kb-caixa__check', '✓'))
    titulo.append(no('span', '', caixa.titulo))
    div.append(titulo)
  }
  caixa.linhas.forEach((linha) => div.append(no('p', 'kb-caixa__linha', linha)))
  return div
}

function setaDoDiagrama(rotulo, direcao) {
  const caixa = no('div', `kb-seta${direcao === 'baixo' ? ' kb-seta--baixo' : ''}`)
  if (rotulo) caixa.append(no('span', 'kb-seta__rotulo', rotulo))
  const desenho = s('svg', { viewBox: '0 0 30 10', class: 'kb-seta__svg', 'aria-hidden': 'true' })
  desenho.append(
    s('path', {
      d: 'M1 5h24',
      stroke: 'currentColor',
      'stroke-width': 1.3,
      'stroke-linecap': 'round',
    }),
    s('path', {
      d: 'M21 1.5 26 5l-5 3.5',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.3,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }),
  )
  caixa.append(desenho)
  return caixa
}

function diagramaEstruturado(dados) {
  const lista = (chave) => (Array.isArray(chave) ? chave.map((item) => texto(item)) : [])
  const notas = caixasDoDiagrama(dados.notas)

  const montar = (conteudo) => {
    if (!notas.length) return conteudo
    const caixa = no('div', 'kb-diagrama-estruturado')
    caixa.append(conteudo)
    const rodape = no('div', 'kb-notas')
    notas.forEach((nota) => rodape.append(caixaDoDiagrama(nota)))
    caixa.append(rodape)
    return caixa
  }

  const colunas = colunasDoDiagrama(dados.colunas)
  if (colunas.length) {
    const grade = no('div', 'kb-colunas')
    colunas.forEach((coluna, i) => {
      const bloco = no('div', 'kb-colunas__coluna')
      bloco.append(no('p', 'kb-colunas__titulo', coluna.titulo))
      coluna.caixas.forEach((caixa) => bloco.append(caixaDoDiagrama(caixa)))
      grade.append(bloco)
      if (i < colunas.length - 1) grade.append(setaDoDiagrama(lista(dados.setas)[i], 'direita'))
    })
    return montar(grade)
  }

  const camadas = colunasDoDiagrama(dados.camadas ?? dados.pilha)
  if (camadas.length) {
    const pilha = no('div', 'kb-pilha')
    camadas.forEach((camada, i) => {
      const bloco = no('div', 'kb-colunas__coluna')
      bloco.append(no('p', 'kb-colunas__titulo', camada.titulo))
      const lado = no('div', 'kb-pilha__caixas')
      camada.caixas.forEach((caixa) => lado.append(caixaDoDiagrama(caixa)))
      bloco.append(lado)
      pilha.append(bloco)
      if (i < camadas.length - 1) pilha.append(setaDoDiagrama('', 'baixo'))
    })
    return montar(pilha)
  }

  const fluxo = caixasDoDiagrama(dados.fluxo ?? dados.sequencia)
  if (fluxo.length) {
    const pilha = no('div', 'kb-pilha')
    fluxo.forEach((caixa, i) => {
      pilha.append(caixaDoDiagrama(caixa))
      if (i < fluxo.length - 1) pilha.append(setaDoDiagrama(lista(dados.setas)[i], 'baixo'))
    })
    return montar(pilha)
  }

  const quadrantes = caixasDoDiagrama(dados.quadrantes)
  if (quadrantes.length) {
    const caixa = no('div', 'kb-matriz')
    const eixoY = texto(dados.eixo_y ?? dados.eixoY)
    const eixoX = texto(dados.eixo_x ?? dados.eixoX)
    if (eixoY) caixa.append(no('p', 'kb-matriz__eixo', `↑ ${eixoY}`))
    const grade = no('div', 'kb-matriz__grade')
    quadrantes.slice(0, 4).forEach((quadrante) => {
      const bloco = no('div', `kb-quadrante kb-quadrante--${quadrante.tom}`)
      bloco.append(no('p', 'kb-quadrante__titulo', quadrante.titulo))
      const lista_ = no('ul', 'kb-quadrante__lista')
      quadrante.linhas.forEach((linha) => {
        const li = no('li', 'kb-quadrante__item')
        li.append(no('span', 'kb-quadrante__bolinha'), no('span', '', linha))
        lista_.append(li)
      })
      bloco.append(lista_)
      grade.append(bloco)
    })
    caixa.append(grade)
    if (eixoX) caixa.append(no('p', 'kb-matriz__eixo kb-matriz__eixo--x', `${eixoX} →`))
    return montar(caixa)
  }

  return null
}

function diagrama(dados, bruto) {
  const estruturado = diagramaEstruturado(dados)
  if (estruturado) return estruturado
  const cru = dados.linhas ?? dados.texto ?? dados.diagrama ?? dados.ascii
  const linhas_ = Array.isArray(cru) ? cru.map((item) => texto(item)) : texto(cru).split('\n')
  if (!linhas_.some((linha) => linha.trim())) {
    return naoEntendi('o diagrama precisa de `linhas`, `colunas`, `camadas`, `fluxo` ou `quadrantes`', bruto)
  }
  return diagramaDeTexto(linhas_.join('\n'))
}

// ---------------------------------------------------------------- diff

function linhasDiff(bruto) {
  if (!Array.isArray(bruto)) return []
  return bruto
    .map((item) => {
      if (typeof item === 'string') {
        const sinal = item[0]
        if (sinal === '+' || sinal === '-') {
          return { tipo: sinal === '+' ? 'add' : 'del', texto: item.slice(1) }
        }
        return { tipo: 'ctx', texto: item }
      }
      if (typeof item === 'object' && item !== null) {
        const t = texto(item.tipo ?? item.kind ?? item.t).toLowerCase()
        const tipo =
          t.startsWith('add') || t === '+'
            ? 'add'
            : t.startsWith('del') || t.startsWith('rem') || t === '-'
              ? 'del'
              : 'ctx'
        return { tipo, texto: texto(item.texto ?? item.linha ?? item.conteudo ?? item.text) }
      }
      return null
    })
    .filter((linha) => linha && linha.texto !== '')
}

function diffs(arquivo, linhas) {
  const fig = no('figure', 'kb')
  const corpo = no('div', 'kb__corpo')
  fig.append(corpo)

  const adds = linhas.filter((l) => l.tipo === 'add').length
  const dels = linhas.filter((l) => l.tipo === 'del').length
  const caixa = no('div', 'kb-diff')
  const topo = no('div', 'kb-diff__topo')
  topo.append(no('span', 'kb-diff__arquivo', arquivo || 'mudança'))
  const saldo = no('span', 'kb-diff__saldo')
  saldo.append(no('span', 'kb-diff__add', `+${adds}`), document.createTextNode(' '), no('span', 'kb-diff__del', `-${dels}`))
  topo.append(saldo)
  caixa.append(topo)

  linhas.forEach((linha) => {
    const div = no('div', `kb-diff__linha kb-diff__linha--${linha.tipo}`)
    div.append(
      no('span', 'kb-diff__sinal', linha.tipo === 'add' ? '+' : linha.tipo === 'del' ? '-' : ' '),
      no('span', 'kb-diff__texto', linha.texto),
    )
    caixa.append(div)
  })
  corpo.append(caixa)
  return fig
}

// ---------------------------------------------------------------- árvore

function nosDaArvore(bruto, profundidade = 0) {
  if (!Array.isArray(bruto) || profundidade > 6) return []
  return bruto
    .map((item) => {
      if (typeof item === 'string') return { nome: item }
      if (typeof item !== 'object' || item === null) return null
      const filhos = nosDaArvore(item.filhos ?? item.children ?? item.itens, profundidade + 1)
      const nome = texto(item.nome ?? item.name ?? item.texto ?? item.arquivo)
      return nome ? { nome, ...(filhos.length ? { filhos } : {}) } : null
    })
    .filter(Boolean)
}

function arvore(lista) {
  const fig = no('figure', 'kb')
  const corpo = no('div', 'kb__corpo')
  fig.append(corpo)

  const galho = (item) => {
    const li = no('li', 'kb-arvore__item')
    const pasta = (item.filhos?.length ?? 0) > 0
    const linha = no('div', 'kb-arvore__linha')
    linha.append(
      no('span', `kb-arvore__marca${pasta ? ' kb-arvore__marca--pasta' : ''}`),
      no('span', `kb-arvore__nome${pasta ? ' kb-arvore__nome--pasta' : ''}`, item.nome),
    )
    li.append(linha)
    if (pasta) {
      const filhos = no('ul', 'kb-arvore__filhos')
      item.filhos.forEach((filho) => filhos.append(galho(filho)))
      li.append(filhos)
    }
    return li
  }

  const raiz = no('ul', 'kb-arvore')
  lista.forEach((item) => raiz.append(galho(item)))
  corpo.append(raiz)
  return fig
}

// ---------------------------------------------------------------- métrica

function cartoes(bruto) {
  if (!Array.isArray(bruto)) return []
  return bruto
    .map((item) => {
      if (typeof item !== 'object' || item === null) return null
      const rotulo = texto(item.rotulo ?? item.label ?? item.nome)
      const valor = texto(item.valor ?? item.value)
      if (!rotulo || !valor) return null
      return {
        rotulo,
        valor,
        variacao: texto(item.variacao ?? item.delta ?? item.mudanca),
        detalhe: texto(item.detalhe ?? item.detail),
      }
    })
    .filter(Boolean)
}

function metrica(lista) {
  const fig = no('figure', 'kb')
  const corpo = no('div', 'kb__corpo')
  fig.append(corpo)

  const grade = no('div', 'kb-metricas')
  lista.forEach((cartao) => {
    const caixa = no('div', 'kb-metrica')
    caixa.append(no('span', 'kb-metrica__rotulo', cartao.rotulo))
    caixa.append(no('span', 'kb-metrica__valor', cartao.valor))
    if (cartao.variacao) {
      const sobe = cartao.variacao.startsWith('+')
      caixa.append(no('span', `kb-metrica__variacao ${sobe ? 'kb-metrica__variacao--sobe' : 'kb-metrica__variacao--desce'}`, cartao.variacao))
    }
    destacavel(fig, caixa)
    grade.append(caixa)
  })
  corpo.append(grade)
  return fig
}

// ---------------------------------------------------------------- aviso

const TONS_DE_AVISO = ['dica', 'aviso', 'erro', 'info']

function citacao(tomDoAviso, titulo, corpoTexto) {
  const fig = no('figure', 'kb')
  const corpo = no('div', 'kb__corpo')
  fig.append(corpo)
  const caixa = no('div', `kb-aviso kb-aviso--${tomDoAviso}`)
  if (titulo) {
    const titulo_ = no('p', 'kb-aviso__titulo')
    titulo_.append(no('span', 'kb-aviso__ponto'), no('span', '', titulo))
    caixa.append(titulo_)
  }
  caixa.append(no('p', 'kb-aviso__texto', corpoTexto))
  corpo.append(caixa)
  return fig
}

// ---------------------------------------------------------------- quiz

function quiz(pergunta, opcoes, correta, explicacao) {
  const fig = no('figure', 'kb')
  const corpo = no('div', 'kb__corpo')
  fig.append(corpo)

  corpo.append(no('p', 'kb-quiz__pergunta', pergunta))
  const lista = no('ul', 'kb-quiz__opcoes')
  let escolhida = null
  let resultado = null

  const botoes = opcoes.map((opcao, i) => {
    const li = no('li')
    const botao = no('button', 'kb-quiz__opcao')
    botao.type = 'button'
    botao.append(
      no('span', 'kb-quiz__letra', String.fromCharCode(65 + i)),
      no('span', 'kb-quiz__texto', opcao),
      no('span', 'kb-quiz__marca'),
    )
    botao.addEventListener('click', () => {
      escolhida = i
      pintar()
    })
    li.append(botao)
    lista.append(li)
    return botao
  })
  corpo.append(lista)
  resultado = no('p', 'kb-quiz__resultado')
  resultado.hidden = true
  corpo.append(resultado)

  function pintar() {
    botoes.forEach((botao, i) => {
      botao.classList.toggle('kb-quiz__opcao--certa', correta !== undefined && correta === i)
      botao.classList.toggle('kb-quiz__opcao--errada', escolhida === i && correta !== undefined && correta !== i)
      botao.classList.toggle('kb-quiz__opcao--escolhida', escolhida === i)
      botao.querySelector('.kb-quiz__marca').textContent =
        correta !== undefined && correta === i ? 'certa' : ''
      botao.setAttribute('aria-pressed', String(escolhida === i))
    })
    resultado.hidden = false
    const prefixo =
      correta === undefined
        ? 'você respondeu — sem gabarito, o bloco só guarda a escolha.'
        : escolhida === correta
          ? 'acertou. '
          : 'essa não. '
    resultado.textContent = `${prefixo}${explicacao ?? ''}`
  }

  return fig
}

// ---------------------------------------------------------------- mapa radial

function nosRadiais(bruto) {
  if (!Array.isArray(bruto)) return []
  return bruto
    .map((item) => {
      if (typeof item === 'string') return { nome: item }
      if (typeof item !== 'object' || item === null) return null
      const nome = texto(item.nome ?? item.label ?? item.texto ?? item.titulo)
      if (!nome) return null
      return {
        nome,
        sub: texto(item.sub ?? item.subtitulo ?? item.descricao ?? item.papel),
        nota: texto(item.nota ?? item.detalhe),
      }
    })
    .filter(Boolean)
}

function mapaRadial(centro, centroSub, lista) {
  const fig = no('figure', 'kb')
  const corpo = no('div', 'kb__corpo kb__corpo--centro')
  fig.append(corpo)

  const CX = 170
  const CY = 148
  const RAIO = 88
  const total = Math.max(lista.length, 1)
  const anguloDe = (i) => (i / total) * Math.PI * 2 - Math.PI / 2
  const ponto = (i, distancia) => {
    const a = anguloDe(i)
    return [CX + Math.cos(a) * distancia, CY + Math.sin(a) * distancia]
  }
  const ligacao = (i) => {
    const [x1, y1] = ponto(i, 34)
    const [x2, y2] = ponto(i, RAIO - 24)
    const mx = (x1 + x2) / 2
    const my = (y1 + y2) / 2
    const dx = -(y2 - y1)
    const dy = x2 - x1
    const norma = Math.hypot(dx, dy) || 1
    const curva = i % 2 === 0 ? 10 : -10
    return `M${x1.toFixed(1)} ${y1.toFixed(1)} Q${(mx + (dx / norma) * curva).toFixed(1)} ${(my + (dy / norma) * curva).toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`
  }

  const desenho = s('svg', { viewBox: '0 0 340 292', class: 'kb-svg kb-svg--radial' })
  desenho.append(
    s('circle', {
      cx: CX,
      cy: CY,
      r: RAIO,
      fill: 'none',
      stroke: 'rgb(255 255 255 / 10%)',
      'stroke-dasharray': '3 6',
    }),
  )

  const selecionar = (indice) => {
    const aceso = indice >= 0 && fig.dataset.aceso !== String(indice)
    fig.dataset.aceso = aceso ? String(indice) : ''
    fig.querySelectorAll('[data-no]').forEach((elemento) => {
      const escolhido = aceso && elemento.dataset.no === String(indice)
      elemento.classList.toggle('kb-radial__no--aceso', escolhido)
      // O grupo do nó é `.kb-item`; sem esta classe o apagador genérico o apagaria junto.
      if (elemento.classList.contains('kb-item')) {
        elemento.classList.toggle('kb-item--aceso', escolhido)
      }
    })
    fig.classList.toggle('kb--tem-aceso', aceso)
  }

  lista.forEach((no_, i) => {
    const [nx, ny] = ponto(i, RAIO)
    const grupo = s('g', { class: 'kb-radial__no kb-item', 'data-no': i })
    const caminho = s('path', {
      d: ligacao(i),
      fill: 'none',
      class: cor(i),
      stroke: 'currentColor',
      'stroke-width': 1.3,
      'stroke-opacity': 0.4,
    })
    const circulo = s('circle', {
      cx: nx,
      cy: ny,
      r: 22,
      class: cor(i),
      fill: 'currentColor',
      'fill-opacity': 0.09,
      stroke: 'currentColor',
      'stroke-width': 1.3,
      'stroke-opacity': 0.7,
    })
    const nomeCurto = s('text', {
      x: nx,
      y: ny + 3.5,
      'text-anchor': 'middle',
      'font-size': 9.5,
      'font-weight': 600,
      class: 'kb-svg__forte',
    })
    nomeCurto.textContent = no_.nome.slice(0, 9)
    grupo.append(caminho, circulo, nomeCurto)
    // O nome inteiro só desce quando o círculo cortou: repetir "Claude" embaixo de
    // "Claude" era ruído, e no celular o espaço embaixo do nó é curto.
    const cortado = no_.nome.length > 9
    if (cortado) {
      const nome = s('text', {
        x: nx,
        y: ny + 40,
        'text-anchor': 'middle',
        'font-size': 11,
        'font-weight': 600,
        class: 'kb-svg__medio',
      })
      nome.textContent = no_.nome
      grupo.append(nome)
    }
    if (no_.sub) {
      const sub = s('text', {
        x: nx,
        y: ny + (cortado ? 51 : 38),
        'text-anchor': 'middle',
        'font-size': 8.5,
        class: 'kb-svg__fraco',
      })
      sub.textContent = no_.sub.slice(0, 24)
      grupo.append(sub)
    }
    grupo.addEventListener('click', (evento) => {
      evento.stopPropagation()
      selecionar(i)
    })
    desenho.append(grupo)
  })

  desenho.append(
    s('circle', {
      cx: CX,
      cy: CY,
      r: 32,
      fill: '#a78bfa',
      'fill-opacity': 0.15,
      stroke: '#a78bfa',
      'stroke-width': 1.5,
    }),
  )
  const tituloCentro = s('text', {
    x: CX,
    y: CY - 1,
    'text-anchor': 'middle',
    'font-size': 12,
    'font-weight': 700,
    class: 'kb-svg__forte',
  })
  tituloCentro.textContent = centro.slice(0, 14)
  desenho.append(tituloCentro)
  if (centroSub) {
    const sub = s('text', {
      x: CX,
      y: CY + 13,
      'text-anchor': 'middle',
      'font-size': 8.5,
      class: 'kb-svg__fraco',
    })
    sub.textContent = centroSub.slice(0, 18)
    desenho.append(sub)
  }
  corpo.append(desenho)

  const chips = no('ul', 'kb-radial__chips')
  lista.forEach((no_, i) => {
    const li = no('li')
    const botao = no('button', 'kb-radial__chip')
    botao.type = 'button'
    botao.dataset.no = i
    botao.append(no('span', `kb-radial__ponto ${cor(i)}`), document.createTextNode(no_.nome))
    botao.addEventListener('click', () => selecionar(i))
    li.append(botao)
    chips.append(li)
  })
  corpo.append(chips)
  return fig
}

// ---------------------------------------------------------------- plano

function mudancasDoPlano(bruto) {
  if (!Array.isArray(bruto)) return []
  return bruto
    .map((item) => {
      if (typeof item === 'string') return { texto: item }
      if (typeof item !== 'object' || item === null) return null
      const conteudo = texto(item.texto ?? item.o_que ?? item.mudanca ?? item.descricao)
      if (!conteudo) return null
      return { arquivo: texto(item.arquivo ?? item.file ?? item.onde), texto: conteudo }
    })
    .filter(Boolean)
}

function etapasDoPlano(bruto) {
  if (!Array.isArray(bruto)) return []
  return bruto
    .map((item, i) => {
      if (typeof item === 'string') return { titulo: item }
      if (typeof item !== 'object' || item === null) return null
      return {
        titulo: texto(item.titulo ?? item.label ?? item.nome, String(i + 1)),
        texto: texto(item.texto ?? item.descricao ?? item.detalhe),
      }
    })
    .filter(Boolean)
}

function plano(dados, titulo, acoes) {
  const fig = no('figure', 'kb')
  const corpo = no('div', 'kb__corpo')
  fig.append(corpo)

  const caixa = no('div', 'kb-plano')
  const topo = no('div', 'kb-plano__topo')
  topo.append(no('span', 'kb-plano__selo', 'plano'))
  if (titulo) topo.append(no('p', 'kb-plano__titulo', titulo))
  caixa.append(topo)

  const curta = (rotulo, classe, texto_) => {
    if (!texto_) return null
    const bloco = no('div', `kb-plano__curta ${classe}`)
    bloco.append(no('p', 'kb-plano__rotulo', rotulo), no('p', 'kb-plano__texto', texto_))
    return bloco
  }
  const curtas = no('div', 'kb-plano__curtas')
  const deQue = curta('de que é', 'kb-plano__curta--azul', texto(dados.o_que_e ?? dados.o_que ?? dados.definicao))
  const praQue = curta('pra que serve', 'kb-plano__curta--verde', texto(dados.pra_que ?? dados.para_que ?? dados.objetivo))
  const porQue = curta('por que assim', 'kb-plano__curta--violeta', texto(dados.por_que ?? dados.porque ?? dados.motivo))
  for (const bloco of [deQue, praQue, porQue]) if (bloco) curtas.append(bloco)
  if (curtas.childElementCount) caixa.append(curtas)

  const como = etapasDoPlano(dados.como ?? dados.passos ?? dados.etapas)
  if (como.length) {
    const bloco = no('div', 'kb-plano__secao')
    bloco.append(no('p', 'kb-plano__secao-titulo kb-plano__secao-titulo--ambar', 'como'))
    const lista = no('ol', 'kb-plano__como')
    como.forEach((etapa, i) => {
      const item = no('li', 'kb-plano__etapa')
      item.append(no('span', 'kb-plano__numero', i + 1))
      const conteudo = no('div', 'kb-plano__etapa-texto')
      conteudo.append(no('p', 'kb-plano__etapa-titulo', etapa.titulo))
      if (etapa.texto) conteudo.append(no('p', 'kb-plano__texto', etapa.texto))
      item.append(conteudo)
      lista.append(item)
    })
    bloco.append(lista)
    caixa.append(bloco)
  }

  const mudancas = mudancasDoPlano(dados.mudancas ?? dados.mudancas_principais ?? dados.alteracoes)
  if (mudancas.length) {
    const bloco = no('div', 'kb-plano__secao')
    bloco.append(no('p', 'kb-plano__secao-titulo kb-plano__secao-titulo--rosa', 'principais mudanças'))
    const lista = no('ul', 'kb-plano__mudancas')
    mudancas.forEach((mudanca) => {
      const item = no('li', 'kb-plano__mudanca')
      item.append(no('span', 'kb-plano__bolinha'))
      if (mudanca.arquivo) item.append(no('code', 'kb-plano__arquivo', mudanca.arquivo))
      item.append(no('span', 'kb-plano__texto', mudanca.texto))
      lista.append(item)
    })
    bloco.append(lista)
    caixa.append(bloco)
  }

  const resultado = texto(dados.resultado ?? dados.resultado_esperado ?? dados.entrega)
  if (resultado) {
    const bloco = no('div', 'kb-plano__resultado')
    bloco.append(
      no('p', 'kb-plano__secao-titulo', 'resultado final esperado'),
      no('p', 'kb-plano__resultado-texto', resultado),
    )
    caixa.append(bloco)
  }

  const planId = texto(dados.plan_id)
  const decidir = acoes?.decidirPlano
  if (planId && typeof decidir === 'function') {
    const rodape = no('div', 'kb-plano__rodape')
    const aviso = no('p', 'kb-plano__aviso', 'pode começar?')
    const desistir = no('button', 'kb-plano__botao kb-plano__botao--fantasma', 'Desistir')
    const fazer = no('button', 'kb-plano__botao kb-plano__botao--forte', 'Fazer')
    desistir.type = 'button'
    fazer.type = 'button'
    let decidindo = false
    const decidirDe = (aceito) => {
      if (decidindo) return
      decidindo = true
      aviso.textContent = 'Confirmando…'
      desistir.disabled = true
      fazer.disabled = true
      decidir(planId, aceito, (ok) => {
        decidindo = false
        if (ok) {
          rodape.replaceChildren(
            no(
              'p',
              `kb-plano__decisao${aceito ? ' kb-plano__decisao--feito' : ''}`,
              aceito ? 'plano aceito — começando' : 'plano desistido',
            ),
          )
          return
        }
        aviso.textContent = 'Não foi possível confirmar a decisão.'
        desistir.disabled = false
        fazer.disabled = false
      })
    }
    desistir.addEventListener('click', () => decidirDe(false))
    fazer.addEventListener('click', () => decidirDe(true))
    rodape.append(aviso, desistir, fazer)
    caixa.append(rodape)
  }

  corpo.append(caixa)
  return fig
}

// ---------------------------------------------------------------- o despacho

/** O primeiro objeto JSON que fecha dentro do texto, tolerando rabicho depois do `}`. */
export function primeiroObjeto(bruto) {
  const corpo = String(bruto ?? '').trim()
  const aceitar = (valor) =>
    typeof valor === 'object' && valor !== null && !Array.isArray(valor) ? valor : null

  try {
    return aceitar(JSON.parse(corpo))
  } catch {
    /* JSON torto: tenta o primeiro objeto completo, abaixo. */
  }

  const inicio = corpo.indexOf('{')
  if (inicio === -1) return null
  let profundidade = 0
  let emTexto = false
  let escape = false
  for (let i = inicio; i < corpo.length; i += 1) {
    const caractere = corpo[i]
    if (emTexto) {
      if (escape) escape = false
      else if (caractere === '\\') escape = true
      else if (caractere === '"') emTexto = false
      continue
    }
    if (caractere === '"') emTexto = true
    else if (caractere === '{') profundidade += 1
    else if (caractere === '}') {
      profundidade -= 1
      if (profundidade === 0) {
        try {
          return aceitar(JSON.parse(corpo.slice(inicio, i + 1)))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

function deduzirTipo(dados) {
  const lista = (chave) => (Array.isArray(dados[chave]) ? dados[chave] : [])

  if ((dados.pergunta ?? dados.enunciado) != null && lista('opcoes').length) return 'quiz'
  if (lista('cartoes').length) return 'metrica'
  if (lista('fluxos').length) return 'sankey'
  if (lista('ramos').length || dados.centro != null) return 'mapa'
  if (lista('passos').length || lista('etapas').length) return 'passos'
  if (lista('nos').length) return 'mapa-radial'

  const colunas = lista('colunas')
  const linhas = lista('linhas')

  if (colunas.length && linhas.length && Array.isArray(linhas[0])) return 'tabela'
  if (colunas.length && typeof colunas[0] === 'object' && colunas[0] !== null) {
    const primeira = colunas[0]
    if (Array.isArray(primeira.blocos ?? primeira.caixas)) return 'diagrama'
    if (Array.isArray(primeira.itens)) return 'comparacao'
  }

  if (linhas.length && typeof linhas[0] === 'string') return 'diagrama'
  if (linhas.length && typeof linhas[0] === 'object') return 'diffs'

  const itens = lista('itens')
  if (itens.length && typeof itens[0] === 'object' && itens[0] !== null) {
    const primeiro = itens[0]
    if (primeiro.valores != null || primeiro.especificacoes != null || dados.atributos != null) {
      return 'comparacao'
    }
    if (primeiro.filhos != null) return 'arvore'
  }

  const pontos_ = lista('dados')
  if (pontos_.length && typeof pontos_[0] === 'object' && pontos_[0] !== null) {
    if ('rotulo' in pontos_[0]) return 'barras'
  }

  if (dados.texto != null && (dados.tom != null || dados.titulo != null)) return 'citacao'
  return ''
}

function desenhar(tipo, dados, bruto, acoes) {
  const titulo = texto(dados.titulo ?? dados.title)
  const legenda = texto(dados.legenda ?? dados.caption ?? dados.descricao)
  const lista = pontos(dados.dados ?? dados.data ?? dados.valores ?? dados.items ?? dados.series)

  // Cada desenho já nasce dentro da própria `figure`. Embrulhar de novo criava um
  // `.kb` dentro de outro — dois vãos e o título separado do desenho por uma caixa.
  const moldura_ = (conteudo) => {
    if (conteudo.classList?.contains('kb')) {
      if (titulo) conteudo.prepend(no('figcaption', 'kb__titulo', titulo))
      if (legenda) conteudo.append(no('p', 'kb__legenda', legenda))
      return conteudo
    }
    return moldura(titulo, legenda, conteudo)
  }

  switch (tipo) {
    case 'barras':
    case 'barra':
    case 'grafico':
    case 'bar':
    case 'colunas': {
      if (!lista.length) return naoEntendi('não achei valores em `dados`', bruto)
      const deitado = dados.horizontal === true || dados.orientacao === 'horizontal'
      return moldura_(barras(lista, deitado))
    }

    case 'empilhadas':
    case 'empilhado':
    case 'stacked': {
      if (!lista.length) return naoEntendi('não achei valores em `dados`', bruto)
      const cru = dados.series ?? dados.legendas ?? dados.categorias
      const series = Array.isArray(cru) ? cru.map((s) => texto(s)) : ['Série 1', 'Série 2']
      return moldura_(empilhadas(lista, series))
    }

    case 'linhas':
    case 'linha':
    case 'line':
    case 'area':
    case 'área': {
      if (!lista.length) return naoEntendi('não achei valores em `dados`', bruto)
      return moldura_(linhas(lista, tipo === 'area' || tipo === 'área'))
    }

    case 'pizza':
    case 'rosca':
    case 'pie':
    case 'donut': {
      if (!lista.length) return naoEntendi('não achei valores em `dados`', bruto)
      return moldura_(pizza(lista, tipo === 'rosca' || tipo === 'donut'))
    }

    case 'dispersao':
    case 'dispersão':
    case 'scatter':
    case 'pontos': {
      if (!lista.length) return naoEntendi('não achei valores em `dados`', bruto)
      return moldura_(dispersao(lista, false))
    }

    case 'bolha':
    case 'bolhas':
    case 'bubble': {
      if (!lista.length) return naoEntendi('não achei valores em `dados`', bruto)
      return moldura_(dispersao(lista, true))
    }

    case 'radar':
    case 'teia':
    case 'aranha': {
      if (lista.length < 3) return naoEntendi('um radar precisa de pelo menos 3 eixos', bruto)
      return moldura_(radar(lista))
    }

    case 'timeline':
    case 'linha-do-tempo':
    case 'cronologia': {
      if (!lista.length) return naoEntendi('não achei valores em `dados`', bruto)
      return moldura_(timeline(lista))
    }

    case 'sankey':
    case 'fluxo-de-valor':
    case 'rios': {
      const fluxos = elos(dados.fluxos ?? dados.dados ?? dados.elos ?? dados.links)
      if (!fluxos.length) {
        return naoEntendi('um Sankey precisa de `fluxos` com `de`, `para` e `valor`', bruto)
      }
      return moldura_(sankey(fluxos))
    }

    case 'tabela':
    case 'table': {
      const colunas = Array.isArray(dados.colunas)
        ? dados.colunas.map((c) => texto(c))
        : lista.length
          ? ['Rótulo', 'Valor']
          : []
      const linhas = Array.isArray(dados.linhas)
        ? dados.linhas.map((l) => (Array.isArray(l) ? l.map((c) => texto(c)) : [texto(l)]))
        : lista.map((p) => [p.rotulo, fmt(p.valor)])
      if (!colunas.length || !linhas.length) {
        return naoEntendi('a tabela precisa de `colunas` e `linhas`', bruto)
      }
      return moldura_(tabela(colunas, linhas))
    }

    case 'mapa':
    case 'mapa-mental':
    case 'mental':
    case 'mindmap':
    case 'hierarquia': {
      const centro = texto(dados.centro ?? dados.raiz ?? dados.titulo ?? dados.tema)
      const galhos = ramos(dados.ramos ?? dados.galhos ?? dados.itens ?? dados.children)
      if (!centro && !galhos.length) {
        return naoEntendi('um mapa mental precisa de `centro` ou `ramos`', bruto)
      }
      return moldura_(mapaMental({ texto: centro || titulo }, galhos))
    }

    case 'passos':
    case 'fluxo':
    case 'etapas':
    case 'tutorial':
    case 'steps': {
      const cru = dados.passos ?? dados.etapas ?? dados.itens ?? dados.dados
      const lista_ = Array.isArray(cru)
        ? cru
            .map((item, i) => {
              if (typeof item === 'string') return { titulo: item }
              if (typeof item !== 'object' || item === null) return null
              return {
                titulo: texto(item.titulo ?? item.label ?? item.nome, String(i + 1)),
                texto: texto(item.texto ?? item.descricao ?? item.detalhe ?? item.explicacao),
              }
            })
            .filter(Boolean)
        : []
      if (!lista_.length) return naoEntendi('não achei `passos`', bruto)
      return moldura_(passos(lista_))
    }

    case 'comparacao':
    case 'comparar':
    case 'comparativo':
    case 'versus':
      return moldura_(comparacao(dados))

    case 'diagrama':
    case 'ascii':
    case 'fluxograma':
      return moldura_(diagrama(dados, bruto))

    case 'diffs':
    case 'diff':
    case 'diferenca': {
      const linhas_ = linhasDiff(dados.linhas ?? dados.mudancas ?? dados.diff ?? dados.dados)
      if (!linhas_.length) return naoEntendi('não achei `linhas`', bruto)
      return moldura_(diffs(texto(dados.arquivo ?? dados.file), linhas_))
    }

    case 'arvore':
    case 'arquivos':
    case 'pastas':
    case 'tree': {
      const lista_ = nosDaArvore(dados.itens ?? dados.arvore ?? dados.dados ?? dados.children)
      if (!lista_.length) return naoEntendi('não achei `itens`', bruto)
      return moldura_(arvore(lista_))
    }

    case 'metrica':
    case 'metricas':
    case 'kpi':
    case 'numeros': {
      const lista_ = cartoes(dados.cartoes ?? dados.itens ?? dados.dados)
      if (!lista_.length) return naoEntendi('não achei `cartoes`', bruto)
      return moldura_(metrica(lista_))
    }

    case 'citacao':
    case 'alerta':
    case 'aviso':
    case 'callout': {
      const tom = texto(dados.tom ?? dados.nivel ?? dados.classe ?? dados.kind).toLowerCase()
      const tomDoAviso = TONS_DE_AVISO.includes(tom) ? tom : 'info'
      const tit = texto(dados.titulo ?? dados.title)
      const corpo = texto(dados.texto ?? dados.mensagem ?? dados.descricao ?? dados.content)
      if (!corpo && !tit) return naoEntendi('o aviso precisa de `texto`', bruto)
      // O aviso já desenha o próprio título; repetir na moldura duplicava a linha.
      return moldura('', legenda, citacao(tomDoAviso, tit, corpo))
    }

    case 'quiz':
    case 'pergunta': {
      const cru = dados.opcoes ?? dados.alternativas
      const opcoes = Array.isArray(cru)
        ? cru
            .map((item) => {
              if (typeof item === 'string') return item
              if (typeof item !== 'object' || item === null) return null
              return texto(item.texto ?? item.opcao ?? item.label) || null
            })
            .filter(Boolean)
        : []
      if (opcoes.length < 2) return naoEntendi('um quiz precisa de pelo menos 2 `opcoes`', bruto)
      const pergunta = texto(dados.pergunta ?? dados.enunciado) || titulo
      if (!pergunta) return naoEntendi('falta a `pergunta`', bruto)
      const corretaCru = dados.correta ?? dados.resposta
      let correta
      if (typeof corretaCru === 'number' && Number.isFinite(corretaCru)) correta = corretaCru
      else if (typeof corretaCru === 'string' && /^\d+$/.test(corretaCru.trim())) {
        correta = Number(corretaCru.trim())
      }
      return moldura_(quiz(pergunta, opcoes, correta, texto(dados.explicacao)))
    }

    case 'mapa-radial':
    case 'constelacao':
    case 'radial': {
      const lista_ = nosRadiais(dados.nos ?? dados.itens ?? dados.dados)
      if (!lista_.length) return naoEntendi('o mapa radial precisa de `nos`', bruto)
      const centro = texto(dados.centro ?? dados.raiz) || titulo
      if (!centro) return naoEntendi('falta o `centro`', bruto)
      return moldura_(
        mapaRadial(
          centro,
          texto(dados.centro_sub ?? dados.centro_subtitulo),
          lista_,
        ),
      )
    }

    case 'plano':
    case 'plan':
    case 'planejamento':
      return plano(dados, titulo, acoes)

    default:
      return naoEntendi(
        tipo
          ? `não conheço o tipo "${tipo}". Disponíveis: barras, empilhadas, linhas, area, pizza, rosca, dispersao, bolha, radar, timeline, sankey, tabela, mapa, mapa-radial, passos, comparacao, diffs, arvore, metrica, citacao, quiz, plano`
          : 'falta o campo `tipo`',
        bruto,
      )
  }
}

/* ------------------------------------------------------- interface inteligente */

/**
 * O Koda UI Protocol no celular.
 *
 * O PC já desenha ```` ```koda-ui-doc ```` com `src/components/KodaUI/desenho.tsx`; aqui
 * é a mesma árvore `{id,type,props,children}`, com um subconjunto de componentes e o
 * mesmo princípio de segurança: **texto vira texto**, nada de `innerHTML`, HTML, CSS ou
 * JavaScript do modelo. O que o celular não conhece vira um aviso discreto — a conversa
 * em volta continua legível, em vez de a interface inteira sumir.
 *
 * As ações declarativas são as mesmas (`state.*`, `copy`, `openUrl`, `issueNewTurn`),
 * executadas por código daqui. Nenhuma função vem no JSON.
 */

const KI_LIMITES = { profundidade: 12, nos: 250, bytes: 256 * 1024 }

/** URL segura: http/https/mailto; imagem aceita `data:image` pequena. */
function kiUrl(valor, imagem = false) {
  if (typeof valor !== 'string') return null
  const bruto = valor.trim()
  if (!bruto || bruto.length > 2000) return null
  if (imagem && /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(bruto)) {
    return bruto.length > 200 * 1024 ? null : bruto
  }
  try {
    const url = new URL(bruto)
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return null
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.hostname) return null
    if (url.username || url.password) return null
    return bruto
  } catch {
    return null
  }
}

/** `{{chave}}` vira o valor do estado — sempre texto, nunca marcação. */
function kiInterpolar(valor, estado) {
  return texto(valor).replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, chave) => {
    const vivo = estado[chave]
    if (vivo === null || vivo === undefined) return ''
    if (typeof vivo === 'object') {
      try {
        return JSON.stringify(vivo)
      } catch {
        return ''
      }
    }
    return String(vivo)
  })
}

function kiProps(bruto) {
  const props = bruto?.props ?? bruto?.propriedades
  return props && typeof props === 'object' && !Array.isArray(props) ? props : {}
}

function kiFilhos(bruto) {
  const filhos = bruto?.children ?? bruto?.filhos
  return Array.isArray(filhos) ? filhos : []
}

/** O tom dos selos/avisos, como no PC. */
function kiTom(valor, padrao = 'info') {
  const tom = texto(valor, padrao).toLowerCase()
  return ['neutro', 'info', 'sucesso', 'aviso', 'erro'].includes(tom) ? tom : padrao
}

/**
 * Avalia uma expressão aritmética sobre o estado — **sem `eval`**.
 *
 * Mesma gramática do PC (`avaliarExpressao` em `protocolo.ts`): números,
 * `+ - * / %`, parênteses e nomes de chaves de `state`. Qualquer outra coisa
 * devolve `null`, e a calculadora mostra «—» em vez de inventar um número.
 */
function kiAvaliar(expressao, estado) {
  const s = texto(expressao)
  if (!s || s.length > 300) return null
  if (!/^[0-9A-Za-z_+\-*/%().\s]+$/.test(s)) return null
  let i = 0
  const pular = () => {
    while (i < s.length && /\s/.test(s[i])) i += 1
  }
  const primario = () => {
    pular()
    if (s[i] === '(') {
      i += 1
      const valor = soma()
      pular()
      if (s[i] !== ')') return null
      i += 1
      return valor
    }
    if (s[i] === '-') {
      i += 1
      const valor = primario()
      return valor === null ? null : -valor
    }
    if (s[i] === '+') {
      i += 1
      return primario()
    }
    const numero = /^[0-9]+(?:\.[0-9]+)?/.exec(s.slice(i))
    if (numero) {
      i += numero[0].length
      return Number(numero[0])
    }
    const nome = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i))
    if (nome) {
      i += nome[0].length
      const valor = Number(estado[nome[0]])
      return Number.isFinite(valor) ? valor : null
    }
    return null
  }
  const produto = () => {
    let valor = primario()
    if (valor === null) return null
    for (;;) {
      pular()
      const operador = s[i]
      if (operador !== '*' && operador !== '/' && operador !== '%') break
      i += 1
      const direito = primario()
      if (direito === null) return null
      if ((operador === '/' || operador === '%') && direito === 0) return null
      valor =
        operador === '*' ? valor * direito : operador === '/' ? valor / direito : valor % direito
    }
    return valor
  }
  const soma = () => {
    let valor = produto()
    if (valor === null) return null
    for (;;) {
      pular()
      const operador = s[i]
      if (operador !== '+' && operador !== '-') break
      i += 1
      const direito = produto()
      if (direito === null) return null
      valor = operador === '+' ? valor + direito : valor - direito
    }
    return valor
  }
  const resultado = soma()
  pular()
  return i === s.length && Number.isFinite(resultado) ? resultado : null
}

const KI_NS = 'http://www.w3.org/2000/svg'

/** Contador só dos ids internos do SVG (marcador de seta) — único por documento. */
let kiSequenciaSvg = 0

/** Um elemento SVG com atributos — nada de `innerHTML`, nem de string de SVG. */
function kiSvg(tag, atributos = {}) {
  const elemento = document.createElementNS(KI_NS, tag)
  for (const [chave, valor] of Object.entries(atributos)) {
    if (valor !== null && valor !== undefined) elemento.setAttribute(chave, String(valor))
  }
  return elemento
}

/**
 * Ícones desenhados por nós (traços fixos), como no PC.
 *
 * O nome vem do documento; nome desconhecido vira um círculo — nunca vira HTML
 * nem carrega SVG de fora.
 */
const KI_ICONES = {
  check: ['path', { d: 'M4 12l5 5L20 6' }],
  certo: ['path', { d: 'M4 12l5 5L20 6' }],
  x: ['path', { d: 'M6 6l12 12M18 6L6 18' }],
  fechar: ['path', { d: 'M6 6l12 12M18 6L6 18' }],
  mais: ['path', { d: 'M12 5v14M5 12h14' }],
  menos: ['path', { d: 'M5 12h14' }],
  seta: ['path', { d: 'M5 12h14M13 6l6 6-6 6' }],
  estrela: ['polygon', { points: '12,2 15,9 22,9 16,14 18,21 12,17 6,21 8,14 2,9 9,9' }],
  sol: ['circle', { cx: 12, cy: 12, r: 4 }],
  lua: ['path', { d: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z' }],
  nuvem: ['path', { d: 'M18 18H7a4 4 0 1 1 .8-7.9A6 6 0 0 1 19 11a3.5 3.5 0 0 1-1 7z' }],
  pasta: ['path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }],
  arquivo: ['path', { d: 'M6 3h8l4 4v14H6zM14 3v4h4' }],
  link: ['path', { d: 'M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1' }],
  usuario: ['circle', { cx: 12, cy: 8, r: 4 }],
  relogio: ['circle', { cx: 12, cy: 12, r: 9 }],
  calendario: ['rect', { x: 3, y: 5, width: 18, height: 16, rx: 2 }],
  grafico: ['path', { d: 'M4 20V10M10 20V4M16 20v-7M22 20H2' }],
  codigo: ['path', { d: 'M8 6l-5 6 5 6M16 6l5 6-5 6' }],
  busca: ['circle', { cx: 11, cy: 11, r: 7 }],
  calculadora: ['rect', { x: 5, y: 3, width: 14, height: 18, rx: 2 }],
  faisca: ['path', { d: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z' }],
  alerta: ['path', { d: 'M12 3l9 16H3zM12 9v5M12 17h.01' }],
  info: ['circle', { cx: 12, cy: 12, r: 9 }],
}

function kiIcone(nome, tamanho = 20, rotulo = '') {
  const chave = texto(nome, 'circulo').toLowerCase()
  const desenho = KI_ICONES[chave]
  const px = Math.max(12, Math.min(64, Number(tamanho) || 20))
  const svg = kiSvg('svg', {
    viewBox: '0 0 24 24',
    width: px,
    height: px,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.7,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    role: rotulo ? 'img' : null,
    'aria-label': rotulo || null,
    'aria-hidden': rotulo ? null : 'true',
  })
  svg.classList.add('ki-icone')
  if (desenho) {
    const [tag, atributos] = desenho
    const forma = kiSvg(tag, atributos)
    if (tag === 'circle' || tag === 'rect' || tag === 'polygon') {
      forma.setAttribute('fill', chave === 'estrela' ? 'currentColor' : 'none')
    }
    svg.append(forma)
    if (chave === 'info') svg.append(kiSvg('path', { d: 'M12 11v5M12 8h.01' }))
    if (chave === 'usuario') svg.append(kiSvg('path', { d: 'M4 21a8 8 0 0 1 16 0' }))
    if (chave === 'relogio') svg.append(kiSvg('path', { d: 'M12 7v5l3 2' }))
    if (chave === 'calendario') svg.append(kiSvg('path', { d: 'M3 9h18M8 3v4M16 3v4' }))
    if (chave === 'busca') svg.append(kiSvg('path', { d: 'M16 16l5 5' }))
    if (chave === 'sol') svg.append(kiSvg('path', { d: 'M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19' }))
  } else {
    svg.append(kiSvg('circle', { cx: 12, cy: 12, r: 8 }))
  }
  return svg
}

/**
 * Desenha um documento do Koda UI Protocol.
 *
 * Devolve sempre um nó: documento inválido vira aviso, não exceção — o mesmo contrato
 * dos outros blocos visuais.
 */
export function desenharInterface(bruto) {
  const dados = primeiroObjeto(bruto)
  if (!dados) return naoEntendi('a interface não é um JSON válido', String(bruto ?? '').slice(0, 600))
  const raiz = dados.documento && typeof dados.documento === 'object' ? dados.documento : dados

  try {
    if (JSON.stringify(raiz).length > KI_LIMITES.bytes) {
      return naoEntendi('a interface passou de 256 KB', '')
    }
    const versao = texto(raiz.schemaVersion ?? raiz.versao, '1.0')
    if (versao !== '1.0') return naoEntendi(`versão ${versao} não suportada`, '')
    const arvore = raiz.root ?? raiz.raiz
    if (!arvore || typeof arvore !== 'object') return naoEntendi('falta a árvore `root`', '')
  } catch {
    return naoEntendi('não consegui ler a interface', '')
  }

  const estado = {}
  const estadoBruto = raiz.state ?? raiz.estado
  if (estadoBruto && typeof estadoBruto === 'object' && !Array.isArray(estadoBruto)) {
    for (const [chave, valor] of Object.entries(estadoBruto)) {
      if (/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(chave)) estado[chave] = valor
    }
  }
  const acoes = {}
  const acoesBrutas = raiz.actions ?? raiz.acoes
  if (acoesBrutas && typeof acoesBrutas === 'object' && !Array.isArray(acoesBrutas)) {
    for (const [id, acao] of Object.entries(acoesBrutas)) {
      if (acao && typeof acao === 'object' && !Array.isArray(acao)) acoes[id] = acao
    }
  }

  const cartao = no('div', 'ki')
  cartao.setAttribute('role', 'group')
  let contador = 0

  const executar = (id) => {
    const acao = acoes[id]
    if (!acao) return
    const tipo = texto(acao.kind ?? acao.tipo)
    const chave = texto(acao.key)
    switch (tipo) {
      case 'state.set':
        if (chave) {
          estado[chave] = acao.value
          renderizar()
        }
        break
      case 'state.toggle':
        if (chave) {
          estado[chave] = !estado[chave]
          renderizar()
        }
        break
      case 'state.increment':
        if (chave) {
          estado[chave] = Number(estado[chave] ?? 0) + Number(acao.amount ?? 1)
          renderizar()
        }
        break
      case 'ui.setTab':
        if (chave) {
          estado[chave] = acao.value
          renderizar()
        }
        break
      case 'copy':
        navigator.clipboard?.writeText(texto(acao.text)).catch(() => undefined)
        break
      case 'openUrl': {
        const url = kiUrl(acao.url)
        if (url) window.open(url, '_blank', 'noopener')
        break
      }
      case 'issueNewTurn': {
        const mensagem = texto(acao.mensagem)
        if (mensagem) {
          window.dispatchEvent(new CustomEvent('koda:enviar', { detail: { texto: mensagem } }))
        }
        break
      }
      default:
        break
    }
  }

  const contexto = { estado, acoes, executar }

  function renderizar() {
    cartao.replaceChildren()
    contador = 0
    try {
      cartao.append(kiNo(raiz.root ?? raiz.raiz, contexto, 1, renderizar))
    } catch (erro) {
      cartao.append(naoEntendi(erro instanceof Error ? erro.message : 'a interface falhou', ''))
    }
  }

  function kiNo(brutoNo, ctx, profundidade, redesenhar) {
    if (!brutoNo || typeof brutoNo !== 'object') throw new Error('nó precisa ser um objeto')
    if (profundidade > KI_LIMITES.profundidade) throw new Error('a árvore passou de 12 níveis')
    contador += 1
    if (contador > KI_LIMITES.nos) throw new Error('a interface passou de 250 nós')

    const p = kiProps(brutoNo)
    const tipo = texto(brutoNo.type ?? brutoNo.tipo)
    const filhos = () => kiFilhos(brutoNo).map((filho) => kiNo(filho, ctx, profundidade + 1, redesenhar))
    const t = (nome = 'texto') => kiInterpolar(p[nome], ctx.estado)
    const n = (nome, padrao) => {
      const valor = Number(p[nome])
      return Number.isFinite(valor) ? valor : padrao
    }
    const vao = (nome, padrao) => `${Math.max(0, Math.min(8, n(nome, padrao))) * 4}px`

    switch (tipo) {
      case 'KodaBox': {
        const caixa = no('div', 'ki-caixa')
        caixa.style.gap = vao('gap', 1)
        caixa.style.padding = p.padding ? vao('padding', 2) : ''
        caixa.append(...filhos())
        return caixa
      }
      case 'KodaRow': {
        const linha = no('div', 'ki-linha')
        linha.style.gap = vao('gap', 2)
        linha.append(...filhos())
        return linha
      }
      case 'KodaColumn': {
        const coluna = no('div', 'ki-coluna')
        coluna.style.gap = vao('gap', 2)
        coluna.append(...filhos())
        return coluna
      }
      case 'KodaGrid': {
        const grade = no('div', 'ki-grade')
        grade.style.gap = vao('gap', 2)
        grade.style.gridTemplateColumns = `repeat(${Math.max(1, Math.min(6, n('cols', 2)))}, minmax(0, 1fr))`
        grade.append(...filhos())
        return grade
      }
      case 'KodaCard': {
        const cartaoInterno = no('div', 'ki-cartao')
        if (p.titulo) cartaoInterno.append(no('span', 'ki-cartao__titulo', t('titulo')))
        cartaoInterno.append(...filhos())
        return cartaoInterno
      }
      case 'KodaTitle': {
        const nivel = Math.max(1, Math.min(4, n('nivel', 3)))
        const titulo = no(`h${nivel + 2}`, `ki-titulo ki-titulo--${nivel}`, t())
        return titulo
      }
      case 'KodaText':
        return no('span', 'ki-texto', t())
      case 'KodaParagraph':
        return no('p', 'ki-paragrafo', t())
      case 'KodaCaption':
        return no('span', 'ki-legenda', t())
      case 'KodaLabel': {
        const rotulo = no('span', 'ki-rotulo', t())
        rotulo.append(...filhos())
        return rotulo
      }
      case 'KodaBadge':
        return no('span', `ki-selo ki-tom--${kiTom(p.tom, 'neutro')}`, t())
      case 'KodaAlert':
      case 'KodaCallout': {
        const aviso = no('div', `ki-aviso ki-tom--${kiTom(p.tom)}`, t())
        aviso.append(...filhos())
        return aviso
      }
      case 'KodaDivider':
        return no('hr', 'ki-divisor')
      case 'KodaSpacer': {
        const espaco = no('div', 'ki-espaco')
        espaco.style.height = `${Math.max(0, Math.min(64, n('altura', 8)))}px`
        return espaco
      }
      case 'KodaList': {
        const itens = Array.isArray(p.itens) ? p.itens : []
        const lista = no(p.ordenada ? 'ol' : 'ul', 'ki-lista')
        for (const item of itens.slice(0, 100)) {
          lista.append(no('li', '', kiInterpolar(item, ctx.estado)))
        }
        return lista
      }
      case 'KodaLink': {
        const url = kiUrl(p.href)
        if (!url) return no('span', 'ki-legenda', t())
        const link = no('a', 'ki-link', t())
        link.href = url
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        return link
      }
      case 'KodaCodeBlock': {
        const pre = no('pre', 'ki-codigo')
        // O modelo manda `codigo` ou `code`, sem padrão fixo — aceitamos os dois,
        // igual ao PC.
        pre.append(no('code', '', texto(p.codigo ?? p.code)))
        return pre
      }
      case 'KodaImage': {
        const src = kiUrl(p.src, true)
        if (!src) return no('div', 'ki-aviso ki-tom--aviso', 'Imagem indisponível.')
        const figura = no('figure', 'ki-figura')
        const imagem = no('img', 'ki-imagem')
        imagem.src = src
        imagem.alt = texto(p.alt)
        imagem.loading = 'lazy'
        figura.append(imagem)
        if (p.legenda) figura.append(no('figcaption', 'ki-legenda', t('legenda')))
        return figura
      }
      case 'KodaTable': {
        const colunas = Array.isArray(p.colunas) ? p.colunas : []
        const linhas = Array.isArray(p.linhas) ? p.linhas : []
        const tabela = no('table', 'ki-tabela')
        if (colunas.length) {
          const cabecalho = no('thead')
          const linha = no('tr')
          for (const coluna of colunas.slice(0, 20)) linha.append(no('th', '', texto(coluna)))
          cabecalho.append(linha)
          tabela.append(cabecalho)
        }
        const corpo = no('tbody')
        for (const linhaBruta of linhas.slice(0, 500)) {
          const linha = no('tr')
          const celulas = Array.isArray(linhaBruta) ? linhaBruta : [linhaBruta]
          for (const celula of celulas.slice(0, 20)) linha.append(no('td', '', texto(celula)))
          corpo.append(linha)
        }
        tabela.append(corpo)
        return tabela
      }
      case 'KodaMetric': {
        const metrica = no('div', 'ki-metrica')
        metrica.append(no('span', 'ki-legenda', t('rotulo')))
        metrica.append(no('span', 'ki-metrica__valor', t('valor')))
        if (p.variacao) metrica.append(no('span', 'ki-legenda', t('variacao')))
        return metrica
      }
      case 'KodaProgress': {
        const trilha = no('div', 'ki-progresso')
        const barra = no('div', 'ki-progresso__barra')
        const maximo = Math.max(1, n('max', 100))
        barra.style.width = `${Math.max(0, Math.min(100, (n('valor', 0) / maximo) * 100))}%`
        trilha.append(barra)
        return trilha
      }
      case 'KodaButton': {
        const botao = no('button', `ki-botao ki-botao--${texto(p.variante, 'primario')}`, t('rotulo'))
        botao.type = 'button'
        botao.disabled = Boolean(p.desabilitado)
        botao.addEventListener('click', () => ctx.executar(texto(p.actionId)))
        return botao
      }
      case 'KodaSuggestion': {
        const sugestao = no('button', 'ki-sugestao', t())
        sugestao.type = 'button'
        sugestao.addEventListener('click', () => ctx.executar(texto(p.actionId)))
        return sugestao
      }
      case 'KodaPressable': {
        const area = no('div', 'ki-pressavel')
        area.append(...filhos())
        area.addEventListener('click', () => ctx.executar(texto(p.actionId)))
        return area
      }
      case 'KodaInput':
      case 'KodaTextarea': {
        const chave = texto(p.valueBinding?.key ?? p.valueBinding)
        const rotulo = no('label', 'ki-campo')
        if (p.rotulo) rotulo.append(no('span', '', t('rotulo')))
        const campo =
          tipo === 'KodaTextarea'
            ? no('textarea', '')
            : no('input', '')
        if (tipo === 'KodaInput') {
          const formato = texto(p.tipo, 'texto')
          campo.type = formato === 'numero' ? 'number' : formato === 'email' ? 'email' : 'text'
        } else {
          campo.rows = Math.max(2, Math.min(12, n('linhas', 3)))
        }
        campo.value = texto(chave ? ctx.estado[chave] : '')
        campo.placeholder = texto(p.placeholder)
        if (chave) {
          campo.addEventListener('input', () => {
            ctx.estado[chave] = campo.value
          })
        }
        rotulo.append(campo)
        return rotulo
      }
      case 'KodaCheckbox':
      case 'KodaToggle': {
        const chave = texto(p.valueBinding?.key ?? p.valueBinding)
        const linha = no('label', 'ki-opcao')
        const caixa = no('input', '')
        caixa.type = 'checkbox'
        caixa.checked = Boolean(chave ? ctx.estado[chave] : false)
        if (chave) {
          caixa.addEventListener('change', () => {
            ctx.estado[chave] = caixa.checked
          })
        }
        linha.append(caixa, no('span', '', t('rotulo')))
        return linha
      }
      case 'KodaSelect': {
        const chave = texto(p.valueBinding?.key ?? p.valueBinding)
        const rotulo = no('label', 'ki-campo')
        if (p.rotulo) rotulo.append(no('span', '', t('rotulo')))
        const select = no('select', '')
        for (const opcao of (Array.isArray(p.opcoes) ? p.opcoes : []).slice(0, 100)) {
          const item = no('option', '', texto(opcao?.rotulo ?? opcao?.label ?? opcao))
          item.value = texto(opcao?.valor ?? opcao?.value ?? opcao)
          select.append(item)
        }
        select.value = texto(chave ? ctx.estado[chave] : '')
        if (chave) {
          select.addEventListener('change', () => {
            ctx.estado[chave] = select.value
          })
        }
        rotulo.append(select)
        return rotulo
      }
      case 'KodaSlider': {
        const chave = texto(p.valueBinding?.key ?? p.valueBinding)
        const rotulo = no('label', 'ki-campo')
        if (p.rotulo) rotulo.append(no('span', '', `${t('rotulo')} · ${texto(chave ? ctx.estado[chave] : '')}`))
        const faixa = no('input', '')
        faixa.type = 'range'
        faixa.min = String(n('min', 0))
        faixa.max = String(n('max', 100))
        faixa.step = String(n('passo', 1))
        faixa.value = String(chave ? ctx.estado[chave] : n('min', 0))
        if (chave) {
          faixa.addEventListener('input', () => {
            ctx.estado[chave] = Number(faixa.value)
          })
        }
        rotulo.append(faixa)
        return rotulo
      }
      case 'KodaForm': {
        const formulario = no('div', 'ki-formulario')
        formulario.append(...filhos())
        if (p.botao) {
          const enviar = no('button', 'ki-botao ki-botao--primario', texto(p.botao))
          enviar.type = 'button'
          enviar.addEventListener('click', () => ctx.executar(texto(p.actionId)))
          formulario.append(enviar)
        }
        return formulario
      }
      case 'KodaTabs': {
        const abas = (Array.isArray(p.abas) ? p.abas : []).map((aba) => texto(aba))
        const ativa = Math.max(0, abas.indexOf(texto(ctx.estado.__aba)) || 0)
        const bloco = no('div', 'ki-abas')
        const barra = no('div', 'ki-abas__barra')
        abas.forEach((aba, indice) => {
          const botao = no('button', `ki-aba${indice === ativa ? ' ki-aba--ativa' : ''}`, aba)
          botao.type = 'button'
          botao.addEventListener('click', () => {
            ctx.estado.__aba = aba
            redesenhar()
          })
          barra.append(botao)
        })
        bloco.append(barra)
        const painel = no('div', 'ki-abas__painel')
        const filhosBrutos = kiFilhos(brutoNo)
        const temAbaNosFilhos = filhosBrutos.some((filho) => texto(kiProps(filho).aba))
        for (const [indice, filho] of filhosBrutos.entries()) {
          if (temAbaNosFilhos && texto(kiProps(filho).aba) !== abas[ativa]) continue
          painel.append(kiNo(filho, ctx, profundidade + 1, redesenhar))
          if (!temAbaNosFilhos && indice > 0) break
        }
        bloco.append(painel)
        return bloco
      }
      case 'KodaSteps': {
        const itens = Array.isArray(p.itens) ? p.itens : []
        const lista = no('ol', 'ki-passos')
        for (const item of itens.slice(0, 100)) {
          const passo = no('li', '', texto(item?.titulo ?? item?.label ?? item))
          if (item && typeof item === 'object' && (item.detalhe || item.descricao)) {
            passo.append(no('span', 'ki-legenda', texto(item.detalhe ?? item.descricao)))
          }
          lista.append(passo)
        }
        return lista
      }
      case 'KodaAccordion': {
        const detalhes = no('details', 'ki-acordeao')
        detalhes.append(no('summary', '', t('titulo')))
        detalhes.append(...filhos())
        return detalhes
      }
      case 'KodaQuote': {
        const citacao = no('blockquote', 'ki-citacao', t())
        if (p.autor) citacao.append(no('footer', 'ki-legenda', `— ${t('autor')}`))
        return citacao
      }
      case 'KodaSourceList': {
        const fontes = Array.isArray(p.fontes) ? p.fontes : []
        const lista = no('ol', 'ki-lista')
        for (const fonte of fontes.slice(0, 50)) {
          const item = no('li')
          const url = kiUrl(fonte?.url)
          if (url) {
            const link = no('a', 'ki-link', texto(fonte.titulo) || url)
            link.href = url
            link.target = '_blank'
            link.rel = 'noopener noreferrer'
            item.append(link)
          } else {
            item.textContent = texto(fonte?.titulo, 'fonte indisponível')
          }
          lista.append(item)
        }
        return lista
      }
      case 'KodaCitation': {
        const citacao = no('span', 'ki-citacao-inline', t())
        if (p.fonte) citacao.append(no('span', 'ki-legenda', ` — ${t('fonte')}`))
        return citacao
      }
      case 'KodaEntity': {
        const entidade = no('div', 'ki-entidade')
        entidade.append(no('span', 'ki-selo ki-tom--neutro', texto(p.tipo, 'arquivo')))
        entidade.append(no('span', 'ki-entidade__nome', t('nome')))
        if (p.detalhe) entidade.append(no('span', 'ki-legenda', t('detalhe')))
        return entidade
      }
      case 'KodaDiff': {
        const bloco = no('div', 'ki-diff')
        bloco.append(no('pre', 'ki-diff__antes', texto(p.antes)))
        bloco.append(no('pre', 'ki-diff__depois', texto(p.depois)))
        return bloco
      }
      case 'KodaChart': {
        // O modelo manda os pontos em `dados`, ou em `labels`/`values` paralelos ao lado.
        const conteudo = Array.isArray(p.labels) && Array.isArray(p.values)
          ? { labels: p.labels, values: p.values }
          : p.dados
        const desenho = desenharBloco(
          'koda-grafico',
          JSON.stringify({ tipo: texto(p.tipo, 'barras'), dados: conteudo, titulo: texto(p.titulo) }),
        )
        return desenho
      }
      case 'KodaCarousel': {
        const itens = Array.isArray(p.itens) ? p.itens : []
        const lista = no('div', 'ki-carrossel')
        for (const item of itens.slice(0, 30)) {
          lista.append(no('div', 'ki-cartao', texto(item?.titulo ?? item?.texto ?? item)))
        }
        return lista
      }
      case 'KodaPopover': {
        const detalhes = no('details', 'ki-acordeao')
        detalhes.append(no('summary', '', t('rotulo')))
        detalhes.append(...filhos())
        return detalhes
      }
      case 'KodaSandbox':
      case 'KodaAppBlock': {
        const aviso = no('div', 'ki-aviso ki-tom--aviso')
        aviso.textContent = 'Este bloco interativo não roda no celular.'
        if (p.titulo) aviso.prepend(no('strong', '', `${texto(p.titulo)} — `))
        return aviso
      }
      // ---------------------------------------------------------- extras (os mesmos do PC)
      case 'KodaSvg': {
        const formas = Array.isArray(p.formas) ? p.formas : []
        const caixaDoDesenho = /^-?\d+(?:\.\d+)?(?: -?\d+(?:\.\d+)?){3}$/.test(texto(p.viewBox))
          ? texto(p.viewBox)
          : '0 0 320 180'
        const moldura = no('div', 'ki-figura-tecnica')
        const svg = kiSvg('svg', {
          viewBox: caixaDoDesenho,
          preserveAspectRatio: 'xMidYMid meet',
          role: 'img',
          'aria-label': texto(p.titulo, 'desenho vetorial'),
        })
        svg.classList.add('ki-svg')
        for (const forma of formas.slice(0, 120)) {
          const item = forma && typeof forma === 'object' ? forma : {}
          const tipoForma = texto(item.tipo).toLowerCase()
          const cor = texto(item.cor, 'acento')
          const espessura = Math.max(1, Math.min(12, Number(item.espessura) || 2))
          const num = (nome, padrao = 0) => {
            const valor = Number(item[nome])
            return Number.isFinite(valor) ? valor : padrao
          }
          let desenho = null
          if (tipoForma === 'linha') {
            desenho = kiSvg('line', {
              x1: num('x1'),
              y1: num('y1'),
              x2: num('x2'),
              y2: num('y2'),
              stroke: 'currentColor',
              'stroke-width': espessura,
              'stroke-linecap': 'round',
            })
          } else if (tipoForma === 'circulo') {
            desenho = kiSvg('circle', {
              cx: num('cx'),
              cy: num('cy'),
              r: Math.max(0, num('r', 4)),
              fill: 'currentColor',
            })
          } else if (tipoForma === 'retangulo') {
            desenho = kiSvg('rect', {
              x: num('x'),
              y: num('y'),
              width: Math.max(0, num('largura', 10)),
              height: Math.max(0, num('altura', 10)),
              rx: Math.max(0, num('rx', 2)),
              fill: 'currentColor',
              opacity: 0.85,
            })
          } else if (tipoForma === 'texto') {
            desenho = kiSvg('text', {
              x: num('x'),
              y: num('y'),
              fill: 'currentColor',
              'font-size': Math.max(6, Math.min(24, num('tamanho', 12))),
            })
            desenho.textContent = texto(item.texto).slice(0, 200)
          } else if (tipoForma === 'caminho') {
            const d = texto(item.d)
            if (/^[0-9MmLlHhVvCcSsQqTtAaZz,.\s+-]{1,2000}$/.test(d)) {
              desenho = kiSvg('path', {
                d,
                fill: 'none',
                stroke: 'currentColor',
                'stroke-width': espessura,
                'stroke-linecap': 'round',
                'stroke-linejoin': 'round',
              })
            }
          } else if (tipoForma === 'poligono') {
            const pontos = texto(item.pontos)
            if (/^[0-9,.\s+-]{1,800}$/.test(pontos)) {
              desenho = kiSvg('polygon', { points: pontos, fill: 'currentColor', opacity: 0.85 })
            }
          }
          if (desenho) {
            const tons = ['acento', 'sucesso', 'aviso', 'erro', 'neutro', 'fraco']
            desenho.classList.add(`ki-cor--${tons.includes(cor) ? cor : 'acento'}`)
            svg.append(desenho)
          }
        }
        moldura.append(svg)
        if (p.titulo) moldura.append(no('span', 'ki-legenda', t('titulo')))
        return moldura
      }
      case 'KodaVideo': {
        const src = kiUrl(p.src)
        if (!src) return no('div', 'ki-aviso ki-tom--aviso', 'Vídeo indisponível.')
        const figura = no('figure', 'ki-video')
        const video = no('video', '')
        video.controls = true
        video.preload = 'metadata'
        video.src = src
        const poster = kiUrl(p.poster, true)
        if (poster) video.poster = poster
        figura.append(video)
        if (p.legenda) figura.append(no('figcaption', 'ki-legenda', t('legenda')))
        return figura
      }
      case 'KodaIcon':
        return kiIcone(texto(p.nome ?? p.icone, 'circulo'), n('tamanho', 20), texto(p.rotulo))
      case 'KodaMap': {
        const pontos = (Array.isArray(p.pontos) ? p.pontos : [])
          .map((ponto) => ({
            rotulo: texto(ponto?.rotulo),
            lat: Number(ponto?.lat),
            lon: Number(ponto?.lon),
          }))
          .filter((ponto) => Number.isFinite(ponto.lat) && Number.isFinite(ponto.lon))
        if (!pontos.length) return no('span', 'ki-legenda', 'Mapa sem coordenadas válidas.')
        const lats = pontos.map((ponto) => ponto.lat)
        const lons = pontos.map((ponto) => ponto.lon)
        const minLat = Math.min(...lats)
        const maxLat = Math.max(...lats)
        const minLon = Math.min(...lons)
        const maxLon = Math.max(...lons)
        const faixa = Math.max(0.02, maxLat - minLat, maxLon - minLon)
        const x = (lon) => 22 + ((lon - minLon) / faixa) * 276
        const y = (lat) => 156 - ((lat - minLat) / faixa) * 116
        const moldura = no('div', 'ki-figura-tecnica')
        const svg = kiSvg('svg', {
          viewBox: '0 0 320 180',
          role: 'img',
          'aria-label': texto(p.titulo, 'mapa de pontos'),
        })
        svg.classList.add('ki-svg')
        for (const ponto of pontos.slice(0, 40)) {
          const cx = x(ponto.lon)
          const cy = y(ponto.lat)
          svg.append(kiSvg('circle', { cx, cy, r: 7, fill: 'currentColor', 'fill-opacity': 0.15 }))
          svg.append(kiSvg('circle', { cx, cy, r: 3.2, fill: 'currentColor' }))
          if (ponto.rotulo) {
            const rotulo = kiSvg('text', {
              x: cx + (cx > 226 ? -9 : 9),
              y: cy + 3,
              'text-anchor': cx > 226 ? 'end' : 'start',
              'font-size': 8.5,
              fill: 'currentColor',
            })
            rotulo.textContent = ponto.rotulo.slice(0, 20)
            svg.append(rotulo)
          }
        }
        moldura.append(svg)
        const legenda = no('div', 'ki-mapa__legenda')
        for (const ponto of pontos.slice(0, 8)) {
          const url = `https://www.openstreetmap.org/?mlat=${ponto.lat}&mlon=${ponto.lon}#map=14/${ponto.lat}/${ponto.lon}`
          const link = no('a', 'ki-link', ponto.rotulo || 'ponto')
          link.href = url
          link.target = '_blank'
          link.rel = 'noopener noreferrer'
          legenda.append(link)
        }
        moldura.append(legenda)
        return moldura
      }
      case 'KodaDiagram': {
        const nos = (Array.isArray(p.nos) ? p.nos : [])
          .map((item) => ({
            id: texto(item?.id),
            rotulo: texto(item?.rotulo ?? item?.titulo ?? item?.id),
          }))
          .filter((item) => item.id)
        if (!nos.length) return no('span', 'ki-legenda', 'Diagrama sem nós.')
        const ligacoes = (Array.isArray(p.ligacoes) ? p.ligacoes : []).map((item) => ({
          de: texto(item?.de),
          para: texto(item?.para),
          rotulo: texto(item?.rotulo),
        }))
        const colunas = Math.min(4, nos.length)
        const linhas = Math.ceil(nos.length / colunas)
        const largura = 360
        const margem = 52
        const espaco = colunas > 1 ? (largura - margem * 2) / (colunas - 1) : 0
        const larguraNo = Math.min(92, Math.max(56, espaco - 8))
        const altura = Math.max(104, linhas * 84 + 20)
        const baseY = altura / 2 - ((linhas - 1) * 84) / 2
        const posicao = new Map()
        nos.slice(0, 40).forEach((item, indice) => {
          const coluna = indice % colunas
          const linha = Math.floor(indice / colunas)
          posicao.set(item.id, {
            x: colunas === 1 ? largura / 2 : margem + coluna * espaco,
            y: baseY + linha * 84,
          })
        })
        const moldura = no('div', 'ki-figura-tecnica')
        const svg = kiSvg('svg', {
          viewBox: `0 0 ${largura} ${altura}`,
          role: 'img',
          'aria-label': texto(p.titulo, 'diagrama'),
        })
        svg.classList.add('ki-svg')
        kiSequenciaSvg += 1
        const marcador = `ki-seta-${kiSequenciaSvg}`
        const defs = kiSvg('defs')
        const marker = kiSvg('marker', {
          id: marcador,
          viewBox: '0 0 10 10',
          refX: 9,
          refY: 5,
          markerWidth: 5,
          markerHeight: 5,
          orient: 'auto-start-reverse',
        })
        marker.append(kiSvg('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'currentColor' }))
        defs.append(marker)
        svg.append(defs)
        for (const ligacao of ligacoes.slice(0, 60)) {
          const de = posicao.get(ligacao.de)
          const para = posicao.get(ligacao.para)
          if (!de || !para) continue
          svg.append(
            kiSvg('line', {
              x1: de.x,
              y1: de.y,
              x2: para.x,
              y2: para.y,
              stroke: 'currentColor',
              'stroke-width': 1.4,
              opacity: 0.35,
              'marker-end': `url(#${marcador})`,
            }),
          )
          if (ligacao.rotulo) {
            const rotulo = kiSvg('text', {
              x: (de.x + para.x) / 2,
              y: (de.y + para.y) / 2 - 5,
              'text-anchor': 'middle',
              'font-size': 8.5,
              fill: 'currentColor',
            })
            rotulo.textContent = ligacao.rotulo.slice(0, 24)
            svg.append(rotulo)
          }
        }
        for (const item of nos.slice(0, 40)) {
          const ponto = posicao.get(item.id)
          if (!ponto) continue
          const grupo = kiSvg('g')
          grupo.append(
            kiSvg('rect', {
              x: ponto.x - larguraNo / 2,
              y: ponto.y - 16,
              width: larguraNo,
              height: 32,
              rx: 8,
              fill: 'currentColor',
              'fill-opacity': 0.08,
              stroke: 'currentColor',
              'stroke-opacity': 0.22,
            }),
          )
          const rotulo = kiSvg('text', {
            x: ponto.x,
            y: ponto.y + 4,
            'text-anchor': 'middle',
            'font-size': 10,
            'font-weight': 500,
            fill: 'currentColor',
          })
          rotulo.textContent = item.rotulo.slice(0, 20)
          grupo.append(rotulo)
          svg.append(grupo)
        }
        moldura.append(svg)
        return moldura
      }
      case 'KodaWritingBlock': {
        const chave = texto(p.valueBinding?.key ?? p.valueBinding)
        const caixa = no('div', 'ki-escrita')
        if (p.titulo) caixa.append(no('div', 'ki-escrita__titulo', t('titulo')))
        const area = no('textarea', 'ki-escrita__campo')
        area.rows = Math.max(3, Math.min(20, n('linhas', 6)))
        area.value = texto(chave ? ctx.estado[chave] : '')
        area.placeholder = 'Escreva aqui…'
        if (!chave) {
          area.disabled = true
          caixa.append(area)
          return caixa
        }
        const contagem = no('span', 'ki-legenda', `${area.value.length} caracteres`)
        area.addEventListener('input', () => {
          ctx.estado[chave] = area.value
          contagem.textContent = `${area.value.length} caracteres`
        })
        const rodape = no('div', 'ki-escrita__rodape')
        const copiar = no('button', 'ki-botao ki-botao--secundario', 'Copiar')
        copiar.type = 'button'
        copiar.addEventListener('click', () => {
          navigator.clipboard?.writeText(area.value).catch(() => undefined)
        })
        rodape.append(copiar, contagem)
        caixa.append(area, rodape)
        return caixa
      }
      case 'KodaCalculator': {
        const campos = (Array.isArray(p.campos) ? p.campos : [])
          .map((campo) => ({
            chave: texto(campo?.chave),
            rotulo: texto(campo?.rotulo),
            valor: Number(campo?.valor),
          }))
          .filter((campo) => campo.chave)
        const formula = texto(p.formula)
        const unidade = texto(p.unidade)
        const decimais = Math.max(0, Math.min(6, n('casas', 2)))
        const caixa = no('div', 'ki-calculadora')
        caixa.append(no('div', 'ki-calculadora__titulo', texto(p.titulo, 'Calculadora')))
        const grade = no('div', 'ki-calculadora__campos')
        const exibicao = no('span', 'ki-calculadora__valor', '—')
        const calcular = () => {
          const valores = { ...ctx.estado }
          for (const campo of campos) {
            if (valores[campo.chave] === undefined) valores[campo.chave] = campo.valor
          }
          const resultado = kiAvaliar(formula, valores)
          exibicao.textContent =
            resultado === null
              ? '—'
              : resultado.toLocaleString('pt-BR', {
                  minimumFractionDigits: decimais,
                  maximumFractionDigits: decimais,
                })
        }
        for (const campo of campos) {
          const rotulo = no('label', 'ki-campo')
          rotulo.append(no('span', '', campo.rotulo || campo.chave))
          const entrada = no('input', '')
          entrada.type = 'number'
          entrada.inputMode = 'decimal'
          const inicial = ctx.estado[campo.chave] ?? campo.valor
          entrada.value = Number.isFinite(Number(inicial)) ? String(inicial) : ''
          entrada.addEventListener('input', () => {
            ctx.estado[campo.chave] = Number(entrada.value)
            calcular()
          })
          rotulo.append(entrada)
          grade.append(rotulo)
        }
        caixa.append(grade)
        calcular()
        const resultado = no('div', 'ki-calculadora__resultado')
        resultado.append(no('span', 'ki-legenda', 'Resultado'), exibicao)
        if (unidade) resultado.append(no('span', 'ki-legenda', unidade))
        caixa.append(resultado)
        if (formula) caixa.append(no('code', 'ki-calculadora__formula', formula))
        return caixa
      }
      case 'KodaAlgorithm': {
        const passos = (Array.isArray(p.passos) ? p.passos : [])
          .map((item, indice) => {
            if (typeof item === 'string') return { titulo: item, detalhe: '' }
            return {
              titulo: texto(item?.titulo ?? item?.label, `Passo ${indice + 1}`),
              detalhe: texto(item?.detalhe ?? item?.descricao),
            }
          })
          .filter((item) => item.titulo)
        if (!passos.length) return no('span', 'ki-legenda', 'Algoritmo sem passos.')
        const caixa = no('div', 'ki-algoritmo')
        caixa.append(no('div', 'ki-algoritmo__titulo', texto(p.titulo, 'Passo a passo')))
        const lista = no('ol', 'ki-algoritmo__passos')
        for (const passo of passos.slice(0, 60)) {
          const item = no('li', 'ki-algoritmo__passo')
          item.append(no('span', 'ki-algoritmo__marcador', ''))
          const corpo = no('div', 'ki-algoritmo__corpo')
          corpo.append(no('span', 'ki-algoritmo__passo-titulo', passo.titulo))
          if (passo.detalhe) corpo.append(no('span', 'ki-algoritmo__detalhe', passo.detalhe))
          item.append(corpo)
          lista.append(item)
        }
        caixa.append(lista)
        return caixa
      }
      case 'KodaDatePicker': {
        const chave = texto(p.valueBinding?.key ?? p.valueBinding)
        const rotulo = no('label', 'ki-campo')
        if (p.rotulo) rotulo.append(no('span', '', t('rotulo')))
        const campo = no('input', '')
        campo.type = 'date'
        campo.value = texto(chave ? ctx.estado[chave] : '')
        if (chave) {
          campo.addEventListener('change', () => {
            ctx.estado[chave] = campo.value
            redesenhar()
          })
        }
        rotulo.append(campo)
        return rotulo
      }
      case 'KodaRadioGroup': {
        const chave = texto(p.valueBinding?.key ?? p.valueBinding)
        const grupo = no('fieldset', 'ki-grupo')
        if (p.rotulo) grupo.append(no('legend', '', t('rotulo')))
        const nome = `ki-radio-${contador}`
        for (const opcao of (Array.isArray(p.opcoes) ? p.opcoes : []).slice(0, 40)) {
          const valor = texto(opcao)
          const linha = no('label', 'ki-opcao')
          const radio = no('input', '')
          radio.type = 'radio'
          radio.name = nome
          radio.value = valor
          radio.checked = texto(chave ? ctx.estado[chave] : '') === valor
          if (chave) {
            radio.addEventListener('change', () => {
              ctx.estado[chave] = valor
              redesenhar()
            })
          }
          linha.append(radio, no('span', '', valor))
          grupo.append(linha)
        }
        return grupo
      }
      case 'KodaSegmentedControl': {
        const chave = texto(p.valueBinding?.key ?? p.valueBinding)
        const grupo = no('div', 'ki-segmentado')
        grupo.setAttribute('role', 'group')
        if (p.rotulo) grupo.setAttribute('aria-label', t('rotulo'))
        for (const opcao of (Array.isArray(p.opcoes) ? p.opcoes : []).slice(0, 20)) {
          const valor = texto(opcao)
          const ativo = texto(chave ? ctx.estado[chave] : '') === valor
          const botao = no('button', 'ki-segmentado__item', valor)
          botao.type = 'button'
          botao.setAttribute('aria-pressed', ativo ? 'true' : 'false')
          if (ativo) botao.classList.add('ki-segmentado__item--ativo')
          if (chave) {
            botao.addEventListener('click', () => {
              ctx.estado[chave] = valor
              redesenhar()
            })
          }
          grupo.append(botao)
        }
        return grupo
      }
      default: {
        const desconhecido = no('div', 'ki-aviso ki-tom--aviso', `componente "${tipo || '(sem tipo)'}" não suportado no celular`)
        return desconhecido
      }
    }
  }

  renderizar()
  return cartao
}

/** As etiquetas de bloco que viram desenho em vez de código cru — as mesmas do PC. */
export const LINGUAGENS = [
  'koda-grafico',
  'koda-mapa',
  'koda-passos',
  'koda-comparacao',
  'koda-diagrama',
  'koda-visual',
  'koda-plano',
  'koda-ui-doc',
]

export function ehBlocoVisual(linguagem) {
  return LINGUAGENS.includes(linguagem)
}

/**
 * Desenha um bloco visual. Devolve sempre um nó — um bloco que não dá para desenhar vira um
 * aviso discreto, e a resposta em volta continua legível.
 *
 * `acoes.decidirPlano(planId, aceito, retorno)` é opcional: sem ela, o plano aparece inteiro
 * mas sem os botões (é o caso da galeria/teste).
 */
export function desenharBloco(linguagem, bruto, acoes = {}) {
  const corpo = String(bruto ?? '').trim()
  if (!corpo) return naoEntendi('o bloco está vazio', '')

  // A interface inteligente tem árvore e ações próprias — o `desenhar` dos gráficos
  // não serve para ela. (`koda-ui` é o DSL que só o PC interpreta; aqui continua
  // aparecendo como código, em vez de fingir que foi desenhado.)
  if (linguagem === 'koda-ui-doc') {
    return desenharInterface(corpo)
  }

  // O diagrama de traço não é JSON: a IA já desenhou com `┌ ─ │ ▼`.
  if (linguagem === 'koda-diagrama' && !corpo.startsWith('{')) {
    return diagramaDeTexto(corpo)
  }

  const dados = primeiroObjeto(corpo)
  if (!dados) return naoEntendi('o conteúdo não é um JSON válido', corpo)

  const daCerca = linguagem.replace(/^koda-/, '').toLowerCase()
  const declarado = texto(dados.tipo ?? dados.type).toLowerCase()
  const tipo =
    declarado === 'pergunta'
      ? 'quiz'
      : declarado || (daCerca === 'visual' ? deduzirTipo(dados) : daCerca)

  return desenhar(tipo || daCerca, dados, corpo, acoes)
}
