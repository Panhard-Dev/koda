/**
 * O renderer do Koda UI Protocol.
 *
 * Recebe o documento validado (do evento `ui` ao vivo ou do bloco ```koda-ui-doc```
 * gravado na mensagem) e desenha a árvore com os componentes do Koda. O estado é local e
 * **persistido por documento** (`documentId` + `revision`), então um contador continua no
 * mesmo número depois de recarregar a página. Nenhuma interação local chama o modelo: as
 * ações são declarativas e o dispatcher abaixo é código confiável.
 *
 * O que este arquivo não faz — de propósito: `eval`, `new Function`, HTML cru, CSS vindo
 * do documento, `dangerouslySetInnerHTML`. Texto é texto; URL é validada; componente
 * desconhecido vira um cartão de fallback.
 */

import { Component, createElement, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { abrirNoNavegador } from '../../abrirNoNavegador'
import {
  COMPONENTES,
  Accordion,
  Box,
  Carousel,
  Chart,
  DatePicker,
  Popover,
  Steps,
  Toggle,
} from '../UiGenerativa/componentes'
import {
  avaliarExpressao,
  chaveDoBinding,
  interpolar,
  urlSegura,
  validarDocumento,
  type Ctx,
  type KodaDocumento,
  type KodaNo,
} from './protocolo'
import {
  Algoritmo,
  BlocoDeEscrita,
  Calculadora,
  Citacao,
  Diagrama,
  Entidade,
  Icone,
  Mapa,
  Sandbox,
  SvgSeguro,
} from './extras'
import { copiar, formatarValor } from './utilidades'

const Badge = COMPONENTES.badge
const Alerta = COMPONENTES.alert
const Callout = COMPONENTES.callout
const Divisor = COMPONENTES.divider
const Codigo = COMPONENTES.code
const Tabela = COMPONENTES.table
const Metrica = COMPONENTES.stat
const Progresso = COMPONENTES.progress

const CORES = ['#8b5cf6', '#22d3ee', '#34d399', '#fbbf24', '#fb7185', '#a78bfa']

/** O documento validado; a falha de validação vira um cartão legível, nunca tela branca. */
export function DesenhoDocumento({ documento, fonte }: { documento?: unknown; fonte?: string }) {
  const resultado = useMemo(() => validarDocumento(documento ?? fonte), [documento, fonte])
  if (!resultado.ok) return <FalhaDocumento erro={resultado.erro} />
  return <DocumentoValido documento={resultado.documento} />
}

function DocumentoValido({ documento }: { documento: KodaDocumento }) {
  const chaveDoEstado = `koda-ui:${documento.documentId}:${documento.revision}`
  const [estado, setEstado] = useState<Record<string, unknown>>(() => {
    const inicial = { ...documento.state }
    try {
      const salvo = localStorage.getItem(chaveDoEstado)
      if (salvo) {
        const lido = JSON.parse(salvo) as Record<string, unknown>
        if (lido && typeof lido === 'object' && !Array.isArray(lido)) {
          for (const [chave, valor] of Object.entries(lido)) {
            if (chave in inicial) inicial[chave] = valor
          }
        }
      }
    } catch {
      // localStorage indisponível ou JSON velho: começa do estado do documento.
    }
    return inicial
  })
  const [aviso, setAviso] = useState<string | null>(null)
  const [executando, setExecutando] = useState<string | null>(null)
  const avisoTimer = useRef<number | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(chaveDoEstado, JSON.stringify(estado))
    } catch {
      // Sem espaço ou sem localStorage: a interface continua funcionando na sessão.
    }
  }, [chaveDoEstado, estado])

  useEffect(() => () => {
    if (avisoTimer.current !== null) window.clearTimeout(avisoTimer.current)
  }, [])

  const mostrarAviso = (texto: string) => {
    setAviso(texto)
    if (avisoTimer.current !== null) window.clearTimeout(avisoTimer.current)
    avisoTimer.current = window.setTimeout(() => setAviso(null), 1800)
  }

  const definir = (chave: string, valor: unknown) => {
    setEstado((atual) => ({ ...atual, [chave]: valor }))
  }
  const alternar = (chave: string) => {
    setEstado((atual) => ({ ...atual, [chave]: !atual[chave] }))
  }
  const incrementar = (chave: string, quanto: number) => {
    setEstado((atual) => ({ ...atual, [chave]: Number(atual[chave] ?? 0) + quanto }))
  }

  const enviar = (texto: string) => {
    const limpo = texto.trim()
    if (!limpo) return
    window.dispatchEvent(new CustomEvent('koda-ui-enviar', { detail: { texto: limpo } }))
  }

  const despachar = (actionId: string) => {
    const acao = documento.actions[actionId]
    if (!acao) {
      mostrarAviso('Ação indisponível.')
      return
    }
    const textoDaAcao = () => {
      const bruto = acao.text ?? (acao.fromState ? estado[acao.fromState] : '')
      return interpolar(String(bruto ?? ''), estado)
    }
    setExecutando(actionId)
    window.setTimeout(() => setExecutando(null), 700)
    switch (acao.kind) {
      case 'state.set':
        if (acao.key) definir(acao.key, acao.value)
        break
      case 'state.toggle':
        if (acao.key) alternar(acao.key)
        break
      case 'state.increment':
        if (acao.key) incrementar(acao.key, Number(acao.amount ?? 1))
        break
      case 'state.calc': {
        const expressao =
          acao.expression ?? (typeof acao.value === 'string' ? acao.value : '')
        if (!acao.key || !expressao) {
          mostrarAviso('Cálculo sem fórmula.')
          break
        }
        const resultado = avaliarExpressao(expressao, estado)
        if (resultado === null) {
          mostrarAviso('Fórmula inválida.')
          break
        }
        definir(acao.key, resultado)
        break
      }
      case 'ui.setTab':
        if (acao.key) definir(acao.key, acao.value)
        break
      case 'copy': {
        const texto = textoDaAcao()
        void copiar(texto).then((ok) => mostrarAviso(ok ? 'Copiado.' : 'Não foi possível copiar.'))
        break
      }
      case 'openUrl': {
        const url = urlSegura(acao.url)
        if (url) abrirNoNavegador(url)
        else mostrarAviso('Endereço inválido.')
        break
      }
      case 'issueNewTurn':
        enviar(textoDaAcao())
        mostrarAviso('Enviado.')
        break
      case 'form.submit': {
        const mensagem = acao.mensagem
          ? interpolar(acao.mensagem, estado)
          : acao.fromState
            ? formatarValor(estado[acao.fromState])
            : 'Formulário enviado:\n' +
              Object.entries(estado)
                .map(([chave, valor]) => `- ${chave}: ${formatarValor(valor)}`)
                .join('\n')
        enviar(mensagem)
        mostrarAviso('Enviado.')
        break
      }
      default:
        mostrarAviso('Ação não suportada.')
    }
  }

  const ctx: Ctx = { estado, acoes: documento.actions, definir, alternar, incrementar, despachar, executando }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <LimiteDeErro fallback={<FalhaDocumento erro="um componente falhou ao desenhar" />}>
        {renderizar(documento.root, ctx, 'raiz')}
      </LimiteDeErro>
      {aviso ? (
        <span className="text-[11.5px] text-koda-fg/45" role="status">
          {aviso}
        </span>
      ) : null}
    </div>
  )
}

