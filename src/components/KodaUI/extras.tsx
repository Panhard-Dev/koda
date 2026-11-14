/**
 * Componentes extras do Koda UI Protocol: ícones, vetores, diagramas, mapa, escrita,
 * sandbox isolado, algoritmo, citação, entidade e calculadora.
 *
 * Nenhum deles injeta HTML no DOM principal. O sandbox é um iframe com origem opaca
 * (`sandbox="allow-scripts"` sem `allow-same-origin`), CSP restritiva e sem navegação.
 * SVG é desenhado como elementos React, nunca como string de markup.
 *
 * Visual: o mesmo minimalismo do resto do Koda — superfície `fg/[0.03]`, borda de 1 px,
 * raio `xl`, acento roxo só onde há interação. Sem gradientes decorativos, sem sombras
 * pesadas, sem ícones em caixinhas coloridas. Tudo alinhado na mesma grade: cabeçalho de
 * 36 px, corpo com 12 px de padding, controles de 28 px.
 */

import { useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Battery,
  Bell,
  Calculator as CalculatorIcon,
  Calendar,
  Camera,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock,
  Cloud,
  Code,
  Copy,
  CreditCard,
  Database,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Folder,
  Globe,
  Heart,
  HelpCircle,
  Home,
  Image as ImageIcon,
  Info,
  Link as LinkIcon,
  Lock,
  Mail,
  MapPin,
  Minus,
  Moon,
  Music,
  Pause,
  Pencil,
  Phone,
  Play,
  Plus,
  RotateCcw,
  Search,
  Server,
  Settings,
  ShoppingCart,
  Sparkles,
  Star,
  Sun,
  Trash2,
  TrendingDown,
  TrendingUp,
  Upload,
  User,
  Video,
  Wifi,
  Workflow,
  X,
  XCircle,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { abrirNoNavegador } from '../../abrirNoNavegador'
import {
  avaliarExpressao,
  chaveDoBinding,
  urlSegura,
  type Ctx,
} from './protocolo'
import { baixarTexto, copiar } from './utilidades'

const ICONES: Record<string, LucideIcon> = {
  mais: Plus, plus: Plus, menos: Minus, minus: Minus, check: Check, certo: Check,
  x: X, fechar: X, alerta: AlertTriangle, aviso: AlertTriangle, info: Info,
  busca: Search, search: Search, config: Settings, configuracoes: Settings,
  usuario: User, user: User, casa: Home, home: Home, arquivo: FileText,
  file: FileText, pasta: Folder, folder: Folder, download: Download,
  upload: Upload, copiar: Copy, copy: Copy, lixeira: Trash2, trash: Trash2,
  editar: Pencil, edit: Pencil, play: Play, pause: Pause, reiniciar: RotateCcw,
  reset: RotateCcw, direita: ChevronRight, direita2: ArrowRight,
  esquerda: ChevronLeft, esquerda2: ArrowLeft, estrela: Star, star: Star,
  coracao: Heart, heart: Heart, calendario: Calendar, calendar: Calendar,
  relogio: Clock, clock: Clock, email: Mail, mail: Mail, telefone: Phone,
  phone: Phone, mapa: MapPin, map: MapPin, globo: Globe, globe: Globe,
  link: LinkIcon, cadeado: Lock, lock: Lock, olho: Eye, eye: Eye,
  olho_fechado: EyeOff, sino: Bell, bell: Bell, sucesso: CheckCircle2,
  erro: XCircle, ajuda: HelpCircle, sol: Sun, sun: Sun, lua: Moon, moon: Moon,
  nuvem: Cloud, cloud: Cloud, raio: Zap, zap: Zap, alta: TrendingUp,
  baixa: TrendingDown, carrinho: ShoppingCart, cartao: CreditCard,
  camera: Camera, imagem: ImageIcon, video: Video, musica: Music,
  codigo: Code, banco: Database, servidor: Server, wifi: Wifi,
  bateria: Battery, circulo: Circle, calculadora: CalculatorIcon,
  fluxo: Workflow, escrita: Pencil, faisca: Sparkles, abrir: ExternalLink,
}

const CORES: Record<string, string> = {
  accent: 'text-koda-accent',
  destaque: 'text-koda-accent',
  muted: 'text-koda-fg/40',
  fraco: 'text-koda-fg/40',
  fg: 'text-koda-fg/80',
  danger: 'text-red-400',
  erro: 'text-red-400',
  success: 'text-emerald-400',
  sucesso: 'text-emerald-400',
  warning: 'text-amber-400',
  aviso: 'text-amber-400',
}

/** Superfície padrão dos cartões — igual à dos componentes nativos do Koda UI. */
const CARTAO = 'overflow-hidden rounded-xl border border-koda-fg/10 bg-koda-fg/[0.03]'

function texto(valor: unknown): string {
  return typeof valor === 'string' ? valor : ''
}

function numero(valor: unknown, padrao: number): number {
  const n = Number(valor)
  return Number.isFinite(n) ? n : padrao
}

function cor(valor: unknown): string {
  return CORES[texto(valor)] ?? CORES.accent
}

/** Cabeçalho único de todos os cartões: 36 px, título à esquerda, etiqueta à direita. */
function Cabecalho({
  icone,
  titulo,
  etiqueta,
  acoes,
}: {
  icone: ReactNode
  titulo: string
  etiqueta?: string
  acoes?: ReactNode
}) {
  return (
    <div className="flex h-9 items-center gap-2 border-b border-koda-fg/8 px-3">
      <span className="shrink-0 text-koda-fg/35">{icone}</span>
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-koda-fg/65">
        {titulo}
      </span>
      {etiqueta ? (
        <span className="shrink-0 text-[10.5px] tabular-nums text-koda-fg/30">{etiqueta}</span>
      ) : null}
      {acoes}
    </div>
  )
}

/** Botão fantasma padrão dos rodapés e controles. */
const BOTAO_FANTASMA =
  'inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11.5px] font-medium text-koda-fg/55 transition-colors hover:bg-koda-fg/8 hover:text-koda-fg/85 disabled:pointer-events-none disabled:opacity-35'

// ------------------------------------------------------------------ ícone

export function Icone({
  nome,
  tamanho,
  rotulo,
}: {
  nome: string
  tamanho: number
  rotulo: string
}) {
  const IconeLucide = ICONES[nome.toLowerCase()] ?? Circle
  const px = Math.max(12, Math.min(64, tamanho))
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center text-koda-accent"
      role={rotulo ? 'img' : undefined}
      aria-label={rotulo || undefined}
      aria-hidden={rotulo ? undefined : true}
    >
      <IconeLucide width={px} height={px} strokeWidth={1.7} />
    </span>
  )
}

