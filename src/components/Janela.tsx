/**
 * A casca da janela: a caixa que ocupa **exatamente** a viewport, em qualquer zoom.
 *
 * `#root` recebe `zoom: var(--koda-zoom)`, e o zoom escala a interface toda — inclusive o
 * que `100vh`/`100vw` medem. Dividir a medida da viewport pelo zoom desfaz essa
 * multiplicação: em 90% a raiz fica com `100vh/0.9` de altura, que depois do zoom volta a
 * ser `100vh`. Sem isso, "compacto" deixava uma faixa morta embaixo e "grande" empurrava o
 * rodapé para fora da tela.
 *
 * O `overflow-hidden` é a garantia de última linha: nada que estoure uma linha de dentro
 * dos limites pode arrastar a tela inteira. Mas ele **não** substitui o tratamento nos
 * filhos — o que transborda aqui é cortado sem rolagem, ou seja, some da vista. Por isso
 * cada bolha e cada bloco de texto quebra palavra longa por conta própria.
 *
 * Está num lugar só, e não repetido em cada tela, porque a bancada visual
 * (`chat.html` + `src/harnessChat.tsx`) monta a conversa com esta mesma classe: testar uma
 * casca diferente da que vai para o app não provaria nada.
 */
export const CLASSE_DA_JANELA =
  'flex h-[calc(100vh/var(--koda-zoom))] w-[calc(100vw/var(--koda-zoom))] flex-col overflow-hidden bg-koda-bg'