// ------------------------------------------------------------------ renderização

function renderizar(no: KodaNo, ctx: Ctx, chave: string): ReactNode {
  return (
    <LimiteDeErro key={chave} fallback={<FalhaNo no={no} />}>
      <No no={no} ctx={ctx} chave={chave} />
    </LimiteDeErro>
  )
}

function No({ no, ctx, chave }: { no: KodaNo; ctx: Ctx; chave: string }): ReactNode {
  const p = no.props
  const filhos = no.children.map((filho, indice) => renderizar(filho, ctx, `${chave}.${indice}`))
  const texto = (nome = 'texto') => interpolar(String(p[nome] ?? ''), ctx.estado)
  const numero = (nome: string, padrao: number) => {
    const valor = Number(p[nome])
    return Number.isFinite(valor) ? valor : padrao
  }
  const espaco = (nome: string, padrao: number) => {
    const valor = numero(nome, padrao)
    return valor > 0 ? `${Math.min(valor, 8) * 4}px` : undefined
  }

  switch (no.type) {
    case 'KodaBox':
      return <Box padding={p.padding} filhos={filhos} />

    case 'KodaRow':
      return (
        <div
          className="flex min-w-0 flex-row flex-wrap items-end [&>button]:self-end"
          style={{ gap: espaco('gap', 2) }}
        >
          {filhos}
        </div>
      )

    case 'KodaColumn':
      return (
        <div className="flex min-w-0 flex-col" style={{ gap: espaco('gap', 2) }}>
          {filhos}
        </div>
      )

    case 'KodaGrid':
      return (
        <div
          className="grid min-w-0"
          style={{
            gap: espaco('gap', 2),
            gridTemplateColumns: `repeat(${Math.max(1, Math.min(6, numero('cols', 2)))}, minmax(0, 1fr))`,
          }}
        >
          {filhos}
        </div>
      )

    case 'KodaCard':
      return (
        <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-koda-fg/10 bg-koda-fg/[0.03] p-3">
          {p.titulo ? <span className="text-[13px] font-semibold text-koda-fg/90">{texto('titulo')}</span> : null}
          {filhos}
        </div>
      )

    case 'KodaTitle': {
      const nivel = Math.max(1, Math.min(4, numero('nivel', 3)))
      const classes = ['text-[18px]', 'text-[16px]', 'text-[14.5px]', 'text-[13.5px]'][nivel - 1]
      return createElement(
        `h${nivel}`,
        { className: `${classes} font-semibold text-koda-fg/95` },
        texto(),
      )
    }

    case 'KodaText':
      return <span className="text-[13.5px] whitespace-pre-wrap text-koda-fg/85">{texto()}</span>

    case 'KodaParagraph':
      return <p className="text-[13.5px] leading-relaxed whitespace-pre-wrap text-koda-fg/85">{texto()}</p>

    case 'KodaCaption':
      return <span className="text-[11.5px] text-koda-fg/45">{texto()}</span>

    case 'KodaLabel':
      return (
        <span className="flex flex-col gap-1 text-[12.5px] text-koda-fg/60">
          {texto()}
          {filhos}
        </span>
      )

    case 'KodaBadge':
      return <Badge valor={texto()} tom={String(p.tom ?? 'neutro')} />

    case 'KodaAlert':
      return <Alerta valor={texto()} tom={String(p.tom ?? 'info')} />

    case 'KodaCallout':
      return <Callout valor={texto()} tom={String(p.tom ?? 'info')} />

    case 'KodaDivider':
      return <Divisor />

    case 'KodaSpacer':
      return <div style={{ height: `${Math.min(64, numero('altura', 8))}px` }} />

    case 'KodaList': {
      const itens = Array.isArray(p.itens) ? (p.itens as string[]) : []
      const Lista = p.ordenada ? 'ol' : 'ul'
      return (
        <Lista className={`flex list-inside flex-col gap-1 pl-1 text-[13.5px] text-koda-fg/80 ${p.ordenada ? 'list-decimal' : 'list-disc'}`}>
          {itens.map((item, indice) => (
            <li key={indice}>{interpolar(String(item), ctx.estado)}</li>
          ))}
        </Lista>
      )
    }

    case 'KodaLink': {
      const href = urlSegura(p.href)
      if (!href) return <span className="text-[13px] text-koda-fg/60">{texto()}</span>
      return (
        <a
          href={href}
          onClick={(evento) => {
            evento.preventDefault()
            abrirNoNavegador(href)
          }}
          className="text-[13px] text-koda-accent underline underline-offset-2"
        >
          {texto()}
        </a>
      )
    }

    case 'KodaCodeBlock':
      return <Codigo valor={String(p.codigo ?? p.code ?? '')} linguagem={String(p.linguagem ?? p.language ?? '')} />

    case 'KodaImage': {
      const src = urlSegura(p.src, { imagem: true })
      if (!src) return <Alerta valor="Imagem indisponível." tom="aviso" />
      return (
        <figure className="flex min-w-0 flex-col gap-1">
          <img src={src} alt={String(p.alt ?? '')} loading="lazy" className="max-w-full rounded-lg" />
          {p.legenda ? <figcaption className="text-[11.5px] text-koda-fg/45">{texto('legenda')}</figcaption> : null}
        </figure>
      )
    }

    case 'KodaTable':
      return (
        <Tabela
          colunas={Array.isArray(p.colunas) ? (p.colunas as string[]) : []}
          linhas={Array.isArray(p.linhas) ? (p.linhas as unknown[][]) : []}
        />
      )

    case 'KodaMetric':
      return <Metrica rotulo={texto('rotulo')} valor={texto('valor')} variacao={p.variacao ? texto('variacao') : undefined} />

    case 'KodaProgress':
      return <Progresso valor={numero('valor', 0)} max={numero('max', 100)} />

    case 'KodaButton':
      return (
        <Botao
          rotulo={texto('rotulo')}
          variante={String(p.variante ?? 'primario')}
          desabilitado={Boolean(p.desabilitado) || ctx.executando === p.actionId}
          onClick={() => ctx.despachar(String(p.actionId ?? ''))}
        />
      )

    case 'KodaInput': {
      const chave = chaveDoBinding(p.valueBinding)
      if (!chave) return <Alerta valor="Campo sem vínculo de estado." tom="erro" />
      const tipo = String(p.tipo ?? 'texto')
      return (
        <label className="flex flex-col gap-1 text-[12.5px] text-koda-fg/60">
          {p.rotulo ? texto('rotulo') : null}
          <input
            type={tipo === 'numero' ? 'number' : tipo === 'email' ? 'email' : 'text'}
            value={String(ctx.estado[chave] ?? '')}
            placeholder={String(p.placeholder ?? '')}
            aria-label={p.rotulo ? undefined : chave}
            onChange={(evento) =>
              ctx.definir(chave, tipo === 'numero' ? Number(evento.target.value) : evento.target.value)
            }
            className="w-full rounded-lg bg-koda-fg/[0.04] px-2.5 py-1.5 text-[13px] text-koda-fg ring-1 ring-koda-fg/10 outline-none placeholder:text-koda-fg/30 focus:ring-koda-accent"
          />
        </label>
      )
    }

    case 'KodaTextarea': {
      const chave = chaveDoBinding(p.valueBinding)
      if (!chave) return <Alerta valor="Campo sem vínculo de estado." tom="erro" />
      return (
        <label className="flex flex-col gap-1 text-[12.5px] text-koda-fg/60">
          {p.rotulo ? texto('rotulo') : null}
          <textarea
            value={String(ctx.estado[chave] ?? '')}
            placeholder={String(p.placeholder ?? '')}
            aria-label={p.rotulo ? undefined : chave}
            rows={Math.max(2, Math.min(12, numero('linhas', 3)))}
            onChange={(evento) => ctx.definir(chave, evento.target.value)}
            className="w-full resize-y rounded-lg bg-koda-fg/[0.04] px-2.5 py-1.5 text-[13px] text-koda-fg ring-1 ring-koda-fg/10 outline-none placeholder:text-koda-fg/30 focus:ring-koda-accent"
          />
        </label>
      )
    }

    case 'KodaCheckbox': {
      const chave = chaveDoBinding(p.valueBinding)
      if (!chave) return <Alerta valor="Campo sem vínculo de estado." tom="erro" />
      return (
        <label className="flex items-center gap-2 text-[13px] text-koda-fg/85">
          <input
            type="checkbox"
            checked={Boolean(ctx.estado[chave])}
            onChange={() => ctx.alternar(chave)}
            className="h-4 w-4 accent-koda-accent"
          />
          {texto('rotulo')}
        </label>
      )
    }

    case 'KodaRadioGroup': {
      const chave = chaveDoBinding(p.valueBinding)
      if (!chave) return <Alerta valor="Campo sem vínculo de estado." tom="erro" />
      const opcoes = Array.isArray(p.opcoes) ? (p.opcoes as string[]) : []
      return (
        <fieldset className="flex flex-col gap-1.5">
          {p.rotulo ? <legend className="mb-1 text-[12.5px] text-koda-fg/60">{texto('rotulo')}</legend> : null}
          {opcoes.map((opcao) => (
            <label key={opcao} className="flex items-center gap-2 text-[13px] text-koda-fg/85">
              <input
                type="radio"
                name={no.id}
                checked={String(ctx.estado[chave]) === opcao}
                onChange={() => ctx.definir(chave, opcao)}
                className="h-4 w-4 accent-koda-accent"
              />
              {opcao}
            </label>
          ))}
        </fieldset>
      )
    }

    case 'KodaSelect': {
      const chave = chaveDoBinding(p.valueBinding)
      if (!chave) return <Alerta valor="Campo sem vínculo de estado." tom="erro" />
      const opcoes = Array.isArray(p.opcoes) ? (p.opcoes as string[]) : []
      const atual = String(ctx.estado[chave] ?? '')
      return (
        <label className="flex flex-col gap-1 text-[12.5px] text-koda-fg/60">
          {p.rotulo ? texto('rotulo') : null}
          <select
            value={atual}
            aria-label={p.rotulo ? undefined : chave}
            onChange={(evento) => ctx.definir(chave, evento.target.value)}
            className="w-full rounded-lg bg-koda-fg/[0.04] px-2.5 py-1.5 text-[13px] text-koda-fg ring-1 ring-koda-fg/10 outline-none focus:ring-koda-accent"
          >
            {atual === '' ? <option value="">Selecione…</option> : null}
            {opcoes.map((opcao) => (
              <option key={opcao} value={opcao}>
                {opcao}
              </option>
            ))}
          </select>
        </label>
      )
    }

    case 'KodaSlider': {
      const chave = chaveDoBinding(p.valueBinding)
      if (!chave) return <Alerta valor="Campo sem vínculo de estado." tom="erro" />
      const min = numero('min', 0)
      const max = numero('max', 100)
      const passo = Math.max(0.0001, numero('passo', 1))
      return (
        <label className="flex flex-col gap-1">
          <span className="flex items-center justify-between text-[12.5px] text-koda-fg/60">
            <span>{p.rotulo ? texto('rotulo') : chave}</span>
            <span className="font-mono text-koda-fg/85">{formatarValor(ctx.estado[chave])}</span>
          </span>
          <input
            type="range"
            min={min}
            max={max}
            step={passo}
            value={Number(ctx.estado[chave] ?? min)}
            onChange={(evento) => ctx.definir(chave, Number(evento.target.value))}
            className="w-full accent-koda-accent"
          />
        </label>
      )
    }

    case 'KodaSegmentedControl': {
      const chave = chaveDoBinding(p.valueBinding)
      if (!chave) return <Alerta valor="Campo sem vínculo de estado." tom="erro" />
      const opcoes = Array.isArray(p.opcoes) ? (p.opcoes as string[]) : []
      return (
        <div className="inline-flex overflow-hidden rounded-lg border border-koda-fg/12" role="group">
          {opcoes.map((opcao) => (
            <button
              key={opcao}
              type="button"
              aria-pressed={String(ctx.estado[chave]) === opcao}
              onClick={() => ctx.definir(chave, opcao)}
              className={`px-3 py-1 text-[12.5px] transition-colors ${
                String(ctx.estado[chave]) === opcao
                  ? 'bg-koda-accent-strong text-white'
                  : 'text-koda-fg/70 hover:bg-koda-fg/8'
              }`}
            >
              {opcao}
            </button>
          ))}
        </div>
      )
    }

    case 'KodaForm': {
      // O formulário pode não ter ação própria: aí quem age são os botões dos filhos.
      const acaoDoFormulario = String(p.actionId ?? '')
      return (
        <form
          className="flex flex-col gap-2.5"
          onSubmit={(evento) => {
            evento.preventDefault()
            if (acaoDoFormulario) ctx.despachar(acaoDoFormulario)
          }}
        >
          {filhos}
          {acaoDoFormulario ? (
            <Botao
              rotulo={texto('botao') || 'Enviar'}
              variante="primario"
              onClick={() => ctx.despachar(acaoDoFormulario)}
            />
          ) : null}
        </form>
      )
    }

    case 'KodaPressable':
      return (
        <button
          type="button"
          onClick={() => ctx.despachar(String(p.actionId ?? ''))}
          className="rounded-lg px-2 py-1 text-left text-[13px] text-koda-fg/85 transition-colors hover:bg-koda-fg/8"
        >
          {filhos.length ? filhos : texto()}
        </button>
      )

    case 'KodaChart':
      return (
        <Grafico
          tipo={String(p.tipo ?? 'barras')}
          dados={p.dados}
          titulo={String(p.titulo ?? '')}
          labels={p.labels}
          values={p.values}
        />
      )

    case 'KodaTabs':
      return <Abas no={no} filhos={filhos} />

    case 'KodaSteps':
      return <Steps itens={Array.isArray(p.itens) ? (p.itens as string[]) : []} />

    case 'KodaAccordion':
      return <Accordion valor={texto('titulo')} filhos={filhos} />

    case 'KodaCarousel':
      return <Carousel itens={Array.isArray(p.itens) ? (p.itens as string[]) : []} />

    case 'KodaPopover':
      return <Popover valor={texto('rotulo')} filhos={filhos} />

    case 'KodaDatePicker': {
      const chave = chaveDoBinding(p.valueBinding)
      if (!chave) return <Alerta valor="Campo sem vínculo de estado." tom="erro" />
      return (
        <label className="flex flex-col gap-1 text-[12.5px] text-koda-fg/60">
          {p.rotulo ? texto('rotulo') : null}
          <DatePicker valor={String(ctx.estado[chave] ?? '')} onChange={(valor: unknown) => ctx.definir(chave, String(valor ?? ''))} />
        </label>
      )
    }

    case 'KodaToggle': {
      const chave = chaveDoBinding(p.valueBinding)
      if (!chave) return <Alerta valor="Campo sem vínculo de estado." tom="erro" />
      return (
        <Toggle
          valor={Boolean(ctx.estado[chave])}
          rotulo={texto('rotulo')}
          onChange={(valor: unknown) => ctx.definir(chave, valor === 'true' || valor === true)}
        />
      )
    }

    case 'KodaSuggestion':
      return (
        <button
          type="button"
          onClick={() => ctx.despachar(String(p.actionId ?? ''))}
          className="self-start rounded-full border border-koda-fg/12 px-3 py-1 text-[12.5px] text-koda-fg/70 transition-colors hover:border-koda-accent/40 hover:text-koda-fg"
        >
          {texto()}
        </button>
      )

    case 'KodaQuote':
      return (
        <blockquote className="border-l-2 border-koda-accent/40 pl-3 text-[13.5px] leading-relaxed text-koda-fg/80 italic">
          {texto()}
          {p.autor ? <footer className="mt-1 text-[11.5px] text-koda-fg/45 not-italic">— {texto('autor')}</footer> : null}
        </blockquote>
      )

    case 'KodaDiff':
      return <Diferenca antes={String(p.antes ?? '')} depois={String(p.depois ?? '')} />

    case 'KodaSourceList': {
      const fontes = Array.isArray(p.fontes) ? (p.fontes as Array<{ titulo?: string; url?: string }>) : []
      return (
        <ol className="flex list-decimal flex-col gap-1 pl-4 text-[12.5px] text-koda-fg/70">
          {fontes.map((fonte, indice) => {
            const url = urlSegura(fonte.url)
            return (
              <li key={indice}>
                {url ? (
                  <a
                    href={url}
                    onClick={(evento) => {
                      evento.preventDefault()
                      abrirNoNavegador(url)
                    }}
                    className="text-koda-accent underline underline-offset-2"
                  >
                    {fonte.titulo || url}
                  </a>
                ) : (
                  fonte.titulo || 'fonte indisponível'
                )}
              </li>
            )
          })}
        </ol>
      )
    }

    case 'KodaVideo': {
      const src = urlSegura(p.src)
      if (!src) return <Alerta valor="Vídeo indisponível." tom="aviso" />
      const poster = urlSegura(p.poster, { imagem: true })
      return (
        <figure className="flex min-w-0 flex-col gap-1">
          <video controls src={src} poster={poster ?? undefined} className="max-w-full rounded-lg" />
          {p.legenda ? <figcaption className="text-[11.5px] text-koda-fg/45">{texto('legenda')}</figcaption> : null}
        </figure>
      )
    }

    case 'KodaIcon':
      return (
        <Icone
          nome={String(p.nome ?? p.icone ?? 'circulo')}
          tamanho={numero('tamanho', 20)}
          rotulo={texto('rotulo')}
        />
      )

    case 'KodaSvg': {
      const formas = Array.isArray(p.formas) ? (p.formas as Array<Record<string, unknown>>) : []
      return (
        <SvgSeguro
          formas={formas}
          viewBox={String(p.viewBox ?? '0 0 320 180')}
          titulo={texto('titulo')}
        />
      )
    }

    case 'KodaDiagram': {
      const nos = (Array.isArray(p.nos) ? (p.nos as unknown[]) : []).map((item, indice) => {
        if (typeof item === 'string') return { id: `n${indice}`, rotulo: item }
        const objeto = (item ?? {}) as Record<string, unknown>
        return {
          id: String(objeto.id ?? `n${indice}`),
          rotulo: String(objeto.rotulo ?? objeto.label ?? objeto.id ?? `nó ${indice + 1}`),
        }
      })
      const ligacoes = (Array.isArray(p.ligacoes) ? (p.ligacoes as unknown[]) : []).map((item) => {
        const objeto = (item ?? {}) as Record<string, unknown>
        return {
          de: String(objeto.de ?? objeto.from ?? ''),
          para: String(objeto.para ?? objeto.to ?? ''),
          rotulo: String(objeto.rotulo ?? objeto.label ?? ''),
        }
      })
      return <Diagrama nos={nos} ligacoes={ligacoes} titulo={texto('titulo')} />
    }

    case 'KodaMap': {
      const pontos = (Array.isArray(p.pontos) ? (p.pontos as unknown[]) : [])
        .map((item, indice) => {
          const objeto = (item ?? {}) as Record<string, unknown>
          return {
            rotulo: String(objeto.rotulo ?? objeto.nome ?? `ponto ${indice + 1}`),
            lat: Number(objeto.lat ?? objeto.latitude),
            lon: Number(objeto.lon ?? objeto.lng ?? objeto.longitude),
          }
        })
        .filter((ponto) => Number.isFinite(ponto.lat) && Number.isFinite(ponto.lon))
      return <Mapa pontos={pontos} titulo={texto('titulo')} />
    }

    case 'KodaWritingBlock': {
      const chave = chaveDoBinding(p.valueBinding)
      if (!chave) return <Alerta valor="Bloco de escrita sem vínculo de estado." tom="erro" />
      return (
        <BlocoDeEscrita
          titulo={texto('titulo')}
          chave={chave}
          linhas={numero('linhas', 6)}
          ctx={ctx}
        />
      )
    }

    case 'KodaSandbox':
    case 'KodaAppBlock':
      return (
        <Sandbox
          html={String(p.html ?? '')}
          css={String(p.css ?? '')}
          js={String(p.js ?? '')}
          titulo={texto('titulo')}
          altura={numero('altura', no.type === 'KodaAppBlock' ? 420 : 320)}
          prototipo={no.type === 'KodaAppBlock'}
        />
      )

    case 'KodaAlgorithm': {
      const passos = (Array.isArray(p.passos) ? (p.passos as unknown[]) : []).map((item, indice) => {
        if (typeof item === 'string') return { titulo: item, detalhe: '' }
        const objeto = (item ?? {}) as Record<string, unknown>
        return {
          titulo: String(objeto.titulo ?? objeto.label ?? `Passo ${indice + 1}`),
          detalhe: String(objeto.detalhe ?? objeto.descricao ?? ''),
        }
      })
      return <Algoritmo titulo={texto('titulo')} passos={passos} />
    }

    case 'KodaCitation':
      return (
        <Citacao
          texto={texto()}
          fonte={texto('fonte')}
          url={String(p.url ?? '')}
        />
      )

    case 'KodaEntity':
      return (
        <Entidade
          tipo={String(p.tipo ?? 'arquivo')}
          nome={texto('nome')}
          detalhe={texto('detalhe')}
          url={String(p.url ?? '')}
        />
      )

    case 'KodaCalculator': {
      const campos = (Array.isArray(p.campos) ? (p.campos as unknown[]) : []).map((item, indice) => {
        const objeto = (item ?? {}) as Record<string, unknown>
        return {
          chave: String(objeto.chave ?? objeto.key ?? `campo${indice + 1}`),
          rotulo: String(objeto.rotulo ?? objeto.label ?? objeto.chave ?? `Campo ${indice + 1}`),
          valor: Number(objeto.valor ?? objeto.value ?? 0),
        }
      })
      return (
        <Calculadora
          titulo={texto('titulo')}
          campos={campos}
          formula={String(p.formula ?? '')}
          unidade={texto('unidade')}
          casas={numero('casas', 2)}
          ctx={ctx}
        />
      )
    }

    default:
      return <FalhaNo no={no} />
  }
}