// ------------------------------------------------------------------ SVG declarativo

type Forma = Record<string, unknown>

export function SvgSeguro({
  formas,
  viewBox,
  titulo,
}: {
  formas: Forma[]
  viewBox: string
  titulo: string
}) {
  const id = useId().replace(/:/g, '')
  const caixa = /^-?\d+(?:\.\d+)?(?: -?\d+(?:\.\d+)?){3}$/.test(viewBox)
    ? viewBox
    : '0 0 320 180'
  return (
    <div className={CARTAO}>
      <Cabecalho
        icone={<Sparkles width={13} height={13} />}
        titulo={titulo || 'Desenho vetorial'}
        etiqueta="SVG"
      />
      <div className="p-2.5">
        <svg
          viewBox={caixa}
          preserveAspectRatio="xMidYMid meet"
          className="max-h-[320px] w-full rounded-lg border border-koda-fg/8 bg-koda-fg/[0.02]"
          role="img"
          aria-label={titulo || 'desenho vetorial'}
        >
          <defs>
            <pattern id={`grade-${id}`} width="24" height="24" patternUnits="userSpaceOnUse">
              <path
                d="M 24 0 L 0 0 0 24"
                fill="none"
                stroke="currentColor"
                className="text-koda-fg/8"
                strokeWidth="0.6"
              />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill={`url(#grade-${id})`} />
          {formas.slice(0, 120).map((forma, indice) => {
            const tipo = texto(forma.tipo).toLowerCase()
            const classe = cor(forma.cor)
            const espessura = Math.max(1, Math.min(12, numero(forma.espessura, 2)))
            if (tipo === 'linha') {
              return (
                <line
                  key={indice}
                  x1={numero(forma.x1, 0)}
                  y1={numero(forma.y1, 0)}
                  x2={numero(forma.x2, 0)}
                  y2={numero(forma.y2, 0)}
                  stroke="currentColor"
                  className={classe}
                  strokeWidth={espessura}
                  strokeLinecap="round"
                />
              )
            }
            if (tipo === 'circulo') {
              return (
                <circle
                  key={indice}
                  cx={numero(forma.cx, 0)}
                  cy={numero(forma.cy, 0)}
                  r={Math.max(0, numero(forma.r, 4))}
                  fill="currentColor"
                  className={classe}
                />
              )
            }
            if (tipo === 'retangulo') {
              return (
                <rect
                  key={indice}
                  x={numero(forma.x, 0)}
                  y={numero(forma.y, 0)}
                  width={Math.max(0, numero(forma.largura, 10))}
                  height={Math.max(0, numero(forma.altura, 10))}
                  rx={Math.max(0, numero(forma.rx, 2))}
                  fill="currentColor"
                  className={classe}
                  opacity="0.85"
                />
              )
            }
            if (tipo === 'texto') {
              return (
                <text
                  key={indice}
                  x={numero(forma.x, 0)}
                  y={numero(forma.y, 0)}
                  fill="currentColor"
                  className="text-koda-fg/70"
                  fontSize={Math.max(6, Math.min(24, numero(forma.tamanho, 12)))}
                  fontFamily="ui-sans-serif, system-ui, sans-serif"
                >
                  {texto(forma.texto).slice(0, 200)}
                </text>
              )
            }
            if (tipo === 'caminho') {
              const d = texto(forma.d)
              if (!/^[0-9MmLlHhVvCcSsQqTtAaZz,.\s+-]{1,2000}$/.test(d)) return null
              return (
                <path
                  key={indice}
                  d={d}
                  fill="none"
                  stroke="currentColor"
                  className={classe}
                  strokeWidth={espessura}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )
            }
            if (tipo === 'poligono') {
              const pontos = texto(forma.pontos)
              if (!/^[0-9,.\s+-]{1,800}$/.test(pontos)) return null
              return (
                <polygon
                  key={indice}
                  points={pontos}
                  fill="currentColor"
                  className={classe}
                  opacity="0.85"
                />
              )
            }
            return null
          })}
        </svg>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ diagrama

export function Diagrama({
  nos,
  ligacoes,
  titulo,
}: {
  nos: Array<{ id: string; rotulo: string }>
  ligacoes: Array<{ de: string; para: string; rotulo: string }>
  titulo: string
}) {
  const idMarcador = useId().replace(/:/g, '')
  if (!nos.length) return <p className="text-[12.5px] text-koda-fg/50">Diagrama sem nós.</p>
  const colunas = Math.min(4, nos.length)
  const linhas = Math.ceil(nos.length / colunas)
  const largura = 360
  const margem = 52
  const espaco = colunas > 1 ? (largura - margem * 2) / (colunas - 1) : 0
  const larguraNo = Math.min(92, Math.max(56, espaco - 8))
  const altura = Math.max(104, linhas * 84 + 20)
  const baseY = altura / 2 - ((linhas - 1) * 84) / 2
  const posicao = new Map<string, { x: number; y: number }>()
  nos.forEach((no, indice) => {
    const coluna = indice % colunas
    const linha = Math.floor(indice / colunas)
    const x = colunas === 1 ? largura / 2 : margem + coluna * espaco
    const y = baseY + linha * 84
    posicao.set(no.id, { x, y })
  })
  return (
    <div className={CARTAO}>
      <Cabecalho
        icone={<Workflow width={13} height={13} />}
        titulo={titulo || 'Diagrama'}
        etiqueta={`${nos.length} nós`}
      />
      <div className="p-2.5">
        <svg
          viewBox={`0 0 ${largura} ${altura}`}
          className="w-full rounded-lg border border-koda-fg/8 bg-koda-fg/[0.02]"
          role="img"
          aria-label={titulo || 'diagrama'}
        >
          <defs>
            <marker
              id={`seta-${idMarcador}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" className="text-koda-fg/35" />
            </marker>
          </defs>
          {ligacoes.slice(0, 60).map((ligacao, indice) => {
            const de = posicao.get(ligacao.de)
            const para = posicao.get(ligacao.para)
            if (!de || !para) return null
            return (
              <g key={indice}>
                <line
                  x1={de.x}
                  y1={de.y}
                  x2={para.x}
                  y2={para.y}
                  stroke="currentColor"
                  className="text-koda-fg/20"
                  strokeWidth="1.4"
                  markerEnd={`url(#seta-${idMarcador})`}
                />
                {ligacao.rotulo ? (
                  <text
                    x={(de.x + para.x) / 2}
                    y={(de.y + para.y) / 2 - 5}
                    textAnchor="middle"
                    fontSize="8.5"
                    fill="currentColor"
                    className="text-koda-fg/45"
                  >
                    {ligacao.rotulo.slice(0, 24)}
                  </text>
                ) : null}
              </g>
            )
          })}
          {nos.slice(0, 40).map((no) => {
            const ponto = posicao.get(no.id)
            if (!ponto) return null
            return (
              <g key={no.id}>
                <rect
                  x={ponto.x - larguraNo / 2}
                  y={ponto.y - 16}
                  width={larguraNo}
                  height="32"
                  rx="8"
                  fill="currentColor"
                  className="text-koda-accent/[0.10]"
                  stroke="currentColor"
                  strokeOpacity="0.22"
                  strokeWidth="1"
                />
                <text
                  x={ponto.x}
                  y={ponto.y + 4}
                  textAnchor="middle"
                  fontSize="10"
                  fontWeight="500"
                  fill="currentColor"
                  className="text-koda-fg/85"
                >
                  {no.rotulo.slice(0, 20)}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
      {ligacoes.length ? (
        <ul className="flex flex-wrap gap-x-3 gap-y-1 border-t border-koda-fg/8 px-3 py-2 text-[10.5px] text-koda-fg/40">
          {ligacoes.slice(0, 12).map((ligacao, indice) => (
            <li key={indice} className="truncate">
              {ligacao.de} <span className="text-koda-fg/25">→</span> {ligacao.para}
              {ligacao.rotulo ? ` · ${ligacao.rotulo}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

// ------------------------------------------------------------------ mapa (visual, sem tiles)

export function Mapa({
  pontos,
  titulo,
}: {
  pontos: Array<{ rotulo: string; lat: number; lon: number }>
  titulo: string
}) {
  if (!pontos.length) return <p className="text-[12.5px] text-koda-fg/50">Mapa sem pontos.</p>
  const validos = pontos.filter(
    (ponto) => Number.isFinite(ponto.lat) && Number.isFinite(ponto.lon),
  )
  if (!validos.length) {
    return <p className="text-[12.5px] text-koda-fg/50">Mapa sem coordenadas válidas.</p>
  }
  const lats = validos.map((ponto) => ponto.lat)
  const lons = validos.map((ponto) => ponto.lon)
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const minLon = Math.min(...lons)
  const maxLon = Math.max(...lons)
  const faixa = Math.max(0.02, maxLat - minLat, maxLon - minLon)
  const x = (lon: number) => 22 + ((lon - minLon) / faixa) * 276
  const y = (lat: number) => 156 - ((lat - minLat) / faixa) * 116
  return (
    <div className={CARTAO}>
      <Cabecalho
        icone={<MapPin width={13} height={13} />}
        titulo={titulo || 'Mapa de pontos'}
        etiqueta={`${validos.length} pontos`}
      />
      <div className="p-2.5">
        <svg
          viewBox="0 0 320 180"
          className="w-full rounded-lg border border-koda-fg/8 bg-koda-fg/[0.02]"
          role="img"
          aria-label={titulo || 'mapa de pontos'}
        >
          <defs>
            <pattern id="grade-mapa" width="32" height="32" patternUnits="userSpaceOnUse">
              <path
                d="M 32 0 L 0 0 0 32"
                fill="none"
                stroke="currentColor"
                className="text-koda-fg/8"
                strokeWidth="0.6"
              />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grade-mapa)" />
          {validos.map((ponto, indice) => (
            <g key={indice}>
              <circle
                cx={x(ponto.lon)}
                cy={y(ponto.lat)}
                r="7"
                fill="currentColor"
                className="text-koda-accent/15"
              />
              <circle
                cx={x(ponto.lon)}
                cy={y(ponto.lat)}
                r="3.2"
                fill="currentColor"
                className="text-koda-accent"
              />
              <text
                x={x(ponto.lon) + (x(ponto.lon) > 226 ? -9 : 9)}
                y={y(ponto.lat) + 3}
                textAnchor={x(ponto.lon) > 226 ? 'end' : 'start'}
                fontSize="8.5"
                fill="currentColor"
                className="text-koda-fg/70"
              >
                {ponto.rotulo.slice(0, 20)}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-koda-fg/8 px-3 py-2">
        {validos.slice(0, 8).map((ponto, indice) => {
          const url = `https://www.openstreetmap.org/?mlat=${ponto.lat}&mlon=${ponto.lon}#map=14/${ponto.lat}/${ponto.lon}`
          return (
            <button
              key={indice}
              type="button"
              onClick={() => abrirNoNavegador(url)}
              className="inline-flex items-center gap-1 text-[10.5px] text-koda-fg/45 transition-colors hover:text-koda-accent"
            >
              <ExternalLink width={10} height={10} />
              {ponto.rotulo || `ponto ${indice + 1}`}
            </button>
          )
        })}
        <span className="ml-auto text-[10px] text-koda-fg/25">posições aproximadas</span>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ bloco de escrita

export function BlocoDeEscrita({
  titulo,
  chave,
  linhas,
  ctx,
}: {
  titulo: string
  chave: string
  linhas: number
  ctx: Ctx
}) {
  const valor = String(ctx.estado[chave] ?? '')
  const [aviso, setAviso] = useState<string | null>(null)
  const arquivo =
    (titulo || 'texto').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 40) + '.txt'
  return (
    <div className={CARTAO}>
      <Cabecalho
        icone={<Pencil width={13} height={13} />}
        titulo={titulo || 'Escrita'}
        etiqueta="editável"
      />
      <div className="p-3">
        <textarea
          value={valor}
          rows={Math.max(3, Math.min(20, linhas))}
          onChange={(evento) => ctx.definir(chave, evento.target.value)}
          className="w-full resize-y rounded-lg bg-koda-fg/[0.04] px-2.5 py-2 text-[13px] leading-relaxed text-koda-fg ring-1 ring-koda-fg/10 outline-none transition-shadow placeholder:text-koda-fg/30 focus:ring-koda-accent"
          placeholder="Escreva aqui…"
        />
        <div className="mt-2 flex h-7 items-center gap-1">
          <button
            type="button"
            onClick={() => {
              void copiar(valor).then((ok) =>
                setAviso(ok ? 'Copiado.' : 'Não foi possível copiar.'),
              )
            }}
            className={BOTAO_FANTASMA}
          >
            <Copy width={12} height={12} /> Copiar
          </button>
          <button
            type="button"
            onClick={() => baixarTexto(arquivo, valor)}
            className={BOTAO_FANTASMA}
          >
            <Download width={12} height={12} /> Baixar
          </button>
          <span className="ml-auto flex items-center gap-2 text-[10.5px] tabular-nums text-koda-fg/30">
            {aviso ? <span className="text-koda-accent/70">{aviso}</span> : null}
            {valor.length} caracteres
          </span>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ sandbox isolado

function montarSandbox(html: string, css: string, js: string): string {
  const csp =
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
    "img-src data: https:; media-src https:; font-src data:; connect-src 'none'; " +
    "form-action 'none'; base-uri 'none'; frame-ancestors 'none'"
  return (
    '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<style>html,body{margin:0;padding:14px;font:14px/1.5 ui-sans-serif,system-ui,sans-serif;color:#e8e8ea;background:#17171b}${css}</style>` +
    `</head><body>${html}<script>${js}<\/script></body></html>`
  )
}

export function Sandbox({
  html,
  css,
  js,
  titulo,
  altura,
  prototipo,
}: {
  html: string
  css: string
  js: string
  titulo: string
  altura: number
  prototipo?: boolean
}) {
  const alturaSegura = Math.max(120, Math.min(720, altura))
  return (
    <div className={CARTAO}>
      <Cabecalho
        icone={<Code width={13} height={13} />}
        titulo={titulo || 'Prévia'}
        etiqueta={prototipo ? 'protótipo isolado' : 'sandbox isolado'}
      />
      <iframe
        title={titulo || 'prévia isolada'}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={montarSandbox(html, css, js)}
        style={{ height: alturaSegura }}
        className="w-full bg-[#17171b]"
      />
    </div>
  )
}

// ------------------------------------------------------------------ algoritmo

export function Algoritmo({
  titulo,
  passos,
}: {
  titulo: string
  passos: Array<{ titulo: string; detalhe: string }>
}) {
  const [atual, setAtual] = useState(0)
  const [tocando, setTocando] = useState(false)
  useEffect(() => {
    if (!tocando) return
    const timer = window.setInterval(() => {
      setAtual((indice) => {
        if (indice + 1 >= passos.length) {
          setTocando(false)
          return indice
        }
        return indice + 1
      })
    }, 1400)
    return () => window.clearInterval(timer)
  }, [tocando, passos.length])
  if (!passos.length) return <p className="text-[12.5px] text-koda-fg/50">Algoritmo sem passos.</p>
  const indiceAtual = Math.min(atual, passos.length - 1)
  const passo = passos[indiceAtual]
  return (
    <div className={CARTAO}>
      <Cabecalho
        icone={<Play width={12} height={12} />}
        titulo={titulo || 'Passo a passo'}
        etiqueta={`${indiceAtual + 1}/${passos.length}`}
        acoes={
          <span className="flex items-center gap-0.5">
            <button
              type="button"
              aria-label="Passo anterior"
              onClick={() => setAtual((i) => Math.max(0, i - 1))}
              disabled={indiceAtual === 0}
              className="flex h-6 w-6 items-center justify-center rounded-md text-koda-fg/45 transition-colors hover:bg-koda-fg/8 hover:text-koda-fg/80 disabled:pointer-events-none disabled:opacity-30"
            >
              <ChevronLeft width={13} height={13} />
            </button>
            <button
              type="button"
              aria-label={tocando ? 'Pausar' : 'Reproduzir'}
              onClick={() => setTocando((v) => !v)}
              className="flex h-6 w-6 items-center justify-center rounded-md text-koda-fg/45 transition-colors hover:bg-koda-fg/8 hover:text-koda-fg/80"
            >
              {tocando ? <Pause width={11} height={11} /> : <Play width={11} height={11} />}
            </button>
            <button
              type="button"
              aria-label="Próximo passo"
              onClick={() => setAtual((i) => Math.min(passos.length - 1, i + 1))}
              disabled={indiceAtual >= passos.length - 1}
              className="flex h-6 w-6 items-center justify-center rounded-md text-koda-fg/45 transition-colors hover:bg-koda-fg/8 hover:text-koda-fg/80 disabled:pointer-events-none disabled:opacity-30"
            >
              <ChevronRight width={13} height={13} />
            </button>
            <button
              type="button"
              aria-label="Reiniciar"
              onClick={() => {
                setAtual(0)
                setTocando(false)
              }}
              className="ml-0.5 flex h-6 w-6 items-center justify-center rounded-md text-koda-fg/35 transition-colors hover:bg-koda-fg/8 hover:text-koda-fg/80"
            >
              <RotateCcw width={11} height={11} />
            </button>
          </span>
        }
      />
      <ol className="relative px-3 py-2.5">
        <span
          className="absolute top-5 bottom-5 left-[19px] w-px bg-koda-fg/10"
          aria-hidden="true"
        />
        {passos.map((item, indice) => {
          const ativo = indice === indiceAtual
          const feito = indice < indiceAtual
          return (
            <li key={indice} className="relative flex gap-2.5">
              <button
                type="button"
                onClick={() => {
                  setAtual(indice)
                  setTocando(false)
                }}
                aria-label={`Passo ${indice + 1}: ${item.titulo}`}
                aria-current={ativo ? 'step' : undefined}
                className={`relative z-10 mt-1.5 flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full border transition-colors ${
                  ativo
                    ? 'border-koda-accent bg-koda-accent-strong text-white'
                    : feito
                      ? 'border-koda-accent/40 bg-koda-accent/15 text-koda-accent'
                      : 'border-koda-fg/15 bg-koda-bg text-koda-fg/30'
                }`}
              >
                {feito ? <Check width={8} height={8} strokeWidth={3} /> : null}
              </button>
              <div className="min-w-0 flex-1 border-b border-koda-fg/6 py-1.5 last:border-b-0">
                <p
                  className={`text-[12.5px] font-medium transition-colors ${
                    ativo ? 'text-koda-fg/95' : feito ? 'text-koda-fg/55' : 'text-koda-fg/65'
                  }`}
                >
                  {item.titulo}
                </p>
                {item.detalhe ? (
                  <p className="mt-0.5 text-[11.5px] leading-relaxed whitespace-pre-wrap text-koda-fg/45">
                    {item.detalhe}
                  </p>
                ) : null}
              </div>
            </li>
          )
        })}
        <span className="sr-only" aria-live="polite">
          Passo {indiceAtual + 1} de {passos.length}: {passo.titulo}
        </span>
      </ol>
    </div>
  )
}

// ------------------------------------------------------------------ citação e entidade

export function Citacao({
  texto: conteudo,
  fonte,
  url,
}: {
  texto: string
  fonte: string
  url: string
}) {
  const destino = urlSegura(url)
  return (
    <blockquote className="border-l-2 border-koda-accent/40 py-0.5 pl-3">
      <p className="text-[13px] leading-relaxed text-koda-fg/80">{conteudo}</p>
      {fonte || destino ? (
        <footer className="mt-1.5 text-[11px] text-koda-fg/40">
          {destino ? (
            <button
              type="button"
              onClick={() => abrirNoNavegador(destino)}
              className="inline-flex items-center gap-1 text-koda-fg/45 transition-colors hover:text-koda-accent"
            >
              {fonte || destino}
              <ExternalLink width={10} height={10} />
            </button>
          ) : (
            fonte
          )}
        </footer>
      ) : null}
    </blockquote>
  )
}

export function Entidade({
  tipo,
  nome,
  detalhe,
  url,
}: {
  tipo: string
  nome: string
  detalhe: string
  url: string
}) {
  const destino = urlSegura(url)
  const IconeEntidade = ICONES[tipo.toLowerCase()] ?? FileText
  const conteudo = (
    <>
      <IconeEntidade
        width={14}
        height={14}
        strokeWidth={1.7}
        className="shrink-0 text-koda-fg/35"
      />
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="truncate text-[12.5px] font-medium text-koda-fg/85">{nome}</span>
        {detalhe ? (
          <span className="truncate text-[11px] text-koda-fg/40">{detalhe}</span>
        ) : null}
      </span>
      {destino ? (
        <ChevronRight width={13} height={13} className="ml-auto shrink-0 text-koda-fg/25" />
      ) : null}
    </>
  )
  const classe =
    'flex min-w-0 items-center gap-2 rounded-lg border border-koda-fg/10 bg-koda-fg/[0.03] px-2.5 py-1.5 text-left transition-colors'
  if (destino) {
    return (
      <button
        type="button"
        onClick={() => abrirNoNavegador(destino)}
        className={`${classe} hover:border-koda-fg/20 hover:bg-koda-fg/[0.06]`}
      >
        {conteudo}
      </button>
    )
  }
  return <span className={`${classe} self-start`}>{conteudo}</span>
}

// ------------------------------------------------------------------ calculadora

export function Calculadora({
  titulo,
  campos,
  formula,
  unidade,
  casas,
  ctx,
}: {
  titulo: string
  campos: Array<{ chave: string; rotulo: string; valor: number }>
  formula: string
  unidade: string
  casas: number
  ctx: Ctx
}) {
  const estadoCalculo: Record<string, unknown> = { ...ctx.estado }
  for (const campo of campos) {
    if (estadoCalculo[campo.chave] === undefined) estadoCalculo[campo.chave] = campo.valor
  }
  const resultado = avaliarExpressao(formula, estadoCalculo)
  const decimais = Math.max(0, Math.min(6, casas))
  const exibicao =
    resultado === null
      ? '—'
      : resultado.toLocaleString('pt-BR', {
          minimumFractionDigits: decimais,
          maximumFractionDigits: decimais,
        })
  return (
    <div className={CARTAO}>
      <Cabecalho
        icone={<CalculatorIcon width={13} height={13} />}
        titulo={titulo || 'Calculadora'}
        etiqueta="local"
      />
      <div className="p-3">
        <div className="grid grid-cols-2 gap-2">
          {campos.map((campo) => {
            const chave = chaveDoBinding(campo.chave)
            if (!chave) return null
            return (
              <label key={chave} className="flex min-w-0 flex-col gap-1">
                <span className="truncate text-[11px] font-medium text-koda-fg/45">
                  {campo.rotulo || chave}
                </span>
                <input
                  type="number"
                  value={String(ctx.estado[chave] ?? campo.valor ?? '')}
                  onChange={(evento) => ctx.definir(chave, Number(evento.target.value))}
                  className="h-8 w-full rounded-lg bg-koda-fg/[0.04] px-2.5 text-[13px] tabular-nums text-koda-fg ring-1 ring-koda-fg/10 outline-none transition-shadow focus:ring-koda-accent"
                />
              </label>
            )
          })}
        </div>
        <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-koda-fg/8 pt-2.5">
          <span className="text-[11px] font-medium tracking-wide text-koda-fg/40 uppercase">
            Resultado
          </span>
          <span className="flex items-baseline gap-1.5">
            <span className="text-[18px] font-semibold tracking-tight tabular-nums text-koda-fg/95">
              {exibicao}
            </span>
            {unidade ? (
              <span className="text-[11px] text-koda-fg/45">{unidade}</span>
            ) : null}
          </span>
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-3">
          <code className="truncate font-mono text-[10px] text-koda-fg/30">{formula}</code>
          <span className="shrink-0 text-[10px] text-koda-fg/25">cálculo local</span>
        </div>
      </div>
    </div>
  )
}

/** O dispatcher de `KodaSandbox`/`KodaAppBlock` mora no renderer; este tipo só documenta. */
export type ExtraProps = {
  no: { props: Record<string, unknown> }
  ctx: Ctx
  filhos: ReactNode[]
}
