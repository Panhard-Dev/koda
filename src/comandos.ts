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
]

/** O que entra na caixa ao escolher o comando: o token e um espaço, para você continuar. */
export function textoDoComando(comando: Comando): string {
  return `${comando.nome} `
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

/** Os comandos que casam com o que está sendo digitado. */
export function filtrarComandos(consulta: string): Comando[] {
  const alvo = consulta.trim().toLowerCase()
  if (!alvo) return COMANDOS
  return COMANDOS.filter((item) =>
    `${item.nome.slice(1)} ${item.descricao}`.toLowerCase().includes(alvo),
  )
}