// ------------------------------------------------------------------ peças próprias

function Botao({
  rotulo,
  variante,
  desabilitado,
  onClick,
}: {
  rotulo: string
  variante: string
  desabilitado?: boolean
  onClick: () => void
}) {
  const classes =
    variante === 'primario'
      ? 'bg-koda-accent-strong text-white hover:bg-koda-accent-strong/85'
      : variante === 'discreto'
        ? 'text-koda-fg/60 hover:bg-koda-fg/8'
        : 'bg-koda-fg/8 text-koda-fg/80 hover:bg-koda-fg/14'
  return (
    <button
      type="button"
      disabled={desabilitado}
      onClick={onClick}
      className={`self-start rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${classes}`}
    >
      {rotulo || 'ok'}
    </button>
  )
}

function Abas({ no, filhos }: { no: KodaNo; filhos: ReactNode[] }) {
  const abas = Array.isArray(no.props.abas) ? (no.props.abas as string[]) : []
  const [ativa, setAtiva] = useState(0)
  const filhosComAba = no.children.map((filho, indice) => ({
    aba: typeof filho.props.aba === 'string' ? filho.props.aba : null,
    no: filhos[indice],
  }))
  const temAbasNosFilhos = filhosComAba.some((item) => item.aba !== null)
  const visiveis: ReactNode[] = temAbasNosFilhos
    ? filhosComAba.filter((item) => item.aba === abas[ativa]).map((item) => item.no)
    : filhos
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap gap-1 border-b border-koda-fg/10" role="tablist">
        {abas.map((aba, indice) => (
          <button
            key={aba}
            type="button"
            role="tab"
            aria-selected={indice === ativa}
            onClick={() => setAtiva(indice)}
            className={`px-3 py-1.5 text-[12.5px] ${
              indice === ativa ? 'border-b-2 border-koda-accent text-koda-fg/90' : 'text-koda-fg/50'
            }`}
          >
            {aba}
          </button>
        ))}
      </div>
      <div className="flex min-w-0 flex-col gap-2">{visiveis}</div>
    </div>
  )
}

