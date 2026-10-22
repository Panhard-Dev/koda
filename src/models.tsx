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
 * Ordem das **famílias** (Liz, Layze, Koda, Nable) e, dentro de cada uma, do maior para o
 * menor. A ordem entre famílias não sai do backend: `routers/models.py` só ordena por peso
 * dentro do que ele devolve, e o front é que agrupa (ver `FAMILIAS`).
 *
 * Atualizada em 17/10/2026 contra o catálogo ao vivo do host: o host trocou `liz-4` por
 * `liz-4-5-super` (o `liz-4` responde 400 desde então, e deixá-lo aqui faz o seletor de
 * emergência oferecer um modelo que não existe).
 */
export const MODEL_MENU: MenuOption[] = [
  {
    value: 'categoria-liz',
    label: 'Liz',
    icon: MODEL_ICON,
    options: [
      model('liz-4-5-super', 'Liz 4.5 Super'),
      model('liz-3-flash', 'Liz 3 Flash'),
      model('liz-mini-2', 'Liz Mini 2'),
      model('liz-mini-1-3', 'Liz Mini 1.3'),
      model('liz-nano', 'Liz Nano'),
    ],
  },
  {
    value: 'categoria-layze',
    label: 'Layze',
    icon: MODEL_ICON,
    options: [model('layze-2', 'Layze 2')],
  },
  {
    value: 'categoria-koda',
    label: 'Koda',
    icon: MODEL_ICON,
    options: [model('koda-1', 'Koda 1')],
  },
  {
    value: 'categoria-nable',
    label: 'Nable',
    icon: MODEL_ICON,
    // O aviso de tempo limitado mora no **grupo**, colado no nome da família — é dela que
    // ele fala, e não de um item que muda de posição quando a ordem muda.
    trailing: <Aviso texto="Tempo limitado" />,
    options: [model('nable-4-mini-preview', 'Nable 4 Mini Preview')],
  },
]

/**
 * Modelo usado quando não há escolha guardada nesta máquina.
 *
 * `koda-1` é ordem do dono (17/10/2026): «deixa o Koda 1, é melhor». A Liz Nano **não** é
 * padrão e nunca foi pedida como padrão — o que ele pediu foi o contrário, e o registro
 * anterior neste arquivo estava errado.
 *
 * O padrão vale só para a **primeira** abertura: a partir daí manda o que a pessoa escolheu
 * no seletor, guardado por `lerModeloSalvo` (`src/modelo-salvo.ts`) e mantido até ela trocar.
 */
export const MODELO_PADRAO = 'koda-1'

export const ALL_MODELS = MODEL_MENU.flatMap((category) => category.options ?? [])

export const MODEL_LABELS: Record<string, string> = Object.fromEntries(
  // `label` de um MenuOption aceita JSX; aqui os rótulos são todos strings fixas.
  ALL_MODELS.map((option) => [option.value, option.label as string]),
)

/**
 * Ordem de força do seletor: do mais forte para o mais fraco.
 *
 * É decisão do dono (17/10/2026), e é **explícita** em vez de deduzida do nome. A regra
 * antiga tirava o "tamanho" do id (`peso()` no backend media geração e adjetivo), e o
 * resultado não era a força que ele queria: o `nable-4-mini-preview` caía no meio porque
 * "mini" parece pequeno, quando ele manda ele em **segundo**. Número de geração não é força,
 * e adivinhar pelo nome deu essa.
 *
 * A ordem que ele deu: Liz 4.5, Nable 4 mini, Layze 2, Koda 1, Liz 3 Flash — e "aí vai".
 * Os dois mini fecham antes da nano.
 *
 * Com o seletor agrupado por família, esta lista vale **dentro** de cada grupo: a família
 * manda na ordem dos cabeçalhos (`FAMILIAS`), a força manda na ordem dos itens.
 *
 * **A nano é sempre a última**, e isso é regra, não consequência: ela é a mais barata e a
 * mais rápida, e por isso a última da fila — um modelo desconhecido que o host publique
 * amanhã entra **antes** dela (ganha `DESCONHECIDO`, que é menor que o índice da nano), e
 * quem quiser a nano escolhe no fim.
 */
export const ORDEM_DE_FORCA: readonly string[] = [
  'liz-4-5-super',
  'nable-4-mini-preview',
  'layze-2',
  'koda-1',
  'liz-3-flash',
  'liz-mini-2',
  'liz-mini-1-3',
  'liz-nano',
]

/** Posição de um modelo na fila. Quem não está na lista entra antes da nano. */
const DESCONHECIDO = ORDEM_DE_FORCA.indexOf('liz-nano') - 0.5

export function forcaDoModelo(value: string): number {
  const indice = ORDEM_DE_FORCA.indexOf(value)
  return indice === -1 ? DESCONHECIDO : indice
}

/**
 * As famílias do seletor, **na ordem que o dono pediu** (17/10/2026): Liz, Layze, Koda,
 * Nable. A ordem é da família, não do modelo — dentro de cada uma vale a `ORDEM_DE_FORCA`.
 *
 * Em 17/10/2026 a lista chegou a ser **plana**, para a força cruzar as famílias (Nable acima
 * de Layze). O dono não quis: sem cabeçalho, «Liz» e «Nable» viram uma pilha de nomes sem
 * dono, e achar o modelo da família certa passou a ser leitura de id. Voltou o agrupamento, e
 * a ordem das famílias é esta aqui — explícita, porque nenhuma regra tira «Layze antes de
 * Koda» do nome dos modelos.
 *
 * `aviso` é o recado que fica colado no cabeçalho da família (o Nable é oferta por tempo
 * limitado). Ele mora **no grupo** e não no item: é da família que ele fala, e assim não
 * muda de lugar quando a ordem interna muda.
 */
