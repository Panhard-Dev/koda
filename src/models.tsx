import KodaLogo from './components/KodaLogo'
import type { MenuOption } from './components/Menu'

/**
 * A coroa é a marca da casa e vai em **todo** item de modelo — categoria e modelo, na
 * lista viva e na de emergência. Antes a lista viva usava um ícone genérico (Sparkles) e
 * aí, quando o host passou a responder, a coroa desaparecia do seletor inteiro: o menu
 * mudava de cara só porque o backend estava no ar.
 */
const MODEL_ICON = <KodaLogo className="h-3.5 w-auto" color="currentColor" />

/** Modelo que veio do backend (ex.: o catálogo que o serviço publica em /v1/models). */
export type RemoteModel = {
  value: string
  label: string
  hint?: string | null
  /**
   * O código HTTP que este modelo devolveu quando o backend o testou.
   *
   * `200` = respondeu. Qualquer outro = não atende, e o item **sai do seletor** (ver
   * `modelMenu`). `null`/ausente = não testado, ou o host não respondeu — aí o modelo fica,
   * porque um host calado não prova que o modelo sumiu.
   */
  status?: number | null
  /**
   * Teto de contexto do modelo, em tokens — o denominador do medidor de contexto.
   *
   * Vem do backend, que usa o teto que ele mesmo aplica à conversa: o host não publica a
   * janela de cada modelo.
   */
  janela?: number | null
}

const model = (value: string, label: string): MenuOption => ({
  value,
  label,
  icon: MODEL_ICON,
})

/**
 * A etiqueta de aviso de um item do seletor — hoje só «Tempo limitado».
 *
 * O âmbar é a cor de aviso que o app já usa (cartão de permissão, recados de sessão); um
 * aviso com a cor do accent pareceria destaque, não aviso.
 *
 * Existe como componente, e não como texto solto em cada lista, porque o aviso precisa
 * aparecer **igual** na lista viva e na de emergência: divergir entre as duas foi o defeito
 * que a coroa no ícone já consertou uma vez — o menu mudava de cara conforme o host
 * respondesse ou não.
 */
function Aviso({ texto }: { texto: string }) {
  return (
    <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-amber-300 ring-1 ring-amber-500/20">
      {texto}
    </span>
  )
}

/**
 * Catálogo da casa, o espelho de emergência do seletor.
 *
 * Esta lista é só o que o seletor mostra enquanto o backend não respondeu: quando ele
 * responde, é o `/api/models` dele — que vem do serviço — que manda. Os ids daqui são os
 * mesmos que o serviço aceita; qualquer nome fora do catálogo dele é recusado.
 *
 * Ordem do maior para o menor, igual à que o backend calcula em `routers/models.py`.
 */
export const MODEL_MENU: MenuOption[] = [
  {
    value: 'categoria-liz',
    label: 'Liz',
    icon: MODEL_ICON,
    options: [
      model('liz-4', 'Liz 4'),
      model('liz-3-flash', 'Liz 3 Flash'),
      model('liz-mini-2', 'Liz Mini 2'),
      model('liz-mini-1-3', 'Liz Mini 1.3'),
      model('liz-nano', 'Liz Nano'),
    ],
  },
  {
    value: 'categoria-koda',
    label: 'Koda',
    icon: MODEL_ICON,
    options: [model('koda-1', 'Koda 1')],
  },
  {
    value: 'categoria-layze',
    label: 'Layze',
    icon: MODEL_ICON,
    options: [model('layze-2', 'Layze 2')],
  },
  {
    value: 'categoria-nable',
    label: 'Nable',
    icon: MODEL_ICON,
    trailing: <Aviso texto="Tempo limitado" />,
    options: [model('nable-4-mini-preview', 'Nable 4 Mini Preview')],
  },
]

/** Modelo usado quando a interface ainda não recebeu o catálogo do backend. */
export const MODELO_PADRAO = 'liz-4'

export const ALL_MODELS = MODEL_MENU.flatMap((category) => category.options ?? [])

export const MODEL_LABELS: Record<string, string> = Object.fromEntries(
  // `label` de um MenuOption aceita JSX; aqui os rótulos são todos strings fixas.
  ALL_MODELS.map((option) => [option.value, option.label as string]),
)

/** Prefixos de id que viram uma categoria no seletor (liz-nano → Liz). */
const GRUPOS: { chave: string; label: string; aviso?: string }[] = [
  { chave: 'liz', label: 'Liz' },
  { chave: 'koda', label: 'Koda' },
  { chave: 'layze', label: 'Layze' },
  { chave: 'nable', label: 'Nable', aviso: 'Tempo limitado' },
]