// O modelo nem sempre manda os pontos no mesmo formato: pode vir lista de objetos
// ({rotulo, valor} / {label, value}), listas paralelas (labels + values) ou um objeto
// com os pontos dentro (valores/values/items/series/dados). Aceitamos todos — o
// celular já aceita, e os dois lados têm que renderizar a mesma resposta.
function pontosDoGrafico(dados: unknown, labels?: unknown, values?: unknown): Array<{ rotulo: string; valor: number }> {
  const deLista = (lista: unknown[]): Array<{ rotulo: string; valor: number }> =>
    lista
      .map((ponto): { rotulo: string; valor: number } | null => {
        if (Array.isArray(ponto)) return { rotulo: String(ponto[0] ?? ''), valor: Number(ponto[1] ?? 0) }
        if (ponto && typeof ponto === 'object')
          return {
            rotulo: String((ponto as Record<string, unknown>).rotulo ?? (ponto as Record<string, unknown>).label ?? (ponto as Record<string, unknown>).name ?? ''),
            valor: Number((ponto as Record<string, unknown>).valor ?? (ponto as Record<string, unknown>).value ?? 0),
          }
        return null
      })
      .filter((ponto): ponto is { rotulo: string; valor: number } => ponto !== null)

  if (Array.isArray(dados)) {
    const pontos = deLista(dados)
    if (pontos.length) return pontos
  }
  if (dados && typeof dados === 'object' && !Array.isArray(dados)) {
    const registro = dados as Record<string, unknown>
    for (const chave of ['valores', 'values', 'items', 'series', 'dados', 'data', 'pontos', 'points']) {
      if (Array.isArray(registro[chave])) {
        const pontos = deLista(registro[chave] as unknown[])
        if (pontos.length) return pontos
      }
    }
  }
  if (Array.isArray(labels) && Array.isArray(values)) {
    const pontos = (labels as unknown[]).map((rotulo, indice) => ({
      rotulo: String(rotulo ?? ''),
      valor: Number((values as unknown[])[indice] ?? 0),
    }))
    if (pontos.length) return pontos
  }
  return []
}

