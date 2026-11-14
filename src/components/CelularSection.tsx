/**
 * Ajustes › Celular.
 *
 * O caminho é o do RustDesk, mas só com as peças do Koda: o PC abre uma sala
 * e mostra um QR; o celular entra e fala com o backend **daqui**, não com uma
 * nuvem. São três jeitos de chegar ao PC:
 *
 * - **túnel** — um endereço público do Cloudflare Tunnel, sem conta e sem
 *   abrir porta no roteador. Cada QR nasce com porta, link, sala e código
 *   novos, e fica no ar até o dono fechar;
 * - **mesma Wi-Fi** — o servidor de link roda neste PC e o QR aponta para o IP
 *   local;
 * - **servidor próprio** — o mesmo servidor roda num VPS do dono e o PC
 *   conecta nele de saída.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Check,
  Cloud,
  Copy,
  Globe2,
  Loader2,
  Lock,
  Power,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Wifi,
} from 'lucide-react'
import {
  abrirTunelCloudflare,
  conectarAoLink,
  criarSalaDoLink,
  definirRedeLocal,
  desconectarDoLink,
  estadoDaSalaDoLink,
  estadoDaSalaDoTunel,
  estadoDoLink,
  fecharTunelCloudflare,
  fraseDeFalha,
  iniciarLinkLocal,
  pararLinkLocal,
} from '../api/client'
import type { ApiLinkEstado, ApiSalaLink, ApiSalaLinkEstado } from '../api/client'

type Modo = 'tunel' | 'local' | 'servidor'

/**
 * O último QR público desta sessão do app. Fica fora do componente porque a
 * tela de ajustes desmonta ao fechar; sem isso, voltar ao Celular perderia o
 * QR de um túnel que continua aberto no PC.
 */
let ultimoTunel: ApiSalaLink | null = null
let abrindoTunel: Promise<ApiSalaLink> | null = null

function Cartao({
  titulo,
  descricao,
  acao,
  children,
}: {
  titulo: string
  descricao: string
  acao?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="rounded-2xl bg-koda-panel ring-1 ring-koda-fg/8">
      <header className="flex items-start gap-4 px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold text-koda-fg">{titulo}</h2>
          <p className="mt-1 text-[13px] leading-5 text-koda-fg/45">{descricao}</p>
        </div>
        {acao ? <div className="shrink-0">{acao}</div> : null}
      </header>
      {children}
    </section>
  )
}

function Botao({
  children,
  onClick,
  variante = 'primario',
  ocupado = false,
  disabled = false,
}: {
  children: ReactNode
  onClick: () => void
  variante?: 'primario' | 'neutro' | 'perigo'
  ocupado?: boolean
  disabled?: boolean
}) {
  const cores = {
    primario: 'bg-koda-fg text-koda-bg hover:bg-koda-fg/90',
    neutro: 'bg-koda-fg/8 text-koda-fg/80 hover:bg-koda-fg/12',
    perigo: 'bg-red-400/10 text-red-300 hover:bg-red-400/16',
  }[variante]
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || ocupado}
      className={`flex items-center justify-center gap-2 rounded-xl px-3.5 py-2 text-[13px] font-medium transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${cores}`}
    >
      {ocupado ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} /> : null}
      {children}
    </button>
  )
}

function Ponto({ ligado }: { ligado: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-1.5 w-1.5 rounded-full ${ligado ? 'bg-emerald-400' : 'bg-koda-fg/25'}`}
    />
  )
}

function Aba({
  ativa,
  onClick,
  icone,
  children,
}: {
  ativa: boolean
  onClick: () => void
  icone: ReactNode
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[12px] font-medium transition-colors ${
        ativa
          ? 'bg-koda-panel text-koda-fg shadow-sm'
          : 'text-koda-fg/45 hover:text-koda-fg/70'
      }`}
    >
      {icone}
      {children}
    </button>
  )
}