/**
 * O código HTTP ao lado do nome do modelo: «Liz 4 - 200».
 *
 * É a prova do que o backend testou, à vista na própria lista. O verde marca o que
 * respondeu 200; o âmbar, o que respondeu outra coisa sem ter saído do catálogo (cota,
 * credencial, host engasgado). O 400 não chega aqui: ele sai do seletor em `modelMenu`.
 */
function Codigo({ status }: { status: number }) {
  const bom = status === 200
  return (
    <span className="ml-1.5 font-mono text-[11px] tabular-nums">
      <span className="text-koda-fg/45">-</span>{' '}
      <span className={bom ? 'text-emerald-400/80' : 'text-amber-300/80'}>{status}</span>
    </span>
  )
}

/**
 * Seletor de modelo: as categorias do host, montadas a partir do que o backend devolveu.
 *
 * O agrupamento é por prefixo do id em vez de uma lista fixa aqui — assim um modelo novo
 * do host aparece no seletor sozinho, sem precisar mexer no frontend. Os ícones são os
 * mesmos da lista de emergência, para o menu não mudar de aparência conforme o backend
 * responda ou não.
 *
 * `bloqueados` é o recorte do painel: os slugs que ele cadastrou e depois tirou (modelo
 * desativado, ou exceção individual desligada). Vale para as **duas** listas de propósito —
 * a viva e a de emergência. Um modelo desativado que reaparecesse sempre que o host ficasse
 * calado seria o mesmo defeito de antes, só mais difícil de flagrar.
 *
 * O `status` de cada modelo é o código que o backend **testou**: ele sai ao lado do nome
 * («Liz 4 - 200»). Um modelo com **400** não entra na lista — é o host dizendo que não tem
 * mais aquele (`liz-4` saiu do catálogo), e é isso que tira o modelo do seletor sem a
 * pessoa precisar recarregar o app. Os outros códigos (429, 401, 500) mantêm o modelo na
 * lista com o número à vista: ele existe, e o número diz o que aconteceu.
 * `status` ausente não exclui ninguém: host calado não prova que o modelo sumiu.
 */
export function modelMenu(items: RemoteModel[] = [], bloqueados: readonly string[] = []): MenuOption[] {
  const liberado = (value: string) => !bloqueados.includes(value)

  if (items.length === 0) {
    if (bloqueados.length === 0) return MODEL_MENU
    return MODEL_MENU.map((categoria) => ({
      ...categoria,
      options: (categoria.options ?? []).filter((opcao) => liberado(opcao.value)),
    })).filter((categoria) => (categoria.options ?? []).length > 0)
  }

  const opcao = (item: RemoteModel): MenuOption => ({
    value: item.value,
    label:
      typeof item.status === 'number' ? (
        <>
          {item.label}
          <Codigo status={item.status} />
        </>
      ) : (
        item.label
      ),
    hint: item.hint ?? undefined,
    icon: MODEL_ICON,
  })

  // Sai da lista só o que o host **recusou por não ter mais** (400). Um 429 é cota, um 401
  // é credencial e um 500 é o host engasgado: nesses o modelo existe, e sumir com ele
  // esconderia o modelo justamente na hora em que a pessoa precisa saber que ele está lá.
  const visiveis = items.filter(
    (item) => liberado(item.value) && item.status !== 400,
  )
  const grupos: MenuOption[] = []
  const usados = new Set<string>()
  for (const grupo of GRUPOS) {
    const meus = visiveis.filter((item) => item.value.startsWith(`${grupo.chave}-`))
    if (meus.length === 0) continue
    meus.forEach((item) => usados.add(item.value))
    grupos.push({
      value: `categoria-${grupo.chave}`,
      label: grupo.label,
      icon: MODEL_ICON,
      trailing: grupo.aviso ? <Aviso texto={grupo.aviso} /> : undefined,
      options: meus.map(opcao),
    })
  }

  const outros = visiveis.filter((item) => !usados.has(item.value))
  if (outros.length > 0) {
    grupos.push({
      value: 'categoria-outros',
      label: 'Outros',
      icon: MODEL_ICON,
      options: outros.map(opcao),
    })
  }
  return grupos
}

/** Um modelo pelo `value`, com o rótulo do catálogo da casa ou do backend. */
export function findModel(value: string, items: RemoteModel[] = []): MenuOption {
  const remoto = items.find((item) => item.value === value)
  if (remoto) return { value: remoto.value, label: remoto.label, icon: MODEL_ICON }
  return ALL_MODELS.find((item) => item.value === value) ?? { value, label: value, icon: MODEL_ICON }
}