function Grafico({
  tipo,
  dados,
  titulo,
  labels,
  values,
}: {
  tipo: string
  dados: unknown
  titulo: string
  labels?: unknown
  values?: unknown
}) {
  const pontos = pontosDoGrafico(dados, labels, values)
  if (!pontos.length) return <Alerta valor="Gráfico sem dados." tom="aviso" />
  if (tipo === 'linhas') return <GraficoDeLinhas pontos={pontos} titulo={titulo} />
  if (tipo === 'pizza') return <GraficoDePizza pontos={pontos} titulo={titulo} />
  return <Chart dados={pontos} titulo={titulo} />
}

function GraficoDeLinhas({ pontos, titulo }: { pontos: Array<{ rotulo: string; valor: number }>; titulo: string }) {
  const largura = 320
  const altura = 140
  const margem = { esquerda: 34, direita: 10, topo: 10, baixo: 22 }
  const valores = pontos.map((ponto) => ponto.valor)
  const minimo = Math.min(0, ...valores)
  const maximo = Math.max(0, ...valores)
  const faixa = maximo - minimo || 1
  const x = (indice: number) =>
    margem.esquerda +
    (pontos.length === 1 ? 0 : (indice / (pontos.length - 1)) * (largura - margem.esquerda - margem.direita))
  const y = (valor: number) =>
    altura - margem.baixo - ((valor - minimo) / faixa) * (altura - margem.topo - margem.baixo)
  const caminho = pontos.map((ponto, indice) => `${indice === 0 ? 'M' : 'L'} ${x(indice)} ${y(ponto.valor)}`).join(' ')
  const passoRotulo = Math.max(1, Math.ceil(pontos.length / 6))
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {titulo ? <span className="text-[12.5px] text-koda-fg/60">{titulo}</span> : null}
      <svg viewBox={`0 0 ${largura} ${altura}`} className="w-full" role="img" aria-label={titulo || 'gráfico de linhas'}>
        {[0, 0.5, 1].map((fracao) => (
          <line
            key={fracao}
            x1={margem.esquerda}
            x2={largura - margem.direita}
            y1={margem.topo + fracao * (altura - margem.topo - margem.baixo)}
            y2={margem.topo + fracao * (altura - margem.topo - margem.baixo)}
            stroke="currentColor"
            className="text-koda-fg/8"
            strokeWidth="1"
          />
        ))}
        <path d={caminho} fill="none" stroke="currentColor" className="text-koda-accent" strokeWidth="2" />
        {pontos.map((ponto, indice) => (
          <g key={indice}>
            <circle cx={x(indice)} cy={y(ponto.valor)} r="2.6" fill="currentColor" className="text-koda-accent">
              <title>{`${ponto.rotulo}: ${ponto.valor}`}</title>
            </circle>
            {indice % passoRotulo === 0 ? (
              <text x={x(indice)} y={altura - 6} textAnchor="middle" className="fill-current text-[9px] text-koda-fg/45">
                {ponto.rotulo}
              </text>
            ) : null}
          </g>
        ))}
        <text x={margem.esquerda - 4} y={y(maximo) + 3} textAnchor="end" className="fill-current text-[9px] text-koda-fg/45">
          {maximo}
        </text>
        <text x={margem.esquerda - 4} y={y(minimo) + 3} textAnchor="end" className="fill-current text-[9px] text-koda-fg/45">
          {minimo}
        </text>
      </svg>
      <details className="text-[11.5px] text-koda-fg/45">
        <summary className="cursor-pointer">Ver dados</summary>
        <table className="mt-1 w-full border-collapse text-[12px]">
          <thead>
            <tr>
              <th className="border-b border-koda-fg/10 px-1 py-1 text-left font-medium">Rótulo</th>
              <th className="border-b border-koda-fg/10 px-1 py-1 text-right font-medium">Valor</th>
            </tr>
          </thead>
          <tbody>
            {pontos.map((ponto, indice) => (
              <tr key={indice}>
                <td className="border-b border-koda-fg/6 px-1 py-1">{ponto.rotulo}</td>
                <td className="border-b border-koda-fg/6 px-1 py-1 text-right font-mono">{ponto.valor}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  )
}

function GraficoDePizza({ pontos, titulo }: { pontos: Array<{ rotulo: string; valor: number }>; titulo: string }) {
  const total = pontos.reduce((soma, ponto) => soma + Math.max(0, ponto.valor), 0)
  if (total <= 0) return <Alerta valor="Gráfico de pizza precisa de valores positivos." tom="aviso" />
  let acumulado = 0
  const fatias = pontos.map((ponto, indice) => {
    const inicio = (acumulado / total) * 100
    acumulado += Math.max(0, ponto.valor)
    const fim = (acumulado / total) * 100
    return { ...ponto, inicio, fim, cor: CORES[indice % CORES.length] }
  })
  const gradiente = fatias.map((fatia) => `${fatia.cor} ${fatia.inicio}% ${fatia.fim}%`).join(', ')
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {titulo ? <span className="text-[12.5px] text-koda-fg/60">{titulo}</span> : null}
      <div className="flex flex-wrap items-center gap-4">
        <div
          className="h-28 w-28 shrink-0 rounded-full"
          style={{ background: `conic-gradient(${gradiente})` }}
          role="img"
          aria-label={titulo || 'gráfico de pizza'}
        >
          <div className="m-6 h-16 w-16 rounded-full bg-koda-bg" />
        </div>
        <ul className="flex min-w-0 flex-col gap-1 text-[12px] text-koda-fg/75">
          {fatias.map((fatia) => (
            <li key={fatia.rotulo} className="flex items-center gap-2">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: fatia.cor }} />
              <span className="truncate">{fatia.rotulo}</span>
              <span className="ml-auto font-mono text-koda-fg/45">{Math.round((fatia.valor / total) * 100)}%</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function Diferenca({ antes, depois }: { antes: string; depois: string }) {
  const linhas = useMemo(() => diffDeLinhas(antes, depois), [antes, depois])
  return (
    <div className="max-h-80 overflow-auto rounded-lg border border-koda-fg/8 font-mono text-[12px]">
      {linhas.map((linha, indice) => (
        <div
          key={indice}
          className={`flex gap-2 px-2 py-0.5 ${
            linha.tipo === 'add'
              ? 'bg-emerald-400/10 text-emerald-200'
              : linha.tipo === 'del'
                ? 'bg-rose-400/10 text-rose-200'
                : 'text-koda-fg/65'
          }`}
        >
          <span className="w-3 shrink-0 text-koda-fg/30">{linha.tipo === 'add' ? '+' : linha.tipo === 'del' ? '−' : ' '}</span>
          <span className="whitespace-pre-wrap">{linha.texto || ' '}</span>
        </div>
      ))}
    </div>
  )
}

function diffDeLinhas(antes: string, depois: string): Array<{ tipo: 'ctx' | 'add' | 'del'; texto: string }> {
  const a = antes.split('\n').slice(0, 400)
  const b = depois.split('\n').slice(0, 400)
  const tabela = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      tabela[i][j] = a[i] === b[j] ? tabela[i + 1][j + 1] + 1 : Math.max(tabela[i + 1][j], tabela[i][j + 1])
    }
  }
  const saida: Array<{ tipo: 'ctx' | 'add' | 'del'; texto: string }> = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      saida.push({ tipo: 'ctx', texto: a[i] })
      i += 1
      j += 1
    } else if (tabela[i + 1][j] >= tabela[i][j + 1]) {
      saida.push({ tipo: 'del', texto: a[i] })
      i += 1
    } else {
      saida.push({ tipo: 'add', texto: b[j] })
      j += 1
    }
  }
  while (i < a.length) saida.push({ tipo: 'del', texto: a[i++] })
  while (j < b.length) saida.push({ tipo: 'add', texto: b[j++] })
  return saida
}

