import type { ReactNode } from 'react'
import {
  Cable,
  Folder,
  History,
  Menu as MenuIcon,
  MessagesSquare,
  Plus,
  Puzzle,
  Search,
  Settings,
  User,
  X,
} from 'lucide-react'
import KodaLogo from './KodaLogo'
import Menu from './Menu'
import { apelidoDaConta } from '../account'
import type { MenuOption } from './Menu'
import { WindowControls } from './WindowControls'
import type { SettingsSection } from './SettingsScreen'
import type { ApiMcp, ApiProject, ApiSkill } from '../api/client'

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

/**
 * Ícone do painel lateral: quadrado de cantos redondos com a coluna da esquerda cheia.
 * Mesmo traço do resto da interface (24×24, `currentColor`, 1.7) e SVG inline, como a
 * coroa da marca — nenhuma imagem de fora e nenhuma dependência nova.
 */
function IconePainel({ className = 'h-[18px] w-[18px]' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="3.2" y="3.2" width="17.6" height="17.6" rx="4.6" />
      <rect x="6" y="6" width="3.2" height="12" rx="1.4" fill="currentColor" stroke="none" />
    </svg>
  )
}

function Interruptor({ on }: { on: boolean }) {
  /**
   * Interruptor de status: a bolinha desliza para a direita quando está ligado.
   * Ligado usa o roxo de destaque do app; desligado, vermelho. Só indica estado;
   * o clique da linha inteira alterna, e quem guarda o estado é o menu (via `onSelect`).
   */
  return (
    <span
      aria-hidden
      className={[
        'relative block h-5 w-9 rounded-full transition-colors duration-150',
        on ? 'bg-koda-accent-strong' : 'bg-red-400/80',
      ].join(' ')}
    >
      <span
        className={[
          'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.35)]',
          'transition-all duration-150',
          on ? 'left-[18px]' : 'left-0.5',
        ].join(' ')}
      />
    </span>
  )
}

/** Linha informativa do submenu: “2 ativas · 1 desativada”, com as contas coloridas. */
function Resumo({
  ativos,
  singularAtivo,
  pluralAtivo,
  desativados,
  singularDesativado,
  pluralDesativado,
}: {
  ativos: number
  singularAtivo: string
  pluralAtivo: string
  desativados: number
  singularDesativado: string
  pluralDesativado: string
}) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="text-emerald-400">
        {ativos} {ativos === 1 ? singularAtivo : pluralAtivo}
      </span>
      <span className="text-koda-fg/30">·</span>
      <span className="text-red-400">
        {desativados} {desativados === 1 ? singularDesativado : pluralDesativado}
      </span>
    </span>
  )
}

