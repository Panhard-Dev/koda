import { useEffect, useRef, useState } from 'react'
import { Check, Clock, Coins, Copy, RotateCcw, ThumbsDown, ThumbsUp } from 'lucide-react'
import type { ReactNode } from 'react'
import { formatarDuracao } from '../duracao'

/** Tokens em número curto: `870`, `9,2K`, `1,4M` (a ficha não é lugar de número comprido). */
const formatarTokens = (tokens: number): string => {
  if (tokens < 1000) return `${tokens}`
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1).replace('.', ',')}K`
  return `${(tokens / 1_000_000).toFixed(1).replace('.', ',')}M`
}

const formatarHora = (ms: number): string =>
  new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

/**
 * Põe o texto na área de transferência — e diz se deu.
 *
 * A API moderna é a primeira escolha, mas ela depende de a janela estar em foco e da
 * permissão de clipboard: no webview do app ela recusa calada em alguns casos. O caminho
 * antigo (campo temporário + `execCommand`) funciona no clique do usuário mesmo assim — e
 * o que importa é que copiar copie, não qual API fez o serviço.
 */
async function copiarTexto(conteudo: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(conteudo)
    return true
  } catch {
    // Cai no caminho antigo.
  }

  try {
    const campo = document.createElement('textarea')
    campo.value = conteudo
    campo.setAttribute('readonly', '')
    campo.style.position = 'fixed'
    campo.style.top = '-1000px'
    campo.style.opacity = '0'
    document.body.appendChild(campo)
    campo.select()
    const deu = document.execCommand('copy')
    document.body.removeChild(campo)
    return deu
  } catch {
    return false
  }
}

/** Um botão da ficha: discreto até o hover, aceso quando está valendo. */
function Botao({
  titulo,
  ativo = false,
  desabilitado = false,
  pressionado,
  onClick,
  children,
}: {
  titulo: string
  ativo?: boolean
  desabilitado?: boolean
  pressionado?: boolean
  onClick?: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={titulo}
      aria-label={titulo}
      {...(pressionado === undefined ? {} : { 'aria-pressed': pressionado })}
      disabled={desabilitado}
      onClick={onClick}
      className={[
        'flex h-6 w-6 items-center justify-center rounded-md transition-colors duration-150',
        ativo ? 'text-koda-accent' : 'text-koda-fg/35 hover:text-koda-fg/80',
        desabilitado ? 'cursor-default opacity-40' : 'cursor-pointer',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

/** Uma marca da ficha: ícone + texto, com o que ela significa no title. */
function Marca({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <span title={titulo} className="flex items-center gap-1.5">
      {children}
    </span>
  )
}

/**
 * A ficha de uma resposta: o que dá para fazer com ela e quanto ela custou.
 *
 * Fica no fim de **cada** resposta terminada, fora do caminho do texto — copiar, dizer se
 * foi boa ou ruim, pedir de novo, e os números da rodada (uso, tempo, hora). É o lugar onde
 * alguém procura isso por reflexo, e sem ela a única saída para reusar uma resposta era
 * selecionar o texto na mão.
 */
export default function MessageFooter({
  texto,
  tokens = null,
  elapsedMs = null,
  at,
  numeros = true,
  ocupado = false,
  onRefazer,
}: {
  /** O texto gravado da resposta — é o que a cópia leva. */
  texto: string
  /**
   * O que a resposta escreveu, em tokens (`completion_tokens` somados). É o tamanho dela —
   * não o custo: cada passo do agente reenvia o contexto inteiro, e somar isso dava um
   * número que parecia impossível (ver `_tokens` no backend).
   */
  tokens?: number | null
  elapsedMs?: number | null
  /** Quando a resposta entrou na conversa (hora mostrada na ficha). */
  at: number
  /** Mostra uso, tempo e hora (o interruptor de Ajustes → Preferências). */
  numeros?: boolean
  /** Tem resposta rodando agora: refazer ficaria em cima da outra. */
  ocupado?: boolean
  /** Refazer esta rodada. Sem ele o botão nem aparece. */
  onRefazer?: () => void
}) {
  const [copiado, setCopiado] = useState(false)
  const [voto, setVoto] = useState<'bom' | 'ruim' | null>(null)
  const timer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )

  const copiar = async () => {
    if (!texto.trim()) return
    // Recusado dos dois jeitos: a ficha não mente dizendo "copiado".
    if (!(await copiarTexto(texto))) return
    setCopiado(true)
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopiado(false), 1800)
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-6 gap-y-1.5">
      <div className="flex items-center gap-0.5">
        {texto.trim() ? (
          <Botao titulo={copiado ? 'Copiado' : 'Copiar resposta'} ativo={copiado} onClick={() => void copiar()}>
            {copiado ? (
              <Check className="h-3.5 w-3.5" strokeWidth={1.7} />
            ) : (
              <Copy className="h-3.5 w-3.5" strokeWidth={1.7} />
            )}
          </Botao>
        ) : null}

        <Botao
          titulo="Boa resposta"
          ativo={voto === 'bom'}
          pressionado={voto === 'bom'}
          onClick={() => setVoto((atual) => (atual === 'bom' ? null : 'bom'))}
        >
          <ThumbsUp className="h-3.5 w-3.5" strokeWidth={1.7} />
        </Botao>

        <Botao
          titulo="Resposta ruim"
          ativo={voto === 'ruim'}
          pressionado={voto === 'ruim'}
          onClick={() => setVoto((atual) => (atual === 'ruim' ? null : 'ruim'))}
        >
          <ThumbsDown className="h-3.5 w-3.5" strokeWidth={1.7} />
        </Botao>

        {onRefazer ? (
          <Botao titulo="Rodar de novo" desabilitado={ocupado} onClick={onRefazer}>
            <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.7} />
          </Botao>
        ) : null}
      </div>

      {numeros ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-koda-fg/35">
          {tokens ? (
            <Marca titulo={`${tokens.toLocaleString('pt-BR')} tokens escritos nesta resposta`}>
              <Coins className="h-3.5 w-3.5" strokeWidth={1.7} />
              <span className="tabular-nums">{formatarTokens(tokens)} tok</span>
            </Marca>
          ) : null}

          {elapsedMs !== null ? (
            <Marca titulo="Tempo que esta resposta levou">
              <Clock className="h-3.5 w-3.5" strokeWidth={1.7} />
              <span className="tabular-nums">Levou {formatarDuracao(elapsedMs)}</span>
            </Marca>
          ) : null}

          <span title="Hora da resposta" className="tabular-nums">
            {formatarHora(at)}
          </span>
        </div>
      ) : null}
    </div>
  )
}
