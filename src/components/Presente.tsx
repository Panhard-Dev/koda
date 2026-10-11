import { useState } from 'react'
import { ArrowLeft, ArrowRight, Check } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  DIAS_DE_VALIDADE_DO_PACOTE,
  PACOTES_DE_CREDITOS,
  PLANO_FREE,
  PLANOS_PAGOS,
  PRECO_DO_CREDITO_AVULSO,
  VALOR_MINIMO_DO_PACOTE,
  moedasTotaisNoMes,
  precoEmTexto,
} from '../plano'
import {
  MODELO_DE_REFERENCIA,
  conversasCom,
  moedasLegiveis,
  precoDoModelo,
} from '../custo'
import { ALL_MODELS, MODEL_LABELS } from '../models'
import type { Plano, PlanoPago } from '../plano'
import { assinaturaVale } from '../api/cloud'
import type { PlanoDaConta } from '../api/cloud'
import { tempoEmTexto, useSegundosDoDia } from '../tempo'
import { dataCurta } from '../account'

/**
 * As três vistas da área. O `id` é o estado; o rótulo é o que se lê.
 *
 * A ordem não é alfabética de propósito: `Free` primeiro porque é onde a pessoa já está, e a
 * lista abre no que ela tem — abrir no que ela não tem é vender antes de deixar olhar. E
 * `Moedas` por último porque é a única das três que **não** é para todo mundo: ela serve a quem
 * já assina e estourou o crédito do mês.
 */
const ABAS = [
  { id: 'free', rotulo: 'Free' },
  { id: 'planos', rotulo: 'Planos' },
  { id: 'moedas', rotulo: 'Moedas' },
] as const

/**
 * Exportado porque quem guarda em que vista a área deve abrir é o `App`: o checkout devolve
 * para «Planos», e o botão do cabeçalho abre no «Free». Sem isso a pessoa que assinou voltaria
 * para a ficha do Free, e não para a comparação de onde ela veio.
 */
export type Aba = (typeof ABAS)[number]['id']

/**
 * A área do presente.
 *
 * Duas vistas, e por ora só a primeira está construída: a **ficha do plano** que a pessoa tem.
 * A segunda continua em branco — o lugar está reservado, e o que entra nela ainda não foi
 * decidido.
 *
 * A barra carrega o `data-tauri-drag-region` como a do chat: sem ele, a janela do app desktop
 * deixa de poder ser arrastada por aqui, e o canto onde a pessoa pega a janela passa a ser um
 * lugar onde nada acontece. Ela **não** tem linha embaixo — quem separa o topo do corpo aqui é
 * o seletor, que já é uma peça com forma própria.
 */
