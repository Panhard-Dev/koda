import { useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronRight, LogOut, Smartphone } from 'lucide-react'
import { apelidoDaConta, describeDevice, iniciaisDaConta } from '../account'

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-2 px-1 text-[12.5px] text-koda-fg/45">{label}</p>
      <section className="divide-y divide-koda-fg/8 rounded-2xl bg-koda-panel ring-1 ring-koda-fg/8">
        {children}
      </section>
    </div>
  )
}

function Row({
  icon,
  label,
  children,
}: {
  icon?: ReactNode
  label: string
  children: ReactNode
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      {icon ? <span className="shrink-0 text-koda-fg/60">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-koda-fg/90">
        {label}
      </span>
      {children}
    </div>
  )
}

/** Etiqueta neutra, para o que ainda não está pronto (mesma família visual dos ajustes). */
function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-full bg-koda-fg/6 px-2 py-0.5 text-[10.5px] font-semibold tracking-wider text-koda-fg/55 uppercase">
      {children}
    </span>
  )
}

/** Marca do Google: o "G" colorido, sem depender de imagem externa. */
function GoogleMark() {
  return (
    <span className="flex h-4 w-4 items-center justify-center">
      <span className="bg-gradient-to-br from-[#4285f4] via-[#ea4335] to-[#34a853] bg-clip-text text-[15px] leading-none font-bold text-transparent">
        G
      </span>
    </span>
  )
}

export function AccountSection({
  contaKoda = null,
  onSignOut,
}: {
  /** Quem entrou na tela de login — a conta existe no painel, não nesta máquina. */
  contaKoda?: { email: string; nome?: string | null } | null
  onSignOut: () => void
}) {
  const [devicesOpen, setDevicesOpen] = useState(false)
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)
  const [device] = useState(() => describeDevice(navigator.userAgent))

  const apelido = apelidoDaConta(contaKoda)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center pt-1">
        <span className="flex h-24 w-24 items-center justify-center rounded-full bg-gradient-to-br from-koda-accent to-koda-accent-strong text-[28px] font-semibold text-white shadow-[0_16px_36px_-16px_var(--koda-shadow)]">
          {iniciaisDaConta(apelido)}
        </span>
        <p className="mt-4 max-w-full truncate px-4 text-[16px] font-semibold text-koda-fg">
          {apelido}
        </p>
        <p className="mt-1 max-w-full truncate px-4 text-[12.5px] text-koda-fg/45">
          {contaKoda ? contaKoda.email : 'Plano Free · vínculos desta conta'}
        </p>
      </div>

      {/*
        Telefone e Google ainda não são vínculos de verdade: quem guarda a conta é o painel,
        e lá não existe entrar por telefone nem por Google. Em vez de um botão que só
        mexe num campo local, a linha diz o que é — ainda não está pronto.
      */}
      <Group label="Contas vinculadas">
        <Row icon={<Smartphone className="h-4 w-4" strokeWidth={1.7} />} label="Telefone">
          <Tag>Em breve</Tag>
        </Row>

        <Row icon={<GoogleMark />} label="Google">
          <Tag>Em breve</Tag>
        </Row>
      </Group>

      <Group label="Segurança da conta">
        <button
          type="button"
          aria-expanded={devicesOpen}
          onClick={() => setDevicesOpen((value) => !value)}
          className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors duration-150 hover:bg-koda-fg/4 focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
        >
          <span className="flex-1 text-[13.5px] font-medium text-koda-fg/90">
            Gerenciar dispositivos
          </span>
          <span className="shrink-0 text-[13px] text-koda-fg/55">1 dispositivo</span>
          <ChevronRight
            className={[
              'h-4 w-4 shrink-0 text-koda-fg/40 transition-transform duration-150',
              devicesOpen ? 'rotate-90' : '',
            ].join(' ')}
            strokeWidth={1.8}
          />
        </button>

        {devicesOpen ? (
          <div className="flex items-center gap-3 px-4 py-3.5">
            <span className="h-2 w-2 shrink-0 rounded-full bg-koda-accent" />
            <span className="min-w-0 flex-1 truncate text-[13px] text-koda-fg/75">
              {device}
            </span>
            <span className="shrink-0 text-[12px] text-koda-fg/45">sessão atual</span>
          </div>
        ) : null}
      </Group>

      {confirmingSignOut ? (
        <div className="flex items-center justify-between gap-3 rounded-2xl bg-koda-panel px-4 py-3 ring-1 ring-koda-fg/8">
          <p className="min-w-0 text-[12.5px] leading-5 text-koda-fg/60">
            Isso limpa a conversa e o histórico desta máquina — e o Koda volta a pedir a sua
            senha para entrar.
          </p>
          <span className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => setConfirmingSignOut(false)}
              className="rounded-lg px-2.5 py-1.5 text-[13px] text-koda-fg/70 transition-colors hover:bg-koda-fg/8 hover:text-koda-fg focus-visible:outline-none"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={onSignOut}
              className="rounded-lg bg-koda-accent-strong px-2.5 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-koda-accent-strong/85 focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
            >
              Sair
            </button>
          </span>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirmingSignOut(true)}
          className="flex w-full items-center justify-center gap-2 rounded-2xl bg-koda-panel py-4 text-[14px] font-medium text-koda-fg/85 ring-1 ring-koda-fg/8 transition-colors duration-150 hover:bg-koda-fg/6 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
        >
          <LogOut className="h-4 w-4" strokeWidth={1.8} />
          Sair da conta
        </button>
      )}
    </div>
  )
}

export default AccountSection
