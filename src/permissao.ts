import type { ModoPermissao } from './api/client'

/**
 * Os modos de permissão do agente, como aparecem no prompt box.
 *
 * O texto é o que a pessoa lê antes de escolher — «pede antes» / «faz o comum sozinho» /
 * «faz tudo». Sem jargão: quem escolhe isso está decidindo o quanto confia no agente, e
 * uma frase errada aqui vira arquivo apagado. Auto executa comandos shell com as
 * permissões da conta; Livre também solta as ferramentas de arquivo do projeto.
 */
export type ModoDePermissao = {
  id: ModoPermissao
  label: string
  hint: string
  /** Nome curto, para o botão do prompt box. */
  curto: string
}

export const MODOS_PERMISSAO: ModoDePermissao[] = [
  {
    id: 'manual',
    label: 'Perguntar sempre',
    hint: 'Pede antes de rodar comando, escrever, apagar ou sair da pasta',
    curto: 'Manual',
  },
  {
    id: 'default',
    label: 'Padrão',
    hint: 'Trabalha no projeto e pede aprovação para comandos e ações importantes',
    curto: 'Padrão',
  },
  {
    id: 'auto',
    label: 'Auto',
    hint: 'Executa sem pedir aprovação; o shell usa as permissões da sua conta e os arquivos ficam no projeto por padrão',
    curto: 'Automático',
  },
  {
    id: 'livre',
    label: 'Livre — arquivos no computador inteiro',
    hint: 'Sem aprovações; escolha se confia ao Koda acesso a arquivos fora do projeto',
    curto: 'Livre',
  },
]

export const modoDe = (id: ModoPermissao): ModoDePermissao =>
  MODOS_PERMISSAO.find((item) => item.id === id) ?? MODOS_PERMISSAO[1]
