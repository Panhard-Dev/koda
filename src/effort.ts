import type { MenuOption } from './components/Menu'

/**
 * Esforço de raciocínio, enviado ao provedor como `reasoning_effort`.
 *
 * O `auto` é o padrão e não manda campo nenhum: quem decide é o botão **Reasoning** da
 * caixa de mensagem (ligado → `minimal`, desligado → `none`). Os outros valores vão como
 * estão, e aí o Reasoning deixa de influenciar.
 *
 * Não existe `none` na lista de propósito: o gateway recusa esse valor em parte do
 * catálogo — desligar o raciocínio é o que o botão Reasoning já faz, com o cuidado de cair
 * no `minimal` quando o modelo não aceita.
 *
 * `xhigh` e `max` continuam na lista porque o gateway publica os níveis por modelo; no
 * catálogo atual nenhum modelo declara raciocínio. Quem não aceita o nível não quebra — o
 * backend arredonda para o mais próximo que o modelo aceita.
 */
export type Effort = 'auto' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const EFFORT_PADRAO: Effort = 'auto'

const NIVEIS: { value: Effort; label: string; hint: string }[] = [
  { value: 'auto', label: 'Automático', hint: 'Quem decide é o Reasoning' },
  { value: 'minimal', label: 'Mínimo', hint: 'Responde rápido, pensa pouco' },
  { value: 'low', label: 'Baixo', hint: 'Pensa um pouco mais antes de responder' },
  { value: 'medium', label: 'Médio', hint: 'Equilíbrio entre tempo e profundidade' },
  { value: 'high', label: 'Alto', hint: 'Pensa mais — a resposta demora mais' },
  { value: 'xhigh', label: 'Muito alto', hint: 'Pensa muito — a resposta demora bem mais' },
  { value: 'max', label: 'Máximo', hint: 'O máximo que o modelo permite' },
]

export const EFFORT_MENU: MenuOption[] = NIVEIS.map(({ value, label, hint }) => ({
  value,
  label,
  hint,
}))

export function effortLabel(value: string): string {
  return NIVEIS.find((nivel) => nivel.value === value)?.label ?? 'Automático'
}

/**
 * Esforço guardado para um modelo. Cada modelo tem o seu: trocar de modelo troca o
 * esforço junto, em vez de manter um valor só para todos (`qwen-3.8-flash` no alto não
 * quer dizer `glm-5.3-flash` no alto).
 */
export function effortDoModelo(mapa: Record<string, Effort>, modelo: string): Effort {
  return mapa[modelo] ?? EFFORT_PADRAO
}
