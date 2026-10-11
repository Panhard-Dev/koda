import { useState, useEffect } from 'react'
import type { ReactNode } from 'react'
import { Check, ChevronRight, LogOut, Smartphone } from 'lucide-react'
import { apelidoDaConta, dataCurta, describeDevice, iniciaisDaConta } from '../account'
import type { PlanoDaConta } from '../api/cloud'
import { ErroDaConta, assinaturaVale } from '../api/cloud'
import { cancelarAssinatura } from '../api/cobranca'
import type { MotivoSemEstorno } from '../api/cobranca'

/**
 * Quanto tempo a tela de reembolso fica de pé antes de dar a resposta.
 *
 * É **escolha do dono**, e está numa constante para ser uma linha quando ele quiser mexer: o
 * pedido ao Mercado Pago volta em um ou dois segundos, e o relógio aqui é o que dá ao
 * cancelamento o peso de uma solicitação em análise, em vez de um clique que some da tela.
 */
const SEGUNDOS_DO_REEMBOLSO = 30

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

/**
 * O que o plano dá, em linhas.
 *
 * Montado como lista de strings, e não como JSX solto, para os números `null` simplesmente
 * **não virarem linha**. Plano que saiu do catálogo continua valendo para quem assinou — é
 * assim que o servidor o trata — e a tela mostra o que sabe em vez de escrever «null horas».
 */
function beneficiosDoPlano(plano: PlanoDaConta): string[] {
  const itens: string[] = []
  if (plano.horas_por_dia !== null) itens.push(`${plano.horas_por_dia} horas por dia`)
  if (plano.moedas_por_mes !== null) itens.push(`${plano.moedas_por_mes} moedas por mês`)
  if (plano.moedas_por_dia !== null) itens.push(`+ ${plano.moedas_por_dia} moedas por dia`)
  return itens
}

/** Uma linha do que o plano dá. Ponto discreto: aqui a lista é para conferir, não para vender. */
function Beneficio({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-[12.5px] leading-5 text-koda-fg/70">
      <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-koda-accent" />
      <span className="min-w-0">{children}</span>
    </li>
  )
}

/**
 * A frase curta que explica o reembolso — no pop-up e no recado da página.
 *
 * Os três casos são **normais**, não erro: o dinheiro voltou, o prazo passou, ou nunca houve
 * cobrança. Nenhum deles pode aparecer como falha.
 */
function fraseDoEstorno(
  estorno: { id: number } | null,
  motivo: MotivoSemEstorno | null,
): string {
  if (estorno) return `O valor pago foi devolvido (estorno ${estorno.id}).`
  if (motivo === 'prazo_expirado') return 'O prazo de reembolso de 7 dias já tinha passado.'
  return 'Não havia cobrança aprovada para devolver.'
}

/**
 * O pop-up do reembolso.
 *
 * Fica de pé enquanto o pedido corre e **não fecha sozinho** quando dá certo: quem acabou de
 * cancelar precisa ver se o dinheiro voltou, e um pop-up que some sozinho transforma a única
 * informação que importava em algo que passou rápido demais para ler.
 */