// ------------------------------------------------------------------ fallback e erros

function FalhaDocumento({ erro }: { erro: string }) {
  console.warn('[koda-ui] documento não desenhado:', erro)
  return (
    <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-3 text-[12.5px] text-amber-200/90">
      <p className="font-medium">Não consegui desenhar esta interface.</p>
      <p className="mt-1 text-amber-200/60">O conteúdo continua disponível em texto na resposta.</p>
    </div>
  )
}

function FalhaNo({ no }: { no: KodaNo }) {
  console.warn('[koda-ui] componente não desenhado:', no.type)
  return (
    <div className="rounded-lg border border-amber-400/25 bg-amber-400/[0.07] p-2.5 text-[12.5px] text-amber-200/90">
      O componente <code className="font-mono">{no.type}</code> não pôde ser desenhado.
    </div>
  )
}

class LimiteDeErro extends Component<{ children: ReactNode; fallback: ReactNode }, { falhou: boolean }> {
  state = { falhou: false }

  static getDerivedStateFromError() {
    return { falhou: true }
  }

  componentDidCatch(erro: unknown) {
    console.warn('[koda-ui] erro em componente:', erro)
  }

  render() {
    return this.state.falhou ? this.props.fallback : this.props.children
  }
}

// ------------------------------------------------------------------ utilidades