export default function Presente({
  onClose,
  aoAssinar,
  aoComprarCreditos,
  abaInicial = 'free',
  planoDaConta = null,
}: {
  onClose: () => void
  /**
   * O «Assinar» de cada plano pago. Quem leva para o checkout é o `App` — aqui só se avisa
   * qual plano foi escolhido, porque esta tela não sabe (nem deve saber) o que vem depois.
   */
  aoAssinar: (plano: PlanoPago) => void
  /**
   * O «Comprar» de um pacote de crédito.
   *
   * Vai pelo **mesmo** checkout do plano: o caminho do dinheiro é um só, e dois caminhos
   * significariam consertar a cobrança em dois lugares — e esquecer um.
   */
  aoComprarCreditos: (creditos: number, valorCentavos: number) => void
  abaInicial?: Aba
  /**
   * O plano em vigor, como o painel o conta. `null` é o Free.
   *
   * É o que permite marcar a coluna do plano que a pessoa **já assina** e tirar o botão de lá:
   * sem isto, assinar de novo o mesmo plano criava outra cobrança — a renovação — e quem
   * clicasse por curiosidade pagava outra vez sem perceber.
   */
  planoDaConta?: PlanoDaConta | null
}) {
  const [aba, setAba] = useState<Aba>(abaInicial)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div data-tauri-drag-region className="flex shrink-0 items-center gap-2 px-4 py-3">
        <button
          type="button"
          onClick={onClose}
          aria-label="Voltar para o chat"
          className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-koda-fg/55 transition-colors duration-150 hover:bg-koda-fg/8 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.8} />
          Voltar
        </button>
      </div>

      {/* A mesma cápsula do header (`bg-koda-surface`, `rounded-full`, `p-1`): é a forma que o
          app já usa para um grupo de botões, e um seletor de vistas não precisa inventar outra. */}
      <div className="flex shrink-0 justify-center pt-4">
        <div
          role="tablist"
          aria-label="Vistas da área"
          className="inline-flex items-center gap-0.5 rounded-full bg-koda-surface p-1"
        >
          {ABAS.map((item) => {
            const ativa = item.id === aba
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={ativa}
                onClick={() => setAba(item.id)}
                className={[
                  'h-8 rounded-full px-4 text-[13px] transition-colors duration-150',
                  'focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none',
                  ativa
                    ? 'bg-koda-fg/12 font-medium text-koda-fg'
                    : 'text-koda-fg/55 hover:text-koda-fg',
                ].join(' ')}
              >
                {item.rotulo}
              </button>
            )
          })}
        </div>
      </div>

      {aba === 'free' ? (
        // No meio da área. A ficha é curta e sozinha — centralizada ela é o que a tela mostra,
        // e não uma caixa encostada num canto esperando companhia.
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 pb-16">
          {/* `atual` só quando a conta **não tem assinatura que valha**. Antes isto era um `true`
              fixo, porque o app não sabia o plano da conta; agora ele sabe — e uma tentativa
              `pendente` não conta como assinatura, senão o Free deixaria de dizer «Seu plano»
              para quem não tem nada. */}
          <FichaDoPlano
            plano={PLANO_FREE}
            atual={!assinaturaVale(planoDaConta)}
            onVerPlanos={() => setAba('planos')}
          />
        </div>
      ) : aba === 'planos' ? (
        // O `pt-10` é o que descola do seletor: a área é alinhada em cima, e sem ele os nomes
        // nascem encostados na cápsula — o seletor tem respiro próprio, o conteúdo não.
        <div className="flex min-h-0 flex-1 items-start justify-center px-6 pt-10 pb-16">
          {/* `max-w-3xl` com três colunas: é quantos planos pagos existem hoje (o de teste
              saiu, a pedido dele). A grade acompanha a lista — coluna vazia sobraria feia. */}
          <div className="w-full max-w-3xl">
            {/* **Sem caixa.** Os planos lado a lado, separados por um fio — o mesmo recurso da
                ficha do Free, e pelo mesmo motivo: a moldura embrulha o que já está claro. Lado
                a lado é a comparação que a pessoa veio fazer, e ela acontece sem rolar nada. */}
            <div className="grid grid-cols-1 divide-y divide-koda-fg/8 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              {PLANOS_PAGOS.map((plano) => (
                <div key={plano.id} className="px-6 py-2">
                  <span className="text-[15px] font-medium text-koda-fg">{plano.nome}</span>
                  <p className="mt-2.5 flex items-baseline gap-1">
                    <span className="text-[19px] font-medium tabular-nums text-koda-fg">
                      {precoEmTexto(plano.preco)}
                    </span>
                    <span className="text-[12px] text-koda-fg/45">/mês</span>
                  </p>
                  <p className="mt-4 text-[12.5px] leading-5 text-koda-fg/70">
                    {plano.horasPorDia} horas por dia
                  </p>
                  <p className="mt-1 text-[12.5px] leading-5 text-koda-fg/70">
                    {plano.moedasPorMes} moedas por mês
                  </p>
                  {/* O «+» não é enfeite: as moedas do mês e as do dia **somam**, e sem ele a
                      terceira linha pareceria outra forma de dizer a segunda. */}
                  <p className="mt-1 text-[12.5px] leading-5 text-koda-fg/70">
                    + {plano.moedasPorDia} moedas por dia
                  </p>
                  {/* O total é a soma das duas linhas de cima, e é **calculado** — número de
                      total escrito à mão é o primeiro a mentir quando alguém mexe numa parcela.
                      O `≈` é do mês de trinta dias (ver `DIAS_DO_MES`). */}
                  <p className="mt-2 text-[12.5px] leading-5 text-koda-fg/85">
                    ≈ {moedasTotaisNoMes(plano)} moedas por mês no total
                  </p>
                  {/* Botão **neutro**, como o «Ver os planos» da ficha do Free, e não no roxo do
                      app. Três botões aceso lado a lado viram uma parede de roxo — a cor que
                      marca a ação perde o sentido quando ela aparece três vezes na mesma linha.
                      Quem quer assinar acha o botão: ele está logo abaixo do preço.
                      O `aria-label` é necessário porque os três dizem «Assinar»: lido em voz
                      alta, sem o nome do plano, não dá para saber qual é qual. */}
                  {/* Plano que a pessoa **já assina** — e assinar quer dizer `ativa` ou
                      `atrasada`. Uma tentativa `pendente` **não** ganha o selo: ela não é
                      assinatura, e dizer que é faz a pessoa achar que contratou algo que não
                      contratou. Nesse caso o botão continua ali, para ela terminar o que começou
                      ou começar de novo. */}
                  {assinaturaVale(planoDaConta) && planoDaConta?.id === plano.id ? (
                    <div className="mt-5 flex flex-col items-center gap-1">
                      <span className="rounded-full bg-koda-accent/15 px-2.5 py-1 text-[11px] font-semibold text-koda-accent">
                        Sua assinatura
                      </span>
                      {planoDaConta?.renova_em ? (
                        <span className="text-[10.5px] text-koda-fg/40">
                          renova em {dataCurta(planoDaConta.renova_em)}
                        </span>
                      ) : null}
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => aoAssinar(plano)}
                      aria-label={`Assinar o ${plano.nome}`}
                      className="mt-5 flex h-9 w-full items-center justify-center rounded-xl bg-koda-surface text-[13px] text-koda-fg/85 ring-1 ring-koda-fg/8 transition-colors duration-150 hover:bg-koda-fg/10 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
                    >
                      Assinar
                    </button>
                  )}
                </div>
              ))}
            </div>

            <TabelaDeModelos />
          </div>
        </div>
      ) : (
        <AbaMoedas aoComprar={aoComprarCreditos} />
      )}
    </div>
  )
}

