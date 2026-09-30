import { useEffect, useReducer, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import type { Veredicto } from './harnessChat'

/**
 * A bancada: abre uma janela de verdade para cada combinação de largura, altura e escala, e
 * recolhe o que `src/harnessChat.tsx` mediu lá dentro.
 *
 * Por que iframes e não só redimensionar a janela: cada iframe **é** uma viewport. Dentro
 * dele `100vw`, `100vh` e as media queries valem de verdade — é a única maneira de testar a
 * casca do app (`h-[calc(100vh/var(--koda-zoom))] w-[calc(100vw/var(--koda-zoom))]`) em
 * telas que a máquina de quem roda o teste não tem. Também isola cada caso: nenhum estado de
 * um vaza para o outro.
 *
 * A matriz tem os dois eixos que importam: **largura** (de 320, um celular estreito, a 2560)
 * e **escala** (o `--koda-zoom` de 0.9/1/1.15 das Preferências — ele muda a largura útil em
 * CSS pixels, então aperta junto com a largura). A altura entra porque o teto do textarea
 * (192px, ver `Composer`) come a janela numa tela baixa.
 *
 * O caso `regressao` é o **controle**: ele monta a bolha do usuário e a fala do modelo com o
 * desenho de antes do conserto e precisa ser reprovado. Bancada que aprova tudo não é
 * bancada, é enfeite.
 *
 * Duas lições de funcionamento estão gravadas no código, porque as duas já quebraram a
 * bancada em silêncio:
 *
 * 1. **Os quadros ficam à vista.** A primeira versão os escondia fora da tela e o navegador
 *    parava de desenhar iframe que ninguém vê: `requestAnimationFrame` deixava de disparar, a
 *    medição nunca chegava e a bancada ficava pendurada no meio da matriz, sem erro nenhum.
 *    Aqui eles aparecem num painel, reduzidos com `transform: scale()` — que é só visual e
 *    não mexe em `scrollWidth`/`clientWidth`, então a medição continua honesta.
 * 2. **Nenhum caso pode pendurar os outros.** Se um quadro não responde dentro do prazo, ele
 *    é dado como não respondido e a fila anda. Sem isso, um quadro travado congela a matriz
 *    inteira — e uma bancada que não termina é pior do que não ter bancada.
 */

type Caso = { largura: number; altura: number; escala: string }

const LARGURAS = [320, 360, 390, 414, 480, 600, 768, 900, 1024, 1180, 1280, 1440, 1600, 1920, 2560]
const ALTURAS = [820, 520]
const ESCALAS = ['compacto', 'md', 'grande']

const CASOS: Caso[] = []
for (const largura of LARGURAS) {
  for (const altura of ALTURAS) {
    for (const escala of ESCALAS) CASOS.push({ largura, altura, escala })
  }
}

const CENARIOS = ['prompt', 'resposta', 'misto', 'regressao'] as const

/** Quantos quadros ao mesmo tempo: um de cada vez demora, muitos de uma vez engasgam. */
const CONCORRENCIA = 4
/** Largura máxima do quadro no painel — o resto é reduzido por transform. */
const LARGURA_VISUAL = 520
/** Prazo de um quadro. Estourado, ele conta como não respondido e a fila anda. */
const PRAZO_MS = 15000

const chave = (indice: number) => `caso-${indice}`

type Guardado = Record<string, Veredicto[]>

type Estado = {
  emCurso: number[]
  proximo: number
  encerrados: Set<number>
  resultados: Guardado
  iniciadoEm: Record<number, number>
}

/** Um veredicto para o quadro que não respondeu: conta como problema, e não como ausência. */
const naoRespondeu = (): Veredicto[] =>
  CENARIOS.map((cenario) => ({
    cenario,
    largura: 0,
    escala: '',
    documentoRola: false,
    problemas: ['o quadro não respondeu dentro do prazo'],
    rolagensInternas: [],
  }))

function Moldura({ caso, indice }: { caso: Caso; indice: number }) {
  const fator = Math.min(1, LARGURA_VISUAL / caso.largura)
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-koda-fg/40">
        {caso.largura}×{caso.altura} · {caso.escala}
      </span>
      <div
        className="overflow-hidden rounded-lg ring-1 ring-koda-fg/10"
        style={{ width: caso.largura * fator, height: caso.altura * fator }}
      >
        <iframe
          title={chave(indice)}
          src={`/chat.html?escala=${caso.escala}&id=${chave(indice)}`}
          width={caso.largura}
          height={caso.altura}
          style={{ border: 0, transform: `scale(${fator})`, transformOrigin: 'top left' }}
        />
      </div>
    </div>
  )
}

