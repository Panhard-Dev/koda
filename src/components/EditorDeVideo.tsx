import { useEffect, useRef, useState } from 'react'
import { Pause, Play, Upload, Loader2 } from 'lucide-react'
import { blobDoVideo, apiUrl, cabecalhoDeAcesso, prepararAcesso } from '../api/client'
import { SeletorDeVideo } from './SeletorDeVideo'

/**
 * Editor de vídeo — a área que o botão da câmera abre.
 *
 * Quatro áreas, como o dono pediu: a **prévia** (o vídeo tocando de verdade, num
 * `<video>` comum), a **timeline de frames** (miniaturas geradas do próprio arquivo),
 * a **trilha de áudio** (onda desenhada do áudio decodificado) e a coluna da
 * **transcrição**.
 *
 * ## O que é real
 *
 * Tudo aqui funciona de verdade, sem fingir: abrir arquivo (pelo seletor do Koda ou
 * arrastar), tocar/pausar, tempo atual, scrubbable (clicar na trilha pula o vídeo),
 * frames (o `<video>` busca cada timestamp e o `<canvas>` fotografa o quadro) e
 * waveform (`decodeAudioData` do próprio arquivo).
 *
 * A **transcrição** também é real: o front exporta um WAV 16k mono do mesmo decode da
 * onda e o backend roda o Whisper local (`faster-whisper`, modelo `base`, `int8`) com
 * os timestamps de cada fala. Em CPU leva minutos — o vídeo toca enquanto isso.
 */

/** Quantas miniaturas a timeline de frames mostra. */
const QUADROS = 12
/** Tamanho de cada miniatura gerada (a tela escala pelo CSS). */
const LARGURA_QUADRO = 160
const ALTURA_QUADRO = 90
/** Baldes do waveform desenhado. */
const BALDES = 480

/** Um trecho de fala reconhecido: o que foi dito, e entre quais segundos. */
type Segmento = { inicio: number; fim: number; texto: string }

function formatarTempo(segundos: number): string {
  if (!Number.isFinite(segundos) || segundos < 0) return '0:00'
  const m = Math.floor(segundos / 60)
  const s = Math.floor(segundos % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** A onda: um `<canvas>` com o pico de cada balde, espelhado no meio. */
function OndaSonora({ picos }: { picos: number[] }) {
  const tela = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const el = tela.current
    const pincel = el?.getContext('2d')
    if (!el || !pincel) return
    const { width, height } = el
    pincel.clearRect(0, 0, width, height)
    pincel.fillStyle = 'rgba(214, 214, 228, 0.5)'
    const meio = height / 2
    const largura = width / picos.length
    picos.forEach((pico, i) => {
      const altura = Math.max(1, pico * meio)
      pincel.fillRect(i * largura, meio - altura, Math.max(1, largura - 0.4), altura * 2)
    })
  }, [picos])

  return (
    <canvas
      ref={tela}
      width={960}
      height={56}
      className="h-full w-full rounded-md bg-koda-fg/5"
    />
  )
}

/**
 * Reamostra para 16 kHz mono pelo **motor do Web Audio** (`OfflineAudioContext`): o
 * resampler do motor é um FIR de qualidade. Havia aqui uma reamostragem linear
 * (interpolar amostra a amostra) e ela era culpada: o conteúdo acima de 8 kHz espalha
 * alias por toda a banda da fala, e o transcritor culpa as palavras erradas.
 */
async function reamostrar16k(buffer: AudioBuffer): Promise<AudioBuffer> {
  if (buffer.sampleRate === 16000 && buffer.numberOfChannels === 1) return buffer
  const linhas = Math.max(1, Math.ceil(buffer.duration * 16000))
  const contexto = new OfflineAudioContext(1, linhas, 16000)
  const mono = contexto.createBuffer(1, buffer.length, buffer.sampleRate)
  mono.copyToChannel(buffer.getChannelData(0), 0)
  const fonte = contexto.createBufferSource()
  fonte.buffer = mono
  fonte.connect(contexto.destination)
  fonte.start()
  return contexto.startRendering()
}

/**
 * Escreve o WAV: PCM 16 bits mono de um buffer **já** a 16 kHz. O header é feito à
 * mão pelo mesmo motivo de não puxar biblioteca: são 44 bytes.
 */
