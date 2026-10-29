/**
 * Os blocos visuais do Koda — o que a IA desenha na conversa.
 *
 * ## O problema que isto resolve
 *
 * Quem não é da área lê "criei um índice na tabela X e o serviço Y consulta por ele" e não
 * entende nada. A resposta está certa e é inútil para essa pessoa. Um gráfico, um mapa
 * mental, um passo a passo — a mesma informação, na forma que se enxerga.
 *
 * ## Como funciona: a IA manda os DADOS, o Koda desenha
 *
 * A IA escreve um bloco de código com a linguagem `koda-*` e um JSON dentro:
 *
 *     ```koda-grafico
 *     { "tipo": "dispersao", "titulo": "Preço x vendas", "dados": [...] }
 *     ```
 *
 * Aqui o JSON vira um desenho de verdade, em SVG e HTML — **não é imagem**, é React. Isso
 * importa por três motivos:
 *
 * 1. **Não quebra a resposta.** Um JSON inválido vira um aviso discreto, e o resto do
 *    texto continua legível. Se a IA mandasse HTML/JS pronto, um erro derrubaria a fala
 *    inteira, e código de fora rodando na tela é risco que não se assume.
 * 2. **A IA não precisa saber desenhar.** Ela diz "três barras com estes valores"; posição,
 *    cor, escala e eixo saem daqui. O resultado fica consistente entre respostas.
 * 3. **Sai no tema.** As cores vêm das variáveis do Koda, então funciona no claro e no
 *    escuro sem a IA se preocupar com isso.
 *
 * ## Superfícies planas (nada de cartão dentro de cartão)
 *
 * A resposta do Koda flui no fundo — não há cartão em volta do texto. Os blocos seguem a
 * mesma regra: **sem fundo de caixa**, só uma linha fina marcando o limite quando faz
 * sentido. Um cartão com fundo e borda (o `Moldura` antigo) virava uma mancha acinzentada
 * flutuando no fundo escuro, e blocos aninhados desenhavam caixa dentro de caixa — que é
 * o "efeito app separado" que o dono apontou. Daqui pra frente a moldura é discreta, e o
 * desenho pede fundo só quando é campo de verdade (código, entrada).
 *
 * ## Tudo é interativo
 *
 * Passar o mouse mostra um balão com o valor exato; clicar destaca e apaga o resto; `Esc`
 * ou o botão limpam. A mecânica mora em `BlocosInteracao.tsx` — aqui os gráficos só dizem
 * **o que** mostrar, e por isso cada um cabe em poucas linhas.
 *
 * ## O contrato é tolerante de propósito
 *
 * Chave faltando, valor como texto em vez de número, item que não é objeto: nada disso
 * derruba o bloco. Cada desenho valida o que recebe e mostra o que deu — porque a IA vai
 * errar o formato às vezes, e a resposta não pode morrer por isso.
 */

import { useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'

import {
  Balao,
  LimparDestaque,
  apagado,
  tom,
  useInteracao,
} from './BlocosInteracao'
import type { Interacao } from './BlocosInteracao'

// ---------------------------------------------------------------- os dados

/** Um valor de série: o rótulo e o número. */
type Ponto = { rotulo: string; valor: number; valor2?: number; tamanho?: number; grupo?: string }

/** Um nó de mapa mental: o texto e o que pende dele. */
type Ramo = { texto: string; filhos?: Ramo[] }

/** Um passo de fluxo ou de tutorial. */
type Passo = { titulo: string; texto?: string }

/** Um nó de Sankey: origem, destino e o quanto passa. */
type Elo = { de: string; para: string; valor: number }

// ---------------------------------------------------------------- leitura tolerante

function texto(valor: unknown, padrao = ''): string {
  if (valor === null || valor === undefined) return padrao
  if (typeof valor === 'string') return valor
  if (typeof valor === 'number' || typeof valor === 'boolean') return String(valor)
  return padrao
}

/** Número de um valor que pode ter vindo como texto ("1.200", "45%", "R$ 30"). */
function numero(valor: unknown): number {
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

function pontos(bruto: unknown): Ponto[] {
  if (!Array.isArray(bruto)) return []
  const saida: Ponto[] = []
  for (const item of bruto) {
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>
    const ponto: Ponto = {
      rotulo: texto(o.rotulo ?? o.label ?? o.nome ?? o.name ?? o.x),
      valor: numero(o.valor ?? o.value ?? o.y ?? o.total),
    }
    if (o.valor2 !== undefined || o.y2 !== undefined) ponto.valor2 = numero(o.valor2 ?? o.y2)
    if (o.tamanho !== undefined || o.size !== undefined) ponto.tamanho = numero(o.tamanho ?? o.size)
    const grupo = texto(o.grupo ?? o.group ?? o.serie ?? o.categoria)
    if (grupo) ponto.grupo = grupo
    if (ponto.rotulo !== '' || ponto.valor !== 0) saida.push(ponto)
  }
  return saida
}

function ramos(bruto: unknown, profundidade = 0): Ramo[] {
  if (!Array.isArray(bruto) || profundidade > 6) return []
  return bruto
    .map((item) => {
      if (typeof item === 'string') return { texto: item }
      if (typeof item === 'object' && item !== null) {
        const o = item as Record<string, unknown>
        const filhos = ramos(o.filhos ?? o.children ?? o.itens, profundidade + 1)
        return {
          texto: texto(o.texto ?? o.label ?? o.nome ?? o.name ?? o.titulo),
          ...(filhos.length ? { filhos } : {}),
        }
      }
      return null
    })
    .filter((r): r is Ramo => r !== null && r.texto !== '')
}

/** Elos de um Sankey/fluxo de valor, em qualquer uma das formas comuns. */
function elos(bruto: unknown): Elo[] {
  if (!Array.isArray(bruto)) return []
  return bruto
    .map((item) => {
      if (typeof item === 'object' && item !== null) {
        const o = item as Record<string, unknown>
        return {
          de: texto(o.de ?? o.from ?? o.origem ?? o.source),
          para: texto(o.para ?? o.to ?? o.destino ?? o.target),
          valor: numero(o.valor ?? o.value ?? o.peso ?? o.weight),
        }
      }
      return null
    })
    .filter((e): e is Elo => e !== null && e.de !== '' && e.para !== '')
}

// ---------------------------------------------------------------- a moldura

function Moldura({
  titulo,
  legenda,
  children,
}: {
  titulo: string
  legenda?: string
  children: ReactNode
}) {
  // Sem fundo de caixa, sem borda: a moldura é invisível, só o título e o conteúdo
  // fluem na resposta. É o que impede o efeito "cartão flutuando" no fundo escuro e o
  // cartão duplo quando o desenho de dentro já emoldura a si mesmo.
  return (
    <figure className="my-1 flex min-w-0 flex-col gap-2">
      {titulo ? (
        <figcaption className="text-[13px] font-semibold text-koda-fg/90">{titulo}</figcaption>
      ) : null}
      <div className="min-w-0">{children}</div>
      {legenda ? <p className="text-[12px] text-koda-fg/50">{legenda}</p> : null}
    </figure>
  )
}

function NaoEntendi({ motivo, bruto }: { motivo: string; bruto: string }) {
  return (
    <div className="my-1 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-3 text-[12.5px] text-amber-200/90">
      <p className="font-medium">Não consegui desenhar este bloco: {motivo}</p>
      {bruto ? (
        <pre className="mt-2 overflow-x-auto text-[11.5px] whitespace-pre-wrap text-amber-200/60">
          {bruto.slice(0, 300)}
        </pre>
      ) : null}
    </div>
  )
}

/**
 * Envolve um desenho com o balão e o botão de limpar.
 *
 * O botão fica **aqui**, e não na moldura, porque é aqui que a interação de verdade existe:
 * a moldura recebe uma instância vazia (o `Desenho` não tem como saber qual gráfico vai
 * sair antes de escolhê-lo), então um botão lá nunca saberia que há algo destacado.
 */
function ComBalao({ interacao, children }: { interacao: Interacao; children: ReactNode }) {
  return (
    <>
      {children}
      <LimparDestaque interacao={interacao} />
      <Balao dica={interacao.dica} posicao={interacao.posicao} />
    </>
  )
}

// ---------------------------------------------------------------- barras

function Barras({ dados, horizontal }: { dados: Ponto[]; horizontal?: boolean }) {
  const interacao = useInteracao()
  const maximo = Math.max(...dados.map((d) => Math.abs(d.valor)), 1)
  const maior = Math.max(...dados.map((d) => d.rotulo.length), 3)
  const dica = (d: Ponto) => ({ titulo: d.rotulo, valor: d.valor.toLocaleString('pt-BR') })

  if (horizontal) {
    return (
      <ComBalao interacao={interacao}>
        <ul className="flex flex-col gap-2">
          {dados.map((ponto, i) => {
            const chave = `b${i}`
            return (
              <li
                key={i}
                {...interacao.props(chave, dica(ponto))}
                className="flex items-center gap-2.5 rounded-md px-1 py-0.5 transition-opacity"
                style={{ opacity: apagado(interacao, chave) ? 0.3 : 1 }}
              >
                <span
                  className="shrink-0 truncate text-right text-[12px] text-koda-fg/60"
                  style={{ width: `${Math.min(maior, 22)}ch` }}
                >
                  {ponto.rotulo}
                </span>
                <span className="relative h-5 min-w-0 flex-1 rounded-[5px] bg-koda-fg/[0.06]">
                  <span
                    className={`absolute inset-y-0 left-0 rounded-[5px] ${tom(i)} bg-current transition-[width] duration-300`}
                    style={{ width: `${Math.max((Math.abs(ponto.valor) / maximo) * 100, 1.5)}%` }}
                  />
                </span>
                <span className="w-16 shrink-0 text-right font-mono text-[12px] text-koda-fg/70">
                  {ponto.valor.toLocaleString('pt-BR')}
                </span>
              </li>
            )
          })}
        </ul>
      </ComBalao>
    )
  }

  return (
    <ComBalao interacao={interacao}>
      <div className="flex min-w-0 items-end gap-2 overflow-x-auto pt-1">
        {dados.map((ponto, i) => {
          const chave = `b${i}`
          const altura = Math.max((Math.abs(ponto.valor) / maximo) * 100, 2)
          return (
            <div
              key={i}
              {...interacao.props(chave, dica(ponto))}
              className="flex min-w-[42px] flex-1 flex-col items-center gap-1.5 rounded-md transition-opacity"
              style={{ opacity: apagado(interacao, chave) ? 0.3 : 1 }}
            >
              <span className="font-mono text-[11.5px] text-koda-fg/70">
                {ponto.valor.toLocaleString('pt-BR')}
              </span>
              <div className="flex h-32 w-full items-end">
                <div
                  className={`w-full rounded-t-[5px] ${tom(i)} bg-current transition-[height,filter] duration-300 hover:brightness-125`}
                  style={{ height: `${altura}%` }}
                />
              </div>
              <span className="w-full truncate text-center text-[11.5px] text-koda-fg/60">
                {ponto.rotulo}
              </span>
            </div>
          )
        })}
      </div>
    </ComBalao>
  )
}

// ---------------------------------------------------------------- barras empilhadas

function Empilhadas({ dados, series }: { dados: Ponto[]; series: string[] }) {
  const interacao = useInteracao()
  // Cada barra tem um total; a fatia de cada série é `valor` (série 0) ou `valor2`.
  const totais = dados.map((d) => Math.abs(d.valor) + Math.abs(d.valor2 ?? 0))
  const maximo = Math.max(...totais, 1)

  return (
    <ComBalao interacao={interacao}>
      <div className="flex min-w-0 items-end gap-2 overflow-x-auto pt-1">
        {dados.map((ponto, i) => {
          const chave = `e${i}`
          const partes = [Math.abs(ponto.valor), Math.abs(ponto.valor2 ?? 0)]
          const total = totais[i] || 1
          return (
            <div
              key={i}
              {...interacao.props(chave, {
                titulo: ponto.rotulo,
                valor: total.toLocaleString('pt-BR'),
                detalhe: series
                  .map((s, k) => `${s}: ${partes[k].toLocaleString('pt-BR')}`)
                  .join(' · '),
              })}
              className="flex min-w-[42px] flex-1 flex-col items-center gap-1.5 transition-opacity"
              style={{ opacity: apagado(interacao, chave) ? 0.3 : 1 }}
            >
              <div className="flex h-32 w-full flex-col justify-end">
                {partes
                  .map((valor, k) => ({ valor, k }))
                  .reverse()
                  .map(({ valor, k }) => (
                    <div
                      key={k}
                      className={`w-full ${tom(k)} bg-current transition-[height] duration-300 ${k === 0 ? 'rounded-b-[5px]' : ''} ${k === partes.length - 1 ? 'rounded-t-[5px]' : ''}`}
                      style={{ height: `${(valor / maximo) * 100}%` }}
                    />
                  ))}
              </div>
              <span className="w-full truncate text-center text-[11.5px] text-koda-fg/60">
                {ponto.rotulo}
              </span>
            </div>
          )
        })}
      </div>
      {series.length ? (
        <ul className="mt-2 flex flex-wrap gap-3">
          {series.map((s, k) => (
            <li key={k} className="flex items-center gap-1.5 text-[11.5px] text-koda-fg/65">
              <span className={`${tom(k)} h-2.5 w-2.5 rounded-sm bg-current`} />
              {s}
            </li>
          ))}
        </ul>
      ) : null}
    </ComBalao>
  )
}

// ---------------------------------------------------------------- linhas e área

function Linhas({ dados, area }: { dados: Ponto[]; area?: boolean }) {
  const identificador = useId().replace(/:/g, '')
  const interacao = useInteracao()
  if (dados.length < 2) return <Barras dados={dados} horizontal />

  const L = 100
  const A = 40
  const valores = dados.map((d) => d.valor)
  const menor = Math.min(...valores, 0)
  const maior = Math.max(...valores, 1)
  const faixa = maior - menor || 1
  const x = (i: number) => (i / (dados.length - 1)) * L
  const y = (v: number) => A - ((v - menor) / faixa) * (A - 6) - 3
  const caminho = dados
    .map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)} ${y(d.valor).toFixed(2)}`)
    .join(' ')
  const fecho = `${caminho} L${L} ${A} L0 ${A} Z`

  return (
    <ComBalao interacao={interacao}>
      <div className="flex flex-col gap-2">
        <svg viewBox={`-1 -3 ${L + 2} ${A + 4}`} className="h-40 w-full overflow-visible">
          <defs>
            <linearGradient id={`g${identificador}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.3" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <line
              key={f}
              x1="0"
              x2={L}
              y1={y(menor + faixa * f)}
              y2={y(menor + faixa * f)}
              className="stroke-koda-fg/10"
              strokeWidth="0.4"
              strokeDasharray="1.5 1.5"
            />
          ))}
          {area !== false ? (
            <path d={fecho} fill={`url(#g${identificador})`} className="text-koda-accent" />
          ) : null}
          <path
            d={caminho}
            fill="none"
            className="stroke-koda-accent"
            strokeWidth="1.4"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
          {dados.map((d, i) => {
            const chave = `l${i}`
            const destacado = interacao.estaDestacado(chave)
            return (
              <g key={i} {...interacao.props(chave, { titulo: d.rotulo, valor: d.valor.toLocaleString('pt-BR') })}>
                {/* Alvo invisível: o círculo de 1.8px é pequeno demais para o mouse. */}
                <circle cx={x(i)} cy={y(d.valor)} r="5" fill="transparent" />
                <circle
                  cx={x(i)}
                  cy={y(d.valor)}
                  r={destacado ? 3 : 1.8}
                  className="fill-koda-accent transition-[r]"
                />
              </g>
            )
          })}
        </svg>
        <div className="flex justify-between gap-1 overflow-x-auto text-[11px] text-koda-fg/55">
          {dados.map((d, i) => (
            <span key={i} className="min-w-0 flex-1 truncate text-center">
              {d.rotulo}
            </span>
          ))}
        </div>
      </div>
    </ComBalao>
  )
}

