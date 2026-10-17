/** A coroa da marca, com um brilho varrendo quando o Koda está trabalhando. */
const COROA = '0,520 160,520 60,140 270,310 400,80 530,310 740,140 640,520 800,520'

export function ThinkingMark({ className = 'h-4 w-auto' }: { className?: string }) {
  return (
    <svg viewBox="0 0 810 580" className={className} aria-hidden="true">
      <defs>
        {/*
          A faixa de brilho. São **duas**, num retângulo de duas viewBox (1620), numa
          repetição de 810: enquanto uma sai pela direita, a outra entra pela
          esquerda — a coroa nunca fica sem brilho e o laço fecha sem salto (o
          desenho no fim do ciclo é idêntico ao do começo).

          Já houve duas versões erradas aqui: a original, um retângulo de 280px que
          só alcançava o terço esquerdo; e a de faixa única, que por causa do
          easing parava nas duas pontas e parecia piscar de um lado para o outro.
          A travessia é LINEAR (`thinking-shine`, em index.css): velocidade
          constante, uma travessia completa da coroa a cada 1,5s.
        */}
        <linearGradient id="koda-thinking-shine" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--koda-accent)" stopOpacity="0" />
          <stop offset="0.21" stopColor="var(--koda-accent)" stopOpacity="1" />
          <stop offset="0.29" stopColor="var(--koda-accent)" stopOpacity="1" />
          <stop offset="0.5" stopColor="var(--koda-accent)" stopOpacity="0" />
          <stop offset="0.71" stopColor="var(--koda-accent)" stopOpacity="1" />
          <stop offset="0.79" stopColor="var(--koda-accent)" stopOpacity="1" />
          <stop offset="1" stopColor="var(--koda-accent)" stopOpacity="0" />
        </linearGradient>
        <mask id="koda-thinking-mask">
          <polygon points={COROA} fill="#fff" />
        </mask>
      </defs>

      <polygon points={COROA} fill="currentColor" opacity="0.25" />

      <g mask="url(#koda-thinking-mask)">
        <rect
          className="thinking-shine"
          x="0"
          y="0"
          width="1620"
          height="580"
          fill="url(#koda-thinking-shine)"
        />
      </g>
    </svg>
  )
}

export default ThinkingMark
