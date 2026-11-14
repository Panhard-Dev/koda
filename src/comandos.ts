/**
 * Os comandos do menu do "/" do prompt box.
 *
 * O menu é um **completador**, não um atalho que escreve por você. Escolher `/plan` só põe
 * `/plan ` na caixa e devolve o cursor — o que vai para o modelo é o que você escrever, do
 * jeito que você escreveu. Nada de texto pré-definido, nada de mensagem enviada sozinha.
 *
 * Mora fora do `Composer` porque é dado puro: quem filtra e reconhece são funções sem React,
 * e por isso dá para testá-las direto (ver `scripts/testar-comandos.mjs`).
 */

export type Comando = {
  /** O token digitado, com a barra (`/plan`). */
  nome: string
  /** Uma linha, para a lista do menu: o que o comando quer dizer. */
  descricao: string
}

export const COMANDOS: Comando[] = [
  { nome: '/init', descricao: 'Criar ou atualizar o AGENTS.md do projeto' },
  { nome: '/plan', descricao: 'Planejar antes de executar' },
  { nome: '/model', descricao: 'Escolher modelo' },
  { nome: '/permissions', descricao: 'Ajustar permissões' },
  { nome: '/review', descricao: 'Revisar mudanças do projeto' },
  { nome: '/compact', descricao: 'Compactar contexto da conversa' },
  { nome: '/new', descricao: 'Iniciar nova conversa' },
  { nome: '/clear', descricao: 'Limpar a conversa' },
  { nome: '/status', descricao: 'Ver estado do host, backend e modelos' },
  { nome: '/arquivos', descricao: 'Consultar arquivos e subpastas do projeto' },
]

/** O que entra na caixa ao escolher o comando: o token e um espaço, para você continuar. */
export function textoDoComando(comando: Comando): string {
  return `${comando.nome} `
}

/** Comandos que agem na interface, sem mandar texto ao modelo. */
export const ACOES_DE_COMANDO: Record<string, 'model' | 'permissions' | 'new' | 'clear' | 'status'> = {
  '/model': 'model',
  '/permissions': 'permissions',
  '/new': 'new',
  '/clear': 'clear',
  '/status': 'status',
}

/** Os comandos de texto viram uma instrução útil, preservando o que vier depois. */
export function pedidoDoComando(texto: string): string {
  const [nome, ...resto] = texto.trim().split(/\s+/)
  const assunto = resto.join(' ').trim()
  if (nome === '/init') return `Cria ou atualiza o AGENTS.md deste projeto. ${assunto}`.trim()
  if (nome === '/plan') return `Faça um plano antes de executar. ${assunto}`.trim()
  if (nome === '/review') return `Revise as mudanças deste projeto. ${assunto}`.trim()
  if (nome === '/compact') return 'Resuma e compacte o contexto desta conversa.'
  return texto.trim()
}

/**
 * O que está sendo digitado como nome de comando, ou `null` quando não é comando.
 *
 * Devolve o token sem a barra: `/` → `''` (menu aberto, sem filtro), `/ini` → `'ini'`.
 * Devolve `null` quando já passou do nome — `/plan ` e `/plan a tarefa` —, porque aí o
 * comando está escolhido e o que vem depois é o que você está escrevendo.
 */
export function tokenDigitado(texto: string): string | null {
  if (!texto.startsWith('/')) return null
  const resto = texto.slice(1)
  return /^[a-z-]*$/i.test(resto) ? resto.toLowerCase() : null
}

/** `/backend/app/api` é navegação de pastas; `/plan` é comando. */
export function caminhoDigitado(texto: string): string | null {
  if (!texto.startsWith('/')) return null
  const resto = texto.slice(1)
  const nome = resto.split(/[/\s]/, 1)[0].toLowerCase()
  if (!nome) return null
  if (COMANDOS.some((item) => item.nome.slice(1) === nome)) return null
  return resto
}

/** Os comandos que casam com o que está sendo digitado. */
export function filtrarComandos(consulta: string): Comando[] {
  const alvo = consulta.trim().toLowerCase()
  if (!alvo) return COMANDOS
  return COMANDOS.filter((item) =>
    `${item.nome.slice(1)} ${item.descricao}`.toLowerCase().includes(alvo),
  )
}