export function Header({
  searchOpen,
  searchQuery,
  resultLabel,
  projects,
  projectId,
  conta,
  conversations,
  skills,
  mcps,
  painelAberto,
  onToggleSkill,
  onToggleMcp,
  onToggleSearch,
  onSearchQueryChange,
  onNewChat,
  onProjectChange,
  onOpenFolders,
  onOpenConversation,
  onOpenSettings,
  onTogglePainel,
}: {
  searchOpen: boolean
  searchQuery: string
  resultLabel: string | null
  /** Pastas salvas (o projeto é sempre uma pasta de verdade, com caminho completo). */
  projects: ApiProject[]
  projectId: string | null
  /** Conta do painel: o menu mostra o nome dela, nunca um rótulo inventado. */
  conta: { email: string; nome?: string | null } | null
  conversations: ConversationSummary[]
  skills: ApiSkill[]
  mcps: ApiMcp[]
  onToggleSkill: (name: string) => void
  onToggleMcp: (name: string) => void
  onToggleSearch: () => void
  onSearchQueryChange: (value: string) => void
  onNewChat: () => void
  onProjectChange: (id: string | null) => void
  /** Abre o escolhedor de pasta (existente ou nova). */
  onOpenFolders: () => void
  onOpenConversation: (id: string) => void
  onOpenSettings: (section?: SettingsSection) => void
  /** A barra lateral está aberta — o botão do painel fica aceso e alterna. */
  painelAberto: boolean
  onTogglePainel: () => void
}) {
  /** O submenu de projeto lista as pastas salvas e as duas formas de abrir outra. */
  const projectOptions = [
    {
      value: 'sem-projeto',
      label: 'Nenhum projeto',
      hint: 'Conversa solta, sem contexto de código',
    },
    ...projects.map((item) => ({
      value: item.id,
      label: item.nome,
      hint: item.existe ? item.caminho : `${item.caminho} · pasta não encontrada`,
    })),
    {
      value: 'pasta-existente',
      label: 'Usar pasta existente',
      hint: 'Escolher uma pasta que já está no disco',
    },
    {
      value: 'pasta-nova',
      label: 'Começar do zero',
      hint: 'Criar uma pasta nova e trabalhar nela',
    },
  ]

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

  const skillsAtivas = skills.filter((skill) => skill.enabled).length
  const skillsDesativadas = skills.length - skillsAtivas
  const mcpsAtivos = mcps.filter((mcp) => mcp.enabled).length
  const mcpsDesativados = mcps.length - mcpsAtivos

  const skillsSubmenu: MenuOption[] =
    skills.length > 0
      ? [
          {
            value: 'skills-resumo',
            disabled: true,
            label: (
              <Resumo
                ativos={skillsAtivas}
                singularAtivo="ativa"
                pluralAtivo="ativas"
                desativados={skillsDesativadas}
                singularDesativado="desativada"
                pluralDesativado="desativadas"
              />
            ),
          },
          ...skills.map((skill) => ({
            value: `skill:${skill.name}`,
            label: skill.name,
            trailing: <Interruptor on={skill.enabled} />,
            // Alterna sem fechar o menu: dá para ligar e desligar várias seguidas.
            keepOpen: true,
          })),
          {
            value: 'skills-ajustes',
            label: 'Gerenciar nos ajustes',
            icon: <Settings className="h-4 w-4" strokeWidth={1.7} />,
          },
        ]
      : [
          {
            value: 'skills-vazia',
            disabled: true,
            label: 'Nenhuma skill instalada',
            hint: 'Uma pasta com SKILL.md em .agents/skills aparece aqui',
          },
        ]

  const mcpsSubmenu: MenuOption[] =
    mcps.length > 0
      ? [
          {
            value: 'mcps-resumo',
            disabled: true,
            label: (
              <Resumo
                ativos={mcpsAtivos}
                singularAtivo="ativo"
                pluralAtivo="ativos"
                desativados={mcpsDesativados}
                singularDesativado="desativado"
                pluralDesativado="desativados"
              />
            ),
          },
          ...mcps.map((mcp) => ({
            value: `mcp:${mcp.name}`,
            label: mcp.name,
            trailing: <Interruptor on={mcp.enabled} />,
            keepOpen: true,
          })),
          {
            value: 'mcps-ajustes',
            label: 'Gerenciar nos ajustes',
            icon: <Settings className="h-4 w-4" strokeWidth={1.7} />,
          },
        ]
      : [
          {
            value: 'mcps-vazia',
            disabled: true,
            label: 'Nenhum servidor MCP',
            hint: 'O Koda ainda não conecta servidores MCP',
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
          label: apelidoDaConta(conta),
          hint: conta?.email ?? 'Entrar na conta',
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
      options: projectOptions,
    },
    {
      value: 'skills',
      label: 'Skills',
      icon: <Puzzle className="h-4 w-4" strokeWidth={1.7} />,
      options: skillsSubmenu,
    },
    {
      value: 'mcps',
      label: 'MCPs',
      icon: <Cable className="h-4 w-4" strokeWidth={1.7} />,
      options: mcpsSubmenu,
    },
  ]

  const handleSelect = (value: string) => {
    if (value === 'configuracao') onOpenSettings('geral')
    else if (value === 'conta') onOpenSettings('conta')
    else if (value.startsWith('skill:')) onToggleSkill(value.slice('skill:'.length))
    else if (value.startsWith('mcp:')) onToggleMcp(value.slice('mcp:'.length))
    else if (value === 'skills-ajustes') onOpenSettings('skills')
    else if (value === 'mcps-ajustes') onOpenSettings('mcps')
    else if (value === 'nova-conversa') onNewChat()
    else if (value === 'pasta-existente' || value === 'pasta-nova') onOpenFolders()
    else if (value === 'sem-projeto') onProjectChange(null)
    else if (projects.some((item) => item.id === value)) onProjectChange(value)
    else onOpenConversation(value)
  }

  return (
    // `data-tauri-drag-region`: no app desktop, arrastar por essa linha move a
    // janela (a titlebar nativa foi desligada). Filhos clicáveis ficam de fora.
    <header
      data-tauri-drag-region
      className="relative z-20 flex shrink-0 items-center gap-3 px-5 pt-5 pb-11"
    >
      {/*
       * Marca e painel lateral empilhados na ponta esquerda: a coroa em cima, o botão do
       * painel logo abaixo dela.
       *
       * O `-mb-10` desconta a altura do botão de baixo, e é o que mantém a coroa no lugar:
       * sem ele a coluna fica mais alta que a pílula, o `items-center` do cabeçalho
       * recentraliza a linha e a coroa **sobe** — que foi exatamente o defeito da primeira
       * versão. Com o desconto, a coluna mede o mesmo que a coroa (32px), a linha continua
       * com a altura da pílula (44px) e os dois seguem alinhados como antes. O ícone passa a
       * sobrar para baixo, e o `pb-11` do cabeçalho é quem abre o espaço para ele.
       */}
      <div className="flex shrink-0 flex-col items-center gap-1 -mb-10">
        <button
          type="button"
          onClick={onNewChat}
          aria-label="Koda — iniciar nova conversa"
          className="flex items-center rounded-xl p-1 transition-opacity hover:opacity-80 focus-visible:outline-none"
        >
          <KodaLogo className="h-6 w-auto" />
        </button>

        <IconButton
          label={painelAberto ? 'Fechar painel lateral' : 'Abrir painel lateral'}
          active={painelAberto}
          onClick={onTogglePainel}
        >
          <IconePainel className="h-[18px] w-[18px]" />
        </IconButton>
      </div>

      <div className="flex items-center gap-0.5 rounded-full bg-koda-surface px-1.5 py-1 shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset]">
        <Menu
          options={menuOptions}
          value={projectId ?? 'sem-projeto'}
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

      {/* Controles da janela no canto direito — só aparecem dentro do app Tauri. */}
      <div className="-mr-2 ml-auto">
        <WindowControls />
      </div>
    </header>
  )
}

export default Header
