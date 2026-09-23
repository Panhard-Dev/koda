type KodaLogoProps = {
  className?: string
  color?: string
}

/** Coroa roxa usada como marca do Koda. */
export function KodaLogo({ className = 'h-6 w-auto', color = '#b040d0' }: KodaLogoProps) {
  return (
    <svg
      viewBox="0 0 810 580"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <polygon
        points="0,520 160,520 60,140 270,310 400,80 530,310 740,140 640,520 800,520"
        fill={color}
        stroke="none"
      />
    </svg>
  )
}

export default KodaLogo
