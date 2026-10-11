/**
 * A moeda do Koda: um «K» numa moeda roxa.
 *
 * O desenho veio do dono. O `<metadata>` do arquivo original saiu — era a assinatura C2PA da
 * ferramenta que gerou o SVG, não faz parte do produto.
 *
 * Os gradientes têm id **fixo** (`rim`, `face`, `letter`, `ring`): como só existe uma moeda na
 * tela, não há colisão. No dia em que houver duas, os ids precisam de sufixo por instância.
 */
export default function MoedaKoda({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      className={className}
      role="img"
      aria-label="Koda"
    >
      <defs>
        <linearGradient id="rim" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f3e8ff" />
          <stop offset="0.5" stopColor="#9333ea" />
          <stop offset="1" stopColor="#4c1d95" />
        </linearGradient>
        <radialGradient id="face" cx="0.35" cy="0.3" r="0.9">
          <stop offset="0" stopColor="#d8b4fe" />
          <stop offset="0.55" stopColor="#a855f7" />
          <stop offset="1" stopColor="#6b21a8" />
        </radialGradient>
        <linearGradient id="letter" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f5e9ff" />
          <stop offset="1" stopColor="#b57af5" />
        </linearGradient>
        <linearGradient id="ring" x1="1" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#f3e8ff" />
          <stop offset="1" stopColor="#5b21b6" />
        </linearGradient>
      </defs>

      {/* aro externo */}
      <circle cx="256" cy="256" r="240" fill="url(#rim)" />
      {/* serrilhado da borda */}
      <circle
        cx="256"
        cy="256"
        r="231"
        fill="none"
        stroke="#3b0764"
        strokeWidth="10"
        strokeDasharray="3 6"
        opacity="0.45"
      />

      {/* face */}
      <circle cx="256" cy="256" r="212" fill="url(#face)" />
      <circle
        cx="256"
        cy="256"
        r="212"
        fill="none"
        stroke="#3b0764"
        strokeWidth="3"
        opacity="0.5"
      />

      {/* anel interno */}
      <circle cx="256" cy="256" r="186" fill="none" stroke="url(#ring)" strokeWidth="8" />
      <circle
        cx="256"
        cy="256"
        r="172"
        fill="none"
        stroke="#4c1d95"
        strokeWidth="2"
        strokeDasharray="2 8"
        strokeLinecap="round"
        opacity="0.7"
      />

      {/* letra K: sombra, realce e face */}
      <g strokeLinejoin="round">
        <polygon
          transform="translate(5 6)"
          fill="#3b0764"
          opacity="0.55"
          stroke="#3b0764"
          strokeWidth="6"
          points="186,148 234,148 234,236 310,148 368,148 276,254 376,364 316,364 234,272 234,364 186,364"
        />
        <polygon
          transform="translate(-2 -2)"
          fill="#fbf5ff"
          stroke="#fbf5ff"
          strokeWidth="6"
          points="186,148 234,148 234,236 310,148 368,148 276,254 376,364 316,364 234,272 234,364 186,364"
        />
        <polygon
          fill="url(#letter)"
          stroke="#6b21a8"
          strokeWidth="4"
          points="186,148 234,148 234,236 310,148 368,148 276,254 376,364 316,364 234,272 234,364 186,364"
        />
      </g>

      {/* brilho */}
      <path
        d="M110 170 A 160 160 0 0 1 220 82"
        fill="none"
        stroke="#fff"
        strokeWidth="10"
        strokeLinecap="round"
        opacity="0.5"
      />
    </svg>
  )
}
