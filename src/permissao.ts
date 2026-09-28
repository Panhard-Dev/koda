import type { ModoPermissao } from './api/client'

/**
 * Os três modos de permissão do agente, como aparecem no prompt box.
 *
 * O texto é o que a pessoa lê antes de escolher — «pede antes» / «faz o comum sozinho» /
 * «faz tudo». Sem jargão: quem escolhe isso está decidindo o quanto confia no agente, e
 * uma frase errada aqui vira arquivo apagado.
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
    label: 'Aprovação manual',
    hint: 'Pede antes de rodar comando, escrever, apagar ou sair da pasta',
    curto: 'Manual',
  },
  {
    id: 'default',
    label: 'Padrão',
    hint: 'Faz o comum sozinho e pergunta nas decisões importantes',
    curto: 'Padrão',
  },
  {
    id: 'auto',
    label: 'Tudo automático',
    hint: 'Faz tudo sem perguntar',
    curto: 'Automático',
  },
]

export const modoDe = (id: ModoPermissao): ModoDePermissao =>
  MODOS_PERMISSAO.find((item) => item.id === id) ?? MODOS_PERMISSAO[1]
