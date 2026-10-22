/**
 * Os componentes da UI generativa — o catálogo que a IA pode usar.
 *
 * ## O estilo é o do Koda, não outro
 *
 * Estes componentes **não** têm visual próprio: eles imitam a moldura canônica do Koda
 * (ver `Moldura` e `Quiz` no `BlocosVisuais.tsx`), que é:
 *
 *     rounded-xl border border-koda-fg/10 bg-koda-fg/[0.03]
 *
 * Fundo é **tint** (`koda-fg` a 3 %), não painel — é o que faz a interface gerada
 * assentar no fundo da conversa em vez de parecer uma caixa clara flutuando ("caixa
 * dentro de caixa", que era o defeito apontado pelo dono). Tipografia, bordas e cores
 * de estado (emerald/rose no certo/errado) saem da mesma paleta `koda-*`.
 *
 * ## Sem borda duplicada
 *
 * Caixa dentro de caixa com borda nos dois níveis vira "caixa dentro de caixa". O
 * `Nivel` (Context) conta a profundidade: a **primeira** caixa de uma tela tem a borda e
 * o tint; as de dentro ficam **planas** (sem borda, sem fundo), só com o espaçamento. O
 * resultado é uma superfície única, igual ao `BlocosVisuais`, e não um app separado.
 *
 * A lista é grande de propósito (é a resposta a "7 é pouco"): estrutura, formulário,
 * dados, layout e mídia. A IA compõe com eles; componente que ela inventar cai no
 * `Desconhecido`, que explica quais existem — nunca HTML cru, nunca `eval`.
 */

import { createContext, useContext, useState } from 'react'
import type { ReactNode } from 'react'

import { Balao, useInteracao } from '../BlocosInteracao'

import type { Estado, FuncoesUI } from './parser'

/** As props que a IA passou, já resolvidas para valores de verdade. */
export type Props = Record<string, unknown>

/** O catálogo. O valor é o componente; quem monta é o `DesenhoUi`. */
export type Comp = (props: Props & { filhos?: ReactNode[] }) => ReactNode

/** O estado compartilhado (`useState`/`useList` declarado no `{@body}`). */
export type EstadoUI = {
  valor: Estado
  funcoes: FuncoesUI
  set: (nome: string, valor: unknown) => void
}

// ---------------------------------------------------------------- o nível de caixa

/**
 * A profundidade da caixa atual. 0 = fora de toda caixa; 1 = primeira caixa da tela;
 * 2+ = caixa dentro de caixa.
 */
const Nivel = createContext(0)

/**
 * A superfície **plana**: borda fina, sem fundo, só o canto arredondado.
 *
 * É o que faz a interface gerada assentar no fundo da conversa em vez de flutuar como
 * cartão acinzentado (o defeito que o dono apontou). A resposta do Koda não tem fundo de
 * caixa — o texto flui no fundo — e aqui é igual: a superfície é só uma linha fina
 * marcando o limite, sem tinta por trás. Só o que é interativo de verdade (botão, input)
 * leva o leve realce no fundo.
 */
const SUPERFICIE_PLANA = 'rounded-lg border border-koda-fg/8 p-2.5'

