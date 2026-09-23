import type { ReactNode } from 'react'
import {
  Folder,
  History,
  Menu as MenuIcon,
  MessagesSquare,
  Plus,
  Search,
  Settings,
  User,
  X,
} from 'lucide-react'
import KodaLogo from './KodaLogo'
import Menu from './Menu'
import { PROJECTS } from '../models'
import type { SettingsSection } from './SettingsScreen'

export type ConversationSummary = {
  id: string
  title: string
  preview: string
}

function IconButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string
  onClick?: () => void
  active?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={onClick}
      className={[
        'flex h-9 w-9 items-center justify-center rounded-xl transition-colors duration-150',
        'focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none',
        active
          ? 'bg-koda-fg/12 text-koda-fg'
          : 'text-koda-fg/85 hover:bg-koda-fg/10 hover:text-koda-fg',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

export function Header({
  searchOpen,
  searchQuery,
  resultLabel,
  project,
  conversations,
  onToggleSearch,
  onSearchQueryChange,
  onNewChat,
  onProjectChange,
  onOpenConversation,
  onOpenSettings,
}: {
  searchOpen: boolean
  searchQuery: string
  resultLabel: string | null
  project: string
  conversations: ConversationSummary[]
  onToggleSearch: () => void
  onSearchQueryChange: (value: string) => void
  onNewChat: () => void
  onProjectChange: (value: string) => void
  onOpenConversation: (id: string) => void
  onOpenSettings: (section?: SettingsSection) => void
}) {
  const historyOptions =
    conversations.length > 0
      ? conversations.map((conversation) => ({
          value: conversation.id,
          label: conversation.title,
          hint: conversation.preview,
          icon: <History className="h-4 w-4" strokeWidth={1.7} />,
        }))
      : [
          {
            value: 'sem-historico',
            label: 'Nenhuma conversa anterior',
            hint: 'Comece a conversar para o histórico aparecer',
            icon: <History className="h-4 w-4" strokeWidth={1.7} />,
            disabled: true,
          },
        ]

  const menuOptions = [
    {
      value: 'configuracao',
      label: 'Configuração',
      icon: <Settings className="h-4 w-4" strokeWidth={1.7} />,
    },
    {
      value: 'perfil',
      label: 'Perfil',
      icon: <User className="h-4 w-4" strokeWidth={1.7} />,
      options: [
        {
          value: 'conta',
          label: 'Conta Koda',
          hint: 'Plano Free · contas vinculadas',
          icon: <User className="h-4 w-4" strokeWidth={1.7} />,
        },
      ],
    },
    {
      value: 'chat',
      label: 'Chat',
      icon: <MessagesSquare className="h-4 w-4" strokeWidth={1.7} />,
      options: [
        {
          value: 'nova-conversa',
          label: 'Nova conversa',
          icon: <Plus className="h-4 w-4" strokeWidth={1.7} />,
        },
        ...historyOptions,
      ],
    },
    {
      value: 'projeto',
      label: 'Projeto',
      icon: <Folder className="h-4 w-4" strokeWidth={1.7} />,
      options: PROJECTS,
    },
  ]

  const handleSelect = (value: string) => {
    if (value === 'configuracao') onOpenSettings('geral')
    else if (value === 'conta') onOpenSettings('conta')
    else if (value === 'nova-conversa') onNewChat()
    else if (PROJECTS.some((option) => option.value === value)) onProjectChange(value)
    else onOpenConversation(value)
  }

  return (
    <header className="relative z-20 flex shrink-0 items-center gap-3 p-5">
      <button
        type="button"
        onClick={onNewChat}
        aria-label="Koda — iniciar nova conversa"
        className="flex items-center rounded-xl p-1 pr-2 transition-opacity hover:opacity-80 focus-visible:outline-none"
      >
        <KodaLogo className="h-6 w-auto" />
      </button>

      <div className="flex items-center gap-0.5 rounded-full bg-koda-surface px-1.5 py-1 shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset]">
        <Menu
          options={menuOptions}
          value={project}
          onSelect={handleSelect}
          direction="down"
          label="Abrir menu"
          panelClassName="min-w-60"
          panelStyle={{ position: 'fixed', top: 78, left: 20, transformOrigin: 'top left' }}
          triggerClassName="flex h-9 w-9 items-center justify-center rounded-xl text-koda-fg/85 transition-colors duration-150 hover:bg-koda-fg/10 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
        >
          <MenuIcon className="h-[18px] w-[18px]" strokeWidth={1.8} />
        </Menu>
        <IconButton
          label={searchOpen ? 'Fechar pesquisa' : 'Pesquisar na conversa'}
          active={searchOpen}
          onClick={onToggleSearch}
        >
          <Search className="h-[18px] w-[18px]" strokeWidth={1.8} />
        </IconButton>
        <IconButton label="Novo chat" onClick={onNewChat}>
          <Plus className="h-[19px] w-[19px]" strokeWidth={1.8} />
        </IconButton>
      </div>

      {searchOpen ? (
        <div className="menu-in flex items-center gap-2 rounded-full bg-koda-surface px-3.5 py-2 ring-1 ring-koda-fg/8">
          <Search className="h-4 w-4 shrink-0 text-koda-fg/45" strokeWidth={1.8} />
          <input
            autoFocus
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                onSearchQueryChange('')
                onToggleSearch()
              }
            }}
            placeholder="Pesquisar na conversa"
            aria-label="Pesquisar na conversa"
            className="w-52 bg-transparent text-[13.5px] text-koda-fg placeholder:text-koda-fg/35 focus:outline-none"
          />
          {searchQuery ? (
            <>
              <span className="shrink-0 text-[12px] text-koda-fg/45">{resultLabel}</span>
              <button
                type="button"
                aria-label="Limpar pesquisa"
                onClick={() => onSearchQueryChange('')}
                className="shrink-0 text-koda-fg/45 transition-colors hover:text-koda-fg"
              >
                <X className="h-3.5 w-3.5" strokeWidth={2} />
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </header>
  )
}

export default Header
