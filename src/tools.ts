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
  create_directory: 'Criar pasta',
  delete_directory: 'Apagar pasta',
  move_file: 'Mover arquivo',
  copy_file: 'Copiar arquivo',
  rename_file: 'Renomear arquivo',
  get_environment: 'Ver ambiente',
  update_todos: 'Registrar plano',
  search_files: 'Procurar arquivo',
  apply_patch: 'Aplicar patch',
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
  git_push: 'Enviar para o git',
  git_pull: 'Baixar do git',
  install_package: 'Instalar dependência',
  uninstall_package: 'Remover dependência',
  download_file: 'Baixar arquivo',
  upload_file: 'Enviar arquivo',
  use_skill: 'Usar skill',
}

/**
 * Apelido que o modelo escreve de memória -> nome real da ferramenta.
 *
 * O backend já traduz a chamada (é lá que ela roda de verdade); aqui é para a linha na
 * conversa mostrar "Rodar comando" em vez do nome cru que o modelo inventou.
 */
const APELIDOS: Record<string, string> = {
  run_command: 'shell',
  execute_command: 'shell',
  run_code: 'code_interpreter',
  list_directory: 'list_dir',
  listdir: 'list_dir',
  ls: 'list_dir',
  mkdir: 'create_directory',
  rmdir: 'delete_directory',
  search_code: 'search_codebase',
  glob: 'search_files',
  find_files: 'search_files',
  open_url: 'url_reader',
  fetch_url: 'url_reader',
  read_url: 'url_reader',
  create_file: 'write_file',
  update_plan: 'update_todos',
  plan: 'update_todos',
  todos: 'update_todos',
  todo_write: 'update_todos',
  set_todos: 'update_todos',
  apply_diff: 'apply_patch',
  patch: 'apply_patch',
  install: 'install_package',
  uninstall: 'uninstall_package',
  status: 'git_status',
  commit: 'git_commit',
  push: 'git_push',
  pull: 'git_pull',
  download: 'download_file',
  upload: 'upload_file',
}

export const ferramentaCanonica = (nome: string) => APELIDOS[nome] ?? nome

export const rotuloFerramenta = (nome: string) => ROTULOS[ferramentaCanonica(nome)] ?? nome

/**
 * A ferramenta vem de um servidor MCP?
 *
 * O prefixo é o contrato entre o backend e a tela: `mcp__<servidor>__<ferramenta>`. É o que
 * separa o que é do Koda do que roda **fora**, num processo à parte — e o que escolhe o
 * ícone e o rótulo do passo.
 */
export const eFerramentaMcp = (nome: string) => nome.startsWith('mcp__')

/**
 * O nome da ferramenta dentro do servidor, lido do próprio nome externo.
 *
 * É só o paliativo para quando o `mcp` do passo não veio (mensagem antiga, gravada antes
 * desta versão): o nome externo é normalizado, então o que sai daqui pode não ser o nome
 * original. Com o campo `mcp` presente, quem manda é ele.
 */
export const ferramentaDoNomeMcp = (nome: string) =>
  nome.replace(/^mcp__/, '').split('__').slice(1).join('__') || nome

/** Um passo de ferramenta, no mínimo que o rótulo e o resumo precisam. */
type Passo = {
  name: string
  arguments: Record<string, unknown>
  mcp?: { servidor: string; ferramenta: string } | null
}

/**
 * O rótulo do passo na conversa.
 *
 * Para MCP, o nome da **ferramenta no servidor** (`somar`) — o nome técnico
 * (`mcp__eco_server__somar`) é endereço, não rótulo, e vai no detalhe ao clique.
 */
export const rotuloDoPasso = (passo: Passo) => {
  if (passo.mcp) return passo.mcp.ferramenta
  if (eFerramentaMcp(passo.name)) return ferramentaDoNomeMcp(passo.name)
  return rotuloFerramenta(passo.name)
}

/**
 * O **recurso acionado**, em uma linha: de onde veio e o que foi pedido.
 *
 * - MCP: `MCP <servidor> · <argumentos>` — o servidor é o recurso, e o nome dele é o real
 *   (`eco-server`), não o normalizado que o modelo vê.
 * - skill: `skill <nome>` — a skill carregada é o recurso.
 * - o resto: os argumentos, como sempre foram.
 */
export const recursoDoPasso = (passo: Passo) => {
  if (passo.mcp) {
    const args = resumoArgumentos(passo.arguments)
    return args ? `MCP ${passo.mcp.servidor} · ${args}` : `MCP ${passo.mcp.servidor}`
  }
  if (ferramentaCanonica(passo.name) === 'use_skill') {
    const nome = String(passo.arguments?.nome ?? '').trim()
    return nome ? `skill ${nome}` : 'skill'
  }
  return resumoArgumentos(passo.arguments)
}

/**
 * O que a ferramenta recebeu, em uma linha: `chave: valor · chave: valor`.
 *
 * Serve tanto para a linha da ferramenta na conversa quanto para a linha de trabalho, que
 * precisa dizer o que está rodando agora — o mesmo resumo, cortado em limites diferentes.
 */
export const resumoArgumentos = (argumentos: Record<string, unknown>, limite = 96) => {
  // Acompanhar/parar um comando que já está rodando lê melhor em português do que o par
  // chave/valor cru: na linha de baixo aparece "acompanhando o comando abc123", que é o
  // que está acontecendo de verdade.
  if (argumentos.continuar) return `acompanhando o comando ${argumentos.continuar}`
  if (argumentos.parar) return `parando o comando ${argumentos.parar}`

  const partes = Object.entries(argumentos).map(([chave, valor]) => {
    const texto = typeof valor === 'string' ? valor : JSON.stringify(valor)
    const curto = (texto ?? '').replace(/\s+/g, ' ').slice(0, 44)
    return `${chave}: ${curto}${(texto ?? '').length > 44 ? '…' : ''}`
  })
  const resumo = partes.join(' · ')
  return resumo.length > limite ? `${resumo.slice(0, limite)}…` : resumo
}
