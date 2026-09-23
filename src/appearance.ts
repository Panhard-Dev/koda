export type ThemeId = 'dark' | 'light' | 'system'
export type AccentId = 'roxo' | 'azul' | 'verde' | 'rosa'
export type FontId = 'padrao' | 'serif' | 'mono'
export type ScaleId = 'compacto' | 'padrao' | 'grande'

export type Appearance = {
  theme: ThemeId
  accent: AccentId
  font: FontId
  scale: ScaleId
  reducedMotion: boolean
}

export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'dark',
  accent: 'roxo',
  font: 'padrao',
  scale: 'padrao',
  reducedMotion: false,
}

export type AppearanceOption<T extends string> = {
  value: T
  label: string
  /** Mostrado abaixo do rótulo quando a opção está ativa. */
  hint?: string
  /** Amostra de cor (aceita gradiente) — usado nos seletores de tema e destaque. */
  swatch?: string
  /** Pilha de fontes para escrever o próprio rótulo na fonte que ele representa. */
  stack?: string
}

export const THEMES: AppearanceOption<ThemeId>[] = [
  { value: 'light', label: 'Claro', hint: 'Fundo claro, texto escuro.' },
  { value: 'system', label: 'Sistema', hint: 'Segue o sistema operacional.' },
  { value: 'dark', label: 'Escuro', hint: 'Fundo escuro, como está hoje.' },
]

export const ACCENTS: AppearanceOption<AccentId>[] = [
  { value: 'roxo', label: 'Roxo', swatch: '#8b5cf6' },
  { value: 'azul', label: 'Azul', swatch: '#3b82f6' },
  { value: 'verde', label: 'Verde', swatch: '#10b981' },
  { value: 'rosa', label: 'Rosa', swatch: '#ec4899' },
]

export const FONTS: AppearanceOption<FontId>[] = [
  {
    value: 'padrao',
    label: 'Padrão',
    hint: 'Sans do sistema (Inter), como está hoje.',
    stack: "'Inter', system-ui, sans-serif",
  },
  {
    value: 'serif',
    label: 'Serifada',
    hint: 'Georgia/Palatino, mais editorial.',
    stack: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif",
  },
  {
    value: 'mono',
    label: 'Monoespaçada',
    hint: 'Largura fixa, boa para ler código.',
    stack: "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace",
  },
]

export const SCALES: AppearanceOption<ScaleId>[] = [
  { value: 'compacto', label: 'Compacto', hint: '90% — cabe mais conteúdo na tela.' },
  { value: 'padrao', label: 'Padrão', hint: '100% — tamanho original do layout.' },
  { value: 'grande', label: 'Grande', hint: '115% — textos e botões maiores.' },
]
