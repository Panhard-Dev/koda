import { useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'

export type MenuOption = {
  value: string
  label: string
  hint?: string
  icon?: ReactNode
  /** Item apenas informativo: aparece apagado e não seleciona nada. */
  disabled?: boolean
  /** Quando presente, o item não seleciona nada: abre um submenu com estas opções. */
  options?: MenuOption[]
}

type MenuProps = {
  options: MenuOption[]
  value?: string
  onSelect: (value: string) => void
  children: ReactNode
  className?: string
  triggerClassName?: string
  panelClassName?: string
  /** Posição própria do painel (ex.: fixo embaixo do logo). Desliga o ancoramento no gatilho. */
  panelStyle?: CSSProperties
  direction?: 'up' | 'down'
  align?: 'start' | 'end'
  label?: string
}

type Level = {
  title: string | null
  items: MenuOption[]
}

/**
 * Dropdown posicionado em CSS, com um nível de submenu. Nenhum ancestral pode
 * usar `overflow-hidden` no eixo em que o menu abre.
 */
export function Menu({
  options,
  value,
  onSelect,
  children,
  className = '',
  triggerClassName = '',
  panelClassName = '',
  panelStyle,
  direction = 'down',
  align = 'start',
  label,
}: MenuProps) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [parentIndex, setParentIndex] = useState(0)
  const [level, setLevel] = useState<Level | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  const items = level?.items ?? options

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  useEffect(() => {
    // Também roda ao entrar/sair do submenu: o item clicado é desmontado e o foco
    // cairia no <body>, deixando o teclado sem responder dentro do menu.
    if (open) panelRef.current?.focus()
  }, [open, level])

  const indexOfValue = (list: MenuOption[]) =>
    Math.max(0, list.findIndex((option) => option.value === value))

  const openRoot = () => {
    setLevel(null)
    setActiveIndex(indexOfValue(options))
    setOpen(true)
  }

  const openSubmenu = (option: MenuOption, itemIndex: number) => {
    if (!option.options) return
    setLevel({ title: option.label, items: option.options })
    setActiveIndex(indexOfValue(option.options))
    setParentIndex(itemIndex)
  }

  const goBack = () => {
    setLevel(null)
    setActiveIndex(parentIndex)
  }

  const close = (refocus = true) => {
    setOpen(false)
    setLevel(null)
    if (refocus) triggerRef.current?.focus()
  }

  const commit = (index: number) => {
    const option = items[index]
    if (!option || option.disabled) return
    if (option.options) {
      openSubmenu(option, index)
      return
    }
    onSelect(option.value)
    close()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!open) {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault()
        openRoot()
      }
      return
    }

    if (event.key === 'Escape' || event.key === 'ArrowLeft' || event.key === 'Backspace') {
      event.preventDefault()
      if (level) goBack()
      else close()
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => (index + 1) % items.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => (index - 1 + items.length) % items.length)
    } else if (event.key === 'Home') {
      event.preventDefault()
      setActiveIndex(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setActiveIndex(items.length - 1)
    } else if (event.key === 'ArrowRight') {
      const option = items[activeIndex]
      if (!option?.options) return
      event.preventDefault()
      openSubmenu(option, activeIndex)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      commit(activeIndex)
    } else if (event.key === 'Tab') {
      close()
    }
  }

  return (
    <div ref={rootRef} className={['relative', className].join(' ')}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        onClick={() => {
          if (open) close()
          else openRoot()
        }}
        onKeyDown={handleKeyDown}
        className={triggerClassName}
      >
        {children}
      </button>

      {open ? (
        <div
          ref={panelRef}
          id={menuId}
          role="menu"
          tabIndex={-1}
          onKeyDown={handleKeyDown}
          style={panelStyle}
          className={[
            'z-50 max-h-[70vh] min-w-56 overflow-y-auto rounded-2xl bg-koda-surface p-1.5',
            'ring-1 ring-koda-fg/10 shadow-[0_24px_48px_-20px_var(--koda-shadow)]',
            'focus:outline-none menu-in',
            panelStyle
              ? 'fixed'
              : [
                  'absolute',
                  direction === 'up' ? 'bottom-full mb-2' : 'top-full mt-2',
                  align === 'end' ? 'right-0' : 'left-0',
                ].join(' '),
            panelClassName,
          ].join(' ')}
        >
          {level ? (
            <button
              type="button"
              role="menuitem"
              aria-label={`Voltar para ${level.title}`}
              onClick={goBack}
              className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-[11px] font-semibold tracking-wider text-koda-fg/40 uppercase transition-colors duration-100 hover:bg-koda-fg/6 hover:text-koda-fg/70 focus:outline-none"
            >
              <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} />
              {level.title}
            </button>
          ) : null}

          {items.map((option, index) => {
            const isCategory = Boolean(option.options)
            const selected = option.value === value
            const containsSelected = Boolean(
              option.options?.some((child) => child.value === value),
            )
            const active = index === activeIndex

            return (
              <button
                key={option.value}
                type="button"
                role={isCategory ? 'menuitem' : 'menuitemradio'}
                aria-haspopup={isCategory ? 'menu' : undefined}
                aria-checked={isCategory ? undefined : selected}
                disabled={option.disabled}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => commit(index)}
                className={[
                  'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left',
                  'transition-colors duration-100 focus:outline-none',
                  option.disabled ? 'cursor-default opacity-70' : '',
                  active && !option.disabled ? 'bg-koda-fg/8' : 'bg-transparent',
                ].join(' ')}
              >
                {option.icon ? (
                  <span className="mt-0.5 text-koda-fg/60">{option.icon}</span>
                ) : null}
                <span className="min-w-0 flex-1">                      <span className="block text-[13.5px] font-medium break-words text-koda-fg/90">
                        {option.label}
                      </span>
                  {option.hint ? (
                    <span className="mt-0.5 block text-[12px] leading-4 text-koda-fg/45">
                      {option.hint}
                    </span>
                  ) : null}
                </span>
                {!isCategory && selected ? (
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-koda-accent" strokeWidth={2} />
                ) : null}
                {isCategory ? (
                  <span className="mt-0.5 flex shrink-0 items-center gap-1">
                    {containsSelected ? (
                      <Check className="h-4 w-4 text-koda-accent" strokeWidth={2} />
                    ) : null}
                    <ChevronRight className="h-4 w-4 text-koda-fg/35" strokeWidth={1.8} />
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

export default Menu
