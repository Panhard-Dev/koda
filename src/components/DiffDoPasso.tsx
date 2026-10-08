import { useEffect, useState } from 'react'
import { mudancasDaChamada } from '../api/client'
import type { ToolStep } from '../api/client'

/**
 * O que uma chamada de ferramenta escreveu, com o verde no que entrou e o vermelho no que
 * saiu — dentro do cartão dela, na conversa.
 *
 * De onde vem o diff depende da ferramenta, e o critério é sempre o mesmo: mostrar o que a
 * chamada **carregou**, sem inventar.
 *
 * - `edit_file` traz o trecho velho e o novo nos próprios argumentos. O vermelho é o
 *   `old_string`, o verde é o `new_string` — sai daí, sem pedir nada a ninguém, e continua
 *   valendo para uma conversa reaberta.
 * - `apply_patch` traz o diff unificado pronto, já com as marcas de `+` e `-`.
 * - `write_file` traz só o conteúdo novo. O que estava lá antes **não** está na chamada, e é
 *   por isso que só ele pergunta ao backend (`/api/fs/mudancas/chamada`), que guardou o antes
 *   na hora de gravar. Sem essa resposta — conversa de uma execução anterior do Koda — o
 *   conteúdo aparece em verde, que é o que a chamada de fato escreveu.
 *
 * O tipo é decidido pelo **formato dos argumentos**, e não pelo nome da ferramenta: o modelo
 * chama `patch`, `apply_diff` e `create_file` de memória, e o apelido nem sempre bate com o
 * que o backend despacha. O que não mente é o que veio escrito na chamada.
 *
 * Sem números de linha, de propósito: aqui os trechos são fragmentos (o `old_string` de uma
 * edição não é um arquivo), e um número inventado para eles seria pior do que número nenhum.
 * A numeração de verdade é da aba Código, onde o arquivo inteiro está à vista.
 */

type Tipo = 'edicao' | 'patch' | 'escrita'

type Linha = { tipo: 'igual' | 'entrou' | 'saiu'; texto: string }

/**
 * O teto de linhas do cartão.
 *
 * Um `write_file` de um arquivo inteiro é uma linha verde por linha do arquivo, e dois mil
 * elementos dentro de um cartão de conversa pesam de verdade. O que passa disso é cortado com
 * aviso — o resto está na aba Código.
 */
const TETO_DE_LINHAS = 300

/** Que tipo de mudança esta chamada carrega. `null` quando não carrega nenhuma. */
function tipoDaMudanca(argumentos: Record<string, unknown> | undefined): Tipo | null {
  if (!argumentos) return null
  if ('old_string' in argumentos || 'new_string' in argumentos) return 'edicao'
  if (typeof argumentos.diff === 'string') return 'patch'
  if (typeof argumentos.conteudo === 'string') return 'escrita'
  return null
}

/** As linhas de um texto, todas com a mesma marca. */
function bloco(texto: string, tipo: 'entrou' | 'saiu'): Linha[] {
  return texto.split('\n').map((linha) => ({ tipo, texto: linha }))
}

/**
 * As linhas de um diff unificado, como ele mesmo as marca.
 *
 * Os cabeçalhos ficam de fora: `--- a/x`, `+++ b/x` e `@@` são endereço, não conteúdo —
 * pintá-los de vermelho e verde acenderia como mudança um texto que não mudou.
 */
function doDiffUnificado(diff: string): Linha[] {
  const linhas: Linha[] = []
  for (const linha of diff.split('\n')) {
    if (/^(---|\+\+\+|@@|diff |index )/.test(linha)) continue
    if (linha.startsWith('+')) linhas.push({ tipo: 'entrou', texto: linha.slice(1) })
    else if (linha.startsWith('-')) linhas.push({ tipo: 'saiu', texto: linha.slice(1) })
    else if (linha.startsWith(' ') || linha === '') {
      linhas.push({ tipo: 'igual', texto: linha.slice(1) })
    }
  }
  return linhas
}

