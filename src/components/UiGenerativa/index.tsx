/**
 * O interpretador da árvore: liga o parser ao React e ao avaliador.
 *
 * Junta as peças: `parseUi` (a árvore), `avaliar` (a lógica sem `eval`) e os
 * `COMPONENTES` (o desenho). Quem chama passa o texto do bloco `koda-ui` e recebe a
 * interface montada.
 *
 * O `useState` da árvore vira estado React de verdade: quando a IA escreve
 * `{@body const [count, setCount] = DIL.useState(0)}`, `count` é guardado aqui, e os
 * eventos (`onClick`, `onChange`) chamam o `set` — a tela re-renderiza sozinha.
 */

import { Fragment, createElement, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { avaliar } from './avaliador'
import {
  COMPONENTES,
  Accordion,
  Box,
  Carousel,
  Chart,
  DatePicker,
  Desconhecido,
  Popover,
  Repeat,
  Steps,
  Tabs,
  Toggle,
  type EstadoUI,
} from './componentes'
import { alvoDoEvento, nomeDoEstado, querNumero } from './eventos'
import { parseUi, type Estado, type ListaUI, type No } from './parser'

/** Os componentes com estado interno — montados à parte, com `createElement`. */
const COM_ESTADO_INTERNO: Record<string, (props: Record<string, unknown>) => ReactNode> = {
  box: Box,
  chart: Chart,
  carousel: Carousel,
  popover: Popover,
  date: DatePicker,
  accordion: Accordion,
  steps: Steps,
  tabs: Tabs,
  toggle: Toggle,
  repeat: Repeat,
}

/** A interface que a IA descreve, desenhada de verdade. */
export function DesenhoUi({ fonte }: { fonte: string }): ReactNode {
  const { estado, funcoes, arvore } = useMemo(() => parseUi(fonte), [fonte])
  // Cada nome de estado do {@body} vira um useState de verdade, guardado num mapa.
  const [valores, setValores] = useState<Estado>(estado)

  // **Re-sync só quando o bloco COMPLETOU (streaming).** A resposta chega em pedaços e o
  // `{@body}` cresce a cada delta; o parse devolve chaves parciais no meio. Reagir a cada
  // delta (como fazia a versão anterior) criava um **laço de render**: cada delta → chave
  // nova → setValores → re-render → novo fonte → parse → chave nova → setValores… e o
  // navegador matava a página com «Page Unresponsive» (visto em 17/10/2026). A cura é
  // sincronizar **uma vez**, quando a árvore já montou (o `{@body}` fechou e há tags) — e
  // nunca sobrescrever o que a pessoa já mexeu. Antes disso, o useState inicial já carrega
  // o que der do parse parcial.
  const blocoCompleto = arvore.length > 0
  const sincronizado = useRef(false)
  useEffect(() => {
    if (!blocoCompleto || sincronizado.current) return
    sincronizado.current = true
    setValores((atuais) => {
      const proximas: Estado = { ...atuais }
      // preenche SÓ o que falta, com o valor inicial do parse. O que a pessoa já mexeu
      // (mesma chave) fica intacto.
      for (const chave of Object.keys(estado)) {
        if (!(chave in atuais)) proximas[chave] = estado[chave]
      }
      return proximas
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocoCompleto])

  const estadoUI: EstadoUI = {
    valor: valores,
    funcoes,
    set: (nome: string, valor: number | string | boolean | ListaUI) =>
      setValores((v: Estado) => ({ ...v, [nome]: valor })),
  }

  const nos = arvore.map((no, i) => montar(no, i, estadoUI))
  return <>{nos}</>
}

/** O contexto de estado que os componentes usam nos eventos. */
type Ctx = EstadoUI

/** Monta um nó da árvore em elemento React. */
function montar(no: No, chave: number, estado: Ctx): ReactNode {
  if (no.tag === 'texto') {
    return <span key={chave}>{no.valor}</span>
  }

  if (no.tag === 'expressao') {
    const v = avaliar(no.corpo, estado.valor, estado.funcoes)
    return (
      <span key={chave} className="font-mono text-koda-fg/90">
        {v === undefined ? '' : String(v)}
      </span>
    )
  }

  // Resolve os props: literal fica como veio, expressão é avaliada contra o estado.
  const props: Record<string, unknown> = {}
  for (const [nome, valor] of Object.entries(no.props)) {
    if (valor.tipo === 'literal') {
      props[nome] = valor.valor
    } else {
      const v = avaliar(valor.corpo, estado.valor, estado.funcoes)
      props[nome] = v === undefined ? '' : v
    }
  }

  // Os eventos: `onClick={() => setCount(count + 1)}`. O parser guarda o corpo da
  // função; aqui a gente reconhece o padrão `setX(expr)` e chama o set de verdade.
  ligarEventos(no, props, estado)

  const filhos = no.filhos.map((filho, i) => montar(filho, i, estado))
  const nomeComp = no.tag === 'componente' ? no.nome : no.tag

  // Com estado interno (accordion, steps, tabs, toggle, repeat): componente React.
  const ComInterno = COM_ESTADO_INTERNO[nomeComp]
  if (ComInterno) {
    return (
      <Fragment key={chave}>
        {createElement(ComInterno, { ...props, filhos, estado })}
      </Fragment>
    )
  }

  // Sem estado interno: função pura do mapa (recebe props + filhos num objeto).
  const Comp = COMPONENTES[nomeComp]
  if (Comp) {
    return <Fragment key={chave}>{Comp({ ...props, filhos })}</Fragment>
  }
  return <Desconhecido key={chave} nome={nomeComp} />
}

/**
 * Liga `onClick`/`onChange` ao estado. A IA escreve `onClick={() => setCount(count + 1)}`;
 * o parser entrega o corpo `() => setCount(count + 1)`. Aqui reconhece-se o
 * `setNome(expressão)`, avalia a expressão contra o estado atual e chama o set.
 *
 * Não é `eval`: é casar um padrão conhecido (`set` + nome + uma expressão do avaliador).
 * Corpo que não casa o padrão é ignorado — o botão fica sem ação, não executa nada.
 */
function ligarEventos(no: No, props: Record<string, unknown>, estado: Ctx): void {
  if (no.tag !== 'componente') return
  const chaves = Object.keys(estado.valor)
  for (const [nome, valor] of Object.entries(no.props)) {
    if (valor.tipo !== 'expr') continue
    if (nome !== 'onClick' && nome !== 'onChange') continue
    // corpo: `() => setCount(count + 1)` ou `(e) => setUsuarios(Number(e.target.value))`
    const evento = alvoDoEvento(valor.corpo)
    if (!evento) continue
    // A chave de verdade: casa `setUsuarios` com o estado `usuarios` (minúscula).
    const alvo = nomeDoEstado(evento.alvo, chaves)
    const expr = evento.expr
    const querNumeroAqui = querNumero(expr)
    props[nome] = (recebido?: unknown) => {
      // O valor chega de **dois** jeitos, e o handler tem de entender os dois:
      //
      // 1. o componente já extraiu o valor e passou a string/número (`slider`, `input`,
      //    `select` chamam `mudar(e.target.value)`);
      // 2. o componente passou o objeto do evento de verdade (aí tem `.target.value`).
      //
      // Antes só o caso 2 era tratado: como o `slider` passava a string, o handler
      // tentava ler `.target.value` de uma string, dava `undefined`, o estado virava
      // vazio e o input **travava no lugar** — a barra não arrastava (visto em
      // 17/10/2026). Agora o valor é lido dos dois.
      let valorDoControle: string | number | boolean | undefined
      if (typeof recebido === 'string' || typeof recebido === 'number') {
        valorDoControle = recebido
      } else {
        valorDoControle = (recebido as { target?: { value?: string } })?.target?.value
      }
      if (valorDoControle !== undefined) {
        const valorFinal = querNumeroAqui ? Number(valorDoControle) : valorDoControle
        estado.set(alvo, valorFinal)
        return
      }
      const v = avaliar(expr, estado.valor, estado.funcoes)
      if (v !== undefined) estado.set(alvo, v as number | string | boolean)
    }
  }
}
