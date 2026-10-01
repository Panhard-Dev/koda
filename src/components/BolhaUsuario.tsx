/**
 * A bolha do que a pessoa escreveu.
 *
 * O texto sai com `whitespace-pre-wrap` — o prompt veio com as quebras de linha que a
 * pessoa digitou, e reescrevê-las seria mudar o que ela pediu. O problema é o que
 * `pre-wrap` **não** faz: uma sequência sem espaço nenhum (URL comprida, caminho do
 * Windows, base64, uma linha de código colada) não tem onde quebrar, então ela atravessa a
 * bolha e sai da tela. Era por aí que um prompt grande quebrava o layout: com
 * `overflow-hidden` na casca, o pedaço que passava da direita era simplesmente cortado.
 *
 * `break-words` (`overflow-wrap: break-word`) quebra a palavra longa quando ela sozinha não
 * cabe na linha. `min-w-0` é o par do flexbox: sem ele o item tem como largura mínima o seu
 * conteúdo, e `max-w-[80%]` não segura nada — o tamanho mínimo ganha da largura máxima.
 * Os dois são necessários; um sem o outro ainda estoura.
 *
 * Os anexos são nomes de arquivo e podem ser longos. Eles **quebram**, não encurtam: cortar o
 * nome no meio com reticências esconde justamente qual arquivo a pessoa anexou, e é o nome
 * inteiro que ela precisa conferir antes de mandar.
 *
 * Do anexo, a bolha mostra o **nome** — o `id` e o conteúdo ficam no backend, e não dizem
 * nada a quem está lendo a conversa.
 */
export default function BolhaUsuario({
  texto,
  anexos = [],
}: {
  texto: string
  anexos?: { nome: string }[]
}) {
  return (
    <div className="max-w-[80%] min-w-0 rounded-2xl rounded-tr-md bg-koda-input px-4 py-2.5 text-[15px] leading-6 break-words whitespace-pre-wrap text-koda-fg/90 ring-1 ring-koda-fg/5">
      {texto}
      {anexos.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {anexos.map((anexo, indice) => (
            <li
              key={`${anexo.nome}-${indice}`}
              className="max-w-full rounded-md bg-koda-fg/8 px-2 py-0.5 text-[12px] break-words text-koda-fg/70"
            >
              {anexo.nome}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
