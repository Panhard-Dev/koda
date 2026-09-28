/**
 * Como a conta aparece na interface.
 *
 * Quem guarda a conta — identidade, sessão, vínculos — é o painel do Koda; aqui só mora o
 * que é preciso para *mostrar* isso na tela: o apelido e as iniciais do avatar.
 */

/** Conta como a interface a vê: só o que é exibido. */
type ContaVisivel = { email: string; nome?: string | null }

/**
 * Nome curto da conta: o nome que a pessoa escolheu, senão a parte antes do @, senão uma
 * palavra neutra. Nunca inventa um nome — o que aparece é o que está no painel.
 */
export const apelidoDaConta = (conta: ContaVisivel | null): string => {
  const nome = conta?.nome?.trim()
  if (nome) return nome
  const local = conta?.email?.split('@')[0]?.trim()
  return local && local !== '' ? local : 'Sua conta'
}

/**
 * Duas letras para o avatar. Nome composto dá as iniciais ("Pessoa Nova" → PN); nome de uma
 * palavra dá as duas primeiras letras ("admpanpan" → AD).
 */
export const iniciaisDaConta = (apelido: string): string => {
  const palavras = apelido.split(/[\s._-]+/).filter((palavra) => palavra !== '')
  const duas = palavras.length >= 2 ? `${palavras[0][0]}${palavras[1][0]}` : apelido.slice(0, 2)
  return duas.toUpperCase()
}

/** Navegador e sistema desta sessão, lidos do `userAgent` (dado real). */
export const describeDevice = (userAgent: string) => {
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /OPR\//.test(userAgent)
      ? 'Opera'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Chrome\//.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : 'Navegador'

  const system = /Windows/.test(userAgent)
    ? 'Windows'
    : /Mac OS X/.test(userAgent)
      ? 'macOS'
      : /Android/.test(userAgent)
        ? 'Android'
        : /Linux/.test(userAgent)
          ? 'Linux'
          : 'este sistema'

  return `${browser} · ${system}`
}