function Bancada() {
  const [, redesenhar] = useReducer((n: number) => n + 1, 0)

  const estado = useRef<Estado>({
    emCurso: CASOS.slice(0, CONCORRENCIA).map((_, indice) => indice),
    proximo: CONCORRENCIA,
    encerrados: new Set<number>(),
    resultados: {},
    iniciadoEm: Object.fromEntries(
      CASOS.slice(0, CONCORRENCIA).map((_, indice) => [indice, Date.now()]),
    ),
  })

  useEffect(() => {
    const atual = estado.current

    /** Tira um caso da fila e põe o próximo — uma vez só, por mais que ele responda. */
    const encerrar = (indice: number, veredictos?: Veredicto[]) => {
      if (atual.encerrados.has(indice)) return
      atual.encerrados.add(indice)
      if (veredictos) atual.resultados[chave(indice)] = veredictos
      atual.emCurso = atual.emCurso.filter((item) => item !== indice)
      if (atual.proximo < CASOS.length) {
        const novo = atual.proximo
        atual.proximo += 1
        atual.iniciadoEm[novo] = Date.now()
        atual.emCurso = [...atual.emCurso, novo]
      }
      redesenhar()
    }

    const receber = (evento: MessageEvent) => {
      const dados = evento.data as { id?: string; veredictos?: Veredicto[] } | null
      if (!dados?.id?.startsWith('caso-') || !Array.isArray(dados.veredictos)) return
      const indice = Number(dados.id.slice('caso-'.length))
      if (Number.isFinite(indice)) encerrar(indice, dados.veredictos)
    }

    // O relógio da bancada: caso pendurado vira caso encerrado, e a matriz termina sempre.
    const relogio = window.setInterval(() => {
      const agora = Date.now()
      for (const indice of [...atual.emCurso]) {
        if (agora - (atual.iniciadoEm[indice] ?? agora) > PRAZO_MS) {
          encerrar(indice, naoRespondeu())
        }
      }
    }, 2000)

    window.addEventListener('message', receber)
    return () => {
      window.clearInterval(relogio)
      window.removeEventListener('message', receber)
    }
  }, [])

  const atual = estado.current
  const resultados = atual.resultados
  const prontos = Object.keys(resultados).length
  const faltando = CASOS.length - prontos

  /**
   * Um caso só passa se nenhum cenário de verdade acusar problema **e** o controle acusar.
   * Se o controle passar, o que falhou foi a medição, e o veredicto inteiro vale zero.
   */
  const avaliar = (veredictos: Veredicto[] | undefined) => {
    if (!veredictos) return { estado: 'esperando' as const, falhas: [] as string[], controle: false }
    const falhas: string[] = []
    let controle = false
    for (const veredicto of veredictos) {
      if (veredicto.cenario === 'regressao') {
        controle = veredicto.problemas.length > 0
        continue
      }
      if (veredicto.problemas.length > 0) {
        falhas.push(`${veredicto.cenario}: ${veredicto.problemas.join('; ')}`)
      }
    }
    return { estado: 'pronto' as const, falhas, controle }
  }

  const avaliados = CASOS.map((_, indice) => avaliar(resultados[chave(indice)]))
  const comResultado = avaliados.filter((item) => item.estado === 'pronto')
  const casosFalhos = comResultado.filter((item) => item.falhas.length > 0).length
  const controleOk = comResultado.filter((item) => item.controle).length
  const inconclusivos = comResultado.filter((item) => !item.controle).length

  useEffect(() => {
    ;(window as unknown as { __bench?: unknown }).__bench = {
      total: CASOS.length,
      prontos,
      casosFalhos,
      controleDetectou: controleOk,
      inconclusivos,
      falhas: CASOS.map((caso, indice) => ({
        caso,
        falhas: avaliados[indice].falhas,
        controle: avaliados[indice].controle,
      })).filter((item) => item.falhas.length > 0),
    }
  })

  return (
    <div className="min-h-screen bg-koda-bg p-6 font-mono text-[12.5px] text-koda-fg">
      <h1 className="mb-1 text-[16px] font-semibold">Koda — bancada de conversa</h1>
      <p className="mb-4 text-koda-fg/50">
        {CASOS.length} janelas ({LARGURAS.length} larguras × {ALTURAS.length} alturas ×{' '}
        {ESCALAS.length} escalas) · {CENARIOS.length} cenários cada ·{' '}
        {faltando === 0 ? 'medição concluída' : `faltam ${faltando}`}
      </p>

      {/*
       * Os quadros em medição, à vista de propósito (ver a nota das duas lições no topo do
       * arquivo): escondidos, o navegador deixa de desenhá-los e a medição nunca volta.
       */}
      <div className="mb-6 flex flex-wrap gap-4 border-b border-koda-fg/10 pb-6">
        {atual.emCurso.map((indice) => {
          const caso = CASOS[indice]
          if (!caso) return null
          return <Moldura key={chave(indice)} caso={caso} indice={indice} />
        })}
      </div>

      <div className="mb-4 flex flex-wrap gap-3">
        <span className="rounded-lg bg-koda-fg/8 px-3 py-1.5">
          casos com problema: <b>{casosFalhos}</b> de {comResultado.length}
        </span>
        <span className="rounded-lg bg-koda-fg/8 px-3 py-1.5">
          controle (bug antigo) detectado: <b>{controleOk}</b> de {comResultado.length}
        </span>
        <span className="rounded-lg bg-koda-fg/8 px-3 py-1.5">
          inconclusivos: <b>{inconclusivos}</b>
        </span>
      </div>

      <table className="border-collapse">
        <thead>
          <tr className="text-left text-koda-fg/45">
            <th className="px-2 py-1">largura × altura × escala</th>
            {CENARIOS.map((cenario) => (
              <th key={cenario} className="px-2 py-1">
                {cenario}
              </th>
            ))}
            <th className="px-2 py-1">problema</th>
          </tr>
        </thead>
        <tbody>
          {CASOS.map((caso, indice) => {
            const { estado, falhas, controle } = avaliados[indice]
            const veredictos = resultados[chave(indice)]
            return (
              <tr key={chave(indice)} className="border-t border-koda-fg/8">
                <td className="px-2 py-1 text-koda-fg/60">
                  {caso.largura}×{caso.altura} · {caso.escala}
                </td>
                {CENARIOS.map((cenario) => {
                  const veredicto = veredictos?.find((item) => item.cenario === cenario)
                  if (!veredicto) {
                    return (
                      <td key={cenario} className="px-2 py-1 text-koda-fg/25">
                        …
                      </td>
                    )
                  }
                  const quantos = veredicto.problemas.length
                  const ehControle = cenario === 'regressao'
                  const rotulo =
                    quantos === 0
                      ? ehControle
                        ? '× (não pegou)'
                        : '✓'
                      : ehControle
                        ? '✓ (pegou)'
                        : `✗ ${quantos}`
                  const classes = [
                    'rounded px-2 py-0.5',
                    ehControle
                      ? quantos > 0
                        ? 'bg-sky-500/15 text-sky-300'
                        : 'bg-amber-500/20 text-amber-300'
                      : quantos === 0
                        ? 'bg-emerald-500/15 text-emerald-300'
                        : 'bg-red-500/20 text-red-300',
                  ].join(' ')
                  return (
                    <td key={cenario} className="px-2 py-1">
                      <span className={classes} title={veredicto.problemas.join('\n')}>
                        {rotulo}
                      </span>
                    </td>
                  )
                })}
                <td className="max-w-[46ch] px-2 py-1 text-red-300/80">
                  {estado === 'pronto' && !controle ? 'controle não pegou o bug antigo' : (falhas[0] ?? '')}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Bancada />)
