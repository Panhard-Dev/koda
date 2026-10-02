/**
 * Duração e contagem na escala que a pessoa lê — não em milissegundos crus.
 *
 * O app mostrava `2725 ms`, `4833 ms` e `314s` lado a lado: número comprido, unidade
 * trocando sem regra e nenhuma ajuda para saber se aquilo foi rápido. Aqui a régua é uma
 * só, e ela sobe quando a unidade de baixo fica grande demais para ser lida:
 *
 *   `47 ms` → `2,7 s` → `1,4 min` → `1,2 h` → `2 d`
 *
 * O corte é sempre no 60 da unidade anterior (60 s = 1 min, 60 min = 1 h, 24 h = 1 d),
 * como um relógio — e não em potências de 1000, que dariam `2,7 s` mas também `45 min` e
 * `0,7 h`, dois jeitos de dizer a mesma coisa.
 */

/** Uma casa decimal abaixo de 10 (`2,7`), nenhuma acima (`12`) — ou `1,4` viraria `1,40`. */
function numeroCurto(valor: number): string {
  const casas = valor < 10 ? 1 : 0
  return valor.toLocaleString('pt-BR', {
    minimumFractionDigits: casas,
    maximumFractionDigits: casas,
  })
}

/**
 * Duração legível: `ms`, `s`, `min`, `h` ou `d`.
 *
 * Abaixo de um segundo não há o que arredondar — `940 ms` é mais honesto que `0,9 s`, e
 * é justamente a faixa em que a diferença entre duas ferramentas aparece. De um segundo
 * para cima o decimal ajuda (`1,4 s` diz o que `1 s` esconde) e some quando o número já é
 * grande o bastante para o decimal não significar nada.
 */
export function formatarDuracao(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0 ms'
  if (ms < 1000) return `${Math.round(ms)} ms`

  const segundos = ms / 1000
  if (segundos < 60) return `${numeroCurto(segundos)} s`

  const minutos = segundos / 60
  if (minutos < 60) return `${numeroCurto(minutos)} min`

  const horas = minutos / 60
  if (horas < 24) return `${numeroCurto(horas)} h`

  return `${numeroCurto(horas / 24)} d`
}

/**
 * Contagem de caracteres em número curto: `67 caracteres`, `2,4 mil caracteres`.
 *
 * Um raciocínio de 2377 caracteres não precisa dos quatro dígitos para dizer que foi
 * comprido — o que a pessoa quer saber ali é a ordem de grandeza.
 */
export function formatarCaracteres(total: number): string {
  if (!Number.isFinite(total) || total < 0) return '0 caracteres'
  if (total < 1000) return `${Math.round(total)} caracteres`
  if (total < 1_000_000) return `${numeroCurto(total / 1000)} mil caracteres`
  return `${numeroCurto(total / 1_000_000)} mi caracteres`
}