export const COMPONENTES: Record<string, Comp> = {
  // ------------------------------------------------------------ estrutura e texto
  title: ({ valor }: Props) => (
    <span className="text-[13.5px] font-semibold text-koda-fg/90">{String(valor ?? '')}</span>
  ),
  texto: ({ valor }: Props) => <span className="text-[13.5px] text-koda-fg/85">{String(valor ?? '')}</span>,
  label: ({ valor, filhos }: Props & { filhos?: ReactNode[] }) => (
    <span className="flex flex-col gap-1 text-[12.5px] text-koda-fg/60">
      {String(valor ?? '')}
      {filhos}
    </span>
  ),
  paragrafo: ({ valor }: Props) => (
    <p className="text-[13.5px] leading-relaxed text-koda-fg/85">{String(valor ?? '')}</p>
  ),

  // ------------------------------------------------------------ ação
  button: ({ valor, onClick, filhos }: Props & { filhos?: ReactNode[] }) => {
    const acao = typeof onClick === 'function' ? onClick : undefined
    return (
      <button
        type="button"
        onClick={acao ? () => acao() : undefined}
        className="rounded-lg bg-koda-fg/8 px-3 py-1.5 text-[12.5px] font-medium text-koda-fg/80 transition-colors hover:bg-koda-fg/14 hover:text-koda-fg"
      >
        {filhos && filhos.length ? filhos : String(valor ?? 'ok')}
      </button>
    )
  },
  iconbutton: ({ valor, onClick }: Props) => {
    const acao = typeof onClick === 'function' ? onClick : undefined
    return (
      <button
        type="button"
        onClick={acao ? () => acao() : undefined}
        className="flex h-7 w-7 items-center justify-center rounded-lg text-koda-fg/50 transition-colors hover:bg-koda-fg/8 hover:text-koda-fg/80"
        aria-label={String(valor ?? 'ação')}
      >
        {String(valor ?? '•')}
      </button>
    )
  },
  link: ({ valor }: Props) => (
    <span className="text-[13px] text-koda-accent underline underline-offset-2">{String(valor ?? '')}</span>
  ),

  // ------------------------------------------------------------ formulário
  slider: ({ valor, min, max, step, rotulo, onChange }: Props) => {
    const mudar = typeof onChange === 'function' ? onChange : undefined
    return (
      <label className="flex flex-col gap-1">
        <span className="flex items-center justify-between text-[12.5px] text-koda-fg/60">
          <span>{String(rotulo ?? 'valor')}</span>
          <span className="font-mono text-koda-fg/85">{String(valor ?? 0)}</span>
        </span>
        <input
          type="range"
          min={Number(min ?? 0)}
          max={Number(max ?? 100)}
          step={Number(step ?? 1)}
          value={Number(valor ?? 0)}
          onChange={(e) => mudar?.(e.target.value)}
          className="w-full accent-koda-accent"
        />
      </label>
    )
  },
  input: ({ valor, placeholder, onChange }: Props) => {
    const mudar = typeof onChange === 'function' ? onChange : undefined
    return (
      <input
        type="text"
        value={String(valor ?? '')}
        placeholder={String(placeholder ?? '')}
        onChange={(e) => mudar?.(e.target.value)}
        className="w-full rounded-lg bg-koda-fg/[0.04] px-2.5 py-1.5 text-[13px] text-koda-fg ring-1 ring-koda-fg/10 outline-none placeholder:text-koda-fg/30 focus:ring-koda-accent"
      />
    )
  },
  select: ({ valor, opcoes, onChange }: Props) => {
    const mudar = typeof onChange === 'function' ? onChange : undefined
    const lista = Array.isArray(opcoes) ? (opcoes as string[]) : []
    return (
      <select
        value={String(valor ?? '')}
        onChange={(e) => mudar?.(e.target.value)}
        className="w-full rounded-lg bg-koda-fg/[0.04] px-2.5 py-1.5 text-[13px] text-koda-fg ring-1 ring-koda-fg/10 outline-none focus:ring-koda-accent"
      >
        {lista.map((o, i) => (
          <option key={i} value={o}>
            {o}
          </option>
        ))}
      </select>
    )
  },
  checkbox: ({ valor, rotulo, onChange }: Props) => {
    const marcado = valor === true
    const mudar = typeof onChange === 'function' ? onChange : undefined
    return (
      <label className="flex items-center gap-2 text-[13px] text-koda-fg/85">
        <input
          type="checkbox"
          checked={marcado}
          onChange={() => mudar?.(marcado ? 'false' : 'true')}
          className="h-4 w-4 accent-koda-accent"
        />
        {String(rotulo ?? '')}
      </label>
    )
  },
  form: ({ filhos }: Props & { filhos?: ReactNode[] }) => (
    <form className="flex flex-col gap-2.5" onSubmit={(e) => e.preventDefault()}>
      {filhos}
    </form>
  ),
  textarea: ({ valor, placeholder, onChange }: Props) => {
    const mudar = typeof onChange === 'function' ? onChange : undefined
    return (
      <textarea
        value={String(valor ?? '')}
        placeholder={String(placeholder ?? '')}
        onChange={(e) => mudar?.(e.target.value)}
        rows={3}
        className="w-full resize-y rounded-lg bg-koda-fg/[0.04] px-2.5 py-1.5 text-[13px] text-koda-fg ring-1 ring-koda-fg/10 outline-none placeholder:text-koda-fg/30 focus:ring-koda-accent"
      />
    )
  },
  radio: ({ valor, opcoes, onChange }: Props) => {
    const mudar = typeof onChange === 'function' ? onChange : undefined
    const lista = Array.isArray(opcoes) ? (opcoes as string[]) : []
    return (
      <div className="flex flex-col gap-1.5">
        {lista.map((o, i) => (
          <label key={i} className="flex items-center gap-2 text-[13px] text-koda-fg/85">
            <input
              type="radio"
              checked={String(valor) === o}
              onChange={() => mudar?.(o)}
              className="h-4 w-4 accent-koda-accent"
            />
            {o}
          </label>
        ))}
      </div>
    )
  },
  segmented: ({ valor, opcoes, onChange }: Props) => {
    const mudar = typeof onChange === 'function' ? onChange : undefined
    const lista = Array.isArray(opcoes) ? (opcoes as string[]) : []
    return (
      <div className="inline-flex overflow-hidden rounded-lg border border-koda-fg/12">
        {lista.map((o, i) => (
          <button
            key={i}
            type="button"
            onClick={() => mudar?.(o)}
            className={`px-3 py-1 text-[12.5px] transition-colors ${
              String(valor) === o
                ? 'bg-koda-accent-strong text-white'
                : 'text-koda-fg/70 hover:bg-koda-fg/8'
            }`}
          >
            {o}
          </button>
        ))}
      </div>
    )
  },
  pressable: ({ valor, onClick, filhos }: Props & { filhos?: ReactNode[] }) => {
    const acao = typeof onClick === 'function' ? onClick : undefined
    return (
      <button
        type="button"
        onClick={acao ? () => acao() : undefined}
        className="rounded-lg px-2 py-1 text-left text-[13px] text-koda-fg/85 transition-colors hover:bg-koda-fg/8"
      >
        {filhos && filhos.length ? filhos : String(valor ?? '')}
      </button>
    )
  },

  // ------------------------------------------------------------ dados e exibição
  table: ({ colunas, linhas }: Props) => {
    const cols = Array.isArray(colunas) ? (colunas as string[]) : []
    const rows = Array.isArray(linhas) ? (linhas as unknown[][]) : []
    return (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              {cols.map((c, i) => (
                <th
                  key={i}
                  className="border-b border-koda-fg/10 px-2 py-1.5 text-left font-semibold text-koda-fg/80"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((linha, i) => (
              <tr key={i}>
                {linha.map((cel, j) => (
                  <td key={j} className="border-b border-koda-fg/6 px-2 py-1.5 text-koda-fg/70">
                    {String(cel ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  },
  stat: ({ valor, rotulo, variacao }: Props) => (
    <div className="flex flex-col rounded-lg border border-koda-fg/8 p-2.5">
      <span className="text-[11px] tracking-wide text-koda-fg/45 uppercase">{String(rotulo ?? '')}</span>
      <span className="text-[20px] font-semibold text-koda-fg">{String(valor ?? '')}</span>
      {variacao ? <span className="text-[12px] text-emerald-400/80">{String(variacao)}</span> : null}
    </div>
  ),
  list: ({ itens, filhos }: Props & { filhos?: ReactNode[] }) => {
    const lista = Array.isArray(itens) ? (itens as string[]) : []
    return (
      <ul className="flex list-disc flex-col gap-1 pl-4 text-[13.5px] text-koda-fg/80">
        {lista.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
        {filhos}
      </ul>
    )
  },
  badge: ({ valor, tom }: Props) => {
    const cor =
      String(tom) === 'erro'
        ? 'bg-rose-400/15 text-rose-300'
        : String(tom) === 'aviso'
          ? 'bg-amber-400/15 text-amber-200'
          : String(tom) === 'ok'
            ? 'bg-emerald-400/15 text-emerald-300'
            : 'bg-koda-fg/10 text-koda-fg/70'
    return (
      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${cor}`}>{String(valor ?? '')}</span>
    )
  },
  alert: ({ valor, tom }: Props) => {
    const cor =
      String(tom) === 'erro'
        ? 'border-rose-400/25 text-rose-200'
        : String(tom) === 'aviso'
          ? 'border-amber-400/25 text-amber-200'
          : 'border-koda-fg/8 text-koda-fg/80'
    return <div className={`rounded-lg border p-2.5 text-[12.5px] ${cor}`}>{String(valor ?? '')}</div>
  },
  progress: ({ valor, max }: Props) => {
    const pct = Math.min(100, Math.max(0, (Number(valor ?? 0) / Number(max ?? 100)) * 100))
    return (
      <div className="h-2 w-full overflow-hidden rounded-full bg-koda-fg/10">
        <div className="h-full rounded-full bg-koda-accent" style={{ width: `${pct}%` }} />
      </div>
    )
  },
  card: ({ titulo, filhos }: Props & { filhos?: ReactNode[] }) => (
    <div className="flex flex-col gap-2 rounded-lg border border-koda-fg/8 p-3">
      {titulo ? <span className="text-[13px] font-semibold text-koda-fg/90">{String(titulo)}</span> : null}
      {filhos}
    </div>
  ),

  // ------------------------------------------------------------ layout
  grid: ({ cols, filhos }: Props & { filhos?: ReactNode[] }) => (
    <div className="grid gap-2" style={grade(cols)}>
      {filhos}
    </div>
  ),
  row: ({ filhos }: Props & { filhos?: ReactNode[] }) => (
    <div className="flex flex-row flex-wrap items-center gap-2">{filhos}</div>
  ),
  column: ({ filhos }: Props & { filhos?: ReactNode[] }) => (
    <div className="flex flex-col gap-2">{filhos}</div>
  ),
  spacer: ({ valor }: Props) => <div style={{ height: `${Number(valor ?? 8)}px` }} />,

  // ------------------------------------------------------------ mídia
  code: ({ valor, linguagem }: Props) => (
    <pre className="overflow-x-auto rounded-lg bg-koda-fg/[0.04] p-2.5 font-mono text-[12.5px] break-normal ring-1 ring-koda-fg/8">
      <code>{String(valor ?? '')}</code>
      {linguagem ? <span className="mt-1 block text-[10.5px] text-koda-fg/30">{String(linguagem)}</span> : null}
    </pre>
  ),
  imagem: ({ src, alt }: Props) => (
    <img src={String(src ?? '')} alt={String(alt ?? '')} className="max-w-full rounded-lg" loading="lazy" />
  ),
  callout: ({ valor, tom }: Props) => {
    const cor =
      String(tom) === 'dica'
        ? 'border-koda-accent/25 text-koda-fg/85'
        : 'border-koda-fg/8 text-koda-fg/75'
    return <div className={`rounded-lg border p-2.5 text-[12.5px] ${cor}`}>{String(valor ?? '')}</div>
  },
  divider: () => <div className="my-1 h-px w-full bg-koda-fg/10" />,
  icon: ({ valor }: Props) => (
    <span aria-hidden className="text-[13px] text-koda-fg/60">
      {String(valor ?? '●')}
    </span>
  ),
  caption: ({ valor }: Props) => (
    <span className="text-[11.5px] text-koda-fg/45">{String(valor ?? '')}</span>
  ),
}

// ---------------------------------------------------------------- com estado interno

/**
 * Os componentes com estado **interno** (não ligado ao `{@body}`): funcionam sozinhos.
 * Montados pelo `DesenhoUi` com `createElement`, e aí o hook de cada um nasce e morre com
 * ele — a mesma razão do componente `Desenho` no `BlocosVisuais`. Chamar hook dentro de
 * função comum do mapa quebraria as regras de hooks do React.
 */

/** `<box>` — a superfície da tela: borda fina, sem fundo, plana no fundo da conversa. */
export function Box({
  filhos,
  padding,
}: Props & { filhos?: ReactNode[] }): ReactNode {
  const nivel = useContext(Nivel)
  // A primeira caixa leva a superfície (borda fina, sem tinta); as de dentro ficam
  // planas — sem borda duplicada, sem fundo. Só espaçamento.
  const superficie = nivel === 0 ? SUPERFICIE_PLANA : ''
  return (
    <Nivel.Provider value={nivel + 1}>
      <div className={`flex min-w-0 flex-col gap-2.5 ${superficie}`} style={espaco(padding)}>
        {filhos}
      </div>
    </Nivel.Provider>
  )
}

export function Toggle({ valor, rotulo, onChange }: Props): ReactNode {
  const [ligado, setLigado] = useState(valor === true)
  const mudar = typeof onChange === 'function' ? onChange : undefined
  return (
    <button
      type="button"
      onClick={() => {
        const prox = !ligado
        setLigado(prox)
        mudar?.(prox ? 'true' : 'false')
      }}
      className={`flex h-6 w-11 items-center rounded-full p-0.5 transition-colors ${ligado ? 'bg-koda-accent-strong' : 'bg-koda-fg/15'}`}
      aria-pressed={ligado}
    >
      <span
        className={`h-5 w-5 rounded-full bg-white transition-transform ${ligado ? 'translate-x-5' : ''}`}
      />
      {rotulo ? <span className="ml-2 text-[12.5px] text-koda-fg/60">{String(rotulo)}</span> : null}
    </button>
  )
}

/**
 * `<chart>` — gráfico de barras **com balão no mouse**, igual ao do Koda.
 *
 * É o mesmo mecanismo do `BlocosVisuais` (`useInteracao` + `Balao`): passar o mouse
 * numa barra mostra o rótulo e o valor formatado num balão que segue o ponteiro; clicar
 * destaca e apaga o resto; `Esc` limpa. Sem isto o gráfico da UI generativa era "burro" —
 * a pessoa via as barras mas não o número de cada uma (o dono cobrou: "passo o mouse e
 * não mostra nada"). Componente com estado interno porque o balão é estado do React.
 */
export function Chart({ dados, titulo }: Props): ReactNode {
  const interacao = useInteracao()
  const lista = Array.isArray(dados)
    ? (dados as Array<{ rotulo?: string; valor?: number }>)
    : []
  if (!lista.length) return <p className="text-[12.5px] text-koda-fg/50">gráfico sem dados</p>
  const maximo = Math.max(...lista.map((d) => Number(d.valor ?? 0)), 1)
  const dica = (d: { rotulo?: string; valor?: number }) => ({
    titulo: String(d.rotulo ?? ''),
    valor: Number(d.valor ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 }),
  })
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {titulo ? <span className="text-[12.5px] text-koda-fg/60">{String(titulo)}</span> : null}
      <div className="flex min-w-0 items-end gap-2 overflow-x-auto pt-1">
        {lista.map((d, i) => {
          const chave = `c${i}`
          return (
            <div
              key={i}
              {...interacao.props(chave, dica(d))}
              className="flex min-w-0 flex-1 flex-col items-center gap-1 transition-opacity"
              style={{ opacity: interacao.temDestaque && !interacao.estaDestacado(chave) ? 0.4 : 1 }}
            >
              <div
                className="w-full rounded-t bg-koda-accent"
                style={{ height: `${Math.max((Number(d.valor ?? 0) / maximo) * 80, 2)}px` }}
              />
              <span className="truncate text-[10.5px] text-koda-fg/50">{String(d.rotulo ?? '')}</span>
            </div>
          )
        })}
      </div>
      <Balao dica={interacao.dica} posicao={interacao.posicao} />
    </div>
  )
}

/** `<carousel itens={[...]}>` — navega entre itens com Anterior/Próximo. */
export function Carousel({ itens }: Props): ReactNode {
  const lista = Array.isArray(itens) ? (itens as string[]) : []
  const [i, setI] = useState(0)
  if (!lista.length) return <p className="text-[12.5px] text-koda-fg/50">carrossel vazio</p>
  return (
    <div className="flex flex-col gap-1.5">
      <div className="rounded-lg border border-koda-fg/8 p-3 text-[13px] text-koda-fg/85">
        {lista[i]}
      </div>
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setI((a) => (a - 1 + lista.length) % lista.length)}
          className="rounded-lg bg-koda-fg/8 px-3 py-1 text-[12px] text-koda-fg/70 hover:bg-koda-fg/14"
        >
          ‹ Anterior
        </button>
        <span className="text-[11px] text-koda-fg/40">
          {i + 1} / {lista.length}
        </span>
        <button
          type="button"
          onClick={() => setI((a) => (a + 1) % lista.length)}
          className="rounded-lg bg-koda-fg/8 px-3 py-1 text-[12px] text-koda-fg/70 hover:bg-koda-fg/14"
        >
          Próximo ›
        </button>
      </div>
    </div>
  )
}

/** `<popover>` — mostra/ esconde conteúdo ao clicar no gatilho. */
export function Popover({ valor, filhos }: Props & { filhos?: ReactNode[] }): ReactNode {
  const [aberto, setAberto] = useState(false)
  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        className="rounded-lg bg-koda-fg/8 px-3 py-1 text-[12.5px] text-koda-fg/80 hover:bg-koda-fg/14"
      >
        {String(valor ?? 'detalhes')}
      </button>
      {aberto ? (
        <div className="absolute top-full left-0 z-10 mt-1 max-w-[280px] rounded-lg border border-koda-fg/12 bg-koda-surface p-2.5 text-[12.5px] text-koda-fg/80 shadow-[0_8px_24px_-8px_var(--koda-shadow)]">
          {filhos}
        </div>
      ) : null}
    </div>
  )
}

/** `<date valor={...} onChange={...}>` — campo de data nativo. */
export function DatePicker({ valor, onChange }: Props): ReactNode {
  const mudar = typeof onChange === 'function' ? onChange : undefined
  return (
    <input
      type="date"
      value={String(valor ?? '')}
      onChange={(e) => mudar?.(e.target.value)}
      className="rounded-lg bg-koda-fg/[0.04] px-2.5 py-1.5 text-[13px] text-koda-fg ring-1 ring-koda-fg/10 outline-none focus:ring-koda-accent"
    />
  )
}

export function Accordion({ valor, filhos }: Props & { filhos?: ReactNode[] }): ReactNode {
  const [aberto, setAberto] = useState(false)
  return (
    <div className="rounded-lg border border-koda-fg/8">
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-[13px] text-koda-fg/85"
        aria-expanded={aberto}      >
        {String(valor ?? 'detalhe')}
        <span className="text-koda-fg/40">{aberto ? '−' : '+'}</span>
      </button>
      {aberto ? <div className="border-t border-koda-fg/8 px-3 py-2">{filhos}</div> : null}
    </div>
  )
}

export function Steps({ itens }: Props): ReactNode {
  const lista = Array.isArray(itens) ? (itens as string[]) : []
  const [atual, setAtual] = useState(0)
  if (!lista.length) return <p className="text-[12.5px] text-koda-fg/50">passos sem itens</p>
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {lista.map((_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setAtual(i)}
            className={`rounded-full px-2.5 py-1 text-[11.5px] ${i === atual ? 'bg-koda-accent-strong text-white' : 'bg-koda-fg/8 text-koda-fg/60'}`}
          >
            {i + 1}
          </button>
        ))}
      </div>
      <div className="rounded-lg border border-koda-fg/8 p-3 text-[13px] text-koda-fg/85">
        <span className="text-[11px] text-koda-fg/40">
          Passo {atual + 1} de {lista.length}
        </span>
        <p className="mt-1">{lista[atual]}</p>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setAtual((a) => Math.max(0, a - 1))}
          className="rounded-lg bg-koda-fg/8 px-3 py-1 text-[12px] text-koda-fg/70 hover:bg-koda-fg/14"
        >
          Anterior
        </button>
        <button
          type="button"
          onClick={() => setAtual((a) => Math.min(lista.length - 1, a + 1))}
          className="rounded-lg bg-koda-accent-strong px-3 py-1 text-[12px] text-white hover:bg-koda-accent-strong/85"
        >
          Próximo
        </button>
      </div>
    </div>
  )
}

export function Tabs({ itens }: Props): ReactNode {
  const lista = Array.isArray(itens) ? (itens as string[]) : []
  const [aba, setAba] = useState(0)
  if (!lista.length) return <p className="text-[12.5px] text-koda-fg/50">abas sem itens</p>
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1 border-b border-koda-fg/10">
        {lista.map((t, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setAba(i)}
            className={`px-3 py-1.5 text-[12.5px] ${i === aba ? 'border-b-2 border-koda-accent text-koda-fg/90' : 'text-koda-fg/50'}`}
          >
            {t}
          </button>
        ))}
      </div>
      <p className="text-[13px] text-koda-fg/75">{lista[aba]}</p>
    </div>
  )
}

/** `<repeat itens={lista}>` — renderiza um filho por item (a lista dinâmica). */
export function Repeat({
  itens,
  filhos,
  estado,
  renderizar,
}: Props & {
  filhos?: ReactNode[]
  estado?: EstadoUI
  renderizar?: (item: unknown, indice: number) => ReactNode
}): ReactNode {
  const lista = Array.isArray(itens)
    ? itens
    : estado && Array.isArray(estado.valor[String(itens)])
      ? (estado.valor[String(itens)] as unknown[])
      : []
  if (!lista.length) return <p className="text-[12.5px] text-koda-fg/45">lista vazia</p>
  const visiveis = lista.slice(0, 100)
  return (
    <div className="flex flex-col gap-1.5">
      {visiveis.map((item, i) => (
        <div key={typeof item === 'object' && item && 'id' in item ? String((item as { id: unknown }).id) : i} className="flex items-start gap-2">
          <span className="mt-0.5 text-[11px] text-koda-fg/35">{i + 1}.</span>
          {renderizar ? (
            <div className="min-w-0 flex-1">{renderizar(item, i)}</div>
          ) : filhos && filhos.length ? (
            <div className="min-w-0 flex-1">{filhos}</div>
          ) : (
            <span className="text-[13px] text-koda-fg/80">
              {item && typeof item === 'object' && 'texto' in item
                ? String((item as { texto: unknown }).texto ?? '')
                : String(item ?? '')}
            </span>
          )}
        </div>
      ))}
      {lista.length > visiveis.length ? (
        <span className="text-[11px] text-koda-fg/45">Mostrando 100 de {lista.length} itens.</span>
      ) : null}
    </div>
  )
}

/** Componente que a IA inventou e não existe: explica, não quebra. */
export function Desconhecido({ nome }: { nome: string }): ReactNode {
  const lista = [...Object.keys(COMPONENTES), 'accordion', 'steps', 'tabs', 'toggle', 'repeat', 'chart', 'carousel', 'popover', 'date'].join(', ')
  return (
    <div className="rounded-lg border border-amber-400/25 bg-amber-400/[0.07] p-2.5 text-[12.5px] text-amber-200/90">
      <p className="font-medium">
        Não conheço o componente <code className="font-mono">&lt;{nome}&gt;</code>.
      </p>
      <p className="mt-1 text-amber-200/60">Disponíveis: {lista}.</p>
    </div>
  )
}

/** O `padding={3}` vira espaçamento de verdade (escala 0–8 → 0–32px). */
function espaco(padding: unknown): React.CSSProperties {
  const p = Number(padding ?? 0)
  return p > 0 ? { padding: `${Math.min(p, 8) * 4}px` } : {}
}

/** O `grid cols={3}` vira `grid-template-columns`. */
function grade(cols: unknown): React.CSSProperties {
  return { gridTemplateColumns: `repeat(${Math.max(1, Number(cols ?? 2))}, minmax(0, 1fr))` }
}
