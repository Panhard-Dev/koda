/** Estado da conta local. Nada disso sai do navegador nesta build. */
export type Account = {
  phone: string | null
  google: boolean
}

export const INITIAL_ACCOUNT: Account = { phone: null, google: false }

/** Mostra só os últimos dígitos, como um app de verdade faz. */
export const maskPhone = (value: string) => {
  const digits = value.replace(/\D/g, '')
  if (digits.length < 8) return null
  return `+55 •••••-${digits.slice(-4)}`
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
