import type { ReactNode } from 'react'
import { Wrench } from 'lucide-react'

/**
 * Ícones das ferramentas: um desenho por ação, no mesmo traço do resto da interface
 * (24×24, `currentColor`, 1.7). Tudo SVG inline, como a coroa da marca — nenhuma imagem
 * de fora e nenhuma dependência nova.
 */
const GLYPHS: Record<string, ReactNode> = {
  // ---- execução ----
  terminal: (
    <>
      <rect x="2.8" y="4.2" width="18.4" height="15.6" rx="3" />
      <path d="M2.8 9h18.4" />
      <path d="M6.4 6.6h.01M9 6.6h.01" />
      <path d="M7 12.6l2.4 2.4L7 17.4" />
      <path d="M12.6 17.4h4.4" />
    </>
  ),
  rodar: (
    <>
      <rect x="3" y="4.4" width="18" height="15.2" rx="4.6" />
      <path d="M10.4 9.3l4.5 2.7-4.5 2.7z" />
    </>
  ),
  // ---- arquivos ----
  arquivo: (
    <>
      <path d="M6.2 3.6h7.2l4.4 4.4v12.4H6.2z" />
      <path d="M13.2 3.6v4.6h4.6" />
      <path d="M9.2 13.4h5.6M9.2 16.8h3.6" />
    </>
  ),
  arquivoNovo: (
    <>
      <path d="M6.2 3.6h7.2l4.4 4.4v12.4H6.2z" />
      <path d="M13.2 3.6v4.6h4.6" />
      <path d="M12 12.6v5.4M9.3 15.3h5.4" />
    </>
  ),
  lapis: (
    <>
      <path d="M4.6 19.4l1-3.6L15.9 5.5a2.1 2.1 0 013 3L8.6 18.8z" />
      <path d="M14.4 7l2.8 2.8" />
    </>
  ),
  pasta: (
    <path d="M3.4 7.2a2.2 2.2 0 012.2-2.2h3.1l2 2.4h7.7a2.2 2.2 0 012.2 2.2v7.6a2.2 2.2 0 01-2.2 2.2H5.6a2.2 2.2 0 01-2.2-2.2z" />
  ),
  lixeira: (
    <>
      <path d="M4.4 7.4h15.2" />
      <path d="M9.4 7.4V5.9a1.5 1.5 0 011.5-1.5h2.2a1.5 1.5 0 011.5 1.5v1.5" />
      <path d="M6.8 7.4l.8 11a1.6 1.6 0 001.6 1.5h5.6a1.6 1.6 0 001.6-1.5l.8-11" />
      <path d="M10.6 11.2v5.2M13.4 11.2v5.2" />
    </>
  ),
  // ---- busca ----
  lupa: (
    <>
      <circle cx="10.6" cy="10.6" r="6.4" />
      <path d="M15.4 15.4l4.2 4.2" />
    </>
  ),
  regex: (
    <>
      <circle cx="10.6" cy="10.6" r="6.4" />
      <path d="M15.4 15.4l4.2 4.2" />
      <path d="M10.6 8v5.2M8 9.5l5.2 2.2M13.2 9.5l-5.2 2.2" />
    </>
  ),
  escudo: (
    <>
      <path d="M12 3.6l7 2.6v6c0 4.2-2.9 7.4-7 8.8-4.1-1.4-7-4.6-7-8.8v-6z" />
      <path d="M9.2 11.8l2.1 2.1 3.9-4" />
    </>
  ),
  // ---- web ----
  globo: (
    <>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M3.6 12h16.8" />
      <path d="M12 3.6c2.3 2.3 3.5 5.2 3.5 8.4S14.3 18.1 12 20.4C9.7 18.1 8.5 15.2 8.5 12S9.7 5.9 12 3.6z" />
    </>
  ),
  janela: (
    <>
      <rect x="3" y="4.4" width="18" height="15.2" rx="3" />
      <path d="M3 9.2h18" />
      <path d="M6.6 6.8h.01M9.2 6.8h.01" />
    </>
  ),
  // ---- git ----
  ramo: (
    <>
      <circle cx="7" cy="6.4" r="2.2" />
      <circle cx="7" cy="17.6" r="2.2" />
      <circle cx="16.8" cy="9.4" r="2.2" />
      <path d="M7 8.6v7" />
      <path d="M16.8 11.6c0 3-2.5 4.6-5.2 4.6H9.2" />
    </>
  ),
  diff: (
    <>
      <rect x="3.2" y="5" width="7.4" height="14" rx="2" />
      <rect x="13.4" y="5" width="7.4" height="14" rx="2" />
      <path d="M5.7 9.2h2.4M6.9 8v2.4" />
      <path d="M15.9 9.2h2.4M15.9 15.2h2.4" />
    </>
  ),
  historico: (
    <>
      <path d="M20.4 12a8.4 8.4 0 11-2.7-6.2" />
      <path d="M20.6 3.6v4.2h-4.2" />
      <path d="M12 8.4V12l2.9 1.9" />
    </>
  ),
  commit: (
    <>
      <path d="M12 3.6v5M12 15.4v5" />
      <circle cx="12" cy="12" r="3.4" />
    </>
  ),
}

/** Ferramenta do backend -> desenho (os aliases apontam para o mesmo ícone). */
const POR_NOME: Record<string, string> = {
  code_interpreter: 'rodar',
  shell: 'terminal',
  terminal: 'terminal',
  read_file: 'arquivo',
  write_file: 'arquivoNovo',
  edit_file: 'lapis',
  str_replace_editor: 'lapis',
  list_dir: 'pasta',
  delete_file: 'lixeira',
  search_codebase: 'lupa',
  vector_search: 'lupa',
  grep: 'regex',
  regex_search: 'regex',
  get_problems: 'escudo',
  linter: 'escudo',
  web_search: 'globo',
  url_reader: 'janela',
  browser: 'janela',
  git_status: 'ramo',
  git_diff: 'diff',
  git_log: 'historico',
  git_commit: 'commit',
}

export function ToolIcon({
  name,
  className = 'h-3.5 w-3.5',
}: {
  name: string
  className?: string
}) {
  const desenho = GLYPHS[POR_NOME[name] ?? '']

  if (!desenho) {
    return <Wrench className={className} strokeWidth={1.7} aria-hidden="true" />
  }

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
      {desenho}
    </svg>
  )
}

/** Arco girando: ferramenta em execução. */
export function ToolSpinner({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r="8.4"
        stroke="currentColor"
        strokeWidth="1.7"
        opacity="0.22"
      />
      <path
        d="M20.4 12a8.4 8.4 0 00-8.4-8.4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        className="tool-spin"
      />
    </svg>
  )
}

export default ToolIcon