/** O que dá para dizer só com os argumentos — sem perguntar a ninguém. */
function dosArgumentos(step: ToolStep, tipo: Tipo): Linha[] {
  const argumentos = step.arguments ?? {}
  if (tipo === 'edicao') {
    return [
      ...bloco(String(argumentos.old_string ?? ''), 'saiu'),
      ...bloco(String(argumentos.new_string ?? ''), 'entrou'),
    ]
  }
  if (tipo === 'patch') return doDiffUnificado(String(argumentos.diff ?? ''))
  return bloco(String(argumentos.conteudo ?? ''), 'entrou')
}

export default function DiffDoPasso({ step }: { step: ToolStep }) {
  const tipo = tipoDaMudanca(step.arguments)

  // O valor inicial sai dos argumentos, que já estão na mão: o bloco aparece junto com o
  // cartão, sem esperar rede nenhuma.
  const [linhas, setLinhas] = useState<Linha[]>(() => (tipo ? dosArgumentos(step, tipo) : []))

  // Só a escrita pergunta. Edição e patch carregam a mudança inteira nos argumentos, e pedir
  // de novo seria pedir o que já se tem — e que se perde quando o app fecha.
  const pergunta = tipo === 'escrita'

  useEffect(() => {
    if (!pergunta || !step.call_id) return
    let parado = false
    void (async () => {
      try {
        const { itens } = await mudancasDaChamada(step.call_id)
        if (parado) return
        const completo = itens.find((item) => item.linhas && item.linhas.length > 0)?.linhas
        if (!completo) return
        setLinhas(completo.map((item) => ({ tipo: item.tipo, texto: item.texto })))
      } catch {
        // Sem a resposta fica o que veio dos argumentos — que é o conteúdo escrito.
      }
    })()
    return () => {
      parado = true
    }
  }, [pergunta, step.call_id])

  if (!tipo || linhas.length === 0) return null

  const mais = linhas.filter((linha) => linha.tipo === 'entrou').length
  const menos = linhas.filter((linha) => linha.tipo === 'saiu').length
  const mostradas = linhas.length > TETO_DE_LINHAS ? linhas.slice(0, TETO_DE_LINHAS) : linhas

  return (
    <div className="mt-1 mb-1 overflow-hidden rounded-md border border-koda-fg/10">
      <div className="flex items-center gap-2 border-b border-koda-fg/8 px-2 py-1">
        <span className="text-[10.5px] text-koda-fg/40">
          {tipo === 'escrita' ? 'o que a chamada escreveu' : 'o que a chamada mudou'}
        </span>
        <span className="ml-auto font-mono text-[10.5px] tabular-nums">
          <span className="text-emerald-400">+{mais}</span>
          {menos > 0 ? <span className="text-red-400"> −{menos}</span> : null}
        </span>
      </div>

      <pre className="max-h-64 overflow-auto font-mono text-[11.5px] leading-[1.6]">
        {mostradas.map((linha, indice) => {
          const entrou = linha.tipo === 'entrou'
          const saiu = linha.tipo === 'saiu'
          return (
            <span
              key={indice}
              className={[
                'flex',
                entrou ? 'bg-emerald-500/12' : saiu ? 'bg-red-500/12' : '',
              ].join(' ')}
            >
              <span
                aria-hidden
                className={[
                  'w-4 shrink-0 pl-1 select-none',
                  entrou ? 'text-emerald-400' : saiu ? 'text-red-400' : 'text-transparent',
                ].join(' ')}
              >
                {entrou ? '+' : saiu ? '−' : '·'}
              </span>
              <span className={['whitespace-pre pr-2', saiu ? 'text-koda-fg/55' : ''].join(' ')}>
                {linha.texto === '' ? ' ' : linha.texto}
              </span>
            </span>
          )
        })}
      </pre>

      {linhas.length > TETO_DE_LINHAS ? (
        <p className="border-t border-koda-fg/8 px-2 py-1 text-[10.5px] text-koda-fg/40">
          …e mais {(linhas.length - TETO_DE_LINHAS).toLocaleString('pt-BR')} linhas. O arquivo
          inteiro está na aba Código.
        </p>
      ) : null}
    </div>
  )
}
