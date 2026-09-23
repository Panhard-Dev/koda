import type { ReactNode } from 'react'

/**
 * Markdown mínimo para as respostas do modelo: negrito, itálico, `código`, blocos de
 * código, títulos e listas. Sem dependência nova e sem `dangerouslySetInnerHTML` — o
 * texto vira elementos React, então nada de HTML de fora entra na página.
 */
const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*)/g

function inline(texto: string, chave: string): ReactNode[] {
  return texto
    .split(INLINE)
    .filter((parte) => parte !== '')
    .map((parte, indice) => {
      const chaveParte = `${chave}-${indice}`
      if (parte.startsWith('**') && parte.endsWith('**') && parte.length > 4) {
        return (
          <strong key={chaveParte} className="font-semibold text-koda-fg/95">
            {parte.slice(2, -2)}
          </strong>
        )
      }
      if (parte.startsWith('`') && parte.endsWith('`') && parte.length > 2) {
        return (
          <code
            key={chaveParte}
            className="rounded-md bg-koda-fg/8 px-1 py-0.5 font-mono text-[12.5px] text-koda-fg/85"
          >
            {parte.slice(1, -1)}
          </code>
        )
      }
      if (parte.startsWith('*') && parte.endsWith('*') && parte.length > 2) {
        return (
          <em key={chaveParte} className="text-koda-fg/85">
            {parte.slice(1, -1)}
          </em>
        )
      }
      return <span key={chaveParte}>{parte}</span>
    })
}

const MARCA_BULLET = /^[-*•]\s+(.*)$/
const MARCA_NUMERO = /^(\d+)[.)]\s+(.*)$/
const MARCA_TITULO = /^(#{1,4})\s+(.*)$/

function paragrafos(texto: string, chave: string): ReactNode[] {
  const nos: ReactNode[] = []
  let linhas: string[] = []
  let lista: { tipo: 'ul' | 'ol'; itens: string[] } | null = null
  let contador = 0

  const despejarLinhas = () => {
    if (linhas.length === 0) return
    nos.push(
      <p key={`${chave}-p${contador++}`} className="leading-7">
        {linhas.map((linha, indice) => (
          <span key={indice}>
            {indice > 0 ? <br /> : null}
            {inline(linha, `${chave}-l${contador}-${indice}`)}
          </span>
        ))}
      </p>,
    )
    linhas = []
  }

  const despejarLista = () => {
    if (!lista) return
    const itens = lista.itens.map((item, indice) => (
      <li key={indice} className="leading-7">
        {inline(item, `${chave}-i${contador}-${indice}`)}
      </li>
    ))
    nos.push(
      lista.tipo === 'ul' ? (
        <ul key={`${chave}-ul${contador++}`} className="ml-5 list-disc space-y-0.5">
          {itens}
        </ul>
      ) : (
        <ol key={`${chave}-ol${contador++}`} className="ml-5 list-decimal space-y-0.5">
          {itens}
        </ol>
      ),
    )
    lista = null
  }

  for (const linha of texto.split('\n')) {
    const limpa = linha.trim()
    if (!limpa) {
      // Linha em branco fecha o parágrafo, mas **não** a lista: o modelo costuma
      // separar os itens com linha vazia, e fechar aqui viraria uma lista por item.
      despejarLinhas()
      continue
    }

    const titulo = MARCA_TITULO.exec(limpa)
    if (titulo) {
      despejarLinhas()
      despejarLista()
      nos.push(
        <p key={`${chave}-t${contador++}`} className="font-semibold text-koda-fg/95">
          {inline(titulo[2], `${chave}-tl${contador}`)}
        </p>,
      )
      continue
    }

    const bullet = MARCA_BULLET.exec(limpa)
    const numero = MARCA_NUMERO.exec(limpa)
    if (bullet || numero) {
      despejarLinhas()
      const tipo = bullet ? 'ul' : 'ol'
      if (!lista || lista.tipo !== tipo) {
        despejarLista()
        lista = { tipo, itens: [] }
      }
      lista.itens.push((bullet ? bullet[1] : numero?.[2]) ?? '')
      continue
    }

    despejarLista()
    linhas.push(limpa)
  }

  despejarLinhas()
  despejarLista()
  return nos
}

export default function RichText({ text, className = '' }: { text: string; className?: string }) {
  const blocos: ReactNode[] = []
  // Blocos de código ficam nos índices ímpares do split por ```.
  text.split('```').forEach((parte, indice) => {
    if (indice % 2 === 1) {
      const linhas = parte.split('\n')
      const primeira = linhas[0].trim()
      const temLinguagem = primeira !== '' && !primeira.includes(' ')
      const codigo = (temLinguagem ? linhas.slice(1) : linhas).join('\n').replace(/\n+$/, '')
      blocos.push(
        <div key={`code-${indice}`} className="flex flex-col gap-1">
          {temLinguagem && primeira && primeira.length <= 16 ? (
            <span className="text-[10.5px] tracking-wide text-koda-fg/30 uppercase">
              {primeira}
            </span>
          ) : null}
          <pre className="overflow-x-auto rounded-xl bg-koda-fg/4 p-3 font-mono text-[12.5px] leading-5 ring-1 ring-koda-fg/8">
            {codigo}
          </pre>
        </div>,
      )
      return
    }
    blocos.push(...paragrafos(parte, `bloco-${indice}`))
  })

  return <div className={`flex flex-col gap-2.5 ${className}`}>{blocos}</div>
}
