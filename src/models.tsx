import KodaLogo from './components/KodaLogo'
import type { MenuOption } from './components/Menu'

/**
 * A coroa é a marca da casa e vai em **todo** item de modelo — categoria e modelo, na
 * lista viva e na de emergência. Antes a lista viva usava um ícone genérico (Sparkles) e
 * aí, quando o host passou a responder, a coroa desaparecia do seletor inteiro: o menu
 * mudava de cara só porque o backend estava no ar.
 */
const MODEL_ICON = <KodaLogo className="h-3.5 w-auto" color="currentColor" />

/** Modelo que veio do backend (ex.: o catálogo que o host local publica em /v1/models). */
export type RemoteModel = {
  value: string
  label: string
  hint?: string | null
}

const model = (value: string, label: string): MenuOption => ({
  value,
  label,
  icon: MODEL_ICON,
})

/**
 * Catálogo do host local (`koda/host/c-host.exe`), em `http://127.0.0.1:21128`.
 *
 * Esta lista é só o espelho de emergência: quando o backend responde, é o `/api/models`
 * dele — que pergunta ao host — que manda. Os ids daqui são os mesmos que o host aceita
 * em `/v1/chat/completions`; qualquer nome que não esteja no catálogo dele é recusado.
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
]

/** Modelo usado quando a interface ainda não recebeu o catálogo do backend. */
export const MODELO_PADRAO = 'liz-nano'

export const ALL_MODELS = MODEL_MENU.flatMap((category) => category.options ?? [])

export const MODEL_LABELS: Record<string, string> = Object.fromEntries(
  ALL_MODELS.map((option) => [option.value, option.label]),
)

/** Prefixos de id que viram uma categoria no seletor (liz-nano → Liz). */
const GRUPOS: { chave: string; label: string }[] = [
  { chave: 'liz', label: 'Liz' },
  { chave: 'koda', label: 'Koda' },
  { chave: 'layze', label: 'Layze' },
]

/**
 * Seletor de modelo: as categorias do host, montadas a partir do que o backend devolveu.
 *
 * O agrupamento é por prefixo do id em vez de uma lista fixa aqui — assim um modelo novo
 * do host aparece no seletor sozinho, sem precisar mexer no frontend. Os ícones são os
 * mesmos da lista de emergência, para o menu não mudar de aparência conforme o backend
 * responda ou não.
 */
export function modelMenu(items: RemoteModel[] = []): MenuOption[] {
  if (items.length === 0) return MODEL_MENU

  const opcao = (item: RemoteModel): MenuOption => ({
    value: item.value,
    label: item.label,
    hint: item.hint ?? undefined,
    icon: MODEL_ICON,
  })

  const grupos: MenuOption[] = []
  const usados = new Set<string>()
  for (const grupo of GRUPOS) {
    const meus = items.filter((item) => item.value.startsWith(`${grupo.chave}-`))
    if (meus.length === 0) continue
    meus.forEach((item) => usados.add(item.value))
    grupos.push({
      value: `categoria-${grupo.chave}`,
      label: grupo.label,
      icon: MODEL_ICON,
      options: meus.map(opcao),
    })
  }

  const outros = items.filter((item) => !usados.has(item.value))
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


/** Projetos oferecidos no seletor do composer e no menu do header. */
export const PROJECTS: MenuOption[] = [
  { value: 'sem-projeto', label: 'Nenhum projeto', hint: 'Conversa solta, sem contexto de código' },
  { value: 'koda-site', label: 'koda-site', hint: 'Interface web do Koda' },
  { value: 'api-proxy', label: 'api-proxy', hint: 'Serviço de roteamento de modelos' },
  { value: 'landing-page', label: 'landing-page', hint: 'Página de apresentação' },
]

/** Projetos que podem ir no payload de envio (`sem-projeto` significa nenhum). */
export const projectName = (value: string) =>
  value === 'sem-projeto' ? null : value
