import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { AlertTriangle, ArrowRight, Check, RotateCw, X } from 'lucide-react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { DENTRO_DO_TAURI } from './WindowControls'
import { estadoDoNavegador, estadoDosLogs } from '../api/client'
import type { ErroDeLog, EstadoDosLogs } from '../api/client'

/** As seções do painel. */
const ABAS = ['Painel Dev', 'Código', 'Subs', 'Logs'] as const

/**
 * O que foi digitado é um caminho do disco? Devolve o caminho, ou `null` se for site.
 *
 * Aceita as três formas que a mão produz: `C:\pasta\arquivo`, `C:/pasta/arquivo`,
 * `file:///C:/pasta/arquivo` e o caminho de rede `\\servidor\pasta`.
 *
 * Existe porque sem isto o `file:///...` era tratado como site e virava
 * `https://file:///...` — um endereço que não existe, e a tela ficava em branco sem dizer
 * por quê. Era defeito daqui, não do navegador.
 */
function caminhoLocal(valor: string): string | null {
  const bruto = valor.trim()
  if (/^file:\/\//i.test(bruto)) {
    const semEsquema = bruto.replace(/^file:\/\//i, '')
    // `file:///C:/x` vira `/C:/x`; a barra da frente não faz parte do caminho do Windows.
    const caminho = /^\/[a-z]:/i.test(semEsquema) ? semEsquema.slice(1) : semEsquema
    try {
      return decodeURIComponent(caminho)
    } catch {
      return caminho
    }
  }
  if (/^[a-z]:[\\/]/i.test(bruto)) return bruto
  if (/^\\\\/.test(bruto)) return bruto
  return null
}

/**
 * Acha o elemento do texto dentro da moldura, **preferindo título** — o mesmo critério que o
 * MCP usa do lado dele, para os dois pararem na mesma seção.
 */
function acharTextoNaMoldura(documento: Document, busca: string): Element | null {
  const alvo = busca.trim().toLowerCase()
  const grupos = [
    documento.querySelectorAll('h1,h2,h3,h4,h5,h6'),
    documento.querySelectorAll('p,li,td,th,dt,dd,label,button,a,span,div'),
  ]
  for (const grupo of grupos) {
    for (const el of Array.from(grupo)) {
      if (el.children.length > 0) continue
      if ((el.textContent ?? '').trim().toLowerCase().startsWith(alvo)) return el
    }
  }
  for (const grupo of grupos) {
    for (const el of Array.from(grupo)) {
      if (el.children.length > 0) continue
      if ((el.textContent ?? '').toLowerCase().includes(alvo)) return el
    }
  }
  return null
}

/** Sem esquema, assume `https://` — é o que a mão espera ao digitar `exemplo.com`. */
function normalizar(valor: string): string {
  const bruto = valor.trim()
  if (!bruto) return ''
  return /^https?:\/\//i.test(bruto) ? bruto : `https://${bruto}`
}

/**
 * Um caminho do disco vira um endereço que o `iframe` consegue carregar.
 *
 * São **dois** caminhos, porque são dois ambientes:
 * - no app instalado, o protocolo `asset` do Tauri (`convertFileSrc`) — é o único jeito de o
 *   webview alcançar o disco;
 * - em dev, `/@local/…`, servido pelo plugin do `vite.config.ts`.
 *
 * O que **não** funciona em nenhum dos dois é apontar o `iframe` para `file:///…`: o navegador
 * proíbe uma página http(s) de carregar `file://`. É regra dele, não escolha do Koda.
 */
function enderecoDoArquivo(caminho: string): string {
  if (DENTRO_DO_TAURI) return convertFileSrc(caminho)
  // `encodeURI` não mexe em `#` e `?`, e os dois cortariam o caminho no meio.
  const seguro = encodeURI(caminho).replace(/#/g, '%23').replace(/\?/g, '%3F')
  return new URL(`/@local/${seguro}`, window.location.origin).toString()
}

/**
 * Barra lateral — casca, abas e o X. Só a aba **Painel Dev** tem conteúdo (um navegador);
 * as outras três continuam vazias.
 *
 * O que ela é hoje, e só isso:
 * - uma **sobreposição**: `fixed`, da borda de cima à de baixo da janela, sem empurrar o
 *   layout. Cobre a conversa e vive no `z-[60]`, o topo da escada do app (o cabeçalho e a
 *   linha de tarefas são `z-20`, as gavetas `z-40`, os menus `z-50`) — se ficasse abaixo de
 *   qualquer um deles, abrir um menu com o painel aberto o cortaria no meio.
 * - **metade da largura da janela** (`w-1/2`), e é uma medida pedida, não um chute: a coroa do
 *   meio fica centrada na conversa, e o pedido foi que a barra chegasse até a **metade dela** —
 *   ou seja, a borda direita no meio da janela.
 * - **duas áreas**, separadas por uma linha. A faixa de cima (`h-14`) é o *chrome*: as abas
 *   **espalhadas de ponta a ponta** (`flex-1` + `justify-between`) — a primeira encostada na
 *   esquerda, a última encostada no X — e o X quieto no canto direito. O corpo abaixo
 *   (`flex-1`) é o conteúdo.
 *
 * ## O navegador do Painel Dev
 *
 * É um `<iframe>`, e é de propósito: **não adiciona motor nenhum**. O app já roda dentro do
 * WebView2 (o motor do Edge, que é Chromium), e o iframe usa esse mesmo motor — sem processo
 * novo, sem dependência nova, sem download. "Um navegador que não seja Chromium" dentro de um
 * app Tauri no Windows não existe: seria preciso embarcar Gecko ou WebKit inteiros, que é
 * exatamente o oposto de leve. Aqui o peso extra é zero.
 *
 * O `sandbox` não inclui `allow-top-navigation`: sem isso, a página embutida poderia mandar a
 * janela do Koda para outro lugar. As outras permissões são o que faz site normal funcionar.
 *
 * **Limite que não é nosso:** site que manda `X-Frame-Options` ou `frame-ancestors` recusa ser
 * embutido — Google, GitHub, YouTube e outros vão aparecer em branco. Não tem contorno do lado
 * de cá; é o site dizendo "não me embuta".
 *
 * ## Arquivo do disco
 *
 * A barra aceita caminho local (`C:\pasta\x.html`, `C:/pasta/x.html`, `file:///C:/pasta/x.html`
 * e `\\servidor\pasta`) e pasta — a pasta abre como listagem. Quem converte o caminho em
 * endereço carregável é `enderecoDoArquivo()`: protocolo `asset` do Tauri no app instalado,
 * `/@local/…` (plugin do `vite.config.ts`) em dev. Apontar para `file:///` direto **não**
 * funciona: o navegador proíbe página http(s) de carregar `file://`.
 *
 * Também fecha com `Esc` e com clique fora.
 */

/**
 * Uma linha da aba **Logs**.
 *
 * O desenho segue a regra do MCP que produz isto: **um** problema por linha. A repetição não
 * vira linha nova — vira o contador `×N`; o laço vira a etiqueta *repetindo*; e o que nasceu
 * depois da marca da IA vira a etiqueta *novo*. É o que permite ler 40 erros sem rolar uma
 * parede de texto igual.
 */
function LinhaDeLog({ erro }: { erro: ErroDeLog }) {
  const grave = erro.severidade === 'grave'
  return (
    <li className="border-b border-koda-fg/8 px-3 py-2.5 last:border-b-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          aria-hidden
          className={['h-1.5 w-1.5 shrink-0 rounded-full', grave ? 'bg-red-500' : 'bg-amber-400'].join(' ')}
        />
        <span className="text-[11px] font-medium tracking-wide text-koda-fg/55 uppercase">
          {erro.fonte}/{erro.tipo}
        </span>
        <span
          className={[
            'rounded px-1.5 py-0.5 text-[10.5px] font-medium',
            grave ? 'bg-red-500/12 text-red-500' : 'bg-amber-400/20 text-amber-600',
          ].join(' ')}
        >
          {erro.severidade}
        </span>
        {erro.ocorrencias > 1 ? (
          <span className="text-[10.5px] text-koda-fg/45">×{erro.ocorrencias}</span>
        ) : null}
        {erro.repetindo ? (
          <span className="rounded bg-orange-500/15 px-1.5 py-0.5 text-[10.5px] text-orange-500">
            repetindo
          </span>
        ) : null}
        {erro.novo ? (
          <span className="rounded bg-koda-accent/15 px-1.5 py-0.5 text-[10.5px] text-koda-accent">
            novo
          </span>
        ) : null}
      </div>
      <p className="mt-1.5 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-koda-fg/85">
        {erro.texto}
      </p>
      {erro.onde ? (
        <p className="mt-1 font-mono text-[10.5px] break-all text-koda-fg/40">{erro.onde}</p>
      ) : null}
    </li>
  )
}

/**
 * A aba **Logs** — o retrato que o MCP `koda-dev-logs` publica.
 *
 * Lê por sondagem de 2 s, o mesmo ritmo com que o MCP escreve. Mostra **só** erro: o MCP já
 * filtra `log`/`info`/`debug`, e a tela não repete o filtro.
 */
function AbaLogs() {
  const [estado, setEstado] = useState<EstadoDosLogs | null>(null)
  const [fora, setFora] = useState(false)

  useEffect(() => {
    let parado = false
    const passo = async () => {
      try {
        const dados = await estadoDosLogs()
        if (parado) return
        setEstado(dados)
        setFora(false)
      } catch {
        // Backend fora do ar. O detalhe do erro não vai para a tela — só o fato.
        if (!parado) setFora(true)
      }
    }
    void passo()
    const id = window.setInterval(() => void passo(), 2000)
    return () => {
      parado = true
      window.clearInterval(id)
    }
  }, [])

  if (fora) {
    return (
      <p className="px-3 py-3 text-[12.5px] leading-relaxed text-koda-fg/40">
        Não consegui ler os logs — o backend parece fora do ar.
      </p>
    )
  }
  if (!estado) {
    return <p className="px-3 py-3 text-[12.5px] text-koda-fg/40">Lendo…</p>
  }

  const resumo = estado.resumo ?? {}
  const lista = estado.erros ?? []

  if (!estado.vivo && !lista.length) {
    return (
      <p className="px-3 py-3 text-[12.5px] leading-relaxed text-koda-fg/40">
        {estado.motivo ||
          'Nada publicado ainda. Abra uma página pelo Painel Dev (ou peça à IA para abrir) e os erros aparecem aqui — do console, da rede e do servidor.'}
      </p>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-koda-fg/10 px-3 py-2">
        {lista.length ? (
          <>
            <span className="text-[12px] font-medium text-koda-fg/80">
              {resumo.grave ?? 0} grave{(resumo.grave ?? 0) === 1 ? '' : 's'}
            </span>
            <span className="text-[12px] text-koda-fg/50">{resumo.leve ?? 0} leve(s)</span>
            {resumo.novos ? (
              <span className="rounded bg-koda-accent/15 px-1.5 py-0.5 text-[10.5px] text-koda-accent">
                {resumo.novos} novo(s)
              </span>
            ) : null}
          </>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-emerald-600">
            <Check className="h-3.5 w-3.5" strokeWidth={2} />
            Nenhum erro nas fontes lidas
          </span>
        )}
        {!estado.vivo ? (
          <span className="ml-auto inline-flex items-center gap-1 text-[10.5px] text-koda-fg/40">
            <AlertTriangle className="h-3 w-3" strokeWidth={2} />
            parou de publicar
          </span>
        ) : null}
      </div>

      {lista.length ? (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {lista.map((e) => (
            <LinhaDeLog key={e.chave} erro={e} />
          ))}
        </ul>
      ) : (
        <p className="px-3 py-3 text-[12.5px] leading-relaxed text-koda-fg/45">
          Nada quebrado nas fontes lidas. Só aparece aqui o que é erro — aviso de console, erro
          de rede (4xx/5xx) e falha de servidor; `log`/`info` ficam de fora.
        </p>
      )}
    </div>
  )
}

export function PainelLateral({ aberto, onFechar }: { aberto: boolean; onFechar: () => void }) {
  const caixa = useRef<HTMLElement>(null)
  /** Qual seção está aberta. Estado local: é escolha de tela, não do app. */
  const [aba, setAba] = useState<(typeof ABAS)[number]>(ABAS[0])
  /** O que está digitado na barra de endereço. */
  const [endereco, setEndereco] = useState('')
  /** O que está de fato carregado no quadro. Vazio = nenhum site aberto. */
  const [url, setUrl] = useState('')
  /** Por que não há nada no quadro, quando é o caso. Vazio = sem aviso. */
  const [aviso, setAviso] = useState('')
  /** Só serve para forçar recarga: trocar a `key` remonta o iframe. */
  const [recarga, setRecarga] = useState(0)
  /** O iframe que mostra a página — o painel rola ele para acompanhar a IA. */
  const moldura = useRef<HTMLIFrameElement>(null)
  /** A última rolagem publicada pela IA, para reaplicar quando a página terminar de carregar. */
  const rolagemDaIA = useRef<{
    topo: number
    total: number
    janela: number
    alvo?: string | null
  } | null>(null)

  // O `onFechar` que o App manda é uma função nova a cada render. Guardar numa ref mantém o
  // efeito preso só ao `aberto` — sem isso o ouvinte seria desmontado e remontado a cada
  // render da tela inteira.
  const fecharRef = useRef(onFechar)
  useEffect(() => {
    fecharRef.current = onFechar
  }, [onFechar])

  useEffect(() => {
    if (!aberto) return

    const aoTeclar = (evento: KeyboardEvent) => {
      if (evento.key === 'Escape') fecharRef.current()
    }
    const aoApontar = (evento: PointerEvent) => {
      const alvo = evento.target as Node | null
      if (!alvo || !caixa.current?.contains(alvo)) fecharRef.current()
    }

    window.addEventListener('keydown', aoTeclar)
    // O `setTimeout(0)` é o que impede o clique que **abriu** o painel de chegar aqui e
    // fechá-lo no mesmo instante: o ouvinte só passa a existir depois que aquele evento
    // terminou de propagar.
    const id = window.setTimeout(() => {
      document.addEventListener('pointerdown', aoApontar, true)
    }, 0)

    return () => {
      window.clearTimeout(id)
      window.removeEventListener('keydown', aoTeclar)
      document.removeEventListener('pointerdown', aoApontar, true)
    }
  }, [aberto])

  /**
   * Rola a moldura do painel para a mesma altura **relativa** da IA.
   *
   * Relativa, e não em pixels: a janela da IA (1280×860) e a moldura do painel têm tamanhos
   * diferentes, então os mesmos pixels cairiam em outro trecho do texto. A fração é o que faz
   * o painel mostrar o mesmo pedaço que a IA está lendo.
   *
   * Só funciona quando a moldura é da **mesma origem** — o caso do arquivo do disco, servido
   * pelo `/@local/`. Página de outro localhost é outra origem, e aí o navegador não deixa o
   * painel tocar no conteúdo dela; nesse caso o painel mostra o topo, e isso é limite do
   * navegador, não escolha daqui.
   */
  const aplicarRolagem = (
    rolagem: { topo: number; total: number; janela: number; alvo?: string | null } | null,
  ) => {
    const janela = moldura.current?.contentWindow
    if (!rolagem || !janela) return
    try {
      const documento = janela.document

      // O caminho bom: a IA disse **o que** foi olhar, então o painel acha a mesma seção na
      // própria renderização dele. A fração da altura sozinha erra — o painel é estreito, o
      // texto quebra mais, e a mesma fração cai em outro trecho. Foi exatamente o que o dono
      // viu: a IA foi para a seção 3 e o painel parou na 1.
      if (rolagem.alvo) {
        const achou = acharTextoNaMoldura(documento, rolagem.alvo)
        if (achou) {
          achou.scrollIntoView({ block: 'center', behavior: 'smooth' })
          return
        }
      }

      // Sem alvo (rolou até o fim, ou por pixels): a fração é o que sobra.
      const alcanceDaIA = Math.max(rolagem.total - rolagem.janela, 1)
      const fracao = Math.min(Math.max(rolagem.topo / alcanceDaIA, 0), 1)
      const total = documento.documentElement.scrollHeight
      const altura = janela.innerHeight || 1
      // Suave, e não um salto: a tela tem de **andar** como quem rola de verdade.
      janela.scrollTo({ top: Math.round(fracao * Math.max(total - altura, 0)), behavior: 'smooth' })
    } catch {
      // outra origem: não dá para mexer no conteúdo de fora
    }
  }

  /**
   * O painel **acompanha** a página que a IA abriu.
   *
   * Antes daqui o painel espelhava a sessão da IA — e o espelho tomava conta dele: você
   * navegando e o painel mudando sozinho. O dono vetou, com razão. Mas ele também espera
   * *ver* onde a IA está, então o certo não era tirar tudo e deixar nada: é o painel seguir
   * a URL. Ele continua um navegador comum — barra de endereço e página —, só que anda junto.
   *
   * Ele **acompanha** a URL da IA — inclusive ao abrir. A primeira versão não pulava para uma
   * sessão que já estava viva quando o painel abriu, para "não sequestrar o painel"; o dono
   * testou e o efeito foi o oposto do esperado: ele abriu o painel, a IA já estava com a
   * página aberta, e o painel ficou vazio. Ver onde a IA está é o motivo de o painel existir.
   *
   * Depois disso, só reage a **mudança**: se você navegar na barra de endereço, o painel fica
   * onde você deixou — ele não briga com a sua mão, só anda junto quando a IA abre outra coisa.
   */
  useEffect(() => {
    if (!aberto || aba !== 'Painel Dev') return
    let parado = false
    let visto = ''
    let rolado = ''

    const passo = async () => {
      if (parado) return
      try {
        const estado = await estadoDoNavegador()
        if (parado) return
        if (!estado.vivo || !estado.url) return
        rolagemDaIA.current = estado.rolagem ?? null

        if (estado.url !== visto) {
          visto = estado.url
          // A moldura recém-navegada nasce no topo: zera a marca para a rolagem ser
          // reaplicada assim que a IA publicar de novo.
          rolado = ''
          // Caminho do disco: o iframe não carrega `file://`, então passa pelo `/@local/`.
          const caminho = caminhoLocal(estado.url)
          setAviso('')
          setEndereco(caminho ?? estado.url)
          setUrl(caminho ? enderecoDoArquivo(caminho) : estado.url)
          setRecarga((n) => n + 1)
        }

        // A rolagem só é reaplicada quando **muda**: se ela fosse reaplicada a cada volta, o
        // painel brigaria com quem está rolando ele com a mão.
        const marca = estado.rolagem
          ? `${estado.rolagem.topo}/${estado.rolagem.total}/${estado.rolagem.janela}/${estado.rolagem.alvo ?? ''}`
          : ''
        if (marca && marca !== rolado) {
          rolado = marca
          aplicarRolagem(estado.rolagem ?? null)
        }
      } catch {
        // backend fora do ar: o painel segue sendo o navegador de sempre
      }
    }

    void passo()
    const id = window.setInterval(() => void passo(), 1500)
    return () => {
      parado = true
      window.clearInterval(id)
    }
  }, [aberto, aba])

  const ir = (evento: FormEvent) => {
    evento.preventDefault()
    const bruto = endereco.trim()
    if (!bruto) return

    const caminho = caminhoLocal(bruto)
    if (caminho !== null) {
      setAviso('')
      setEndereco(caminho)
      setUrl(enderecoDoArquivo(caminho))
      // Sem trocar a `key` o iframe não recarrega quando o endereço é o mesmo.
      setRecarga((n) => n + 1)
      return
    }

    const site = normalizar(bruto)
    setAviso('')
    setEndereco(site)
    setUrl(site)
    setRecarga((n) => n + 1)
  }

  if (!aberto) return null

  return (
    <aside
      ref={caixa}
      aria-label="Barra lateral"
      className={[
        'painel-in fixed inset-y-0 left-0 z-[60] flex w-1/2 flex-col',
        'border-r border-koda-fg/10 bg-koda-surface',
        'shadow-[0_0_44px_rgba(0,0,0,0.45)]',
      ].join(' ')}
    >
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-koda-fg/10 px-2">
        <div
          role="tablist"
          aria-label="Seções da barra lateral"
          className="flex min-w-0 flex-1 items-center justify-between"
        >
          {ABAS.map((nome) => (
            <button
              key={nome}
              type="button"
              role="tab"
              aria-selected={nome === aba}
              onClick={() => setAba(nome)}
              className={[
                'shrink-0 rounded-lg px-2.5 py-1.5 text-[12.5px] whitespace-nowrap transition-colors duration-150',
                'focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none',
                nome === aba
                  ? 'bg-koda-fg/12 text-koda-fg'
                  : 'text-koda-fg/60 hover:bg-koda-fg/8 hover:text-koda-fg',
              ].join(' ')}
            >
              {nome}
            </button>
          ))}
        </div>

        <button
          type="button"
          aria-label="Fechar barra lateral"
          title="Fechar barra lateral"
          onClick={() => fecharRef.current()}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-koda-fg/55 transition-colors duration-150 hover:bg-koda-fg/10 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
        >
          <X className="h-4 w-4" strokeWidth={1.8} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {aba === 'Logs' ? <AbaLogs /> : null}
        {aba !== 'Painel Dev' ? null : (
          <>
            <form
              onSubmit={ir}
              className="flex shrink-0 items-center gap-1.5 border-b border-koda-fg/10 px-2 py-2"
            >
              <input
                value={endereco}
                onChange={(evento) => setEndereco(evento.target.value)}
                placeholder="https://exemplo.com"
                aria-label="Endereço"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-lg bg-koda-fg/8 px-2.5 py-1.5 text-[12.5px] text-koda-fg placeholder:text-koda-fg/35 focus:outline-none"
              />
              <button
                type="submit"
                aria-label="Abrir endereço"
                title="Abrir endereço"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-koda-fg/60 transition-colors duration-150 hover:bg-koda-fg/10 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
              >
                <ArrowRight className="h-4 w-4" strokeWidth={1.8} />
              </button>
              <button
                type="button"
                aria-label="Recarregar"
                title="Recarregar"
                disabled={!url}
                onClick={() => setRecarga((n) => n + 1)}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-koda-fg/60 transition-colors duration-150 hover:bg-koda-fg/10 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none disabled:pointer-events-none disabled:opacity-35"
              >
                <RotateCw className="h-4 w-4" strokeWidth={1.8} />
              </button>
            </form>

            {url ? (
              <iframe
                key={recarga}
                ref={moldura}
                onLoad={() => aplicarRolagem(rolagemDaIA.current)}
                title="Navegador do Painel Dev"
                src={url}
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                className="min-h-0 w-full flex-1 border-0 bg-white"
              />
            ) : (
              <p className="px-3 py-3 text-[12.5px] leading-relaxed text-koda-fg/40">
                {aviso ||
                  'Digite um endereço acima. Site que recusa ser embutido (Google, GitHub, YouTube) vai aparecer em branco — é o próprio site bloqueando, não o Koda.'}
              </p>
            )}
          </>
        )}
      </div>
    </aside>
  )
}

export default PainelLateral
