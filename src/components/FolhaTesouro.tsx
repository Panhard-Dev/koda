/**
 * Folha de mapa do tesouro — pergaminho com a rota tracejada e o X.
 *
 * Decoração que fica **atrás** da coroa no seletor de modelos do composer: a coroa é a
 * marca da casa e manda na frente; o pergaminho só aparece por trás, nas bordas, como
 * um papel enfiado por baixo. Daí `pointer-events-none` e `aria-hidden` — nunca é alvo
 * de clique nem de leitor de tela.
 *
 * O desenho é de propósito três elementos só — página de canto cortado, rota tracejada,
 * X — porque ele vive em ~18 px: traço fino ou caminho caprichado vira borrona nesse
 * tamanho. A cor vem do `currentColor` de quem usa (o composer passa um âmbar fraco,
 * para o pergaminho aparecer sem brigar com a coroa).
 */
export function FolhaTesouro({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true" fill="none">
      {/* O pergaminho: página de bordas retas com o canto de baixo cortado (a dobra). */}
      <path
        d="M9.5 4.5h12A2.5 2.5 0 0 1 24 7v16.5l-3.5 3.5h-11A2.5 2.5 0 0 1 7 24.5V7a2.5 2.5 0 0 1 2.5-2.5Z"
        fill="currentColor"
        fillOpacity="0.22"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      {/* A rota: tracejado subindo da margem de baixo até o X. */}
      <path
        d="M11 22.5c2.5-1.5 3-5 1.5-8S11.5 9 15.5 8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeDasharray="2.8 2.8"
      />
      {/* O X do tesouro. */}
      <path
        d="M17.5 6.5 21 10M21 6.5 17.5 10"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  )
}

export default FolhaTesouro