// ---------------------------------------------------------------- pizza / rosca

function Pizza({ dados, rosca }: { dados: Ponto[]; rosca?: boolean }) {
  const interacao = useInteracao()
  const total = dados.reduce((soma, d) => soma + Math.abs(d.valor), 0)
  if (total <= 0) return <Barras dados={dados} horizontal />

  let angulo = -90
  const fatias = dados.map((d, i) => {
    const fatia = (Math.abs(d.valor) / total) * 360
    const inicio = angulo
    angulo += fatia
    const rad = (grau: number) => (grau * Math.PI) / 180
    const x1 = 50 + 48 * Math.cos(rad(inicio))
    const y1 = 50 + 48 * Math.sin(rad(inicio))
    const x2 = 50 + 48 * Math.cos(rad(angulo))
    const y2 = 50 + 48 * Math.sin(rad(angulo))
    const grande = fatia > 180 ? 1 : 0
    const caminho =
      fatia >= 359.9
        ? 'M50 2 A48 48 0 1 1 49.99 2 Z'
        : `M50 50 L${x1.toFixed(2)} ${y1.toFixed(2)} A48 48 0 ${grande} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`
    return { caminho, ponto: d, fracao: Math.abs(d.valor) / total, i }
  })

  return (
    <ComBalao interacao={interacao}>
      <div className="flex flex-wrap items-center gap-4">
        <svg viewBox="0 0 100 100" className="h-36 w-36 shrink-0">
          {fatias.map((f) => {
            const chave = `p${f.i}`
            const destacado = interacao.estaDestacado(chave)
            return (
              <path
                key={f.i}
                d={f.caminho}
                {...interacao.props(chave, {
                  titulo: f.ponto.rotulo,
                  valor: `${f.ponto.valor.toLocaleString('pt-BR')} · ${(f.fracao * 100).toFixed(1)}%`,
                  cor: tom(f.i),
                })}
                className={`${tom(f.i)} fill-current transition-opacity`}
                // A fatia destacada cresce um pouco, saindo do centro: é o realce que se
                // enxerga sem precisar de cor diferente.
                transform={destacado ? 'translate(2.5 2.5) scale(1.04)' : undefined}
                style={{ opacity: apagado(interacao, chave) ? 0.25 : 1 }}
              />
            )
          })}
          {rosca ? <circle cx="50" cy="50" r="26" className="fill-koda-input" /> : null}
        </svg>
        <ul className="flex min-w-0 flex-1 flex-col gap-1">
          {fatias.map((f) => {
            const chave = `p${f.i}`
            return (
              <li
                key={f.i}
                {...interacao.props(chave, {
                  titulo: f.ponto.rotulo,
                  valor: `${f.ponto.valor.toLocaleString('pt-BR')} · ${(f.fracao * 100).toFixed(1)}%`,
                  cor: tom(f.i),
                })}
                className="flex items-center gap-2 rounded-md px-1.5 py-0.5 text-[12.5px] transition-opacity hover:bg-koda-fg/6"
                style={{ opacity: apagado(interacao, chave) ? 0.35 : 1 }}
              >
                <span className={`${tom(f.i)} h-2.5 w-2.5 shrink-0 rounded-sm bg-current`} />
                <span className="min-w-0 flex-1 truncate text-koda-fg/75">{f.ponto.rotulo}</span>
                <span className="shrink-0 font-mono text-koda-fg/60">
                  {(f.fracao * 100).toFixed(1)}%
                </span>
              </li>
            )
          })}
        </ul>
      </div>
    </ComBalao>
  )
}

// ---------------------------------------------------------------- dispersão e bolha

function Dispersao({ dados, bolha }: { dados: Ponto[]; bolha?: boolean }) {
  const interacao = useInteracao()
  if (dados.length < 2) return <Barras dados={dados} horizontal />

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

  // Coordenadas em 100x50 com margem, para os pontos não encostarem na borda.
  const px = (v: number) => 4 + ((v - minX) / fx) * 92
  const py = (v: number) => 46 - ((v - minY) / fy) * 42
  const pr = (v: number) => (bolha ? 2 + (Math.abs(v) / maxTam) * 5 : 2.4)

  return (
    <ComBalao interacao={interacao}>
      <div className="flex flex-col gap-1.5">
        <svg viewBox="0 0 100 50" className="h-48 w-full overflow-visible">
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line
                x1="4"
                x2="96"
                y1={py(minY + fy * f)}
                y2={py(minY + fy * f)}
                className="stroke-koda-fg/10"
                strokeWidth="0.3"
                strokeDasharray="1.5 1.5"
              />
              <line
                y1="4"
                y2="46"
                x1={px(minX + fx * f)}
                x2={px(minX + fx * f)}
                className="stroke-koda-fg/10"
                strokeWidth="0.3"
                strokeDasharray="1.5 1.5"
              />
            </g>
          ))}
          {dados.map((d, i) => {
            const chave = `d${i}`
            const destacado = interacao.estaDestacado(chave)
            return (
              <circle
                key={i}
                cx={px(d.valor)}
                cy={py(d.valor2 ?? 0)}
                r={pr(tam[i]) * (destacado ? 1.4 : 1)}
                {...interacao.props(chave, {
                  titulo: d.rotulo,
                  valor: `x: ${d.valor.toLocaleString('pt-BR')} · y: ${(d.valor2 ?? 0).toLocaleString('pt-BR')}`,
                  detalhe: bolha && d.tamanho !== undefined ? `tamanho: ${d.tamanho}` : undefined,
                  cor: tom(i),
                })}
                className={`${tom(i)} fill-current transition-opacity`}
                style={{ opacity: apagado(interacao, chave) ? 0.2 : 0.85 }}
              />
            )
          })}
        </svg>
        <div className="flex justify-between font-mono text-[11px] text-koda-fg/45">
          <span>eixo x: {minX.toLocaleString('pt-BR')} … {maxX.toLocaleString('pt-BR')}</span>
          <span>eixo y: {minY.toLocaleString('pt-BR')} … {maxY.toLocaleString('pt-BR')}</span>
        </div>
      </div>
    </ComBalao>
  )
}

// ---------------------------------------------------------------- radar

function Radar({ dados }: { dados: Ponto[] }) {
  const interacao = useInteracao()
  if (dados.length < 3) return <Barras dados={dados} horizontal />

  const maximo = Math.max(...dados.map((d) => Math.abs(d.valor)), 1)
  const n = dados.length
  const centro = 50
  const raio = 38
  const anguloDe = (i: number) => (i / n) * Math.PI * 2 - Math.PI / 2
  const pontoDe = (i: number, fracao: number) => {
    const a = anguloDe(i)
    return [centro + Math.cos(a) * raio * fracao, centro + Math.sin(a) * raio * fracao]
  }
  const caminho =
    dados
      .map((d, i) => {
        const [x, y] = pontoDe(i, Math.abs(d.valor) / maximo)
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`
      })
      .join(' ') + ' Z'

  return (
    <ComBalao interacao={interacao}>
      <div className="flex flex-col items-center gap-2">
        <svg viewBox="0 0 100 100" className="h-56 w-56">
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <polygon
              key={f}
              points={dados.map((_, i) => pontoDe(i, f).map((v) => v.toFixed(2)).join(',')).join(' ')}
              className="fill-none stroke-koda-fg/12"
              strokeWidth="0.4"
            />
          ))}
          {dados.map((_, i) => {
            const [x, y] = pontoDe(i, 1)
            return (
              <line key={i} x1={centro} y1={centro} x2={x} y2={y} className="stroke-koda-fg/12" strokeWidth="0.4" />
            )
          })}
          <path d={caminho} className="fill-koda-accent/25 stroke-koda-accent" strokeWidth="1.2" />
          {dados.map((d, i) => {
            const chave = `r${i}`
            const [x, y] = pontoDe(i, Math.abs(d.valor) / maximo)
            const [lx, ly] = pontoDe(i, 1.18)
            return (
              <g key={i}>
                <circle
                  cx={x}
                  cy={y}
                  r={interacao.estaDestacado(chave) ? 3.4 : 2.2}
                  {...interacao.props(chave, {
                    titulo: d.rotulo,
                    valor: d.valor.toLocaleString('pt-BR'),
                  })}
                  className="fill-koda-accent"
                />
                <text
                  x={lx}
                  y={ly}
                  className="fill-current text-koda-fg/60"
                  fontSize="4"
                  textAnchor="middle"
                  dominantBaseline="middle"
                >
                  {d.rotulo.slice(0, 12)}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
    </ComBalao>
  )
}

// ---------------------------------------------------------------- timeline

function Timeline({ dados }: { dados: Ponto[] }) {
  const interacao = useInteracao()
  if (!dados.length) return <Barras dados={dados} horizontal />

  return (
    <ComBalao interacao={interacao}>
      <ol className="relative flex flex-col gap-0 pl-1">
        {/* O fio que atravessa: é o que faz a lista virar linha do tempo. */}
        <span className="absolute top-2 bottom-2 left-[7px] w-px bg-koda-fg/15" aria-hidden="true" />
        {dados.map((ponto, i) => {
          const chave = `t${i}`
          const destacado = interacao.estaDestacado(chave)
          return (
            <li
              key={i}
              {...interacao.props(chave, {
                titulo: ponto.rotulo,
                valor: ponto.valor ? ponto.valor.toLocaleString('pt-BR') : undefined,
                detalhe: ponto.grupo,
              })}
              className="relative flex gap-3 rounded-md py-1.5 pr-2 pl-0 transition-opacity"
              style={{ opacity: apagado(interacao, chave) ? 0.3 : 1 }}
            >
              <span
                className={`relative z-10 mt-1 ml-[3px] h-2.5 w-2.5 shrink-0 rounded-full ${tom(i)} bg-current ring-4 ring-koda-input transition-transform ${destacado ? 'scale-150' : ''}`}
              />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] text-koda-fg/85">{ponto.rotulo}</p>
                {ponto.grupo ? (
                  <p className="text-[11.5px] text-koda-fg/50">{ponto.grupo}</p>
                ) : null}
              </div>
              {ponto.valor ? (
                <span className="shrink-0 font-mono text-[11.5px] text-koda-fg/55">
                  {ponto.valor.toLocaleString('pt-BR')}
                </span>
              ) : null}
            </li>
          )
        })}
      </ol>
    </ComBalao>
  )
}

// ---------------------------------------------------------------- sankey

function Sankey({ fluxos }: { fluxos: Elo[] }) {
  const interacao = useInteracao()
  if (!fluxos.length) return <NaoEntendi motivo="não achei fluxos" bruto="" />

  // Colunas por profundidade: quem só aparece como origem fica na primeira, quem só
  // aparece como destino vai para a última.
  const origens = [...new Set(fluxos.map((f) => f.de))]
  const destinos = [...new Set(fluxos.map((f) => f.para))]
  const total = fluxos.reduce((s, f) => s + Math.abs(f.valor), 0) || 1

  const altura = Math.max(origens.length, destinos.length) * 26 + 10
  const alturaDe = (nome: string, lado: 'de' | 'para') => {
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

  // Cada fita sai de um ponto da origem e chega a um ponto do destino, com uma curva.
  let usadoOrigem: Record<string, number> = {}
  let usadoDestino: Record<string, number> = {}
  const fitas = fluxos.map((f, i) => {
    const o = caixasOrigem.find((c) => c.nome === f.de)!
    const d = caixasDestino.find((c) => c.nome === f.para)!
    const espessura = (Math.abs(f.valor) / total) * (altura - 20)
    const yo = o.y + (usadoOrigem[f.de] ?? 0)
    const yd = d.y + (usadoDestino[f.para] ?? 0)
    usadoOrigem[f.de] = (usadoOrigem[f.de] ?? 0) + espessura
    usadoDestino[f.para] = (usadoDestino[f.para] ?? 0) + espessura
    const x1 = 34
    const x2 = 66
    const caminho = `M${x1} ${yo} C${(x1 + x2) / 2} ${yo}, ${(x1 + x2) / 2} ${yd}, ${x2} ${yd} L${x2} ${yd + espessura} C${(x1 + x2) / 2} ${yd + espessura}, ${(x1 + x2) / 2} ${yo + espessura}, ${x1} ${yo + espessura} Z`
    return { caminho, fluxo: f, i, espessura }
  })

  return (
    <ComBalao interacao={interacao}>
      <svg viewBox={`0 0 100 ${altura}`} className="w-full" style={{ maxHeight: altura * 3 }}>
        {caixasOrigem.map((c, i) => (
          <g key={`o${i}`}>
            <rect x="16" y={c.y} width="18" height={c.h} rx="1.5" className={`${tom(i)} fill-current`} />
            <text x="14" y={c.y + c.h / 2} fontSize="3.4" textAnchor="end" dominantBaseline="middle" className="fill-current text-koda-fg/75">
              {c.nome.slice(0, 18)}
            </text>
          </g>
        ))}
        {fitas.map((f) => (
          <path
            key={f.i}
            d={f.caminho}
            {...interacao.props(`s${f.i}`, {
              titulo: `${f.fluxo.de} → ${f.fluxo.para}`,
              valor: f.fluxo.valor.toLocaleString('pt-BR'),
              cor: tom(f.i),
            })}
            className={`${tom(f.i)} fill-current transition-opacity`}
            style={{ opacity: apagado(interacao, `s${f.i}`) ? 0.12 : interacao.estaDestacado(`s${f.i}`) ? 0.85 : 0.45 }}
          />
        ))}
        {caixasDestino.map((c, i) => (
          <g key={`d${i}`}>
            <rect x="66" y={c.y} width="18" height={c.h} rx="1.5" className={`${tom(i + 1)} fill-current`} />
            <text x="86" y={c.y + c.h / 2} fontSize="3.4" dominantBaseline="middle" className="fill-current text-koda-fg/75">
              {c.nome.slice(0, 18)}
            </text>
          </g>
        ))}
      </svg>
    </ComBalao>
  )
}

// ---------------------------------------------------------------- mapa mental

function MapaMental({ raiz, lista }: { raiz: Ramo; lista: Ramo[] }) {
  const interacao = useInteracao()
  const cor = useId().replace(/:/g, '')

  const galho = (ramo: Ramo, chave: string, nivel: number): ReactNode => {
    const destacado = interacao.estaDestacado(chave)
    return (
      <li key={chave} className="relative">
        <div
          {...interacao.props(chave, {
            titulo: ramo.texto,
            detalhe: nivel === 0 ? 'ramo principal' : `nível ${nivel + 1}`,
            cor: tom(nivel),
          })}
          className="flex items-start gap-2 rounded-md px-1 py-0.5 transition-opacity hover:bg-koda-fg/6"
          style={{ opacity: apagado(interacao, chave) ? 0.35 : 1 }}
        >
          <span
            className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${tom(nivel)} bg-current transition-transform ${destacado ? 'scale-[1.8]' : ''}`}
          />
          <span
            className={[
              'min-w-0',
              nivel === 0 ? 'text-[13.5px] text-koda-fg/90' : 'text-[12.5px] text-koda-fg/70',
            ].join(' ')}
          >
            {ramo.texto}
          </span>
        </div>
        {ramo.filhos?.length ? (
          <ul className="ml-2 border-l border-dashed border-koda-fg/15 pl-3.5">
            {ramo.filhos.map((filho, i) => galho(filho, `${chave}-${i}`, nivel + 1))}
          </ul>
        ) : null}
      </li>
    )
  }

  return (
    <ComBalao interacao={interacao}>
      <div className="flex flex-col gap-2.5">
        <div
          {...interacao.props(`raiz-${cor}`, { titulo: raiz.texto, detalhe: 'o tema central' })}
          className="flex items-center gap-2 rounded-lg bg-koda-accent/12 px-3 py-2"
        >
          <span className="h-2 w-2 shrink-0 rounded-full bg-koda-accent" />
          <span className="text-[14px] font-semibold text-koda-fg">{raiz.texto}</span>
        </div>
        {lista.length ? (
          <ul className="ml-3 flex flex-col">{lista.map((ramo, i) => galho(ramo, `r${i}`, 0))}</ul>
        ) : null}
      </div>
    </ComBalao>
  )
}