/**
 * A vista «Moedas»: onde se compra crédito avulso.
 *
 * Ela é a vista do **excedente** — quem chega aqui já assina e já estourou o crédito do mês.
 * Por isso não há comparação com os planos nesta tela: dizer «o plano é melhor negócio» é
 * verdade e não ajuda quem já está no plano e só precisa terminar o trabalho que começou.
 *
 * **A compra ainda não está ligada**, e o botão está desabilitado em vez de fingir. Um botão que
 * abre uma tela de erro é pior que um botão apagado: o apagado diz a verdade sem precisar de
 * clique. Quando o pagamento avulso entrar, é este botão que liga — o fluxo de PIX já existe.
 * **O botão leva ao checkout**, o mesmo dos planos. Ele não cobra aqui: quem cobra é a tela de
 * pagamento, e ter duas telas capazes de criar cobrança é ter dois lugares para consertar
 * quando a cobrança quebrar.
 */
function AbaMoedas({ aoComprar }: { aoComprar: (creditos: number, valorCentavos: number) => void }) {
  // O valor livre. Guarda o **texto** digitado, e não o número: converter a cada tecla faria
  // «5,» virar 5 e apagar a vírgula que a pessoa acabou de digitar.
  const [valor, setValor] = useState('')
  const reais = Number(valor.replace(',', '.'))
  const valido = Number.isFinite(reais) && reais >= VALOR_MINIMO_DO_PACOTE
  const creditos = valido ? Math.floor(reais / PRECO_DO_CREDITO_AVULSO) : 0

  return (
    <div className="flex min-h-0 flex-1 items-start justify-center px-6 pt-10 pb-16">
      <div className="w-full max-w-3xl">
        <p className="px-1 text-[12.5px] text-koda-fg/45">Créditos extras</p>
        <p className="mt-2 max-w-xl px-1 text-[11.5px] leading-4 text-koda-fg/35">
          Para quando o crédito do mês acaba e ainda falta trabalho. Eles entram depois dos
          créditos do plano e valem {DIAS_DE_VALIDADE_DO_PACOTE} dias.
        </p>

        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {PACOTES_DE_CREDITOS.map((pacote) => (
            <div
              key={pacote.creditos}
              className="flex flex-col rounded-2xl bg-koda-panel p-5 ring-1 ring-koda-fg/8"
            >
              <p className="text-[21px] font-medium tabular-nums text-koda-fg">
                {pacote.creditos.toLocaleString('pt-BR')}
              </p>
              <p className="text-[12px] text-koda-fg/45">créditos</p>

              <p className="mt-4 text-[15px] font-medium tabular-nums text-koda-fg">
                {precoEmTexto(pacote.preco)}
              </p>

              <button
                type="button"
                onClick={() => aoComprar(pacote.creditos, Math.round(pacote.preco * 100))}
                className="mt-4 flex h-9 w-full items-center justify-center rounded-xl bg-koda-surface text-[13px] text-koda-fg/85 ring-1 ring-koda-fg/8 transition-colors duration-150 hover:bg-koda-fg/10 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
              >
                Comprar
              </button>
            </div>
          ))}

          {/* O valor livre fecha a grade, e é o último de propósito: fica embaixo do 1.000, e
              é a saída de quem não quer nenhum dos números prontos. */}
          <div className="flex flex-col rounded-2xl bg-koda-panel p-5 ring-1 ring-koda-fg/8">
            <label htmlFor="valor-do-pacote" className="text-[12px] text-koda-fg/45">
              Escolha o valor
            </label>

            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="text-[15px] text-koda-fg/40">R$</span>
              <input
                id="valor-do-pacote"
                inputMode="decimal"
                autoComplete="off"
                placeholder={VALOR_MINIMO_DO_PACOTE.toFixed(2).replace('.', ',')}
                value={valor}
                onChange={(evento) => setValor(evento.target.value)}
                className="w-full bg-transparent text-[21px] font-medium tabular-nums text-koda-fg outline-none placeholder:text-koda-fg/25"
              />
            </div>

            <p className="mt-0.5 text-[12px] text-koda-fg/45">
              {valido
                ? `${creditos.toLocaleString('pt-BR')} créditos`
                : `mínimo R$ ${VALOR_MINIMO_DO_PACOTE.toFixed(2).replace('.', ',')}`}
            </p>

            <button
              type="button"
              disabled={!valido}
              onClick={() => aoComprar(creditos, Math.round(reais * 100))}
              className={[
                'mt-4 flex h-9 w-full items-center justify-center rounded-xl text-[13px] transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none',
                valido
                  ? 'bg-koda-surface text-koda-fg/85 ring-1 ring-koda-fg/8 hover:bg-koda-fg/10 hover:text-koda-fg'
                  : 'cursor-not-allowed bg-koda-fg/8 text-koda-fg/35',
              ].join(' ')}
            >
              Comprar
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Quanto custa cada modelo, em moedas por milhão de tokens.
 *
 * Fica **embaixo** dos três planos, e ocupou o lugar do «≈ N conversas» que cada coluna tinha.
 * Aquele número era uma régua só — sempre no modelo médio — e repetia a mesma frase três
 * vezes; o que decide a escolha é quanto sai do saldo em **cada** modelo, que é o que esta
 * lista mostra.
 *
 * O preço **não** é digitado aqui: sai de `../custo`, a mesma tabela que o app usa para cobrar
 * a resposta. Preço escrito à mão numa tela de venda é preço que diverge da conta no dia em que
 * alguém mexer num dos dois lados.
 *
 * A lista é a do seletor de modelos (`../models`), na mesma ordem — o conjunto que a pessoa lê
 * aqui é o mesmo que ela pode escolher na caixa de escrever.
 */
function TabelaDeModelos() {
  return (
    <div className="mt-10 border-t border-koda-fg/8 pt-6">
      <p className="text-[11px] font-semibold tracking-wider text-koda-fg/40 uppercase">
        Custo por modelo
      </p>
      <ul className="mt-4 grid grid-cols-1 gap-x-10 gap-y-3 sm:grid-cols-2">
        {/* Ordenado **por preço**, e não na ordem do seletor. Enquanto o preço vinha do porte,
            os três do mesmo degrau apareciam juntos e a ordem do catálogo não incomodava; com um
            preço por modelo, ela embaralhava os números entre as colunas (10,5 / 7 na primeira
            linha, 3 / 12 na terceira) — e uma lista de preços que não sobe é uma lista que não
            se compara. A cópia é porque `ALL_MODELS` é constante de módulo. */}
        {[...ALL_MODELS]
          .sort((a, b) => precoDoModelo(a.value) - precoDoModelo(b.value))
          .map((modelo) => (
            <li key={modelo.value} className="flex items-baseline justify-between gap-3">
              <span className="truncate text-[12.5px] text-koda-fg/80">{String(modelo.label)}</span>
              <span className="shrink-0 text-[12.5px] tabular-nums text-koda-fg/50">
                {moedasLegiveis(precoDoModelo(modelo.value))} moedas por 1M tokens
              </span>
            </li>
          ))}
      </ul>
    </div>
  )
}

/**
 * A ficha do plano: quem ele é e o que ele dá, em lista.
 *
 * **Sem caixa e sem barra.** A lista é o formato que as pessoas já conhecem de página de
 * assinatura, e é o que escala: quando existirem os planos pagos, cada linha vira comparação
 * direta com o Free. A barra saiu porque respondia outra pergunta — quanto ainda resta, que a
 * aba da caixa de escrever já responde o tempo todo, ali onde a pessoa está olhando.
 *
 * Os números saem do plano (`../plano`), e não de literais daqui: os mesmos aparecem na aba, e
 * duas cópias deles divergiriam.
 */
function FichaDoPlano({
  plano,
  atual = false,
  onVerPlanos,
}: {
  plano: Plano
  atual?: boolean
  onVerPlanos: () => void
}) {
  const segundos = useSegundosDoDia()

  return (
    <div className="w-full max-w-md">
      <div className="flex items-center justify-center gap-2">
        <span className="text-[17px] font-semibold text-koda-fg">{plano.nome}</span>
        {atual ? (
          <span className="rounded-full bg-koda-accent/15 px-2 py-0.5 text-[11px] font-semibold text-koda-accent">
            Seu plano
          </span>
        ) : null}
      </div>
      <p className="mt-1.5 text-center text-[13px] leading-5 text-koda-fg/45">
        O plano de entrada — o que todo mundo tem, sem pagar nada.
      </p>

      <ul className="mt-7 flex flex-col gap-3.5">
        <Item>{plano.horasPorDia} horas por dia, voltando à meia-noite</Item>
        <Item>
          {plano.moedasPorMes} moedas por mês, renovando todo dia {plano.moedasRenovamNoDia}º
        </Item>
        <Item>
          ≈ {conversasCom(plano.moedasPorMes)} conversas, no modelo{' '}
          {MODEL_LABELS[MODELO_DE_REFERENCIA]}
        </Item>
      </ul>

      {/* O retrato de hoje, e não a promessa do plano: é o único número vivo desta página.
          **Sem barra** — a barra cheia de ponta a ponta chamava mais atenção que qualquer
          coisa na tela e não dizia nada que o número já não diga. Aqui o dado é a frase.

          **Só na ficha do plano que a conta tem.** O contador é o do orçamento **dela**
          (`../tempo`), e desde que ele passou a vir do plano da conta mostrá-lo numa ficha
          que não é a sua faria a frase dizer «Das 1 horas do dia» embaixo de um contador de
          4 horas — a contradição que o número existe para evitar. */}
      {atual ? (
        <div className="mt-7 border-t border-koda-fg/8 pt-5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[11px] font-semibold tracking-wider text-koda-fg/40 uppercase">
              Hoje
            </span>
            <span className="text-[13px] tabular-nums text-koda-fg/75">
              restam {tempoEmTexto(segundos)}
            </span>
          </div>
          <p className="mt-1.5 text-[12px] text-koda-fg/40">
            Das {plano.horasPorDia} horas do dia · o resto vai para as moedas
          </p>
        </div>
      ) : null}

      <div className="mt-6 flex justify-center">
        {/* Botão **neutro**, e não no destaque do app: o roxo aqui gastava a cor que marca
            «Seu plano» logo acima e o próprio caminho de destaque da tela. Quem quer subir de
            plano acha o botão — ele não precisa ser o mais gritante para ser achado. */}
        <button
          type="button"
          onClick={onVerPlanos}
          className="flex h-9 items-center gap-1.5 rounded-xl bg-koda-surface px-3.5 text-[13px] text-koda-fg/85 ring-1 ring-koda-fg/8 transition-colors duration-150 hover:bg-koda-fg/10 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
        >
          Ver os planos
          <ArrowRight className="h-4 w-4" strokeWidth={2} />
        </button>
      </div>
    </div>
  )
}

/** Uma linha do que o plano inclui. O visto é o de sempre: verde, redondo, do lado de fora. */
function Item({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
        <Check className="h-2.5 w-2.5" strokeWidth={3} />
      </span>
      <span className="text-[13px] leading-5 text-koda-fg/75">{children}</span>
    </li>
  )
}