function ModalDeReembolso({
  estado,
  onFechar,
}: {
  estado: {
    fase: 'processando' | 'concluido'
    segundos: number
    estorno: { id: number } | null
    motivo: MotivoSemEstorno | null
  }
  onFechar: () => void
}) {
  const devolveu = estado.estorno !== null

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 px-6">
      <div className="w-full max-w-sm rounded-2xl bg-koda-panel p-6 ring-1 ring-koda-fg/10">
        {estado.fase === 'processando' ? (
          <>
            <span className="mx-auto block h-9 w-9 animate-spin rounded-full border-2 border-koda-fg/12 border-t-koda-accent" />
            <p className="mt-5 text-center text-[17px] font-medium text-koda-fg">
              Preparando o reembolso
            </p>
            <p className="mt-1.5 text-center text-[12.5px] leading-5 text-koda-fg/50">
              Estamos pedindo o estorno ao Mercado Pago. Não feche a janela.
            </p>
            <p className="mt-4 text-center text-[11.5px] tabular-nums text-koda-fg/35">
              {estado.segundos}s
            </p>
          </>
        ) : (
          <>
            <span
              className={[
                'mx-auto flex h-12 w-12 items-center justify-center rounded-full',
                devolveu
                  ? 'bg-emerald-500/15 text-emerald-400'
                  : 'bg-koda-fg/8 text-koda-fg/50',
              ].join(' ')}
            >
              <Check className="h-6 w-6" strokeWidth={2.5} />
            </span>
            <p className="mt-4 text-center text-[17px] font-medium text-koda-fg">
              {devolveu ? 'Reembolso solicitado' : 'Assinatura cancelada'}
            </p>
            <p className="mt-1.5 text-center text-[12.5px] leading-5 text-koda-fg/50">
              {fraseDoEstorno(estado.estorno, estado.motivo)}
            </p>
            <button
              type="button"
              onClick={onFechar}
              className="mt-5 flex h-11 w-full items-center justify-center rounded-full bg-koda-accent text-[13.5px] font-medium text-koda-bg transition-colors duration-150 hover:bg-koda-accent-strong focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
            >
              Fechar
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * A etiqueta do plano, no perfil.
 *
 * Fica **aqui** porque é aqui que a pessoa procura por ela quando quer saber o que tem — é a
 * mesma pergunta que a área de planos responde, só que do lado de dentro, sem precisar abrir
 * a comparação de novo.
 *
 * O **estado muda a cor**, e é o ponto: plano ativo é accent; aguardando pagamento e atrasado
 * são âmbar, porque ainda não valem. Um selo só, da mesma cor para tudo, faria «já paguei» e
 * «falta pagar» parecerem a mesma coisa — e é justamente a diferença que a pessoa vem checar.
 *
 * O nome vem do painel (`PlanoDaConta`), não de uma lista daqui: plano renomeado lá apareceria
 * com o nome velho se a tela traduzisse o id sozinha.
 */
function EtiquetaDoPlano({ plano }: { plano: PlanoDaConta | null }) {
  if (!plano) {
    return (
      <span className="mt-3 rounded-full bg-koda-fg/6 px-2.5 py-1 text-[11px] text-koda-fg/55">
        Plano Free
      </span>
    )
  }

  const sufixo =
    plano.status === 'pendente'
      ? ' · aguardando pagamento'
      : plano.status === 'atrasada'
        ? ' · pagamento atrasado'
        : plano.status === 'cancelada'
          ? ' · cancelado'
          : ''

  return (
    <span
      className={[
        'mt-3 rounded-full px-2.5 py-1 text-[11px]',
        sufixo === ''
          ? 'bg-koda-accent/15 font-medium text-koda-accent'
          : 'bg-amber-400/10 text-amber-300/90',
      ].join(' ')}
    >
      {plano.nome}
      {sufixo}
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
  planoDaConta = null,
  onAssinaturaMudou,
  onSignOut,
}: {
  /** Quem entrou na tela de login — a conta existe no painel, não nesta máquina. */
  contaKoda?: { email: string; nome?: string | null } | null
  /** O plano em vigor, como o painel o conta. `null` é o Free. */
  planoDaConta?: PlanoDaConta | null
  /** Avisa que a assinatura mudou, para o `App` recolher o plano de novo no painel. */
  onAssinaturaMudou?: () => void
  onSignOut: () => void
}) {
  const [devicesOpen, setDevicesOpen] = useState(false)
  const [assinaturaOpen, setAssinaturaOpen] = useState(false)
  const [confirmandoCancelamento, setConfirmandoCancelamento] = useState(false)
  const [recadoDoCancelamento, setRecadoDoCancelamento] = useState<string | null>(null)
  const [erroDoCancelamento, setErroDoCancelamento] = useState<string | null>(null)
  /** O pop-up do reembolso. `null` = fechado. */
  const [reembolso, setReembolso] = useState<{
    fase: 'processando' | 'concluido'
    segundos: number
    estorno: { id: number; status: string } | null
    motivo: MotivoSemEstorno | null
  } | null>(null)
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)
  const [device] = useState(() => describeDevice(navigator.userAgent))

  const apelido = apelidoDaConta(contaKoda)
  // O plano só é tratado como assinatura quando **vale**: `pendente` é tentativa, não plano.
  // Estreitar aqui (e não chamar `assinaturaVale` dentro do JSX) é o que deixa o TypeScript
  // saber que daqui para dentro ele não é nulo.
  const assinatura = assinaturaVale(planoDaConta) ? planoDaConta : null

  // O prazo de reembolso, como o servidor o conta. A tela **mostra** e desabilita o pedido
  // depois dele; quem decide se estorna é o servidor, no cancelamento. Comparação de strings
  // ISO, que ordenam igual a datas — o mesmo formato que o servidor devolve.
  const prazoDoEstorno = assinatura?.estorno_ate ?? null
  const podePedirReembolso =
    prazoDoEstorno !== null && prazoDoEstorno > new Date().toISOString()

  /**
   * Cancela a assinatura e pede o estorno.
   *
   * O dinheiro é devolvido **pelo servidor** — o app não tem como estornar nada, só pedir. E o
   * pedido é coisa séria: quando dá certo, a resposta traz o **id do estorno**, e é isso que a
   * tela mostra. Sem id não houve devolução, e a tela não pode dizer que houve.
   *
   * A resposta e o relógio correm **em paralelo**, e a tela espera os dois: o Mercado Pago
   * responde em um ou dois segundos, e sem o `Promise.all` o pop-up fecharia antes de a pessoa
   * ler o que aconteceu.
   *
   * O recado final fica **fora** do grupo da assinatura de propósito: quando o cancelamento dá
   * certo, o plano da conta vira `null` e o grupo inteiro desaparece — o recado sumiria junto, e
   * a pessoa nunca saberia que o dinheiro voltou.
   */
  async function cancelar() {
    setErroDoCancelamento(null)
    setConfirmandoCancelamento(false)
    setReembolso({
      fase: 'processando',
      segundos: SEGUNDOS_DO_REEMBOLSO,
      estorno: null,
      motivo: null,
    })

    try {
      const [resposta] = await Promise.all([
        cancelarAssinatura(),
        new Promise((resolver) => window.setTimeout(resolver, SEGUNDOS_DO_REEMBOLSO * 1000)),
      ])
      setRecadoDoCancelamento(`Assinatura cancelada. ${fraseDoEstorno(resposta.estorno, resposta.estorno_motivo)}`)
      setReembolso({
        fase: 'concluido',
        segundos: 0,
        estorno: resposta.estorno,
        motivo: resposta.estorno_motivo,
      })
      onAssinaturaMudou?.()
    } catch (falha) {
      setReembolso(null)
      setErroDoCancelamento(
        falha instanceof ErroDaConta
          ? falha.message
          : 'Não consegui cancelar agora. Tente de novo em instantes.',
      )
    }
  }

  // O relógio do pop-up. Corre só enquanto está processando, e para quando a fase vira
  // `concluido` — aí o número na tela não serve mais para nada.
  useEffect(() => {
    if (reembolso?.fase !== 'processando') return
    const tique = window.setInterval(() => {
      setReembolso((atual) =>
        atual ? { ...atual, segundos: Math.max(0, atual.segundos - 1) } : atual,
      )
    }, 1000)
    return () => window.clearInterval(tique)
  }, [reembolso?.fase])

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
        <EtiquetaDoPlano plano={assinatura} />
      </div>

      {/*
        A assinatura vem **antes** dos vínculos: é o que a pessoa abre o perfil para conferir,
        e é onde ela procura o botão de cancelar quando quer sair.

        Só aparece quando ela **vale** (`ativa` ou `atrasada`). Uma tentativa `pendente` — que
        sobrevive a um checkout abandonado ou a uma cobrança que falhou — não é assinatura, e
        mostrar «Sua assinatura» ali faz a pessoa achar que contratou algo que não contratou.
      */}
      {assinatura ? (
        <Group label="Sua assinatura">
          <button
            type="button"
            aria-expanded={assinaturaOpen}
            onClick={() => setAssinaturaOpen((valor) => !valor)}
            className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors duration-150 hover:bg-koda-fg/4 focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
          >
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-koda-fg/90">
              {assinatura.nome}
            </span>
            <span className="shrink-0 text-[13px] text-koda-fg/55">
              {assinatura.renova_em ? `renova em ${dataCurta(assinatura.renova_em)}` : 'ativa'}
            </span>
            <ChevronRight
              className={[
                'h-4 w-4 shrink-0 text-koda-fg/40 transition-transform duration-150',
                assinaturaOpen ? 'rotate-90' : '',
              ].join(' ')}
              strokeWidth={1.8}
            />
          </button>

          {assinaturaOpen ? (
            <div className="px-4 py-3.5">
              <p className="text-[11px] font-semibold tracking-wider text-koda-fg/40 uppercase">
                O que ela dá
              </p>
              <ul className="mt-3 flex flex-col gap-2.5">
                {beneficiosDoPlano(assinatura).map((item) => (
                  <Beneficio key={item}>{item}</Beneficio>
                ))}
              </ul>

              {confirmandoCancelamento ? (
                <div className="mt-4 rounded-xl bg-koda-fg/4 px-3.5 py-3">
                  <p className="text-[12px] leading-5 text-koda-fg/60">
                    {podePedirReembolso
                      ? 'Isso cancela agora e devolve o valor pago. Não dá para desfazer.'
                      : 'Isso cancela agora. O prazo de reembolso já passou, então o valor não volta. Não dá para desfazer.'}
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setConfirmandoCancelamento(false)}
                      className="rounded-lg px-2.5 py-1.5 text-[13px] text-koda-fg/70 transition-colors hover:bg-koda-fg/8 hover:text-koda-fg focus-visible:outline-none"
                    >
                      Deixar como está
                    </button>
                    <button
                      type="button"
                      onClick={() => void cancelar()}
                      className="rounded-lg bg-rose-500/85 px-2.5 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-rose-500 focus-visible:ring-2 focus-visible:ring-rose-400 focus-visible:outline-none"
                    >
                      {podePedirReembolso ? 'Cancelar e receber de volta' : 'Cancelar a assinatura'}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setConfirmandoCancelamento(true)}
                    className="mt-4 w-full rounded-xl bg-koda-fg/4 py-2.5 text-[12.5px] text-koda-fg/70 transition-colors duration-150 hover:bg-koda-fg/8 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
                  >
                    {podePedirReembolso
                      ? 'Cancelar a assinatura e pedir reembolso'
                      : 'Cancelar a assinatura'}
                  </button>
                  {/* O prazo dito em data, e não em regra: «sete dias» a pessoa teria de
                      calcular de cabeça a partir de quando? A data ela lê e sabe. */}
                  {prazoDoEstorno ? (
                    <p className="mt-2 text-center text-[11px] text-koda-fg/35">
                      {podePedirReembolso
                        ? `Reembolso disponível até ${dataCurta(prazoDoEstorno)}.`
                        : `O prazo de reembolso terminou em ${dataCurta(prazoDoEstorno)}.`}
                    </p>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </Group>
      ) : null}

      {recadoDoCancelamento ? (
        <p className="rounded-2xl bg-emerald-500/8 px-4 py-3 text-[12.5px] leading-5 text-emerald-300/90 ring-1 ring-emerald-500/20">
          {recadoDoCancelamento}
        </p>
      ) : null}

      {erroDoCancelamento ? (
        <p className="rounded-2xl bg-rose-500/8 px-4 py-3 text-[12.5px] leading-5 text-rose-300/90 ring-1 ring-rose-500/20">
          {erroDoCancelamento}
        </p>
      ) : null}

      {reembolso ? (
        <ModalDeReembolso estado={reembolso} onFechar={() => setReembolso(null)} />
      ) : null}

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
