/** Nome técnico da ferramenta -> rótulo curto em português, para a conversa ficar legível. */
const ROTULOS: Record<string, string> = {
  code_interpreter: 'Rodar Python',
  shell: 'Rodar comando',
  terminal: 'Rodar comando',
  read_file: 'Ler arquivo',
  write_file: 'Escrever arquivo',
  edit_file: 'Editar arquivo',
  str_replace_editor: 'Editar arquivo',
  list_dir: 'Listar pasta',
  delete_file: 'Apagar arquivo',
  search_codebase: 'Buscar no código',
  vector_search: 'Buscar no código',
  grep: 'Buscar com regex',
  regex_search: 'Buscar com regex',
  get_problems: 'Conferir arquivo',
  linter: 'Conferir arquivo',
  web_search: 'Buscar na web',
  url_reader: 'Abrir página',
  browser: 'Abrir página',
  git_status: 'Status do git',
  git_diff: 'Diff do git',
  git_log: 'Histórico do git',
  git_commit: 'Commit no git',
}

export const rotuloFerramenta = (nome: string) => ROTULOS[nome] ?? nome
