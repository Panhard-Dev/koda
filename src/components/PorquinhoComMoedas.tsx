/**
 * Porquinho com moedas — o ícone da área Economia em Ajustes.
 *
 * É traço, como os ícones do lucide ao lado: na coluna de Ajustes ele vive em 16 px e
 * precisa ler junto com eles. O porquinho fica na metade de baixo e as duas moedas caem
 * na fenda — é o que separa este desenho de um cofrinho qualquer.
 *
 * O corpo do porquinho parte do `piggy-bank` do lucide (ISC), reduzido e deslocado para
 * abrir espaço para as moedas. O `strokeWidth` maior dentro do grupo compensa a escala,
 * para o traço não ficar mais fino que o dos outros ícones.
 */
export function PorquinhoComMoedas({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* As moedas: uma maior, com a face marcada, e outra menor atrás. */}
      <circle cx="10.9" cy="3.1" r="1.8" strokeWidth="1.4" />
      <path d="M10.1 3.1h1.6" strokeWidth="1.2" />
      <circle cx="14.8" cy="2.3" r="1.1" strokeWidth="1.4" />

      {/* O porquinho, reduzido para caber debaixo das moedas. */}
      <g transform="translate(1.2 4) scale(0.82)" strokeWidth="2">
        <path d="M11 17h3v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-3a3.16 3.16 0 0 0 2-2h1a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1h-1a5 5 0 0 0-2-4V3a4 4 0 0 0-3.2 1.6l-.3.4H11a6 6 0 0 0-6 6v1a5 5 0 0 0 2 4v3a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1z" />
        <path d="M16 10h.01" />
        <path d="M2 8v1a2 2 0 0 0 2 2h1" />
      </g>

      {/* A fenda na lombada, logo abaixo das moedas. */}
      <path d="M10.2 9.6h2.6" strokeWidth="1.4" />
    </svg>
  )
}

export default PorquinhoComMoedas
