/** A coroa da marca, com um brilho varrendo quando o Koda está trabalhando. */
const COROA = '0,520 160,520 60,140 270,310 400,80 530,310 740,140 640,520 800,520'

export function ThinkingMark({ className = 'h-4 w-auto' }: { className?: string }) {
  return (
    <svg viewBox="0 0 810 580" className={className} aria-hidden="true">
      <defs>
        <mask id="koda-thinking-mask">
          <polygon points={COROA} fill="#fff" />
        </mask>
      </defs>

      <polygon points={COROA} fill="currentColor" opacity="0.25" />

      <g mask="url(#koda-thinking-mask)">
        <rect
          className="thinking-shine"
          x="-280"
          y="-20"
          width="280"
          height="620"
        />
      </g>
    </svg>
  )
}

export default ThinkingMark