function wavMono16k(buffer: AudioBuffer): Blob {
  const taxa = 16000
  const amostras = buffer.getChannelData(0)
  const dados = new Int16Array(amostras.length)
  for (let i = 0; i < amostras.length; i += 1) {
    dados[i] = Math.max(-1, Math.min(1, amostras[i])) * 0x7fff
  }
  const cabecalho = new ArrayBuffer(44)
  const vista = new DataView(cabecalho)
  const texto = (offset: number, valor: string) => {
    for (let i = 0; i < valor.length; i += 1) vista.setUint8(offset + i, valor.charCodeAt(i))
  }
  texto(0, 'RIFF')
  vista.setUint32(4, 36 + dados.byteLength, true)
  texto(8, 'WAVE')
  texto(12, 'fmt ')
  vista.setUint32(16, 16, true)
  vista.setUint16(20, 1, true)
  vista.setUint16(22, 1, true)
  vista.setUint32(24, taxa, true)
  vista.setUint32(28, taxa * 2, true)
  vista.setUint16(32, 2, true)
  vista.setUint16(34, 16, true)
  texto(36, 'data')
  vista.setUint32(40, dados.byteLength, true)
  return new Blob([cabecalho, dados.buffer], { type: 'audio/wav' })
}

export function EditorDeVideo({ aberto }: { aberto: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const urlRef = useRef('')

  const [url, setUrl] = useState('')
  const [nome, setNome] = useState('')
  const [duracao, setDuracao] = useState(0)
  const [atual, setAtual] = useState(0)
  const [tocando, setTocando] = useState(false)
  const [quadros, setQuadros] = useState<string[]>([])
  const [gerandoQuadros, setGerandoQuadros] = useState(false)
  const [picos, setPicos] = useState<number[] | null>(null)
  const [audioEstado, setAudioEstado] = useState<'vazio' | 'gerando' | 'pronto' | 'falhou'>('vazio')
  const [arrastando, setArrastando] = useState(false)
  const [seletorAberto, setSeletorAberto] = useState(false)
  const [segmentos, setSegmentos] = useState<Segmento[]>([])
  const [transcricao, setTranscricao] = useState<'vazio' | 'gerando' | 'pronto' | 'falhou'>('vazio')

  // A URL de objeto vive até sair da tela: sem este cleanup, cada vídeo aberto vaza.
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    },
    [],
  )

  // Fechar a barra **pausa** o vídeo — e só isso. A barra não desmonta mais o editor
  // (ver `BarraLateralCamera`), então reabrir devolve o vídeo do mesmo segundo, com
  // frames, onda e transcrição intactos.
  useEffect(() => {
    if (!aberto) videoRef.current?.pause()
  }, [aberto])

  const carregar = (arquivo: File) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    const novo = URL.createObjectURL(arquivo)
    urlRef.current = novo
    setNome(arquivo.name)
    setAtual(0)
    setDuracao(0)
    setQuadros([])
    setPicos(null)
    setAudioEstado('vazio')
    setUrl(novo)
  }

  /**
   * Escolhido no seletor: os bytes vêm do backend como `blob:` — a mesma URL de objeto
   * do arrastar-e-soltar, então frames e waveform funcionam igual. Sem o `blob:` o
   * `<video>` toca, mas o `<canvas>` dos frames quebraria (origem cruzada).
   */
  const carregarDoCaminho = async (caminho: string) => {
    setSeletorAberto(false)
    try {
      const blob = await blobDoVideo(caminho)
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      const novo = URL.createObjectURL(blob)
      urlRef.current = novo
      setNome(caminho.split(/[\\/]/).pop() ?? caminho)
      setAtual(0)
      setDuracao(0)
      setQuadros([])
      setPicos(null)
      setAudioEstado('vazio')
      setUrl(novo)
    } catch {
      // Backend fora do ar ou arquivo fora do lugar: a área segue como estava.
    }
  }

  // Os frames: um `<video>` irmão busca cada timestamp e o `<canvas>` fotografa o
  // quadro. O de verdade continua livre para tocar.
  useEffect(() => {
    if (!url) return
    let vivo = true
    const el = document.createElement('video')
    el.src = url
    el.muted = true
    el.preload = 'auto'

    void (async () => {
      try {
        await new Promise<void>((pronta, falha) => {
          el.onloadedmetadata = () => pronta()
          el.onerror = () => falha(new Error('metadados'))
        })
        if (!vivo) return
        setDuracao(el.duration)
        if (!Number.isFinite(el.duration) || el.duration <= 0) return

        setGerandoQuadros(true)
        const tela = document.createElement('canvas')
        tela.width = LARGURA_QUADRO
        tela.height = ALTURA_QUADRO
        const pincel = tela.getContext('2d')
        const novos: string[] = []
        for (let i = 0; i < QUADROS; i += 1) {
          const t = Math.min(((i + 0.5) * el.duration) / QUADROS, el.duration - 0.05)
          await new Promise<void>((pronta) => {
            el.onseeked = () => pronta()
            el.currentTime = t
          })
          if (!vivo) return
          pincel?.drawImage(el, 0, 0, tela.width, tela.height)
          novos.push(tela.toDataURL('image/jpeg', 0.62))
        }
        if (vivo) setQuadros(novos)
      } catch {
        // Vídeo que o navegador não lê: a área segue vazia, sem fingir.
      } finally {
        if (vivo) setGerandoQuadros(false)
      }
    })()

    return () => {
      vivo = false
      el.src = ''
    }
  }, [url])

  /**
   * Onda e transcrição nascem do **mesmo** decode. A onda reduz o áudio a picos por
   * balde; a transcrição reexporta um WAV 16k mono (o que o Whisper quer) e manda para
   * o backend. Decodificar duas vezes um arquivo grande seria pagar o preço dele duas
   * vezes — e o preço não é pequeno.
   *
   * As duas metades são independentes de propósito: backend fora do ar derruba a
   * transcrição, não a onda — que é local e já terminou antes.
   */
  useEffect(() => {
    if (!url) {
      setAudioEstado('vazio')
      setTranscricao('vazio')
      setSegmentos([])
      return
    }
    let vivo = true
    void (async () => {
      setAudioEstado('gerando')
      setTranscricao('gerando')

      let decodificado: AudioBuffer
      try {
        const bruto = await (await fetch(url)).arrayBuffer()
        const contexto = new AudioContext()
        decodificado = await contexto.decodeAudioData(bruto)
        void contexto.close()
      } catch {
        if (vivo) {
          setAudioEstado('falhou')
          setTranscricao('falhou')
        }
        return
      }
      if (!vivo) return

      // A onda: local, rápida, não depende de ninguém.
      try {
        const canal = decodificado.getChannelData(0)
        const passo = Math.max(1, Math.floor(canal.length / BALDES))
        const novos: number[] = []
        for (let i = 0; i < BALDES; i += 1) {
          let pico = 0
          const inicio = i * passo
          // Amostra a cada 16: a onda não precisa de cada amostra, e o laço inteiro
          // num arquivo longo custaria caro.
          for (let j = 0; j < passo; j += 16) {
            const v = Math.abs(canal[inicio + j] ?? 0)
            if (v > pico) pico = v
          }
          novos.push(pico)
        }
        if (vivo) {
          setPicos(novos)
          setAudioEstado('pronto')
        }
      } catch {
        if (vivo) setAudioEstado('falhou')
      }

      // A transcrição: minutos de CPU no backend. O vídeo toca enquanto isso.
      try {
        await prepararAcesso()
        const resposta = await fetch(`${apiUrl}/api/fs/transcricao`, {
          method: 'POST',
          headers: { ...cabecalhoDeAcesso(), 'content-type': 'audio/wav' },
          body: wavMono16k(await reamostrar16k(decodificado)),
        })
        if (!resposta.ok) throw new Error(`transcrição recusou (${resposta.status})`)
        const dados = (await resposta.json()) as { segmentos: Segmento[] }
        if (vivo) {
          setSegmentos(dados.segmentos)
          setTranscricao('pronto')
        }
      } catch {
        if (vivo) setTranscricao('falhou')
      }
    })()
    return () => {
      vivo = false
    }
  }, [url])

  const alternar = () => {
    const el = videoRef.current
    if (!el) return
    if (el.paused) void el.play()
    else el.pause()
  }

  /** Clicar num trecho da transcrição pula o vídeo para o segundo em que ele começa. */
  const pularPara = (segundos: number) => {
    const el = videoRef.current
    if (el) el.currentTime = segundos
    setAtual(segundos)
  }

  /** Clicar na trilha do áudio pula o vídeo para aquele ponto. */
  const irPara = (evento: React.MouseEvent<HTMLDivElement>) => {
    const el = videoRef.current
    if (!el || !duracao) return
    const caixa = evento.currentTarget.getBoundingClientRect()
    const fracao = Math.min(Math.max((evento.clientX - caixa.left) / caixa.width, 0), 1)
    el.currentTime = fracao * duracao
    setAtual(el.currentTime)
  }

  const fracao = duracao > 0 ? Math.min(atual / duracao, 1) : 0

  return (
    <>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_17rem] grid-rows-[minmax(0,1fr)_auto_auto_auto]">
      {/* Prévia — o vídeo de verdade */}
      <div
        className={[
          'relative flex min-h-0 items-center justify-center bg-black/40 transition-shadow',
          arrastando ? 'ring-2 ring-koda-accent ring-inset' : '',
        ].join(' ')}
        onDragOver={(evento) => {
          evento.preventDefault()
          setArrastando(true)
        }}
        onDragLeave={() => setArrastando(false)}
        onDrop={(evento) => {
          evento.preventDefault()
          setArrastando(false)
          const arquivo = evento.dataTransfer.files?.[0]
          if (arquivo) carregar(arquivo)
        }}
      >
        {url ? (
          <video
            ref={videoRef}
            src={url}
            className="max-h-full max-w-full"
            onClick={alternar}
            onTimeUpdate={(evento) => setAtual(evento.currentTarget.currentTime)}
            onPlay={() => setTocando(true)}
            onPause={() => setTocando(false)}
          />
        ) : (
          <div className="px-6 text-center">
            <Upload className="mx-auto h-7 w-7 text-koda-fg/40" strokeWidth={1.7} />
            <p className="mt-2 text-[12.5px] text-koda-fg/55">Arraste um vídeo aqui</p>
            <p className="mt-1 text-[11.5px] text-koda-fg/35">
              ou use “Abrir vídeo” abaixo — MP4, WebM, MOV, o que o navegador tocar
            </p>
          </div>
        )}
      </div>

      {/* Transcrição — a coluna da direita */}
      <aside className="row-span-4 flex min-h-0 flex-col border-l border-koda-fg/10">
        <div className="shrink-0 border-b border-koda-fg/10 px-3 py-2">
          <span className="text-[11px] font-medium tracking-wide text-koda-fg/55 uppercase">
            Transcrição
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {transcricao === 'pronto' && segmentos.length > 0 ? (
            <ul className="space-y-1">
              {segmentos.map((seg, i) => (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => pularPara(seg.inicio)}
                    className="w-full rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-koda-fg/6 focus-visible:outline-none"
                  >
                    <span className="block font-mono text-[11px] text-koda-accent">
                      {Math.round(seg.inicio)}s - {Math.round(seg.fim)}s
                    </span>
                    <span className="mt-0.5 block text-[12.5px] leading-relaxed text-koda-fg/85">
                      {seg.texto}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : transcricao === 'gerando' ? (
            <div className="flex flex-col items-center gap-2.5 py-10 text-center">
              <Loader2 className="h-6 w-6 animate-spin text-koda-accent" strokeWidth={1.8} />
              <p className="text-[12.5px] text-koda-fg/55">Transcrevendo a fala…</p>
              <p className="max-w-[15rem] text-[11.5px] leading-relaxed text-koda-fg/35">
                Em CPU isso leva alguns minutos. O vídeo toca enquanto isso — as linhas
                aparecem aqui quando terminar.
              </p>
            </div>
          ) : (
            <p className="text-[12.5px] leading-relaxed text-koda-fg/40">
              {transcricao === 'falhou'
                ? 'Não consegui transcrever este áudio. O vídeo, os frames e a onda continuam funcionando normalmente.'
                : nome
                  ? 'A transcrição começa sozinha quando o vídeo carrega.'
                  : 'Nenhum vídeo carregado. A transcrição do que é falado aparece aqui, linha por linha, quando você abrir um vídeo com fala.'}
            </p>
          )}
        </div>
      </aside>

      {/* Transporte */}
      <div className="col-start-1 flex shrink-0 items-center gap-3 border-t border-koda-fg/10 px-3 py-2">
        <button
          type="button"
          aria-label={tocando ? 'Pausar' : 'Tocar'}
          title={tocando ? 'Pausar' : 'Tocar'}
          disabled={!url}
          onClick={alternar}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-koda-fg/85 transition-colors duration-150 hover:bg-koda-fg/10 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none disabled:pointer-events-none disabled:opacity-35"
        >
          {tocando ? (
            <Pause className="h-4 w-4" strokeWidth={1.8} />
          ) : (
            <Play className="h-4 w-4" strokeWidth={1.8} />
          )}
        </button>
        <span className="shrink-0 font-mono text-[12px] text-koda-fg/70">
          {formatarTempo(atual)} / {formatarTempo(duracao)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-koda-fg/35">
          {nome || 'sem arquivo'}
        </span>
        <button
          type="button"
          aria-label="Abrir vídeo"
          title="Abrir vídeo"
          onClick={() => setSeletorAberto(true)}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-xl px-2.5 text-[12px] text-koda-fg/85 transition-colors duration-150 hover:bg-koda-fg/10 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
        >
          <Upload className="h-3.5 w-3.5" strokeWidth={1.7} />
          Abrir vídeo
        </button>
      </div>

      {/* Timeline de frames */}
      <div className="col-start-1 shrink-0 border-t border-koda-fg/10 px-3 py-2">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-medium tracking-wide text-koda-fg/55 uppercase">
            Frames
          </span>
          {gerandoQuadros ? (
            <span className="text-[11px] text-koda-fg/35">gerando as miniaturas…</span>
          ) : null}
        </div>
        <div className="relative h-12 overflow-hidden rounded-md bg-koda-fg/5">
          {quadros.length ? (
            <div className="flex h-full gap-0.5">
              {quadros.map((quadro, i) => (
                <img
                  key={i}
                  src={quadro}
                  alt={`Frame ${i + 1}`}
                  className="h-full min-w-0 flex-1 rounded-sm object-cover"
                />
              ))}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center border border-dashed border-koda-fg/10 text-[11.5px] text-koda-fg/35">
              {gerandoQuadros ? '…' : 'as miniaturas dos frames aparecem aqui'}
            </div>
          )}
          {url ? (
            <div
              className="pointer-events-none absolute top-0 bottom-0 w-px bg-koda-accent"
              style={{ left: `${fracao * 100}%` }}
            />
          ) : null}
        </div>
      </div>

      {/* Trilha de áudio */}
      <div className="col-start-1 shrink-0 border-t border-koda-fg/10 px-3 py-2">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-medium tracking-wide text-koda-fg/55 uppercase">
            Áudio
          </span>
        </div>
        <div
          className="relative h-14 cursor-pointer"
          onClick={irPara}
          role="presentation"
        >
          {audioEstado === 'pronto' && picos ? (
            <OndaSonora picos={picos} />
          ) : (
            <div className="flex h-full items-center justify-center rounded-md bg-koda-fg/5 text-[11.5px] text-koda-fg/35">
              {audioEstado === 'gerando'
                ? 'lendo o áudio…'
                : audioEstado === 'falhou'
                  ? 'onda não disponível para este arquivo'
                  : 'a onda do áudio aparece aqui'}
            </div>
          )}
          {url ? (
            <div
              className="pointer-events-none absolute top-0 bottom-0 w-px bg-koda-accent"
              style={{ left: `${fracao * 100}%` }}
            />
          ) : null}
        </div>
      </div>
      </div>

      {seletorAberto ? (
        <SeletorDeVideo
          onFechar={() => setSeletorAberto(false)}
          onEscolher={(caminho) => void carregarDoCaminho(caminho)}
        />
      ) : null}
    </>
  )
}

export default EditorDeVideo
