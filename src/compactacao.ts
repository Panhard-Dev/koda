/**
 * Os avisos de compactação que o backend manda **dentro do texto** da resposta.
 *
 * Eles nascem como uma linha em itálico (`_(histórico compactado: …)_`) porque precisam
 * ficar gravados junto da mensagem — reabrir a conversa depois tem de mostrar que parte do
 * histórico virou resumo. Na tela, porém, uma frase em itálico no meio da resposta não diz
 * nada a ninguém: some no texto, parece sobra e ninguém entende o que aconteceu.
 *
 * Aqui essa linha é reconhecida e vira um **bloco** — o cartão de contexto que a conversa
 * desenha no lugar exato onde a compactação aconteceu. O texto gravado continua intacto:
 * o que muda é só como ele é lido.
 */

export type MotivoDeCompactacao = 'historico' | 'contexto' | 'reducao' | 'corte'

export type Compactacao = {
  motivo: MotivoDeCompactacao
  /** Mensagens antigas que viraram resumo (`historico`); `null` nos outros motivos. */
  compactados: number | null
  /** Tamanho do contexto antes/depois, em tokens — quando o provedor conta. */
  tokensAntes: number | null
  tokensDepois: number | null
}

type Regra = {
  padrao: RegExp
  montar: (achado: RegExpMatchArray) => Compactacao
}

/**
 * As quatro notas, com o formato exato em que o backend as escreve.
 *
 * Ancoradas no texto completo de cada nota (não em pedaços): nota pela metade continua
 * texto até chegar inteira — assim nada aparece truncado na tela no meio do stream.
 */
const REGRAS: Regra[] = [
  {
    padrao:
      /_\(histórico compactado: (\d+) mensagens antigas viraram resumo, para a conversa caber no contexto\)_/,
    montar: (achado) => ({
      motivo: 'historico',
      compactados: Number(achado[1]),
      tokensAntes: null,
      tokensDepois: null,
    }),
  },
  {
    padrao:
      /_\(contexto compactado: ~(\d+)k → ~(\d+)k tokens — o que já foi feito segue no resumo\)_/,
    montar: (achado) => ({
      motivo: 'contexto',
      compactados: null,
      tokensAntes: Number(achado[1]) * 1000,
      tokensDepois: Number(achado[2]) * 1000,
    }),
  },
  {
    padrao:
      /_\(o provedor recusou o tamanho do pedido: encolhi o contexto para ~(\d+)k tokens e sigo daqui\)_/,
    montar: (achado) => ({
      motivo: 'reducao',
      compactados: null,
      tokensAntes: null,
      tokensDepois: Number(achado[1]) * 1000,
    }),
  },
  {
    padrao: /_\(a resposta foi cortada no teto de tokens do modelo — sigo do que veio completo\)_/,
    montar: () => ({
      motivo: 'corte',
      compactados: null,
      tokensAntes: null,
      tokensDepois: null,
    }),
  },
]

/** Um pedaço do texto: fala do modelo, ou um aviso de compactação no meio dela. */
export type ParteDoTexto =
  | { tipo: 'texto'; texto: string }
  | { tipo: 'compactacao'; compactacao: Compactacao }

/**
 * Quebra um texto em fala + avisos, na ordem em que apareceram.
 *
 * As quebras de linha em volta de cada aviso saem junto com ele (o backend escreve
 * `\n\n_(…)_\n\n`): sem isso a conversa ficaria com buracos brancos em volta do cartão.
 * Devolve sempre pelo menos um pedaço; texto sem aviso nenhum volta como um `texto` só.
 */
export function separarCompactacoes(texto: string): ParteDoTexto[] {
  const partes: ParteDoTexto[] = []
  let resto = texto

  while (resto) {
    let melhor: { indice: number; fim: number; compactacao: Compactacao } | null = null
    for (const regra of REGRAS) {
      const achado = regra.padrao.exec(resto)
      if (!achado || achado.index === undefined) continue
      if (melhor && achado.index >= melhor.indice) continue
      melhor = {
        indice: achado.index,
        fim: achado.index + achado[0].length,
        compactacao: regra.montar(achado),
      }
    }

    if (!melhor) break

    // As quebras de linha encostadas no aviso saem **com** ele; o resto do texto fica
    // exatamente como veio. Nada é aparado além disso: o texto é o que está na tela, e
    // etapa de stream com um `\n\n` no fim (parágrafo novo) não pode perder a quebra.
    const antes = resto.slice(0, melhor.indice).replace(/\n+$/, '')
    if (antes) partes.push({ tipo: 'texto', texto: antes })
    partes.push({ tipo: 'compactacao', compactacao: melhor.compactacao })
    resto = resto.slice(melhor.fim).replace(/^\n+/, '')
  }

  // Sem aviso nenhum, o texto volta inteiro — sem poda de nada.
  if (resto) partes.push({ tipo: 'texto', texto: resto })
  if (partes.length === 0 && texto) partes.push({ tipo: 'texto', texto })
  return partes
}