const CAMADAS_DE_SEGURANCA = [
  {
    titulo: 'QR novo, tudo novo',
    texto:
      'Cada QR abre uma porta local, um endereço trycloudflare, uma sala e um código que nunca se repetem.',
  },
  {
    titulo: 'API fechada',
    texto:
      'O link só aceita as rotas que o celular usa — chat, modelos, projetos, anexos e permissões. O resto responde 403.',
  },
  {
    titulo: 'Freio por sala',
    texto:
      '90 pedidos por minuto e 4 em paralelo; acima disso o link recusa, mesmo com o QR na mão.',
  },
  {
    titulo: 'Token fica em casa',
    texto:
      'O token da API local é injetado pelo PC. Ele nunca entra no QR nem atravessa o Cloudflare.',
  },
  {
    titulo: 'Nada de docs expostos',
    texto:
      'O servidor do link não publica OpenAPI nem Swagger, e as respostas não ficam em cache.',
  },
  {
    titulo: 'Só este PC escuta',
    texto:
      'A porta do link existe apenas em 127.0.0.1. O Cloudflare é a única entrada e nada é aberto no roteador.',
  },
]

export default function CelularSection({ abrirQrAoEntrar = false }: { abrirQrAoEntrar?: boolean }) {
  const [modo, setModo] = useState<Modo>('tunel')
  const [estado, setEstado] = useState<ApiLinkEstado | null>(null)
  const [sala, setSala] = useState<ApiSalaLink | null>(null)
  const [presenca, setPresenca] = useState<ApiSalaLinkEstado | null>(null)
  const [ocupado, setOcupado] = useState<string | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [copiado, setCopiado] = useState(false)
  const [linkRemoto, setLinkRemoto] = useState('')
  const [tokenRemoto, setTokenRemoto] = useState('')
  const autoFeito = useRef(false)

  const atualizarEstado = useCallback(async () => {
    try {
      setEstado(await estadoDoLink())
    } catch {
      /* a tela continua com o que já sabia */
    }
  }, [])

  const mostrarQrPublico = useCallback(async (forcar = false) => {
    setErro(null)
    setOcupado('tunel')
    try {
      // Duas montagens seguidas do painel não podem abrir dois túneis e matar
      // o QR que o celular acabou de ler. Sem `forcar`, a chamada é única.
      const pedido =
        abrindoTunel ??
        (abrindoTunel = abrirTunelCloudflare(forcar).finally(() => {
          abrindoTunel = null
        }))
      const nova = await pedido
      ultimoTunel = nova
      setSala(nova)
      setPresenca(null)
      setEstado(await estadoDoLink())
    } catch (falha) {
      setErro(fraseDeFalha(falha))
    } finally {
      setOcupado(null)
    }
  }, [])

  // Ao entrar: lê o estado e, se veio do ícone do header, abre o QR público.
  useEffect(() => {
    let cancelado = false
    void estadoDoLink().then(
      (agora) => {
        if (cancelado) return
        setEstado(agora)
        const vivo =
          ultimoTunel !== null &&
          agora.tunel.aberto &&
          agora.tunel.sala === ultimoTunel.sala
        if (vivo) {
          // Já havia um túnel desta sessão: mostra o mesmo QR, sem rotacionar.
          setModo('tunel')
          setSala(ultimoTunel)
          return
        }
        if (abrirQrAoEntrar && !autoFeito.current) {
          autoFeito.current = true
          setModo('tunel')
          void mostrarQrPublico()
        }
      },
      () => {
        /* a tela continua com o que já sabia */
      },
    )
    return () => {
      cancelado = true
    }
  }, [abrirQrAoEntrar, mostrarQrPublico])

  // Enquanto há sala, pergunta ao servidor de link se o celular entrou.
  useEffect(() => {
    if (!sala) return
    const consultarSala = sala.modo === 'tunel' ? estadoDaSalaDoTunel : estadoDaSalaDoLink
    let cancelado = false
    const consultar = () => {
      void consultarSala(sala.sala).then(
        (agora) => {
          if (!cancelado) setPresenca(agora)
        },
        () => {
          if (!cancelado) setPresenca(null)
        },
      )
    }
    const primeiro = window.setTimeout(consultar, 0)
    const relogio = window.setInterval(consultar, 2000)
    return () => {
      cancelado = true
      window.clearTimeout(primeiro)
      window.clearInterval(relogio)
    }
  }, [sala])

  const ligarLocal = async () => {
    setErro(null)
    setOcupado('ligando')
    try {
      const proximo = await iniciarLinkLocal()
      setEstado(proximo)
      setSala(await criarSalaDoLink())
      setPresenca(null)
    } catch (falha) {
      setErro(fraseDeFalha(falha))
    } finally {
      setOcupado(null)
    }
  }

  const gerarSala = async () => {
    setErro(null)
    setOcupado('sala')
    try {
      if (modo === 'local') {
        if (!estado?.link.rodando) {
          const proximo = await iniciarLinkLocal()
          setEstado(proximo)
        }
        setSala(await criarSalaDoLink())
      } else {
        const base = linkRemoto.trim()
        if (!/^https?:\/\//i.test(base)) {
          setErro('O endereço do servidor precisa começar com http:// ou https://.')
          return
        }
        const nova = await criarSalaDoLink(base, tokenRemoto.trim() || undefined)
        setSala(nova)
        await conectarAoLink({ link: base, sala: nova.sala, segredo: nova.segredo })
        await atualizarEstado()
      }
      setPresenca(null)
    } catch (falha) {
      setErro(fraseDeFalha(falha))
    } finally {
      setOcupado(null)
    }
  }

  const fechar = async () => {
    setErro(null)
    setOcupado('fechando')
    try {
      setSala(null)
      setPresenca(null)
      if (modo === 'tunel') {
        ultimoTunel = null
        await fecharTunelCloudflare()
        setEstado(await estadoDoLink())
      } else if (modo === 'servidor') {
        await desconectarDoLink()
      } else {
        await pararLinkLocal()
        setEstado(await estadoDoLink())
      }
    } catch (falha) {
      setErro(fraseDeFalha(falha))
    } finally {
      setOcupado(null)
    }
  }

  /**
   * Trocar de aba não fecha o QR público: o túnel fica no ar até o botão
   * «Desligar». Fechá-lo aqui matava o endereço que o celular já tinha lido.
   */
  const trocarModo = (novo: Modo) => {
    if (novo === modo) return
    setSala(null)
    setPresenca(null)
    setModo(novo)
    if (novo === 'tunel' && ultimoTunel) {
      setSala(ultimoTunel)
    }
  }

  const redeLigada = Boolean(estado?.link.rede_local)

  /**
   * O interruptor do pareamento sem chave.
   *
   * Ligado, o celular acha este PC na Wi-Fi e entra sem QR, link ou chave. É
   * deliberadamente explícito: qualquer aparelho da mesma rede entra no Koda
   * enquanto isto estiver ligado — por isso o padrão é desligado.
   */
  const alternarRede = async () => {
    setErro(null)
    setOcupado('rede')
    try {
      setEstado(await definirRedeLocal(!redeLigada))
    } catch (falha) {
      setErro(fraseDeFalha(falha))
    } finally {
      setOcupado(null)
    }
  }

  const copiar = async () => {
    if (!sala) return
    try {
      await navigator.clipboard.writeText(sala.url)
      setCopiado(true)
      window.setTimeout(() => setCopiado(false), 1600)
    } catch {
      setErro('Não consegui copiar; selecione o link e copie à mão.')
    }
  }

  const conectado = Boolean(presenca?.convidado) || Boolean(estado?.cliente?.convidado)
  const linkLigado = Boolean(estado?.link.rodando)
  const tunelAberto = Boolean(estado?.tunel.aberto)
  const ehTunel = sala?.modo === 'tunel'
  const noAr = modo === 'tunel' ? tunelAberto : linkLigado

  return (
    <div className="flex flex-col gap-4">
      <Cartao
        titulo="Conectar celular"
        descricao="O celular vira uma janela do Koda deste computador. O agente, os arquivos e as permissões continuam aqui."
        acao={
          <span className="flex items-center gap-2 rounded-full bg-koda-fg/6 px-3 py-1.5 text-[11.5px] font-medium text-koda-fg/55">
            <Ponto ligado={conectado} />
            {conectado
              ? 'Celular conectado'
              : modo === 'tunel'
                ? tunelAberto
                  ? 'Túnel no ar'
                  : 'Desligado'
                : linkLigado
                  ? 'No ar'
                  : 'Desligado'}
          </span>
        }
      >
        <div className="border-t border-koda-fg/8 px-5 py-4">
          <div className="flex gap-2 rounded-xl bg-koda-fg/5 p-1">
            <Aba
              ativa={modo === 'tunel'}
              onClick={() => trocarModo('tunel')}
              icone={<Cloud className="h-3.5 w-3.5" strokeWidth={1.8} />}
            >
              Túnel público
            </Aba>
            <Aba
              ativa={modo === 'local'}
              onClick={() => trocarModo('local')}
              icone={<Wifi className="h-3.5 w-3.5" strokeWidth={1.8} />}
            >
              Mesma Wi-Fi
            </Aba>
            <Aba
              ativa={modo === 'servidor'}
              onClick={() => trocarModo('servidor')}
              icone={<Globe2 className="h-3.5 w-3.5" strokeWidth={1.8} />}
            >
              Meu servidor
            </Aba>
          </div>

          {modo === 'tunel' ? (
            <div className="mt-3 flex flex-col gap-2">
              <p className="text-[12.5px] leading-5 text-koda-fg/45">
                Um endereço público do Cloudflare Tunnel — sem conta e sem abrir porta no
                roteador. Cada QR nasce com porta, link, sala e código novos, e fica no ar até
                você fechar.
              </p>
              <p className="text-[11.5px] leading-5 text-koda-fg/35">
                O Koda abre o túnel sozinho — na primeira vez pode levar um pouco mais para
                carregar. O computador precisa ficar ligado com o Koda aberto.
              </p>
            </div>
          ) : modo === 'local' ? (
            <div className="mt-3 flex flex-col gap-3">
              <p className="text-[12.5px] leading-5 text-koda-fg/45">
                O servidor do link roda neste PC. O celular precisa estar na mesma rede — e o
                computador precisa ficar ligado com o Koda aberto.
              </p>
              <div className="flex items-start justify-between gap-4 rounded-xl bg-koda-fg/[0.03] px-3.5 py-3 ring-1 ring-koda-fg/8">
                <div className="min-w-0">
                  <p className="text-[12.5px] font-medium text-koda-fg/80">
                    Entrada pela rede local
                  </p>
                  <p className="mt-1 text-[11.5px] leading-5 text-koda-fg/40">
                    No celular, o botão «Entrar pela rede local» acha este PC sozinho — sem
                    QR, link ou chave. Qualquer aparelho nesta rede entra no Koda enquanto
                    isto estiver ligado.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={redeLigada}
                  aria-label="Entrada pela rede local"
                  onClick={() => void alternarRede()}
                  disabled={ocupado !== null}
                  className={[
                    'relative mt-0.5 h-6 w-10 shrink-0 rounded-full transition-colors duration-200',
                    'focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none',
                    redeLigada ? 'bg-koda-accent' : 'bg-koda-fg/15',
                    ocupado === 'rede' ? 'opacity-60' : '',
                  ].join(' ')}
                >
                  <span
                    className={[
                      'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200',
                      redeLigada ? 'translate-x-[18px]' : 'translate-x-0.5',
                    ].join(' ')}
                  />
                </button>
              </div>
              {redeLigada && estado?.link.url ? (
                <p className="text-[11.5px] leading-5 text-koda-fg/35">
                  O celular procura em <span className="font-mono">{estado.link.url}</span>.
                  Abra o app do Koda no celular e toque em «Entrar pela rede local».
                </p>
              ) : null}
            </div>
          ) : (
            <div className="mt-3 flex flex-col gap-2.5">
              <p className="text-[12.5px] leading-5 text-koda-fg/45">
                Suba a pasta <code className="rounded bg-koda-fg/8 px-1 py-0.5 text-[11.5px]">link/</code>{' '}
                num servidor seu (VPS, Raspberry Pi, Tailscale). O PC conecta nele de saída; nada
                passa pela nuvem do Koda.
              </p>
              <label className="flex flex-col gap-1.5">
                <span className="text-[11px] font-semibold tracking-wider text-koda-fg/45 uppercase">
                  Endereço do servidor
                </span>
                <input
                  value={linkRemoto}
                  onChange={(evento) => setLinkRemoto(evento.target.value)}
                  placeholder="https://link.seudominio.com"
                  spellCheck={false}
                  className="rounded-xl bg-koda-input px-3 py-2 text-[13px] text-koda-fg ring-1 ring-koda-fg/10 outline-none placeholder:text-koda-fg/30 focus:ring-2 focus:ring-koda-accent"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[11px] font-semibold tracking-wider text-koda-fg/45 uppercase">
                  Token do servidor (opcional)
                </span>
                <input
                  value={tokenRemoto}
                  onChange={(evento) => setTokenRemoto(evento.target.value)}
                  placeholder="KODA_LINK_TOKEN"
                  spellCheck={false}
                  type="password"
                  className="rounded-xl bg-koda-input px-3 py-2 text-[13px] text-koda-fg ring-1 ring-koda-fg/10 outline-none placeholder:text-koda-fg/30 focus:ring-2 focus:ring-koda-accent"
                />
              </label>
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {modo === 'tunel' ? (
              <Botao
                onClick={() => void mostrarQrPublico(true)}
                ocupado={ocupado === 'tunel'}
                disabled={ocupado !== null && ocupado !== 'tunel'}
              >
                <QrCode className="h-3.5 w-3.5" strokeWidth={1.9} />
                {ocupado === 'tunel'
                  ? 'Abrindo túnel…'
                  : sala
                    ? 'Novo QR público'
                    : 'Abrir túnel e mostrar QR'}
              </Botao>
            ) : modo === 'local' ? (
              <Botao
                onClick={linkLigado && !sala ? gerarSala : ligarLocal}
                ocupado={ocupado === 'ligando' || ocupado === 'sala'}
              >
                <QrCode className="h-3.5 w-3.5" strokeWidth={1.9} />
                {sala ? 'Novo QR' : linkLigado ? 'Mostrar QR' : 'Ligar e mostrar QR'}
              </Botao>
            ) : (
              <Botao onClick={gerarSala} ocupado={ocupado === 'sala'}>
                <QrCode className="h-3.5 w-3.5" strokeWidth={1.9} />
                Gerar QR
              </Botao>
            )}
            {sala || noAr ? (
              <Botao onClick={fechar} variante="neutro" ocupado={ocupado === 'fechando'}>
                <Power className="h-3.5 w-3.5" strokeWidth={1.9} />
                {modo === 'servidor' ? 'Desconectar' : 'Desligar'}
              </Botao>
            ) : null}
            <span className="flex items-center gap-1.5 text-[11.5px] text-koda-fg/35">
              <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.8} />
              O token da API não sai deste PC
            </span>
          </div>

          {erro ? (
            <p className="mt-3 rounded-xl bg-red-400/10 px-3 py-2 text-[12.5px] leading-5 text-red-300">
              {erro}
            </p>
          ) : null}
        </div>
      </Cartao>

      {sala ? (
        <Cartao
          titulo="Aponte a câmera do celular"
          descricao={
            ehTunel
              ? 'O QR abre o Koda mobile já pareado com este computador. O túnel fica aberto até você desligar.'
              : 'O QR abre o Koda mobile já pareado com este computador. O código é de uso único e a sala expira sozinha.'
          }
          acao={
            <button
              type="button"
              onClick={() => void (ehTunel ? mostrarQrPublico(true) : gerarSala())}
              disabled={ocupado !== null}
              className="flex items-center gap-1.5 rounded-xl bg-koda-fg/6 px-3 py-1.5 text-[12px] font-medium text-koda-fg/65 transition-colors hover:bg-koda-fg/10 disabled:opacity-50"
            >
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.9} />
              {ehTunel ? 'Novo QR público' : 'Novo QR'}
            </button>
          }
        >
          <div className="flex flex-col gap-4 border-t border-koda-fg/8 px-5 py-5 sm:flex-row sm:items-start">
            <div className="mx-auto w-fit rounded-2xl bg-white p-3 shadow-lg shadow-black/30 sm:mx-0">
              {sala.qr ? (
                <img
                  src={sala.qr}
                  alt="QR para conectar o celular ao Koda deste PC"
                  className="h-52 w-52"
                />
              ) : (
                <div className="flex h-52 w-52 items-center justify-center p-4 text-center text-[12px] leading-5 text-neutral-500">
                  QR indisponível nesta build. Use o link ao lado.
                </div>
              )}
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[12.5px] text-koda-fg/55">
                <Ponto ligado={conectado} />
                {conectado ? 'Celular conectado' : 'Aguardando o celular…'}
              </div>

              <div className="mt-3 rounded-xl bg-koda-input px-3 py-2.5 ring-1 ring-koda-fg/8">
                <p className="text-[10.5px] font-semibold tracking-wider text-koda-fg/35 uppercase">
                  Link
                </p>
                <p className="mt-1 break-all font-mono text-[11.5px] leading-5 text-koda-fg/75">
                  {sala.url}
                </p>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={copiar}
                  className="flex items-center gap-1.5 rounded-xl bg-koda-fg/6 px-3 py-1.5 text-[12px] font-medium text-koda-fg/70 transition-colors hover:bg-koda-fg/10"
                >
                  {copiado ? (
                    <Check className="h-3.5 w-3.5 text-emerald-400" strokeWidth={2.2} />
                  ) : (
                    <Copy className="h-3.5 w-3.5" strokeWidth={1.9} />
                  )}
                  {copiado ? 'Copiado' : 'Copiar link'}
                </button>
                <span className="font-mono text-[11.5px] text-koda-fg/45">
                  {sala.sala}-{sala.codigo}
                </span>
              </div>

              <p className="mt-3 text-[11.5px] leading-5 text-koda-fg/35">
                {sala.modo === 'tunel'
                  ? `Modo túnel: o Cloudflare entrega o celular a este PC, e a porta local (${sala.porta ?? '…'}) escuta só em 127.0.0.1.`
                  : sala.modo === 'direto'
                    ? 'Modo direto: o celular fala com este PC pela rede local.'
                    : 'Modo relay: o PC está conectado de saída ao seu servidor de link.'}
              </p>
              <p className="mt-1 text-[11.5px] leading-5 text-amber-300/70">
                Quem entrar nesta sala controla o agente deste PC. Trate o QR como uma senha.
              </p>
            </div>
          </div>
        </Cartao>
      ) : null}

      {modo === 'tunel' ? (
        <Cartao
          titulo="Segurança do túnel"
          descricao="O link público existe só para esta sala e morre quando você fecha."
        >
          <div className="grid gap-px border-t border-koda-fg/8 bg-koda-fg/8 sm:grid-cols-2">
            {CAMADAS_DE_SEGURANCA.map((camada) => (
              <div key={camada.titulo} className="bg-koda-panel px-5 py-4">
                <p className="flex items-center gap-2 text-[12.5px] font-medium text-koda-fg/85">
                  <Lock className="h-3.5 w-3.5 shrink-0 text-koda-fg/40" strokeWidth={1.8} />
                  {camada.titulo}
                </p>
                <p className="mt-1 text-[12px] leading-5 text-koda-fg/40">{camada.texto}</p>
              </div>
            ))}
          </div>
        </Cartao>
      ) : sala ? null : (
        <Cartao
          titulo="Como funciona"
          descricao="Sem conta, sem nuvem e sem abrir porta no roteador."
        >
          <div className="grid gap-px border-t border-koda-fg/8 bg-koda-fg/8 sm:grid-cols-3">
            {[
              {
                icone: <Smartphone className="h-4 w-4" strokeWidth={1.8} />,
                titulo: 'O celular é a tela',
                texto: 'Ele manda a mensagem e mostra a resposta; quem executa as ferramentas é o PC.',
              },
              {
                icone: <Cloud className="h-4 w-4" strokeWidth={1.8} />,
                titulo: 'Túnel público',
                texto: 'O Cloudflare entrega o celular a este PC. Cada QR cria porta, link e sala novos.',
              },
              {
                icone: <Wifi className="h-4 w-4" strokeWidth={1.8} />,
                titulo: 'Mesma Wi-Fi',
                texto: 'Sem internet: o servidor de link sobe dentro do backend e o QR aponta para o IP local.',
              },
            ].map((item) => (
              <div key={item.titulo} className="bg-koda-panel px-5 py-4">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-koda-fg/6 text-koda-fg/60">
                  {item.icone}
                </span>
                <p className="mt-2.5 text-[13px] font-medium text-koda-fg/85">{item.titulo}</p>
                <p className="mt-1 text-[12px] leading-5 text-koda-fg/40">{item.texto}</p>
              </div>
            ))}
          </div>
        </Cartao>
      )}
    </div>
  )
}