// ---------------------------------------------------------------- fluxo / passos

function Fluxo({ passos }: { passos: Passo[] }) {
  const interacao = useInteracao()
  return (
    <ComBalao interacao={interacao}>
      <ol className="flex flex-col">
        {passos.map((passo, i) => {
          const chave = `f${i}`
          const destacado = interacao.estaDestacado(chave)
          return (
            <li
              key={i}
              {...interacao.props(chave, { titulo: passo.titulo, detalhe: `passo ${i + 1} de ${passos.length}` })}
              className="flex gap-3 rounded-md transition-opacity"
              style={{ opacity: apagado(interacao, chave) ? 0.3 : 1 }}
            >
              <div className="flex shrink-0 flex-col items-center">
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full bg-koda-accent/18 text-[11.5px] font-semibold text-koda-accent transition-transform ${destacado ? 'scale-110 bg-koda-accent/35' : ''}`}
                >
                  {i + 1}
                </span>
                {i < passos.length - 1 ? (
                  <span className="w-px flex-1 bg-koda-fg/15" style={{ minHeight: '14px' }} />
                ) : null}
              </div>
              <div className="min-w-0 flex-1 pb-3.5">
                <p className="text-[13.5px] font-medium text-koda-fg/90">{passo.titulo}</p>
                {passo.texto ? (
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-koda-fg/60">{passo.texto}</p>
                ) : null}
              </div>
            </li>
          )
        })}
      </ol>
    </ComBalao>
  )
}

// ---------------------------------------------------------------- comparação

function Comparacao({ colunas }: { colunas: { titulo: string; itens: string[] }[] }) {
  const interacao = useInteracao()
  return (
    <ComBalao interacao={interacao}>
      <div className="grid min-w-0 gap-2.5 sm:grid-cols-[repeat(auto-fit,minmax(180px,1fr))]">
        {colunas.map((coluna, i) => {
          const chave = `c${i}`
          return (
            <div
              key={i}
              {...interacao.props(chave, { titulo: coluna.titulo, detalhe: `${coluna.itens.length} pontos` })}
              className="flex min-w-0 flex-col gap-2 rounded-lg border border-koda-fg/10 p-3 transition-opacity"
              style={{ opacity: apagado(interacao, chave) ? 0.3 : 1 }}
            >
              <p className={`text-[13px] font-semibold ${tom(i)}`}>{coluna.titulo}</p>
              <ul className="flex flex-col gap-1.5">
                {coluna.itens.map((item, j) => (
                  <li key={j} className="flex gap-2 text-[12.5px] leading-relaxed text-koda-fg/70">
                    <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-koda-fg/35" />
                    <span className="min-w-0">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </div>
    </ComBalao>
  )
}

// ---------------------------------------------------------------- comparação em matriz

/** Um item da comparação: o nome, a ficha (atributo → valor) e se é o recomendado. */
type ItemComparado = { nome: string; valores: Record<string, string>; recomendado: boolean }

/** Onde a IA costuma pôr o nome do item. */
const NOMES_DO_ITEM = ['nome', 'titulo', 'label', 'produto', 'modelo', 'item']

/** Onde ela costuma pôr a ficha, quando não achata os campos no próprio item. */
const FICHAS_DO_ITEM = ['valores', 'especificacoes', 'ficha', 'atributos', 'dados', 'caracteristicas']

/** Um valor de ficha: número e booleano viram texto; objeto e lista não são valor. */
function valorDaFicha(valor: unknown): string {
  if (typeof valor === 'string') return valor
  if (typeof valor === 'number' || typeof valor === 'boolean') return String(valor)
  return ''
}

/**
 * Lê a matriz de comparação de qualquer formato que a IA mandar.
 *
 * O formato preferido é `{ itens: [{ nome, valores: {...} }] }`, mas o modelo também
 * escreve a ficha **achatada** (`{ nome: "Celular 2", Preço: "R$ 3.499" }`) e chama as
 * chaves de `produtos`, `opcoes` ou `especificacoes`. Nada disso pode virar bloco morto:
 * é a diferença entre "a IA tentou comparar" e "a comparação apareceu".
 */
function itensComparados(bruto: unknown): ItemComparado[] {
  if (!Array.isArray(bruto)) return []
  const itens: ItemComparado[] = []
  bruto.forEach((item, i) => {
    if (typeof item === 'string') {
      const nome = item.trim()
      if (nome) itens.push({ nome, valores: {}, recomendado: false })
      return
    }
    if (typeof item !== 'object' || item === null) return
    const o = item as Record<string, unknown>
    const nome =
      NOMES_DO_ITEM.map((campo) => texto(o[campo]).trim()).find(Boolean) || `Opção ${i + 1}`

    const valores: Record<string, string> = {}
    for (const campo of FICHAS_DO_ITEM) {
      const dentro = o[campo]
      if (typeof dentro !== 'object' || dentro === null || Array.isArray(dentro)) continue
      for (const [atributo, valor] of Object.entries(dentro as Record<string, unknown>)) {
        const lido = valorDaFicha(valor)
        if (atributo.trim() && lido) valores[atributo.trim()] = lido
      }
    }
    // Ficha achatada: o que sobra no item e não é nome, ficha nem selo é atributo.
    for (const [campo, valor] of Object.entries(o)) {
      if (NOMES_DO_ITEM.includes(campo) || FICHAS_DO_ITEM.includes(campo)) continue
      if (campo === 'recomendado' || campo === 'melhor' || campo === 'destaque') continue
      const lido = valorDaFicha(valor)
      if (lido && !(campo in valores)) valores[campo] = lido
    }

    const recomendado = o.recomendado === true || o.melhor === true || o.destaque === true
    itens.push({ nome, valores, recomendado })
  })
  return itens
}

/** A ordem das linhas: a que a IA pediu, ou a união dos atributos na ordem em que vieram. */
function atributosDe(pedidos: unknown, itens: ItemComparado[]): string[] {
  const lista = Array.isArray(pedidos)
    ? pedidos.map((item) => texto(item).trim()).filter(Boolean)
    : []
  const todos = [...new Set(itens.flatMap((item) => Object.keys(item.valores)))]
  if (!lista.length) return todos
  // Atributo pedido que ninguém tem continua aparecendo, com a célula vazia: sumir com o
  // atributo que a pessoa pediu para comparar é pior do que mostrar que falta o dado.
  return [...new Set([...lista, ...todos])]
}

/** Quem ganha cada linha: aceita o nome do item ou a posição dele na lista. */
function destaquesDe(bruto: unknown, itens: ItemComparado[]): Record<string, string> {
  if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) return {}
  const saida: Record<string, string> = {}
  for (const [atributo, alvo] of Object.entries(bruto as Record<string, unknown>)) {
    const nome =
      typeof alvo === 'number' ? itens[alvo]?.nome ?? '' : texto(alvo).trim()
    if (nome) saida[atributo.trim()] = nome
  }
  return saida
}

/**
 * A comparação de verdade: N itens nas colunas, os mesmos atributos nas linhas.
 *
 * ## Por que existe, se já havia `comparacao`
 *
 * O `comparacao` de antes é "duas listas lado a lado" (prós e contras): cada coluna tem um
 * título e marcadores soltos. Quando a pessoa pergunta "qual desses três celulares eu levo",
 * a IA tentava responder com aquilo — e saía uma coluna com "R$ 3.499" e outra com "bateria
 * boa", nada alinhado. Comparar ficha de produto exige **linha = atributo**, e era isso que
 * não existia. O bloco é o mesmo (`koda-comparacao`), com `atributos` + `itens`.
 *
 * ## A leitura é por coluna
 *
 * Passar o mouse em qualquer célula acende a **coluna inteira** e apaga as outras — comparar
 * é olhar um candidato de ponta a ponta, e célula a célula não ajuda nisso. O balão mostra o
 * par atributo/valor exato que está embaixo do mouse.
 */
function TabelaComparativa({
  itens,
  atributos,
  destaques,
}: {
  itens: ItemComparado[]
  atributos: string[]
  destaques: Record<string, string>
}) {
  const interacao = useInteracao()

  return (
    <ComBalao interacao={interacao}>
      <div className="min-w-0 overflow-x-auto">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr>
              <th
                scope="col"
                className="sticky left-0 z-10 border-b border-koda-fg/15 bg-koda-bg px-2 py-2 text-left text-[10.5px] font-medium tracking-wide text-koda-fg/35 uppercase"
              >
                {itens.length} opções
              </th>
              {itens.map((item, i) => {
                const chave = `cmp${i}`
                const p = interacao.props(chave, {
                  titulo: item.nome,
                  detalhe: `${atributos.length} atributos`,
                })
                return (
                  <th
                    key={i}
                    scope="col"
                    {...p}
                    style={{ ...p.style, opacity: apagado(interacao, chave) ? 0.3 : 1 }}
                    className={`border-b border-koda-fg/15 px-2.5 py-2 text-left align-bottom ${
                      item.recomendado ? 'bg-koda-accent/[0.07]' : ''
                    }`}
                  >
                    <span
                      className={`block text-[12.5px] font-semibold ${
                        item.recomendado ? 'text-koda-accent' : 'text-koda-fg/85'
                      }`}
                    >
                      {item.nome}
                    </span>
                    {item.recomendado ? (
                      <span className="mt-1 inline-block rounded-full bg-koda-accent/15 px-1.5 py-0.5 text-[9.5px] font-medium tracking-wide text-koda-accent uppercase">
                        recomendado
                      </span>
                    ) : null}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {atributos.map((atributo) => (
              <tr key={atributo} className="align-top">
                <th
                  scope="row"
                  className="sticky left-0 z-10 border-b border-koda-fg/8 bg-koda-bg px-2 py-1.5 text-left text-[11.5px] font-medium whitespace-nowrap text-koda-fg/45"
                >
                  {atributo}
                </th>
                {itens.map((item, i) => {
                  const chave = `cmp${i}`
                  const valor = item.valores[atributo] ?? '—'
                  const venceu = destaques[atributo] === item.nome
                  const p = interacao.props(chave, {
                    titulo: `${item.nome} · ${atributo}`,
                    detalhe: valor,
                  })
                  return (
                    <td
                      key={i}
                      {...p}
                      style={{ ...p.style, opacity: apagado(interacao, chave) ? 0.3 : 1 }}
                      className={`border-b border-koda-fg/8 px-2.5 py-1.5 whitespace-nowrap ${
                        venceu ? 'font-semibold text-koda-accent' : 'text-koda-fg/75'
                      } ${item.recomendado ? 'bg-koda-accent/[0.04]' : ''}`}
                    >
                      {valor}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ComBalao>
  )
}

// ---------------------------------------------------------------- diagrama de traço

/**
 * Glifos que **desenham** em vez de escrever: caixa, seta e marca.
 *
 * A distinção é o que faz o diagrama virar desenho: o traço fica em cor de traço e o texto
 * fica em cor de texto. Sem isso, o ASCII do modelo é uma parede de caracteres iguais — que
 * é exatamente o que o dono apontou nas fotos dele (20/10/2026).
 */
const GLIFO_CAIXA = /[─│┌┐└┘├┤┬┴┼╭╮╰╯═║╔╗╚╝╠╣╦╩╬|]/
const GLIFO_SETA = /[→←↑↓▼▲◀▶►◄]/

/**
 * A linha inteira é borda? (`+----+`, `|    |`, `=====`)
 *
 * `-` só entra como traço quando a linha **só** tem traço: no meio de um texto ele é hífen
 * ou marcador de lista, e pintar aquilo de cor de desenho sujaria a leitura.
 */
function ehBorda(linha: string): boolean {
  const limpa = linha.replace(/\s/g, '')
  if (!limpa) return false
  return /^[+\-=|]+$/.test(limpa) && (limpa.length >= 2 || limpa === '|')
}

/** Um pedaço da linha, já sabendo se é traço, seta ou texto. */
function pedacosDaLinha(linha: string): { tipo: 'caixa' | 'seta' | 'texto'; texto: string }[] {
  const borda = ehBorda(linha)
  const pedacos: { tipo: 'caixa' | 'seta' | 'texto'; texto: string }[] = []
  let atual = ''
  let tipoAtual: 'caixa' | 'seta' | 'texto' = 'texto'
  const fechar = () => {
    if (atual) pedacos.push({ tipo: tipoAtual, texto: atual })
    atual = ''
  }
  for (const caractere of linha) {
    const tipo = GLIFO_SETA.test(caractere)
      ? 'seta'
      : borda || GLIFO_CAIXA.test(caractere)
        ? 'caixa'
        : 'texto'
    if (tipo !== tipoAtual) {
      fechar()
      tipoAtual = tipo
    }
    atual += caractere
  }
  fechar()
  return pedacos
}

/**
 * O diagrama de traço, desenhado com cuidado tipográfico.
 *
 * ## Por que não é só um bloco de código
 *
 * O modelo já sabe desenhar caixa e seta com `┌ ─ │ ▼` — o que ele não sabe é que aquilo
 * **é um desenho**. Num `<pre>` cinza, o diagrama lê igual a código, e a pessoa precisa
 * decifrar. Aqui o traço sai na cor de destaque, a seta mais forte que a caixa, e o texto
 * no tom normal: o olho separa a estrutura do conteúdo sem ninguém explicar.
 *
 * ## O alinhamento é sagrado
 *
 * `whitespace-pre` + `font-mono` + `leading` fixo: o desenho é uma grade de caracteres, e
 * qualquer quebra de linha ou fonte proporcional desmonta a caixa. Em tela estreita a
 * moldura rola na horizontal — nunca reflui o desenho.
 */
function Diagrama({ linhas }: { linhas: string[] }) {
  const interacao = useInteracao()
  return (
    <ComBalao interacao={interacao}>
      <div className="min-w-0 overflow-x-auto rounded-xl bg-koda-fg/[0.035] p-3 ring-1 ring-koda-fg/8">
        <pre className="koda-diagrama text-[12px] leading-[1.5] whitespace-pre">
          {linhas.map((linha, i) => {
            const chave = `dg${i}`
            const p = interacao.props(chave, { titulo: `linha ${i + 1}`, detalhe: linha.trim() })
            return (
              <div
                key={i}
                {...p}
                style={{ ...p.style, opacity: apagado(interacao, chave) ? 0.3 : 1 }}
                className="transition-opacity"
              >
                {linha
                  ? pedacosDaLinha(linha).map((pedaco, j) => (
                      <span
                        key={j}
                        className={
                          pedaco.tipo === 'seta'
                            ? 'text-koda-accent'
                            : pedaco.tipo === 'caixa'
                              ? 'text-koda-accent/50'
                              : 'text-koda-fg/80'
                        }
                      >
                        {pedaco.texto}
                      </span>
                    ))
                  : '\u00A0'}
              </div>
            )
          })}
        </pre>
      </div>
    </ComBalao>
  )
}

// ---------------------------------------------------------------- diagrama em colunas

/** Um bloco dentro de uma coluna: título, linhas de detalhe e o tom. */
type CaixaDoDiagrama = {
  titulo: string
  linhas: string[]
  tom: 'neutro' | 'atencao' | 'erro' | 'ok'
}

/** Uma coluna do diagrama: o título em cima e as caixas empilhadas. */
type ColunaDoDiagrama = { titulo: string; caixas: CaixaDoDiagrama[] }

/**
 * A cor da caixa pelo tom. Função, e não mapa constante: `TONS_DE_AVISO` é declarado mais
 * abaixo no arquivo, e um mapa montado no topo leria a variável antes de ela existir.
 */
function classeDaCaixa(tom: CaixaDoDiagrama['tom']): string {
  if (tom === 'atencao') return TONS_DE_AVISO.aviso
  if (tom === 'erro') return TONS_DE_AVISO.erro
  if (tom === 'ok') return 'border-emerald-400/40 bg-emerald-400/[0.08]'
  return 'border-koda-fg/12 bg-koda-fg/[0.04]'
}

/** O tom que veio escrito — `atencao`/`aviso`/`erro`/`ok`, em português ou inglês. */
function tomDaCaixa(bruto: unknown): CaixaDoDiagrama['tom'] {
  const t = texto(bruto).toLowerCase()
  if (t === 'ok' || t === 'bom' || t === 'verde' || t === 'sucesso') return 'ok'
  if (t === 'erro' || t === 'ruim' || t === 'vermelho' || t === 'falha') return 'erro'
  if (t === 'atencao' || t === 'atenção' || t === 'aviso' || t === 'alerta') return 'atencao'
  return 'neutro'
}

/**
 * Lê as caixas de uma coluna (ou as notas do rodapé) de qualquer formato que a IA mandar.
 *
 * Aceita `{ titulo, linhas }`, `{ nome, texto }`, e a string solta. As linhas podem vir como
 * lista ou como um texto com quebras — o modelo faz das duas formas, e nenhuma delas pode
 * virar caixa vazia na tela.
 */
function caixasDoDiagrama(bruto: unknown): CaixaDoDiagrama[] {
  if (!Array.isArray(bruto)) return []
  return bruto
    .map((item) => {
      if (typeof item === 'string') {
        const titulo = item.trim()
        return titulo ? { titulo, linhas: [], tom: 'neutro' as const } : null
      }
      if (typeof item !== 'object' || item === null) return null
      const o = item as Record<string, unknown>
      const cru = o.linhas ?? o.itens ?? o.texto ?? o.detalhe ?? o.descricao
      const linhas = Array.isArray(cru)
        ? cru.map((linha) => texto(linha)).filter(Boolean)
        : texto(cru)
            .split('\n')
            .map((linha) => linha.trim())
            .filter(Boolean)
      return {
        titulo: texto(o.titulo ?? o.nome ?? o.label),
        linhas,
        tom: tomDaCaixa(o.tom ?? o.estado ?? o.nivel ?? o.cor),
      }
    })
    .filter((caixa): caixa is CaixaDoDiagrama => caixa !== null)
}

function colunasDoDiagrama(bruto: unknown): ColunaDoDiagrama[] {
  if (!Array.isArray(bruto)) return []
  return bruto
    .map((item, i) => {
      if (typeof item !== 'object' || item === null) return null
      const o = item as Record<string, unknown>
      const caixas = caixasDoDiagrama(o.blocos ?? o.caixas ?? o.itens ?? o.dados)
      if (!caixas.length) return null
      return { titulo: texto(o.titulo ?? o.label ?? o.nome, `coluna ${i + 1}`), caixas }
    })
    .filter((coluna): coluna is ColunaDoDiagrama => coluna !== null)
}

/** A seta entre duas partes: horizontal na tela larga, vertical na estreita. */
function SetaDoDiagrama({
  rotulo,
  direcao = 'direita',
}: {
  rotulo?: string
  direcao?: 'direita' | 'baixo'
}) {
  return (
    <div className="flex shrink-0 flex-col items-center justify-center gap-1 py-1">
      {rotulo ? (
        <span className="max-w-[130px] text-center text-[10px] leading-tight text-koda-fg/45">
          {rotulo}
        </span>
      ) : null}
      <svg
        width="30"
        height="10"
        viewBox="0 0 30 10"
        aria-hidden="true"
        className={`text-koda-accent/80 ${
          direcao === 'baixo' ? 'rotate-90' : 'rotate-90 lg:rotate-0'
        }`}
      >
        <path d="M1 5h24" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <path
          d="M21 1.5 26 5l-5 3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}

function CaixaDoDiagramaView({ caixa }: { caixa: CaixaDoDiagrama }) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${classeDaCaixa(caixa.tom)}`}>
      {caixa.titulo ? (
        <p className="flex items-start gap-1.5 font-mono text-[12px] leading-snug font-semibold text-koda-fg/90">
          {caixa.tom === 'ok' ? (
            <span className="text-emerald-400" aria-hidden="true">
              ✓
            </span>
          ) : null}
          <span className="min-w-0">{caixa.titulo}</span>
        </p>
      ) : null}
      {caixa.linhas.map((linha, i) => (
        <p key={i} className="mt-0.5 text-[11.5px] leading-snug text-koda-fg/60">
          {linha}
        </p>
      ))}
    </div>
  )
}

/**
 * O diagrama de arquitetura: colunas lado a lado, caixas empilhadas, seta no meio.
 *
 * ## Por que colunas, e não traço
 *
 * O `koda-diagrama` de traço resolve o desenho que a IA já sabe fazer à mão — mas ele
 * carrega a limitação do desenho à mão: largura fixa de caractere, nada se adapta à tela, e
 * o "problema" de cada caixa só aparece se o modelo escrever a palavra. Aqui o modelo manda
 * a **estrutura** (coluna → caixas → tom) e o Koda desenha: a coluna estica, o tom pinta a
 * caixa, a seta vira seta. É o mesmo dado que ele já manda; só que desenhado, e não
 * digitado (pedido do dono em 20/10/2026, com o print da arquitetura em três colunas).
 */
function DiagramaDeColunas({ colunas, setas }: { colunas: ColunaDoDiagrama[]; setas: string[] }) {
  const pecas: ReactNode[] = []
  colunas.forEach((coluna, i) => {
    pecas.push(
      <div
        key={`coluna-${i}`}
        className="flex min-w-0 flex-1 flex-col gap-2 rounded-xl bg-koda-fg/[0.03] p-2.5 ring-1 ring-koda-fg/8"
      >
        <p className="px-1 text-[11.5px] font-semibold text-koda-fg/70">{coluna.titulo}</p>
        {coluna.caixas.map((caixa, j) => (
          <CaixaDoDiagramaView key={j} caixa={caixa} />
        ))}
      </div>,
    )
    if (i < colunas.length - 1) {
      pecas.push(<SetaDoDiagrama key={`seta-${i}`} rotulo={setas[i]} />)
    }
  })
  return <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-stretch">{pecas}</div>
}

/**
 * Camadas: a mesma ideia das colunas, empilhada.
 *
 * Coluna é "quem fala com quem" na horizontal; camada é "o que está por baixo" — cliente,
 * servidor, banco, disco. A leitura é de cima para baixo, e as caixas de cada camada ficam
 * lado a lado porque são alternativas dentro dela (dois workers, dois bancos).
 */
function DiagramaDeCamadas({ camadas }: { camadas: ColunaDoDiagrama[] }) {
  const pecas: ReactNode[] = []
  camadas.forEach((camada, i) => {
    pecas.push(
      <div
        key={`camada-${i}`}
        className="flex min-w-0 flex-col gap-2 rounded-xl bg-koda-fg/[0.03] p-2.5 ring-1 ring-koda-fg/8"
      >
        <p className="px-1 text-[11.5px] font-semibold text-koda-fg/70">{camada.titulo}</p>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
          {camada.caixas.map((caixa, j) => (
            <div key={j} className="min-w-0 flex-1">
              <CaixaDoDiagramaView caixa={caixa} />
            </div>
          ))}
        </div>
      </div>,
    )
    if (i < camadas.length - 1) pecas.push(<SetaDoDiagrama key={`seta-${i}`} direcao="baixo" />)
  })
  return <div className="flex min-w-0 flex-col gap-1">{pecas}</div>
}

/**
 * Fluxo: caixas em sequência, com o rótulo no fio da seta.
 *
 * Diferente de `koda-passos`, que é uma lista numerada: aqui cada etapa é uma **caixa**, e a
 * seta carrega a condição ("se o teste falhar", "depois do deploy"). Para bifurcação de
 * verdade, o modo de traço resolve melhor — duas saídas desenhadas não cabem num fluxo
 * linear sem virar adivinhação.
 */
function DiagramaDeFluxo({ passos, setas }: { passos: CaixaDoDiagrama[]; setas: string[] }) {
  const pecas: ReactNode[] = []
  passos.forEach((passo, i) => {
    pecas.push(
      <div key={`passo-${i}`} className="mx-auto w-full max-w-[540px]">
        <CaixaDoDiagramaView caixa={passo} />
      </div>,
    )
    if (i < passos.length - 1) {
      pecas.push(<SetaDoDiagrama key={`seta-${i}`} rotulo={setas[i]} direcao="baixo" />)
    }
  })
  return <div className="flex min-w-0 flex-col gap-1">{pecas}</div>
}

/**
 * Matriz 2×2: dois eixos e quatro quadrantes.
 *
 * A ordem dos quadrantes é a de leitura: superior esquerdo, superior direito, inferior
 * esquerdo, inferior direito. Os eixos aparecem como legenda acima e à direita — girar texto
 * na vertical fica bonito em revista e ilegível numa conversa.
 */
function DiagramaDeMatriz({
  quadrantes,
  eixoX,
  eixoY,
}: {
  quadrantes: CaixaDoDiagrama[]
  eixoX: string
  eixoY: string
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {eixoY ? (
        <p className="text-[10.5px] tracking-wide text-koda-fg/40 uppercase">↑ {eixoY}</p>
      ) : null}
      <div className="grid min-w-0 gap-2 sm:grid-cols-2">
        {quadrantes.slice(0, 4).map((quadrante, i) => (
          <div
            key={i}
            className={`flex min-w-0 flex-col gap-1.5 rounded-xl border px-3 py-2.5 ${classeDaCaixa(quadrante.tom)}`}
          >
            <p className="text-[12px] font-semibold text-koda-fg/85">{quadrante.titulo}</p>
            <ul className="flex flex-col gap-1">
              {quadrante.linhas.map((linha, j) => (
                <li key={j} className="flex gap-1.5 text-[11.5px] leading-snug text-koda-fg/65">
                  <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-koda-fg/35" />
                  <span className="min-w-0">{linha}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {eixoX ? (
        <p className="text-right text-[10.5px] tracking-wide text-koda-fg/40 uppercase">
          {eixoX} →
        </p>
      ) : null}
    </div>
  )
}

/** As notas do rodapé, iguais em todos os formatos de diagrama. */
function ComNotas({ notas, children }: { notas: CaixaDoDiagrama[]; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {children}
      {notas.length ? (
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
          {notas.map((nota, i) => (
            <div key={i} className="min-w-0 flex-1">
              <CaixaDoDiagramaView caixa={nota} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Qual diagrama desenhar — decidido pela **chave que veio**, não por um `tipo` a mais.
 *
 * `colunas` (horizontal), `camadas` (empilhado), `fluxo` (sequência) e `quadrantes` (matriz
 * 2×2) são quatro desenhos diferentes do mesmo bloco. O modelo escolhe a forma que combina
 * com o que ele tem a dizer, e não precisa aprender um nome novo a cada uma.
 */
function DiagramaEstruturado({ dados }: { dados: Record<string, unknown> }) {
  const lista = (chave: unknown) => (Array.isArray(chave) ? chave.map((item) => texto(item)) : [])
  const notas = caixasDoDiagrama(dados.notas)

  const colunas = colunasDoDiagrama(dados.colunas)
  if (colunas.length) {
    return (
      <ComNotas notas={notas}>
        <DiagramaDeColunas colunas={colunas} setas={lista(dados.setas)} />
      </ComNotas>
    )
  }
  const camadas = colunasDoDiagrama(dados.camadas ?? dados.pilha)
  if (camadas.length) {
    return (
      <ComNotas notas={notas}>
        <DiagramaDeCamadas camadas={camadas} />
      </ComNotas>
    )
  }
  const passos = caixasDoDiagrama(dados.fluxo ?? dados.sequencia)
  if (passos.length) {
    return (
      <ComNotas notas={notas}>
        <DiagramaDeFluxo passos={passos} setas={lista(dados.setas)} />
      </ComNotas>
    )
  }
  const quadrantes = caixasDoDiagrama(dados.quadrantes)
  if (quadrantes.length) {
    return (
      <ComNotas notas={notas}>
        <DiagramaDeMatriz
          quadrantes={quadrantes}
          eixoX={texto(dados.eixo_x ?? dados.eixoX)}
          eixoY={texto(dados.eixo_y ?? dados.eixoY)}
        />
      </ComNotas>
    )
  }
  return null
}

/**
 * `koda-diagrama` aceita as três formas que o modelo escreve:
 *
 * 1. o desenho **cru** (que é o natural — ele já desenha assim, com `┌ ─ │ ▼`);
 * 2. o JSON `{ "titulo", "linhas": [...] }` quando quer título e legenda;
 * 3. o JSON **estruturado** `{ "colunas": [{ "titulo", "blocos": [...] }] }`, que sai como
 *    arquitetura em colunas — caixa, tom e seta desenhados, sem depender de fonte.
 *
 * Enquanto o bloco chega pela metade, o texto cru aparece como está: nada de cartão de erro
 * piscando no meio do stream.
 */
export function DiagramaDeTexto({ fonte }: { fonte: string }) {
  const bruto = fonte.trim()
  let linhas: string[] = []
  let titulo = ''
  let legenda = ''
  let estruturado: ReactNode = null
  if (bruto.startsWith('{')) {
    try {
      const dados = JSON.parse(bruto) as Record<string, unknown>
      estruturado = <DiagramaEstruturado dados={dados} />
      const cru = dados.linhas ?? dados.texto ?? dados.diagrama ?? dados.ascii
      linhas = Array.isArray(cru) ? cru.map((item) => texto(item)) : texto(cru).split('\n')
      titulo = texto(dados.titulo ?? dados.title)
      legenda = texto(dados.legenda ?? dados.rodape)
    } catch {
      // JSON pela metade: cai no texto cru abaixo, que é o que já está na tela.
    }
  }
  if (estruturado) {
    return (
      <Moldura titulo={titulo} legenda={legenda}>
        {estruturado}
      </Moldura>
    )
  }
  if (!linhas.some((linha) => linha.trim())) linhas = fonte.replace(/\n+$/, '').split('\n')
  if (!linhas.some((linha) => linha.trim())) return null
  return (
    <Moldura titulo={titulo} legenda={legenda}>
      <Diagrama linhas={linhas} />
    </Moldura>
  )
}

// ---------------------------------------------------------------- tabela

function Tabela({ colunas, linhas }: { colunas: string[]; linhas: string[][] }) {
  const interacao = useInteracao()
  return (
    <ComBalao interacao={interacao}>
      <div className="min-w-0 overflow-x-auto">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr>
              {colunas.map((c, i) => (
                <th
                  key={i}
                  className="border-b border-koda-fg/15 px-2 py-1.5 text-left font-semibold text-koda-fg/80"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {linhas.map((linha, i) => {
              const chave = `tl${i}`
              return (
                <tr
                  key={i}
                  {...interacao.props(chave, {
                    titulo: linha[0] ?? `linha ${i + 1}`,
                    detalhe: colunas.slice(1).map((c, k) => `${c}: ${linha[k + 1] ?? ''}`).join(' · '),
                  })}
                  className="transition-opacity hover:bg-koda-fg/6"
                  style={{ opacity: apagado(interacao, chave) ? 0.3 : 1 }}
                >
                  {linha.map((celula, j) => (
                    <td key={j} className="border-b border-koda-fg/8 px-2 py-1.5 text-koda-fg/70">
                      {celula}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </ComBalao>
  )
}

// ---------------------------------------------------------------- diff

/** Uma linha de diff: entrou, saiu ou é o contexto que ficou igual. */
type LinhaDiff = { tipo: 'add' | 'del' | 'ctx'; texto: string }

/**
 * Linhas de diff em qualquer forma: objeto com `tipo`, ou a string do git (`+`, `-`, ` `).
 * O modelo escreve dos dois jeitos, e um formato recusado aqui viraria bloco morto na
 * conversa — então os dois entram.
 */
function linhasDiff(bruto: unknown): LinhaDiff[] {
  if (!Array.isArray(bruto)) return []
  return bruto
    .map((item) => {
      if (typeof item === 'string') {
        const sinal = item[0]
        if (sinal === '+' || sinal === '-') {
          return { tipo: sinal === '+' ? 'add' : 'del', texto: item.slice(1) } as LinhaDiff
        }
        return { tipo: 'ctx', texto: item } as LinhaDiff
      }
      if (typeof item === 'object' && item !== null) {
        const o = item as Record<string, unknown>
        const t = texto(o.tipo ?? o.kind ?? o.t).toLowerCase()
        const tipo: LinhaDiff['tipo'] =
          t.startsWith('add') || t === '+'
            ? 'add'
            : t.startsWith('del') || t.startsWith('rem') || t === '-'
              ? 'del'
              : 'ctx'
        return { tipo, texto: texto(o.texto ?? o.linha ?? o.conteudo ?? o.text) }
      }
      return null
    })
    .filter((l): l is LinhaDiff => l !== null && l.texto !== '')
}

function Diffs({ arquivo, linhas }: { arquivo?: string; linhas: LinhaDiff[] }) {
  const interacao = useInteracao()
  const adds = linhas.filter((l) => l.tipo === 'add').length
  const dels = linhas.filter((l) => l.tipo === 'del').length

  return (
    <ComBalao interacao={interacao}>
      <div className="overflow-hidden rounded-lg ring-1 ring-koda-fg/10">
        <div className="flex items-center justify-between gap-2 border-b border-koda-fg/10 bg-koda-fg/5 px-2.5 py-1.5">
          <span className="min-w-0 truncate font-mono text-[11.5px] text-koda-fg/70">
            {arquivo || 'mudança'}
          </span>
          <span className="shrink-0 font-mono text-[11px]">
            <span className="text-emerald-400">+{adds}</span>{' '}
            <span className="text-rose-400">-{dels}</span>
          </span>
        </div>
        <div className="flex flex-col font-mono text-[12px] leading-5">
          {linhas.map((linha, i) => {
            const chave = `df${i}`
            return (
              <div
                key={i}
                {...interacao.props(chave, {
                  titulo:
                    linha.tipo === 'add'
                      ? 'linha nova'
                      : linha.tipo === 'del'
                        ? 'linha removida'
                        : 'contexto',
                  valor: `linha ${i + 1}`,
                })}
                className={[
                  'flex gap-2 px-2.5 transition-opacity',
                  linha.tipo === 'add' ? 'bg-emerald-400/10 text-emerald-200/90' : '',
                  linha.tipo === 'del' ? 'bg-rose-400/10 text-rose-200/80' : '',
                  linha.tipo === 'ctx' ? 'text-koda-fg/55' : '',
                ].join(' ')}
                style={{ opacity: apagado(interacao, chave) ? 0.4 : 1 }}
              >
                <span className="w-3 shrink-0 text-koda-fg/40 select-none">
                  {linha.tipo === 'add' ? '+' : linha.tipo === 'del' ? '-' : ' '}
                </span>
                <span className="min-w-0 whitespace-pre-wrap break-words">{linha.texto}</span>
              </div>
            )
          })}
        </div>
      </div>
    </ComBalao>
  )
}

// ---------------------------------------------------------------- árvore de arquivos

/** Um nó de árvore: o nome e, se for pasta, o que tem dentro. */
type NoArvore = { nome: string; filhos?: NoArvore[] }

function nos(bruto: unknown, profundidade = 0): NoArvore[] {
  if (!Array.isArray(bruto) || profundidade > 6) return []
  return bruto
    .map((item) => {
      if (typeof item === 'string') return { nome: item }
      if (typeof item === 'object' && item !== null) {
        const o = item as Record<string, unknown>
        const filhos = nos(o.filhos ?? o.children ?? o.itens, profundidade + 1)
        return {
          nome: texto(o.nome ?? o.name ?? o.texto ?? o.arquivo),
          ...(filhos.length ? { filhos } : {}),
        }
      }
      return null
    })
    .filter((n): n is NoArvore => n !== null && n.nome !== '')
}

function Arvore({ lista }: { lista: NoArvore[] }) {
  const interacao = useInteracao()

  const galho = (no: NoArvore, chave: string): ReactNode => {
    const pasta = (no.filhos?.length ?? 0) > 0
    return (
      <li key={chave}>
        <div
          {...interacao.props(chave, { titulo: no.nome, detalhe: pasta ? 'pasta' : 'arquivo' })}
          className="flex items-center gap-2 rounded-md px-1 py-0.5 transition-opacity hover:bg-koda-fg/6"
          style={{ opacity: apagado(interacao, chave) ? 0.35 : 1 }}
        >
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-[2px] ${pasta ? 'bg-koda-accent' : 'bg-koda-fg/35'}`}
          />
          <span
            className={`min-w-0 truncate text-[12.5px] ${pasta ? 'text-koda-fg/90' : 'text-koda-fg/65'}`}
          >
            {no.nome}
          </span>
        </div>
        {no.filhos?.length ? (
          <ul className="ml-2.5 flex flex-col border-l border-dashed border-koda-fg/15 pl-2.5">
            {no.filhos.map((filho, i) => galho(filho, `${chave}-${i}`))}
          </ul>
        ) : null}
      </li>
    )
  }

  return (
    <ComBalao interacao={interacao}>
      <ul className="flex flex-col">{lista.map((no, i) => galho(no, `a${i}`))}</ul>
    </ComBalao>
  )
}

// ---------------------------------------------------------------- cartões de número

/** Um cartão de métrica: rótulo pequeno, valor grande, variação colorida. */
type Cartao = { rotulo: string; valor: string; variacao?: string; detalhe?: string }

function cartoes(bruto: unknown): Cartao[] {
  if (!Array.isArray(bruto)) return []
  return bruto
    .map((item): Cartao | null => {
      if (typeof item !== 'object' || item === null) return null
      const o = item as Record<string, unknown>
      return {
        rotulo: texto(o.rotulo ?? o.label ?? o.nome),
        valor: texto(o.valor ?? o.value),
        variacao: texto(o.variacao ?? o.delta ?? o.mudanca) || undefined,
        detalhe: texto(o.detalhe ?? o.detail) || undefined,
      }
    })
    .filter((c): c is Cartao => c !== null && c.rotulo !== '' && c.valor !== '')
}

function Metrica({ lista }: { lista: Cartao[] }) {
  const interacao = useInteracao()

  return (
    <ComBalao interacao={interacao}>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-[repeat(auto-fit,minmax(130px,1fr))]">
        {lista.map((cartao, i) => {
          const chave = `m${i}`
          const sobe = cartao.variacao?.startsWith('+')
          return (
            <div
              key={i}
              {...interacao.props(chave, { titulo: cartao.rotulo, valor: cartao.detalhe })}
              className="flex min-w-0 flex-col gap-1 rounded-lg border border-koda-fg/10 bg-koda-fg/[0.03] p-3 transition-opacity"
              style={{ opacity: apagado(interacao, chave) ? 0.4 : 1 }}
            >
              <span className="text-[11.5px] text-koda-fg/50">{cartao.rotulo}</span>
              <span className="font-mono text-[20px] leading-none text-koda-fg">{cartao.valor}</span>
              {cartao.variacao ? (
                <span className={`text-[11.5px] ${sobe ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {cartao.variacao}
                </span>
              ) : null}
            </div>
          )
        })}
      </div>
    </ComBalao>
  )
}

// ---------------------------------------------------------------- aviso colorido

/** As cores do aviso, por tom. Sem tom conhecido, é `info` — nunca um aviso sem cor. */
const TONS_DE_AVISO: Record<string, string> = {
  dica: 'border-koda-accent/40 bg-koda-accent/[0.08]',
  aviso: 'border-amber-400/40 bg-amber-400/[0.08]',
  erro: 'border-rose-400/40 bg-rose-400/[0.08]',
  info: 'border-sky-400/40 bg-sky-400/[0.08]',
}

const PONTO_DO_AVISO: Record<string, string> = {
  dica: 'bg-koda-accent',
  aviso: 'bg-amber-400',
  erro: 'bg-rose-400',
  info: 'bg-sky-400',
}

function Citacao({ tomDoAviso, titulo: tit, corpo }: { tomDoAviso: string; titulo?: string; corpo: string }) {
  return (
    <div className={`rounded-xl border px-3.5 py-3 ${TONS_DE_AVISO[tomDoAviso] ?? TONS_DE_AVISO.info}`}>
      {tit ? (
        <p className="flex items-center gap-1.5 text-[13px] font-semibold text-koda-fg/90">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${PONTO_DO_AVISO[tomDoAviso] ?? PONTO_DO_AVISO.info}`}
          />
          {tit}
        </p>
      ) : null}
      <p className={`text-[12.5px] leading-relaxed text-koda-fg/80 ${tit ? 'mt-1' : ''}`}>{corpo}</p>
    </div>
  )
}

// ---------------------------------------------------------------- quiz

/**
 * O quiz: o único bloco que **guarda estado**.
 *
 * Todos os outros desenhos reagem ao mouse; este reage ao clique e continua diferente
 * depois. É o que faz ele valer a pena como bloco de dados: a pessoa responde, e certo e
 * errado aparecem na hora, sem ida ao servidor. Sem `correta` no JSON, ele só guarda a
 * escolha — não julga o que não sabe.
 */
function Quiz({
  pergunta,
  opcoes,
  correta,
  explicacao,
}: {
  pergunta: string
  opcoes: string[]
  correta?: number
  explicacao?: string
}) {
  const [escolhida, setEscolhida] = useState<number | null>(null)
  const respondeu = escolhida !== null

  return (
    // Sem moldura de cartão: o quiz flui na resposta. As opções são botões que marcam
    // certo/errado — superfície de campo, não de caixa. É o que tira o "cartão dentro do
    // cartão" que fazia o bloco parecer um app separado.
    <div className="my-1 flex flex-col gap-2">
      <p className="text-[13.5px] font-semibold text-koda-fg/90">{pergunta}</p>
      <ul className="flex flex-col gap-1.5">
        {opcoes.map((opcao, i) => {
          const eEscolhida = escolhida === i
          const eCerta = respondeu && correta === i
          return (
            <li key={i}>
              <button
                type="button"
                onClick={() => setEscolhida(i)}
                className={[
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors',
                  eCerta
                    ? 'bg-emerald-400/10 text-emerald-200'
                    : eEscolhida
                      ? 'bg-rose-400/10 text-rose-200'
                      : 'text-koda-fg/75 hover:bg-koda-fg/6 hover:text-koda-fg',
                ].join(' ')}
              >
                <span className="font-mono text-[11.5px] text-koda-fg/40">
                  {String.fromCharCode(65 + i)}
                </span>
                <span className="min-w-0 flex-1">{opcao}</span>
                {eCerta ? <span className="shrink-0 text-[11px]">certa</span> : null}
              </button>
            </li>
          )
        })}
      </ul>
      {respondeu ? (
        <p className="text-[12.5px] leading-relaxed text-koda-fg/60">
          {correta === undefined
            ? 'você respondeu — sem gabarito, o bloco só guarda a escolha.'
            : escolhida === correta
              ? 'acertou. '
              : 'essa não. '}
          {explicacao ?? ''}
        </p>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------- mapa radial

/** Um nó do mapa radial: o nome dentro do círculo e o que ele é embaixo. */
type NoRadial = { nome: string; sub?: string; nota?: string }

function nosRadiais(bruto: unknown): NoRadial[] {
  if (!Array.isArray(bruto)) return []
  return bruto
    .map((item) => {
      if (typeof item === 'string') return { nome: item }
      if (typeof item === 'object' && item !== null) {
        const o = item as Record<string, unknown>
        const nome = texto(o.nome ?? o.label ?? o.texto ?? o.titulo)
        if (nome === '') return null
        return {
          nome,
          sub: texto(o.sub ?? o.subtitulo ?? o.descricao ?? o.papel) || undefined,
          nota: texto(o.nota ?? o.detalhe) || undefined,
        }
      }
      return null
    })
    .filter((n): n is NoRadial => n !== null)
}

/**
 * O mapa radial — a constelação.
 *
 * O centro é o tema, os nós ficam numa roda de ligações curvadas, e **clicar acende**: o
 * nó escolhido e a ligação dele ganham brilho (o filtro de borrão do SVG, que embaça o
 * próprio elemento e devolve o original por cima — o halo sai da cor de cada um) enquanto
 * o resto apaga. A seleção é estado do componente, como no quiz: clica de novo ou `Esc`
 * limpa. Os chips de baixo são a segunda porta do mesmo clique — clicar no **nome** acende
 * a barrinha, que era o pedido.
 */
function MapaRadial({
  centro,
  centroSub,
  lista,
}: {
  centro: string
  centroSub?: string
  lista: NoRadial[]
}) {
  const interacao = useInteracao()
  const idBrilho = useId().replace(/:/g, '')
  const [selecionado, setSelecionado] = useState<number | null>(null)

  useEffect(() => {
    const tecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelecionado(null)
    }
    window.addEventListener('keydown', tecla)
    return () => window.removeEventListener('keydown', tecla)
  }, [])

  const CX = 170
  const CY = 148
  const RAIO = 88
  const total = Math.max(lista.length, 1)
  const anguloDe = (i: number) => (i / total) * Math.PI * 2 - Math.PI / 2
  const ponto = (i: number, distancia: number): [number, number] => {
    const a = anguloDe(i)
    return [CX + Math.cos(a) * distancia, CY + Math.sin(a) * distancia]
  }
  /** A ligação curvada: sai da beira do centro, chega na beira do nó, e a curva alterna de
   * lado a cada nó — é o que faz a roda parecer orgânica e não uma roda de bicicleta. */
  const ligacao = (i: number) => {
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

  return (
    <ComBalao interacao={interacao}>
      <div className="flex flex-col items-center gap-2">
        <svg viewBox="0 0 340 292" className="mx-auto h-auto w-full max-w-[440px]">
          <defs>
            <filter id={`brilho-${idBrilho}`} x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation="3.5" result="borrao" />
              <feMerge>
                <feMergeNode in="borrao" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <circle cx={CX} cy={CY} r={RAIO} fill="none" className="stroke-koda-fg/10" strokeDasharray="3 6" />
          {lista.map((no, i) => {
            const cor = tom(i)
            const aceso = selecionado === i
            const outroAceso = selecionado !== null && !aceso
            const [nx, ny] = ponto(i, RAIO)
            return (
              <g key={i} style={{ opacity: outroAceso ? 0.25 : 1, transition: 'opacity 0.2s' }}>
                <path
                  d={ligacao(i)}
                  fill="none"
                  className={`${cor} stroke-current`}
                  strokeWidth={aceso ? 2.8 : 1.3}
                  strokeOpacity={aceso ? 1 : 0.4}
                  filter={aceso ? `url(#brilho-${idBrilho})` : undefined}
                  style={{ transition: 'stroke-width 0.2s' }}
                />
                <circle
                  cx={nx}
                  cy={ny}
                  r={22}
                  {...interacao.props(`n${i}`, { titulo: no.nome, valor: no.sub, detalhe: no.nota, cor })}
                  onClick={() => setSelecionado(aceso ? null : i)}
                  className={`${cor} fill-current stroke-current`}
                  fillOpacity={aceso ? 0.22 : 0.09}
                  strokeWidth={aceso ? 2.4 : 1.3}
                  strokeOpacity={aceso ? 1 : 0.7}
                  filter={aceso ? `url(#brilho-${idBrilho})` : undefined}
                />
                <text
                  x={nx}
                  y={ny + 3.5}
                  textAnchor="middle"
                  fontSize="9.5"
                  fontWeight="600"
                  className="pointer-events-none fill-current text-koda-fg/90"
                >
                  {no.nome.slice(0, 9)}
                </text>
                <text
                  x={nx}
                  y={ny + 40}
                  textAnchor="middle"
                  fontSize="11"
                  fontWeight="600"
                  className="pointer-events-none fill-current text-koda-fg/85"
                >
                  {no.nome}
                </text>
                {no.sub ? (
                  <text
                    x={nx}
                    y={ny + 51}
                    textAnchor="middle"
                    fontSize="8.5"
                    className="pointer-events-none fill-current text-koda-fg/45"
                  >
                    {no.sub.slice(0, 24)}
                  </text>
                ) : null}
              </g>
            )
          })}
          <circle
            cx={CX}
            cy={CY}
            r={32}
            className="fill-koda-accent/15 stroke-koda-accent"
            strokeWidth="1.5"
            filter={`url(#brilho-${idBrilho})`}
          />
          <text
            x={CX}
            y={CY - 1}
            textAnchor="middle"
            fontSize="12"
            fontWeight="700"
            className="pointer-events-none fill-current text-koda-fg"
          >
            {centro.slice(0, 14)}
          </text>
          {centroSub ? (
            <text
              x={CX}
              y={CY + 13}
              textAnchor="middle"
              fontSize="8.5"
              className="pointer-events-none fill-current text-koda-fg/55"
            >
              {centroSub.slice(0, 18)}
            </text>
          ) : null}
        </svg>
        <ul className="flex max-w-[440px] flex-wrap justify-center gap-1.5">
          {lista.map((no, i) => {
            const aceso = selecionado === i
            return (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => setSelecionado(aceso ? null : i)}
                  className={[
                    'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] ring-1 transition-colors',
                    aceso
                      ? 'bg-koda-fg/10 text-koda-fg ring-koda-fg/30'
                      : 'text-koda-fg/55 ring-koda-fg/12 hover:bg-koda-fg/6 hover:text-koda-fg/80',
                  ].join(' ')}
                >
                  <span className={`${tom(i)} h-2 w-2 shrink-0 rounded-full bg-current`} />
                  {no.nome}
                </button>
              </li>
            )
          })}
        </ul>
        {selecionado !== null ? (
          <button
            type="button"
            onClick={() => setSelecionado(null)}
            className="rounded-md px-2 py-0.5 text-[11px] text-koda-fg/45 transition-colors hover:bg-koda-fg/8 hover:text-koda-fg/75"
          >
            limpar seleção
          </button>
        ) : null}
      </div>
    </ComBalao>
  )
}

// ---------------------------------------------------------------- plano

/** Uma mudança do plano: o arquivo (quando é código) e o que muda nele. */
type Mudanca = { arquivo?: string; texto: string }

function mudancasDoPlano(bruto: unknown): Mudanca[] {
  if (!Array.isArray(bruto)) return []
  return bruto
    .map((item) => {
      if (typeof item === 'string') return { texto: item }
      if (typeof item === 'object' && item !== null) {
        const o = item as Record<string, unknown>
        const conteudo = texto(o.texto ?? o.o_que ?? o.mudanca ?? o.descricao)
        if (conteudo === '') return null
        return { arquivo: texto(o.arquivo ?? o.file ?? o.onde) || undefined, texto: conteudo }
      }
      return null
    })
    .filter((m): m is Mudanca => m !== null)
}

function etapasDoPlano(bruto: unknown): Passo[] {
  if (!Array.isArray(bruto)) return []
  return bruto
    .map((item, i) => {
      if (typeof item === 'string') return { titulo: item }
      if (typeof item === 'object' && item !== null) {
        const o = item as Record<string, unknown>
        return {
          titulo: texto(o.titulo ?? o.label ?? o.nome, `${i + 1}`),
          texto: texto(o.texto ?? o.descricao ?? o.detalhe) || undefined,
        }
      }
      return null
    })
    .filter((p): p is Passo => p !== null)
}

/**
 * O cartão do plano — o que a IA apresenta **antes** de a pessoa aceitar.
 *
 * As seis partes são o contrato (de que é, pra que serve, por que assim, como, mudanças,
 * resultado esperado) e o prompt manda entregar todas; aqui o que vier é renderizado e o
 * que faltar simplesmente não aparece — o bloco não morre por seção ausente, porque a IA
 * vai esquecer um campo às vezes e a resposta não pode pagar por isso. O `como` é o único
 * trecho com ordem: numerado, como o passo a passo. As mudanças aceitam arquivo, que sai
 * em mono com balão no mouse — é o que quem lê confere primeiro.
 */
function Plano({
  planId,
  titulo,
  deQue,
  praQue,
  porQue,
  como,
  mudancas,
  resultado,
}: {
  planId?: string
  titulo: string
  deQue?: string
  praQue?: string
  porQue?: string
  como: Passo[]
  mudancas: Mudanca[]
  resultado?: string
}) {
  const interacao = useInteracao()
  /**
   * A decisão do plano. Enquanto não decidida, o cartão termina nos dois botões —
   * **Fazer** (aceita e o agente começa) e **Desistir** (recusa). Depois de clicar, os
   * botões saem e fica só a marca da decisão: o plano é uma porta, e porta fechada é
   * porta fechada.
   *
   * O clique **não** executa nada aqui dentro — quem manda mensagem é o chat. O aviso
   * vai por um evento de janela (`koda-plano`), e o `App` (único que sabe enviar)
   * transforma a decisão na mensagem "pode começar" / "não faça". Na galeria
   * (`blocos.html`) ninguém escuta o evento: os botões só mostram o estado, que é o
   * que a vitrine precisa.
   */
  const [decisao, setDecisao] = useState<'fazer' | 'desistir' | null>(null)
  const [decidindo, setDecidindo] = useState(false)
  const [erroDecisao, setErroDecisao] = useState(false)

  const decidir = (aceito: boolean) => {
    if (decisao || decidindo || !planId) return
    setDecidindo(true)
    setErroDecisao(false)
    window.dispatchEvent(new CustomEvent('koda-plano', { detail: { aceito, planId,
      onResult: (ok: boolean) => {
        setDecidindo(false)
        setErroDecisao(!ok)
        if (ok) setDecisao(aceito ? 'fazer' : 'desistir')
      },
    } }))
  }

  /** Uma das três explicações curtas — a cor é a identidade da seção. */
  const curta = (rotulo: string, classes: string, texto_: string | undefined) =>
    texto_ ? (
      <div className={`rounded-lg border p-2.5 ${classes}`}>
        <p className="text-[10px] font-semibold tracking-wide uppercase opacity-80">{rotulo}</p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-koda-fg/80">{texto_}</p>
      </div>
    ) : null

  return (
    <div className="my-1 flex min-w-0 flex-col gap-3 rounded-xl border border-koda-accent/25 bg-koda-accent/[0.04] p-4">
      <div className="flex items-center gap-2">
        <span className="shrink-0 rounded-full bg-koda-accent/18 px-2.5 py-0.5 text-[10.5px] font-bold tracking-wide text-koda-accent uppercase">
          plano
        </span>
        {titulo ? <p className="min-w-0 text-[14px] font-semibold text-koda-fg/95">{titulo}</p> : null}
      </div>

      <div className="grid gap-2.5 sm:grid-cols-3">
        {curta('de que é', 'border-sky-400/30 bg-sky-400/[0.06]', deQue)}
        {curta('pra que serve', 'border-emerald-400/30 bg-emerald-400/[0.06]', praQue)}
        {curta('por que assim', 'border-violet-400/30 bg-violet-400/[0.06]', porQue)}
      </div>

      {como.length ? (
        <div>
          <p className="text-[10px] font-semibold tracking-wide text-amber-300/90 uppercase">como</p>
          <ol className="mt-1.5 flex flex-col">
            {como.map((passo, i) => (
              <li key={i} className="flex gap-2.5">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-400/15 text-[10.5px] font-semibold text-amber-300">
                  {i + 1}
                </span>
                <div className="min-w-0 pb-2">
                  <p className="text-[13px] font-medium text-koda-fg/90">{passo.titulo}</p>
                  {passo.texto ? (
                    <p className="text-[12px] leading-relaxed text-koda-fg/60">{passo.texto}</p>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {mudancas.length ? (
        <div>
          <p className="text-[10px] font-semibold tracking-wide text-rose-300/90 uppercase">
            principais mudanças
          </p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {mudancas.map((mudanca, i) => (
              <li
                key={i}
                {...interacao.props(`pm${i}`, {
                  titulo: mudanca.arquivo ?? 'mudança',
                  valor: mudanca.texto,
                })}
                className="flex items-start gap-2 rounded-md px-1 py-0.5 text-[12.5px] transition-colors hover:bg-koda-fg/5"
              >
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-rose-400/70" />
                {mudanca.arquivo ? (
                  <code className="shrink-0 rounded bg-koda-fg/8 px-1 font-mono text-[11.5px] text-koda-fg/85">
                    {mudanca.arquivo}
                  </code>
                ) : null}
                <span className="min-w-0 text-koda-fg/70">{mudanca.texto}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {resultado ? (
        <div className="rounded-lg border border-koda-accent/30 bg-koda-accent/10 p-3">
          <p className="text-[10px] font-bold tracking-wide text-koda-accent uppercase">
            resultado final esperado
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-koda-fg/85">{resultado}</p>
        </div>
      ) : null}

      {decisao === null ? (
        <div className="mt-1 flex items-center justify-end gap-2 border-t border-koda-fg/8 pt-3">
          <p className="mr-auto text-[11.5px] text-koda-fg/45">
            {!planId ? 'Plano antigo: peça um plano atualizado.' : erroDecisao
              ? 'Não foi possível confirmar a decisão.' : decidindo ? 'Confirmando…' : 'pode começar?'}
          </p>
          <button
            type="button"
            onClick={() => decidir(false)}
            disabled={!planId || decidindo}
            className="rounded-xl px-3 py-1.5 text-[12.5px] font-medium text-koda-fg/60 ring-1 ring-koda-fg/12 transition-colors hover:bg-koda-fg/6 hover:text-koda-fg/85"
          >
            Desistir
          </button>
          <button
            type="button"
            onClick={() => decidir(true)}
            disabled={!planId || decidindo}
            className="rounded-xl bg-koda-accent-strong px-3.5 py-1.5 text-[12.5px] font-medium text-white ring-1 ring-transparent transition-colors hover:bg-koda-accent-strong/85"
          >
            Fazer
          </button>
        </div>
      ) : (
        <p
          className={`mt-1 flex items-center gap-1.5 border-t border-koda-fg/8 pt-3 text-[12px] font-medium ${
            decisao === 'fazer' ? 'text-emerald-400/90' : 'text-koda-fg/40'
          }`}
        >
          {decisao === 'fazer' ? 'plano aceito — começando' : 'plano desistido'}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- o despacho

/**
 * O primeiro objeto JSON que **fecha** dentro do texto do bloco.
 *
 * Existe porque o modelo erra o JSON de um jeito específico: ele fecha o objeto e
 * **continua escrevendo** logo depois — em 17/10/2026 saiu um plano com `...,"como":[...]}`
 * seguido de `,{"arquivo":"package.json",...}` até o fim do bloco. O `JSON.parse` recusa o
 * conjunto ("Extra data"), o bloco caía no `Codigo`, e o JSON cru aparecia na conversa com
 * o cabeçalho KODA-VISUAL.
 *
 * Ler o primeiro objeto é o certo aqui, e não um atalho: o bloco declara o que é nas
 * primeiras chaves (`tipo`, `titulo`), e o resto — quando existe — é o modelo emendando
 * uma segunda estrutura que a interface não conhece. Desenhar o que fechou é melhor que
 * mostrar código para quem pediu um desenho; o excedente não some da mensagem, só não
 * vira desenho.
 *
 * O caminho rápido é o `JSON.parse` de sempre. A varredura só roda quando ele falha, e
 * respeita strings e escapes para não se perder numa `}` dentro de um texto.
 */
export function primeiroObjeto(bruto: string): Record<string, unknown> | null {
  const corpo = bruto.trim()
  const aceitar = (valor: unknown): Record<string, unknown> | null =>
    typeof valor === 'object' && valor !== null && !Array.isArray(valor)
      ? (valor as Record<string, unknown>)
      : null

  try {
    return aceitar(JSON.parse(corpo))
  } catch {
    // JSON torto: tenta o primeiro objeto completo, abaixo.
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

/**
 * O tipo, lido do **formato dos dados**, quando o modelo esqueceu de dizer qual é.
 *
 * A ordem vai da assinatura mais específica para a mais genérica, porque várias chaves se
 * repetem entre desenhos (`linhas` é tabela, diff e diagrama; `colunas` é tabela, comparação
 * e diagrama em colunas). Cada linha aqui é uma assinatura que **só** aquele desenho tem.
 */
function deduzirTipo(dados: Record<string, unknown>): string {
  const lista = (chave: string) => (Array.isArray(dados[chave]) ? (dados[chave] as unknown[]) : [])

  if ((dados.pergunta ?? dados.enunciado) != null && lista('opcoes').length) return 'quiz'
  if (lista('cartoes').length) return 'metrica'
  if (lista('fluxos').length) return 'sankey'
  if (lista('ramos').length || dados.centro != null) return 'mapa'
  if (lista('passos').length || lista('etapas').length) return 'passos'
  if (lista('nos').length) return 'mapa-radial'

  const colunas = lista('colunas')
  const linhas = lista('linhas')

  // `colunas` + `linhas` de arrays é tabela; de objetos com `blocos` é diagrama em colunas.
  if (colunas.length && linhas.length && Array.isArray(linhas[0])) return 'tabela'
  if (colunas.length && typeof colunas[0] === 'object' && colunas[0] !== null) {
    const primeira = colunas[0] as Record<string, unknown>
    if (Array.isArray(primeira.blocos ?? primeira.caixas)) return 'diagrama'
    if (Array.isArray(primeira.itens)) return 'comparacao'
  }

  // `linhas` de texto é o desenho de traço; de objeto é diff.
  if (linhas.length && typeof linhas[0] === 'string') return 'diagrama'
  if (linhas.length && typeof linhas[0] === 'object') return 'diffs'

  const itens = lista('itens')
  if (itens.length && typeof itens[0] === 'object' && itens[0] !== null) {
    const primeiro = itens[0] as Record<string, unknown>
    if (primeiro.valores != null || primeiro.especificacoes != null || dados.atributos != null) {
      return 'comparacao'
    }
    if (primeiro.filhos != null) return 'arvore'
  }

  const pontos = lista('dados')
  if (pontos.length && typeof pontos[0] === 'object' && pontos[0] !== null) {
    if ('rotulo' in (pontos[0] as Record<string, unknown>)) return 'barras'
  }

  if (dados.texto != null && (dados.tom != null || dados.titulo != null)) return 'citacao'
  return ''
}

export function desenhar(linguagem: string, bruto: string): ReactNode {
  const dados = primeiroObjeto(bruto)
  if (!dados) {
    return <NaoEntendi motivo="o conteúdo não é um JSON válido" bruto={bruto} />
  }

  const daCerca = linguagem.replace(/^koda-/, '').toLowerCase()
  const declarado = texto(dados.tipo ?? dados.type).toLowerCase()

  // **A cerca genérica não diz o desenho — os dados dizem.**
  //
  // `koda-visual` é a cerca de tudo que não tem cerca própria; quem escolhe o desenho é o
  // `tipo` dentro do JSON. Quando o modelo esquece esse campo, o código usava o nome da
  // cerca — e `visual` não existe no switch, então a resposta morria num cartão amarelo
  // «não conheço o tipo "visual"» com o JSON cru embaixo. Aconteceu com o quiz (16/10/2026)
  // e voltou em 20/10/2026 com métrica e tabela, em modelos diferentes: **o dado estava
  // certo, faltava o rótulo**. Agora o formato do próprio dado resolve (`deduzirTipo`), e
  // o cartão amarelo fica só para o que não tem forma reconhecível.
  const tipo =
    declarado === 'pergunta'
      ? 'quiz'
      : declarado || (daCerca === 'visual' ? deduzirTipo(dados) : daCerca)

  return <Desenho tipo={tipo || daCerca} dados={dados} bruto={bruto} />
}

/**
 * O componente que escolhe o desenho.
 *
 * É um componente, e não um `switch` dentro de `desenhar`, por causa das **regras dos
 * hooks**: cada gráfico chama `useInteracao()` para ter o próprio balão, e chamar isso
 * dentro de um `switch` faria a contagem de hooks mudar entre renderizações — o React
 * recusa, e com razão. Como componente, o hook de cada desenho nasce e morre com ele.
 */
function Desenho({
  tipo,
  dados,
  bruto,
}: {
  tipo: string
  dados: Record<string, unknown>
  bruto: string
}) {
  const titulo = texto(dados.titulo ?? dados.title)
  const legenda = texto(dados.legenda ?? dados.caption ?? dados.descricao) || undefined
  const lista = pontos(dados.dados ?? dados.data ?? dados.valores ?? dados.items ?? dados.series)

  /** A moldura em volta do desenho. A interação mora dentro de cada gráfico (ver `ComBalao`). */
  const moldura = (conteudo: ReactNode) => (
    <Moldura titulo={titulo} legenda={legenda}>
      {conteudo}
    </Moldura>
  )

  switch (tipo) {
    case 'barras':
    case 'barra':
    case 'grafico':
    case 'bar':
    case 'colunas': {
      if (!lista.length) return <NaoEntendi motivo="não achei valores em `dados`" bruto={bruto} />
      const deitado = dados.horizontal === true || dados.orientacao === 'horizontal'
      return moldura(<Barras dados={lista} horizontal={deitado} />)
    }

    case 'empilhadas':
    case 'empilhado':
    case 'stacked': {
      if (!lista.length) return <NaoEntendi motivo="não achei valores em `dados`" bruto={bruto} />
      const cru = dados.series ?? dados.legendas ?? dados.categorias
      const series = Array.isArray(cru) ? cru.map((s) => texto(s)) : ['Série 1', 'Série 2']
      return moldura(<Empilhadas dados={lista} series={series} />)
    }

    case 'linhas':
    case 'linha':
    case 'line':
    case 'area':
    case 'área': {
      if (!lista.length) return <NaoEntendi motivo="não achei valores em `dados`" bruto={bruto} />
      const comArea = tipo === 'area' || tipo === 'área'
      return moldura(<Linhas dados={lista} area={comArea} />)
    }

    case 'pizza':
    case 'rosca':
    case 'pie':
    case 'donut': {
      if (!lista.length) return <NaoEntendi motivo="não achei valores em `dados`" bruto={bruto} />
      return moldura(<Pizza dados={lista} rosca={tipo === 'rosca' || tipo === 'donut'} />)
    }

    case 'dispersao':
    case 'dispersão':
    case 'scatter':
    case 'pontos': {
      if (!lista.length) return <NaoEntendi motivo="não achei valores em `dados`" bruto={bruto} />
      return moldura(<Dispersao dados={lista} />)
    }

    case 'bolha':
    case 'bolhas':
    case 'bubble': {
      if (!lista.length) return <NaoEntendi motivo="não achei valores em `dados`" bruto={bruto} />
      return moldura(<Dispersao dados={lista} bolha />)
    }

    case 'radar':
    case 'teia':
    case 'aranha': {
      if (lista.length < 3) {
        return <NaoEntendi motivo="um radar precisa de pelo menos 3 eixos" bruto={bruto} />
      }
      return moldura(<Radar dados={lista} />)
    }

    case 'timeline':
    case 'linha-do-tempo':
    case 'cronologia': {
      if (!lista.length) return <NaoEntendi motivo="não achei valores em `dados`" bruto={bruto} />
      return moldura(<Timeline dados={lista} />)
    }

    case 'sankey':
    case 'fluxo-de-valor':
    case 'rios': {
      const fluxos = elos(dados.fluxos ?? dados.dados ?? dados.elos ?? dados.links)
      if (!fluxos.length) {
        return (
          <NaoEntendi
            motivo="um Sankey precisa de `fluxos` com `de`, `para` e `valor`"
            bruto={bruto}
          />
        )
      }
      return moldura(<Sankey fluxos={fluxos} />)
    }

    case 'tabela':
    case 'table': {
      const colunas = Array.isArray(dados.colunas) ? dados.colunas.map((c) => texto(c)) : lista.length ? ['Rótulo', 'Valor'] : []
      const linhas = Array.isArray(dados.linhas)
        ? dados.linhas.map((l) => (Array.isArray(l) ? l.map((c) => texto(c)) : [texto(l)]))
        : lista.map((p) => [p.rotulo, p.valor.toLocaleString('pt-BR')])
      if (!colunas.length || !linhas.length) {
        return <NaoEntendi motivo="a tabela precisa de `colunas` e `linhas`" bruto={bruto} />
      }
      return moldura(<Tabela colunas={colunas} linhas={linhas} />)
    }

    case 'mapa':
    case 'mapa-mental':
    case 'mental':
    case 'mindmap':
    case 'hierarquia': {
      const centro = texto(dados.centro ?? dados.raiz ?? dados.titulo ?? dados.tema)
      const galhos = ramos(dados.ramos ?? dados.galhos ?? dados.itens ?? dados.children)
      if (!centro && !galhos.length) {
        return <NaoEntendi motivo="um mapa mental precisa de `centro` ou `ramos`" bruto={bruto} />
      }
      return moldura(<MapaMental raiz={{ texto: centro || titulo }} lista={galhos} />)
    }

    case 'passos':
    case 'fluxo':
    case 'etapas':
    case 'tutorial':
    case 'steps': {
      const cru = dados.passos ?? dados.etapas ?? dados.itens ?? dados.dados
      const passos: Passo[] = Array.isArray(cru)
        ? cru
            .map((item, i) => {
              if (typeof item === 'string') return { titulo: item }
              if (typeof item === 'object' && item !== null) {
                const o = item as Record<string, unknown>
                return {
                  titulo: texto(o.titulo ?? o.label ?? o.nome, `${i + 1}`),
                  texto: texto(o.texto ?? o.descricao ?? o.detalhe ?? o.explicacao) || undefined,
                }
              }
              return null
            })
            .filter((p): p is Passo => p !== null)
        : []
      if (!passos.length) return <NaoEntendi motivo="não achei `passos`" bruto={bruto} />
      return moldura(<Fluxo passos={passos} />)
    }

    case 'comparacao':
    case 'comparar':
    case 'comparativo':
    case 'versus': {
      const cru = dados.itens ?? dados.produtos ?? dados.opcoes ?? dados.colunas ?? dados.dados
      // Ficha de produto vem primeiro: é o formato que a IA usa quando a pergunta é "qual
      // desses eu levo". Sem atributo nenhum (só marcadores por coluna), cai nas listas.
      const itens = itensComparados(cru)
      const atributos = atributosDe(dados.atributos ?? dados.campos ?? dados.linhas, itens)
      if (itens.length && atributos.length) {
        const destaques = destaquesDe(
          dados.destaques ?? dados.melhores ?? dados.vencedores,
          itens,
        )
        return moldura(
          <TabelaComparativa itens={itens} atributos={atributos} destaques={destaques} />,
        )
      }
      const colunas = Array.isArray(cru)
        ? cru
            .map((item) => {
              if (typeof item !== 'object' || item === null) return null
              const o = item as Record<string, unknown>
              const dentro = o.itens ?? o.contents ?? o.lista
              const lista = Array.isArray(dentro) ? dentro.map((x) => texto(x)) : []
              return { titulo: texto(o.titulo ?? o.label ?? o.nome), itens: lista }
            })
            .filter((c): c is { titulo: string; itens: string[] } => c !== null)
        : []
      if (!colunas.length) return <NaoEntendi motivo="não achei `itens` nem `colunas`" bruto={bruto} />
      return moldura(<Comparacao colunas={colunas} />)
    }

    case 'diagrama':
    case 'ascii':
    case 'fluxograma': {
      // Arquitetura/camadas/fluxo/matriz: o modelo mandou a estrutura, o desenho é do Koda.
      const estruturado = <DiagramaEstruturado dados={dados} />
      if (estruturado) return moldura(estruturado)
      const cru = dados.linhas ?? dados.texto ?? dados.diagrama ?? dados.ascii
      const linhas = Array.isArray(cru) ? cru.map((item) => texto(item)) : texto(cru).split('\n')
      if (!linhas.some((linha) => linha.trim())) {
        return (
          <NaoEntendi
            motivo="o diagrama precisa de `linhas`, `colunas`, `camadas`, `fluxo` ou `quadrantes`"
            bruto={bruto}
          />
        )
      }
      return moldura(<Diagrama linhas={linhas} />)
    }

    case 'diffs':
    case 'diff':
    case 'diferenca': {
      const linhas = linhasDiff(dados.linhas ?? dados.mudancas ?? dados.diff ?? dados.dados)
      if (!linhas.length) return <NaoEntendi motivo="não achei `linhas`" bruto={bruto} />
      const arquivo = texto(dados.arquivo ?? dados.file) || undefined
      return moldura(<Diffs arquivo={arquivo} linhas={linhas} />)
    }

    case 'arvore':
    case 'arquivos':
    case 'pastas':
    case 'tree': {
      const lista = nos(dados.itens ?? dados.arvore ?? dados.dados ?? dados.children)
      if (!lista.length) return <NaoEntendi motivo="não achei `itens`" bruto={bruto} />
      return moldura(<Arvore lista={lista} />)
    }

    case 'metrica':
    case 'metricas':
    case 'kpi':
    case 'numeros': {
      const lista = cartoes(dados.cartoes ?? dados.itens ?? dados.dados)
      if (!lista.length) return <NaoEntendi motivo="não achei `cartoes`" bruto={bruto} />
      return moldura(<Metrica lista={lista} />)
    }

    case 'citacao':
    case 'alerta':
    case 'aviso':
    case 'callout': {
      const t = texto(dados.tom ?? dados.nivel ?? dados.classe ?? dados.kind).toLowerCase()
      const tomDoAviso = TONS_DE_AVISO[t] ? t : 'info'
      const tit = texto(dados.titulo ?? dados.title) || undefined
      const corpo = texto(dados.texto ?? dados.mensagem ?? dados.descricao ?? dados.content)
      if (!corpo && !tit) return <NaoEntendi motivo="o aviso precisa de `texto`" bruto={bruto} />
      return moldura(<Citacao tomDoAviso={tomDoAviso} titulo={tit} corpo={corpo} />)
    }

    case 'quiz':
    case 'pergunta': {
      const cru = dados.opcoes ?? dados.alternativas
      const opcoes = Array.isArray(cru)
        ? cru
            .map((item) => {
              if (typeof item === 'string') return item
              if (typeof item === 'object' && item !== null) {
                const o = item as Record<string, unknown>
                return texto(o.texto ?? o.opcao ?? o.label) || null
              }
              return null
            })
            .filter((o): o is string => o !== null && o !== '')
        : []
      if (opcoes.length < 2) {
        return <NaoEntendi motivo="um quiz precisa de pelo menos 2 `opcoes`" bruto={bruto} />
      }
      const pergunta = texto(dados.pergunta ?? dados.enunciado) || titulo
      if (!pergunta) return <NaoEntendi motivo="falta a `pergunta`" bruto={bruto} />
      const corretaCru = dados.correta ?? dados.resposta
      let correta: number | undefined
      if (typeof corretaCru === 'number' && Number.isFinite(corretaCru)) correta = corretaCru
      else if (typeof corretaCru === 'string' && /^\d+$/.test(corretaCru.trim())) {
        correta = Number(corretaCru.trim())
      }
      return moldura(
        <Quiz
          pergunta={pergunta}
          opcoes={opcoes}
          correta={correta}
          explicacao={texto(dados.explicacao) || undefined}
        />,
      )
    }

    case 'mapa-radial':
    case 'constelacao':
    case 'radial': {
      const lista = nosRadiais(dados.nos ?? dados.itens ?? dados.dados)
      if (!lista.length) return <NaoEntendi motivo="o mapa radial precisa de `nos`" bruto={bruto} />
      const centro = texto(dados.centro ?? dados.raiz) || titulo
      if (!centro) return <NaoEntendi motivo="falta o `centro`" bruto={bruto} />
      return moldura(
        <MapaRadial
          centro={centro}
          centroSub={texto(dados.centro_sub ?? dados.centro_subtitulo) || undefined}
          lista={lista}
        />,
      )
    }

    case 'plano':
    case 'plan':
    case 'planejamento': {
      const como = etapasDoPlano(dados.como ?? dados.passos ?? dados.etapas)
      const mudancas = mudancasDoPlano(dados.mudancas ?? dados.mudancas_principais ?? dados.alteracoes)
      const deQue = texto(dados.o_que_e ?? dados.o_que ?? dados.definicao) || undefined
      const praQue = texto(dados.pra_que ?? dados.para_que ?? dados.objetivo) || undefined
      const porQue = texto(dados.por_que ?? dados.porque ?? dados.motivo) || undefined
      const resultado = texto(dados.resultado ?? dados.resultado_esperado ?? dados.entrega) || undefined
      if (!deQue && !praQue && !porQue && !como.length && !mudancas.length && !resultado) {
        return (
          <NaoEntendi
            motivo="o plano precisa de pelo menos uma parte (o_que_e, pra_que, por_que, como, mudancas, resultado)"
            bruto={bruto}
          />
        )
      }
      return (
        <Plano
          planId={texto(dados.plan_id) || undefined}
          titulo={titulo}
          deQue={deQue}
          praQue={praQue}
          porQue={porQue}
          como={como}
          mudancas={mudancas}
          resultado={resultado}
        />
      )
    }

    default:
      return (
        <NaoEntendi
          motivo={
            tipo
              ? `não conheço o tipo "${tipo}". Disponíveis: barras, empilhadas, linhas, area, pizza, rosca, dispersao, bolha, radar, timeline, sankey, tabela, mapa, mapa-radial, passos, comparacao, diffs, arvore, metrica, citacao, quiz, plano`
              : 'falta o campo `tipo`'
          }
          bruto={bruto}
        />
      )
  }
}

/**
 * As etiquetas de bloco que viram desenho em vez de código cru.
 *
 * `koda-plano` entra aqui porque é **o nome que o backend pede**: o portão do modo Plan
 * manda o modelo apresentar o plano num bloco ```koda-plano``` (`EXIGIR_BLOCO_PLANO` em
 * `agent/loop.py`). Fora desta lista o cartão não era desenhado — o JSON do plano aparecia
 * cru na conversa, com o cabeçalho "KODA-PLANO" e as chaves à mostra (visto em 17/10/2026).
 * O tipo sai do próprio nome (`koda-plano` → `plano`), então não precisa de campo `tipo`.
 */
export const LINGUAGENS = [
  'koda-grafico',
  'koda-mapa',
  'koda-passos',
  'koda-comparacao',
  'koda-diagrama',
  'koda-visual',
  'koda-plano',
] as const

export function ehBlocoVisual(linguagem: string): boolean {
  return (LINGUAGENS as readonly string[]).includes(linguagem)
}

export default desenhar