const FAMILIAS: { chave: string; label: string; aviso?: string }[] = [
  { chave: 'liz', label: 'Liz' },
  { chave: 'layze', label: 'Layze' },
  { chave: 'koda', label: 'Koda' },
  { chave: 'nable', label: 'Nable', aviso: 'Tempo limitado' },
]

/**
 * A família de um id — `liz-nano` → `liz`.
 *
 * Olha o **último** pedaço do id porque o host pode publicar com namespace
 * (`vendor/liz-nano`); comparar o id inteiro jogaria esses modelos para «Outros» e eles
 * apareceriam num grupo à parte, longe dos irmãos.
 */
function familiaDe(value: string): string | null {
  const curto = value.split('/').pop() ?? value
  const achada = FAMILIAS.find((familia) => curto.startsWith(`${familia.chave}-`))
  return achada?.chave ?? null
}

/** Um grupo de família, com o cabeçalho e o aviso que ela tiver. */
function grupoDaFamilia(chave: string, label: string, opcoes: MenuOption[], aviso?: string): MenuOption {
  return {
    value: `categoria-${chave}`,
    label,
    icon: MODEL_ICON,
    trailing: aviso ? <Aviso texto={aviso} /> : undefined,
    options: opcoes,
  }
}

/**
 * Seletor de modelo: as famílias do host, montadas a partir do que o backend devolveu.
 *
 * **Agrupado por família** — Liz, Layze, Koda, Nable —, e dentro de cada uma na ordem de
 * força (`ORDEM_DE_FORCA`). Modelo que o host publique sem família conhecida não some: cai
 * em «Outros», no fim, para um catálogo novo aparecer sozinho em vez de ficar invisível até
 * alguém mexer no frontend.
 *
 * O ícone é o mesmo da lista de emergência, para o menu não mudar de aparência conforme o
 * backend responda ou não.
 *
 * `bloqueados` é o recorte do painel: os slugs que ele cadastrou e depois tirou (modelo
 * desativado, ou exceção individual desligada). Vale para as **duas** listas de propósito —
 * a viva e a de emergência. Um modelo desativado que reaparecesse sempre que o host ficasse
 * calado seria o mesmo defeito de antes, só mais difícil de flagrar.
 *
 * O `status` de cada modelo é o código que o backend **testou**, e ele **não aparece na
 * tela**: é só o que decide quem fica na lista. Um modelo com **400** não entra — é o host
 * dizendo que não tem mais aquele (`liz-4` saiu do catálogo), e é isso que tira o modelo do
 * seletor sem a pessoa precisar recarregar o app. Os outros códigos (429, 401, 500, 502)
 * mantêm o modelo na lista, em silêncio: ele existe, e o número é da sonda, não da pessoa.
 * `status` ausente não exclui ninguém: host calado não prova que o modelo sumiu.
 */
export function modelMenu(items: RemoteModel[] = [], bloqueados: readonly string[] = []): MenuOption[] {
  const liberado = (value: string) => !bloqueados.includes(value)

  // Sem catálogo do backend, o espelho é o da casa — já na ordem das famílias (MODEL_MENU).
  // Grupo que ficasse vazio pelos bloqueios sai da lista: cabeçalho sem item é um beco.
  if (items.length === 0) {
    return MODEL_MENU.map((categoria) =>
      grupoDaFamilia(
        categoria.value.replace('categoria-', ''),
        categoria.label as string,
        (categoria.options ?? []).filter((opcao) => liberado(opcao.value)),
        FAMILIAS.find((familia) => `categoria-${familia.chave}` === categoria.value)?.aviso,
      ),
    ).filter((categoria) => (categoria.options ?? []).length > 0)
  }

  const opcao = (item: RemoteModel): MenuOption => ({
    value: item.value,
    label: item.label,
    hint: item.hint ?? undefined,
    icon: MODEL_ICON,
  })

  // Sai da lista só o que o host **recusou por não ter mais** (400). Um 429 é cota, um 401
  // é credencial e um 500 é o host engasgado: nesses o modelo existe, e sumir com ele
  // esconderia o modelo justamente na hora em que a pessoa precisa saber que ele está lá.
  const visiveis = items
    .filter((item) => liberado(item.value) && item.status !== 400)
    .sort((a, b) => forcaDoModelo(a.value) - forcaDoModelo(b.value))

  const grupos: MenuOption[] = []
  const usados = new Set<string>()
  for (const familia of FAMILIAS) {
    const meus = visiveis.filter((item) => familiaDe(item.value) === familia.chave)
    if (meus.length === 0) continue
    meus.forEach((item) => usados.add(item.value))
    grupos.push(grupoDaFamilia(familia.chave, familia.label, meus.map(opcao), familia.aviso))
  }

  // Família que o app ainda não conhece: aparece em «Outros» em vez de desaparecer. É o
  // caminho para um modelo novo do host entrar no seletor sem release do frontend.
  const outros = visiveis.filter((item) => !usados.has(item.value))
  if (outros.length > 0) {
    grupos.push(grupoDaFamilia('outros', 'Outros', outros.map(opcao)))
  }
  return grupos
}

/** Um modelo pelo `value`, com o rótulo do catálogo da casa ou do backend. */
export function findModel(value: string, items: RemoteModel[] = []): MenuOption {
  const remoto = items.find((item) => item.value === value)
  if (remoto) return { value: remoto.value, label: remoto.label, icon: MODEL_ICON }
  return ALL_MODELS.find((item) => item.value === value) ?? { value, label: value, icon: MODEL_ICON }
}



