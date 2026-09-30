import KodaLogo from './KodaLogo'
import RichText from './RichText'

/**
 * Um trecho de fala do modelo: a coroa à esquerda e o texto ao lado.
 *
 * A largura é `max-w-[85%]`, e não `w-[85%]`: uma resposta curta ("Feito.") fica do tamanho
 * dela, sem uma caixa larga e vazia em volta.
 *
 * O par que evita o estouro está no `RichText` (`min-w-0` + `break-words` no seu container):
 * aqui a coroa é `shrink-0` e o texto é quem cede. Era onde a resposta enorme quebrava o
 * layout — parágrafo com URL comprida, caminho de arquivo ou linha de código que atravessava
 * a tela em vez de quebrar.
 */
export default function FalaDoModelo({ texto }: { texto: string }) {
  return (
    <div className="flex items-start gap-3">
      <KodaLogo className="mt-1.5 h-3.5 w-auto shrink-0 text-koda-fg/70" color="currentColor" />
      <RichText text={texto} className="max-w-[85%] text-[15px] text-koda-fg/85" />
    </div>
  )
}
