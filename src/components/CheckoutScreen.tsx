import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, CalendarPlus, Check, Clock, Coins, Copy, Info, QrCode, Sigma } from 'lucide-react'
import type { ReactNode, RefObject } from 'react'
import { precoEmTexto, DIAS_DE_VALIDADE_DO_PACOTE } from '../plano'
import type { PlanoPago } from '../plano'
import { assinarComPix, comprarCreditos, meusCreditos, minhaAssinatura, novaChaveDeCobranca } from '../api/cobranca'
import type { Cobranca } from '../api/cobranca'

/**
 * A tela de pagamento — o destino do botão «Assinar» da área de Planos.
 *
 * ## Só PIX, por enquanto
 *
 * O cartão saiu a pedido dele. A rota do servidor continua de pé (`/api/assinatura/cartao`) e
 * o código dela está no histórico; o que não existe hoje é a tela que a chama. Quando o
 * cartão voltar, é a mesma estrutura daqui: trocar o cartão por um token com a Public Key e
 * mandar o token.
 *
 * ## O caminho
 *
 *   1. Nome e CPF. Sem os dois **válidos** o botão fica apagado.
 *   2. «Assinar» cria a cobrança no servidor, que fala com o Mercado Pago e devolve o QR.
 *   3. O QR aparece onde estava o formulário, com o copia-e-cola ao lado.
 *   4. O app pergunta de tempo em tempo se a assinatura ficou ativa — o PIX é pago **fora**
 *      daqui, e a única forma de saber que caiu é perguntar. Quem confirma de verdade é o
 *      webhook; esta tela só olha o resultado.
 *
 * O preço **não** é enviado por nós: o app manda o `id` do plano e o servidor cobra o que
 * está no banco dele. É o que impede o cliente de escolher quanto pagar.
 */
/**
 * O que esta tela está cobrando.
 *
 * **Um checkout, dois produtos.** O plano e o pacote de créditos compartilham tudo o que
 * importa — o PIX, o QR, a sonda, a festa — e diferem só no que a tela diz e no que ela
 * pergunta ao servidor depois. Duplicar a tela para a segunda compra seria duplicar o caminho
 * do dinheiro, que é a última coisa que se quer em dois lugares: um conserto num lado e não no
 * outro é uma cobrança errada esperando acontecer.
 */
export type CompraDoCheckout =
  | { tipo: 'plano'; plano: PlanoPago }
  | { tipo: 'creditos'; creditos: number; valorCentavos: number }

export default function CheckoutScreen({
  compra,
  onClose,
  onAssinou,
  onIrParaOChat,
}: {
  compra: CompraDoCheckout
  onClose: () => void
  /**
   * Chamado **uma vez**, quando a compra se resolve — a assinatura ativa, ou os créditos na
   * conta. É o que faz o perfil parar de dizer «Free» sem esperar a próxima sonda de sessão,
   * que roda de tempo em tempo.
   */
  onAssinou: () => void
  /** Para onde a tela leva sozinha depois de comemorar — o chat, que é onde a pessoa quer estar. */
  onIrParaOChat: () => void
}) {
  const [nome, setNome] = useState('')
  const [documento, setDocumento] = useState('')
  const [fase, setFase] = useState<'preparando' | 'preencher' | 'gerando' | 'aguardando' | 'paga'>(
    'preparando',
  )
  const [cobranca, setCobranca] = useState<Cobranca | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [copiado, setCopiado] = useState(false)
  const [segundos, setSegundos] = useState(6)

  // Uma chave por **visita** a esta tela, e não por clique: se a resposta se perder e a
  // pessoa apertar de novo, o servidor devolve a mesma cobrança em vez de criar uma
  // segunda. Cobrar duas vezes é o único erro daqui que aparece no extrato dela.
  const chave = useRef(novaChaveDeCobranca())
  const caixaDoCodigo = useRef<HTMLTextAreaElement | null>(null)

  // Os avisos moram numa ref de propósito: o `App` passa funções novas a cada render, e se
  // elas entrassem nas dependências dos efeitos a sonda e a contagem reiniciariam a cada
  // quadro — os relógios nunca chegariam a disparar.
  const acoes = useRef({ onAssinou, onIrParaOChat })
  useEffect(() => {
    acoes.current = { onAssinou, onIrParaOChat }
  }, [onAssinou, onIrParaOChat])

  const erroDoDocumento = erroDeDocumento(documento)
  const pronto = nome.trim().length >= 3 && documento.replace(/\D/g, '').length === 11 && !erroDoDocumento

  /** Quanto sai da conta, em centavos — do plano ou do pacote. */
  const centavos = compra.tipo === 'plano' ? Math.round(compra.plano.preco * 100) : compra.valorCentavos

  /**
   * O saldo de crédito avulso **antes** desta compra.
   *
   * É o que permite saber que o PIX caiu: o webhook credita, o saldo sobe, e o alvo é o saldo de
   * antes mais o que esta compra vale. Sem o de antes, um saldo qualquer pareceria pagamento —
   * e quem já tinha crédito veria a festa antes de pagar.
   */
  const saldoAntes = useRef(0)

  /**
   * Ao entrar, o checkout **prepara** — e a tela de carregamento aqui não é enfeite.
   *
   * Ela espera duas coisas reais: a resposta do servidor sobre a assinatura (a Public Key e o
   * plano em vigor, que o app precisa para cobrar) e a sessão estar de pé. Sem sessão válida
   * não existe cobrança, e é muito melhor descobrir isso **antes** de a pessoa digitar o CPF.
   *
   * O piso de 700 ms é escolha, não carga: a resposta chega em menos de 200 ms, e uma tela de
   * carregamento que pisca é pior do que não existir — ela passa a impressão de defeito. O
   * mesmo recurso que os bancos usam para não piscar saldo na tela.
   */
  useEffect(() => {
    let vivo = true
    const piso = new Promise((resolver) => window.setTimeout(resolver, 700))
    // A preparação pergunta o que faz sentido para **este** produto: a assinatura em vigor para
    // um plano, o saldo atual para um pacote. Nos dois casos a resposta também prova que a
    // sessão está de pé — que é o que interessa antes de pedir o CPF.
    const trabalho = (
      compra.tipo === 'plano'
        ? minhaAssinatura().catch(() => null)
        : meusCreditos()
            .then((r) => {
              if (vivo) saldoAntes.current = r.creditos
              return r
            })
            .catch(() => null)
    )
    void Promise.all([trabalho, piso]).then(() => {
      if (vivo) setFase('preencher')
    })
    return () => {
      vivo = false
    }
    // Uma vez, na entrada: `compra` não muda enquanto a tela está aberta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function assinar() {
    setErro(null)
    setFase('gerando')
    try {
      // Um caminho só, dois produtos: o que muda é a rota e o corpo. Do plano vai o **id** (o
      // preço é do servidor); do pacote vai o **valor** (a quantidade de créditos é do
      // servidor). Em nenhum dos dois o app decide quanto a pessoa leva.
      const resposta =
        compra.tipo === 'plano'
          ? await assinarComPix({
              planoId: compra.plano.id,
              nome,
              documento,
              chave: chave.current,
            })
          : await comprarCreditos({
              valorCentavos: compra.valorCentavos,
              nome,
              documento,
              chave: chave.current,
            })
      setCobranca(resposta.pagamento)
      setFase('aguardando')
    } catch (falha) {
      setErro(falha instanceof Error ? falha.message : 'Não consegui criar a cobrança. Tente de novo.')
      setFase('preencher')
    }
  }

  // A sonda. Só existe enquanto há cobrança em aberto, e para quando a assinatura fica ativa.
  useEffect(() => {
    if (fase !== 'aguardando') return
    let vivo = true
    let relogio: number | undefined

    const olhar = async () => {
      try {
        if (compra.tipo === 'plano') {
          const { assinatura } = await minhaAssinatura()
          if (!vivo || assinatura?.status !== 'ativa') return
        } else {
          // O alvo é o saldo de antes mais o que esta compra vale. Comparar com o saldo sozinho
          // daria festa para quem já tinha crédito, antes de pagar.
          const { creditos } = await meusCreditos()
          if (!vivo || creditos < saldoAntes.current + compra.creditos) return
        }
        setFase('paga')
        setSegundos(6)
        acoes.current.onAssinou()
      } catch {
        // A rede tropeçou: a próxima olhada resolve. Não vale interromper o pagamento por
        // causa de uma consulta — quem confirma é o webhook, do outro lado.
      }
    }

    // A primeira olhada só **depois de dez segundos**, e as seguintes de cinco em cinco.
    // O PIX não cai no primeiro segundo — quem paga leva um tempo abrindo o app do banco —, e
    // perguntar desde o instante zero é gastar requisição para receber «ainda não» várias
    // vezes. O atraso é o que evita transformar uma tela parada num metralhador do servidor.
    const espera = window.setTimeout(() => {
      void olhar()
      relogio = window.setInterval(olhar, 5000)
    }, 10_000)

    return () => {
      vivo = false
      window.clearTimeout(espera)
      if (relogio !== undefined) window.clearInterval(relogio)
    }
  }, [fase])

  // A festa dura seis segundos e depois a tela leva a pessoa para o chat sozinha. O botão
  // existe para quem quiser ir antes — e para quem quiser ficar, o `Ir para o chat` continua
  // ali depois da contagem chegar a zero (a saída automática acontece uma vez só).
  useEffect(() => {
    if (fase !== 'paga') return
    const tique = window.setInterval(() => setSegundos((valor) => Math.max(0, valor - 1)), 1000)
    const saida = window.setTimeout(() => acoes.current.onIrParaOChat(), 6000)
    return () => {
      window.clearInterval(tique)
      window.clearTimeout(saida)
    }
  }, [fase])

  async function copiarCodigo() {
    if (!cobranca?.qr_code) return
    try {
      await navigator.clipboard.writeText(cobranca.qr_code)
      setCopiado(true)
      window.setTimeout(() => setCopiado(false), 2000)
    } catch {
      // Sem área de transferência (o webview pode não dar): seleciona o texto, que aí o
      // Ctrl+C da pessoa resolve. Falhar em silêncio aqui deixaria ela sem o código.
      caixaDoCodigo.current?.select()
    }
  }

  /**
   * Enquanto prepara ou gera, a tela é **só** a espera.
   *
   * Sem cabeçalho, sem cartão de resumo, sem nada clicável em volta: o que sobra na tela é o
   * que a pessoa precisa ler. Qualquer coisa em volta convida a mexer no que está no meio do
   * caminho — e é o desenho que o checkout do ChatGPT usa.
   *
   * O `data-tauri-drag-region` fica aqui também: sem ele, a janela do app deixa de poder ser
   * arrastada durante a espera, e o topo vira um lugar onde nada acontece.
   */
  if (fase === 'preparando' || fase === 'gerando') {
    return (
      <div
        data-tauri-drag-region
        className="flex min-h-0 flex-1 flex-col items-center justify-center px-6"
      >
        {/* Roda de CSS e não ícone: a lib troca nome de ícone entre versões, e um spinner
            quebrado numa tela de pagamento é pior do que não ter ícone nenhum. */}
        <span className="h-9 w-9 animate-spin rounded-full border-2 border-koda-fg/12 border-t-koda-accent" />
        <p className="mt-6 text-[19px] font-medium text-koda-fg">
          {fase === 'preparando' ? 'Preparando o seu plano' : 'Gerando o seu QR Code'}
        </p>
        <p className="mt-2 text-[13px] leading-5 text-koda-fg/45">
          {fase === 'preparando'
            ? 'Conferindo a sua conta e o meio de pagamento'
            : 'Falando com o Mercado Pago'}
        </p>
      </div>
    )
  }

  /**
   * A festa também é a tela inteira.
   *
   * Se a espera toma a tela, a comemoração toma também — e pelo mesmo motivo: no momento em que
   * o pagamento cai, não há mais nada naquela tela que a pessoa precise ver ou clicar além do
   * «deu certo» e do caminho de volta. O cartão de resumo ali ao lado só repetiria o preço que
   * ela acabou de pagar.
   */
  if (fase === 'paga') {
    return (
      <div
        data-tauri-drag-region
        className="flex min-h-0 flex-1 flex-col items-center justify-center px-6"
      >
        <div className="flex flex-col items-center text-center">
          {/* O visto entra com `pop` e o resto em cascata (`stagger`). O `pop` fica **fora** do
              `stagger` de propósito: os dois definem `animation`, e o que vale entre eles seria
              decidido pela ordem do arquivo CSS — frágil demais para uma tela de festa. */}
          <span className="pop flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/25">
            <Check className="h-8 w-8" strokeWidth={2.5} />
          </span>

          <div className="stagger mt-5 flex flex-col items-center">
            <p className="text-[21px] font-semibold text-koda-fg">
              {compra.tipo === 'plano' ? 'Parabéns, você é assinante!' : 'Créditos na conta!'}
            </p>
            <p className="mt-2 max-w-sm text-[13px] leading-5 text-koda-fg/55">
              {compra.tipo === 'plano' ? (
                <>
                  O <span className="font-medium text-koda-fg/85">{compra.plano.nome}</span> já
                  está valendo na sua conta. Obrigado por assinar o Koda.
                </>
              ) : (
                <>
                  <span className="font-medium text-koda-fg/85">
                    {compra.creditos.toLocaleString('pt-BR')} créditos
                  </span>{' '}
                  entraram na sua conta. Eles valem 90 dias e entram depois dos créditos do plano.
                </>
              )}
            </p>
            <button
              type="button"
              onClick={onIrParaOChat}
              className="mt-6 flex h-11 items-center justify-center rounded-full bg-koda-accent px-7 text-[13.5px] font-medium text-koda-bg transition-colors duration-150 hover:bg-koda-accent-strong focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
            >
              Ir para o chat
            </button>
            <p className="mt-3 text-[11.5px] text-koda-fg/35">
              Levando você para o chat em {segundos}s…
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div data-tauri-drag-region className="flex shrink-0 items-center gap-1 px-4 py-3.5">
        <button
          type="button"
          onClick={onClose}
          aria-label="Voltar para os planos"
          className="-ml-1 flex h-9 w-9 items-center justify-center rounded-lg text-koda-fg/70 transition-colors duration-150 hover:bg-koda-fg/8 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
        >
          <ArrowLeft className="h-5 w-5" strokeWidth={1.8} />
        </button>
        <h1 className="text-[20px] font-semibold text-koda-fg">Configurar seu plano</h1>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-5 pb-12">
          <div className="grid grid-cols-1 gap-7 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
            <div>
              <PainelDoPix
                fase={fase}
                nome={nome}
                documento={documento}
                erroDoDocumento={erroDoDocumento}
                cobranca={cobranca}
                copiado={copiado}
                caixaDoCodigo={caixaDoCodigo}
                onNome={setNome}
                onDocumento={setDocumento}
                onCopiar={copiarCodigo}
              />
              {erro ? (
                <p className="mt-4 flex items-start gap-2 rounded-xl bg-rose-500/8 px-3.5 py-2.5 text-[12px] leading-4 text-rose-300/90 ring-1 ring-rose-500/20">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
                  {erro}
                </p>
              ) : null}
            </div>

            <Resumo
              compra={compra}
              centavos={centavos}
              fase={fase}
              pronto={pronto}
              onAssinar={assinar}
              onEditar={() => {
                setCobranca(null)
                setErro(null)
                setFase('preencher')
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * O painel do PIX, em dois tempos: primeiro o formulário, depois o QR.
 *
 * Os campos **saem** quando o QR entra, em vez de ficarem acima dele. Não é economia de
 * espaço: depois de a cobrança existir, o nome e o CPF já foram para o Mercado Pago, e mexer
 * neles ali daria a impressão de que mudaria alguma coisa — não mudaria, a cobrança já está
 * criada. Para corrigir, o caminho é voltar.
 */
function PainelDoPix({
  fase,
  nome,
  documento,
  erroDoDocumento,
  cobranca,
  copiado,
  caixaDoCodigo,
  onNome,
  onDocumento,
  onCopiar,
}: {
  fase: 'preencher' | 'gerando' | 'aguardando'
  nome: string
  documento: string
  erroDoDocumento: string | null
  cobranca: Cobranca | null
  copiado: boolean
  caixaDoCodigo: RefObject<HTMLTextAreaElement | null>
  onNome: (valor: string) => void
  onDocumento: (valor: string) => void
  onCopiar: () => void
}) {
  if (fase === 'gerando') {
    return (
      <div className="rounded-xl bg-koda-input p-5 ring-1 ring-koda-fg/10">
        <p className="text-[13.5px] text-koda-fg">Pague com PIX</p>
        <div className="mt-6 flex flex-col items-center gap-3 pb-4">
          {/* Roda de CSS e não ícone: a lib troca nome de ícone entre versões, e um spinner
              quebrado numa tela de pagamento é pior do que não ter ícone nenhum. */}
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-koda-fg/15 border-t-koda-accent" />
          <p className="text-[12.5px] text-koda-fg/55">Gerando o QR Code…</p>
          <p className="text-[11.5px] text-koda-fg/35">Falando com o Mercado Pago</p>
        </div>
      </div>
    )
  }

  if (fase === 'aguardando' && cobranca) {
    return (
      <div className="rounded-xl bg-koda-input p-5 ring-1 ring-koda-fg/10">
        <p className="text-[13.5px] text-koda-fg">Pague com PIX</p>
        <p className="mt-1.5 text-[12px] leading-5 text-koda-fg/45">
          Abra o app do seu banco e aponte a câmera — ou copie o código. Esta tela avisa sozinha
          quando o pagamento cair.
        </p>

        {cobranca.qr_code_base64 ? (
          // O QR vem em base64 do Mercado Pago, sem o prefixo `data:`. O CSP do app já permite
          // `data:` em imagem — foi por isso que ele não precisou mudar.
          //
          // O cartão branco é **do tamanho do QR** (`w-fit`), e não da largura do painel: branco
          // esticado de ponta a ponta com um quadradinho no meio parecia faixa, não código. A
          // sombra é a mesma família da que o perfil usa — ela descola o branco do fundo escuro,
          // que é o que faz o código ser lido como um objeto e não como um buraco na tela.
          <div className="mt-5 flex justify-center">
            <div className="w-fit rounded-2xl bg-white p-4 shadow-[0_18px_40px_-24px_var(--koda-shadow)]">
              <img
                src={`data:image/png;base64,${cobranca.qr_code_base64}`}
                alt="QR Code para pagar com PIX"
                className="h-56 w-56"
              />
            </div>
          </div>
        ) : (
          <div className="mt-4 flex h-52 items-center justify-center rounded-lg border border-dashed border-koda-fg/12">
            <span className="text-[12px] text-koda-fg/30">o Mercado Pago não devolveu a imagem</span>
          </div>
        )}

        {/* A validade fica **colada no código**, como no checkout do ChatGPT: um QR vencido é a
            razão mais comum de «paguei e não caiu», e sem a data a pessoa não tem como saber se
            ainda dá tempo. Quando o Mercado Pago não manda validade, a linha não existe. */}
        {validadeDoQr(cobranca.expira_em) ? (
          <p className="mt-2.5 text-center text-[11.5px] text-koda-fg/40">
            {validadeDoQr(cobranca.expira_em)}
          </p>
        ) : null}

        {cobranca.qr_code ? (
          <>
            {/* O «ou» entre o QR e o código, como no ChatGPT: os dois fazem a mesma coisa, e
                sem ele pareceria que a pessoa precisa dos dois. */}
            <div className="mt-4 flex items-center gap-3">
              <span className="h-px flex-1 bg-koda-fg/8" />
              <span className="text-[10.5px] font-semibold tracking-wider text-koda-fg/30 uppercase">
                ou
              </span>
              <span className="h-px flex-1 bg-koda-fg/8" />
            </div>
            <textarea
              ref={caixaDoCodigo}
              readOnly
              value={cobranca.qr_code}
              aria-label="Código PIX para copiar e colar"
              onFocus={(evento) => evento.target.select()}
              // `wrap="off"` e uma linha de altura: o código tem ~250 caracteres e, quebrando,
              // virava um bloco de quatro linhas que empurrava o botão para fora da tela. Em uma
              // linha com rolagem lateral, ele ocupa o que merece — quem quer o código, copia.
              wrap="off"
              className="mt-3 h-11 w-full resize-none overflow-x-auto rounded-lg bg-koda-panel px-3 py-2.5 font-mono text-[11px] whitespace-nowrap text-koda-fg/70 ring-1 ring-koda-fg/10 outline-none focus:ring-2 focus:ring-koda-accent/70"
            />
            <button
              type="button"
              onClick={onCopiar}
              className="mt-2 flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-koda-fg/8 text-[12.5px] text-koda-fg/85 transition-colors duration-150 hover:bg-koda-fg/12 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
            >
              {copiado ? (
                <>
                  <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
                  Copiado
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" strokeWidth={1.8} />
                  Copiar o código
                </>
              )}
            </button>
          </>
        ) : null}

        <p className="mt-4 flex items-start gap-2 border-t border-koda-fg/8 pt-3.5 text-[11.5px] leading-4 text-koda-fg/40">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
          Aguardando o pagamento. A confirmação chega sozinha, em alguns segundos.
        </p>      </div>
    )
  }

  return (
    <div>
      <h2 className="text-[13px] font-medium text-koda-fg">Pagamento</h2>
      <div className="mt-3 rounded-xl bg-koda-input p-4 ring-1 ring-koda-fg/10">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-koda-accent/12 text-koda-accent">
            <QrCode className="h-4 w-4" strokeWidth={1.7} />
          </span>
          <div className="min-w-0">
            <p className="text-[13.5px] text-koda-fg">Pague com PIX</p>
            <p className="mt-0.5 text-[11.5px] leading-4 text-koda-fg/45">
              O QR Code aparece aqui depois de você gerar a cobrança.
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-3">
          <Campo
            id="pix-nome"
            rotulo="Nome completo do pagador"
            placeholder="Nome completo do pagador"
            valor={nome}
            onValor={onNome}
            inputMode="text"
            autoComplete="name"
          />
          <Campo
            id="pix-cpf"
            rotulo="CPF do pagador"
            placeholder="CPF do pagador"
            valor={documento}
            onValor={onDocumento}
            mascara={mascaraCpf}
            erro={erroDoDocumento}
          />
          <p className="text-[11.5px] leading-4 text-koda-fg/35">
            O Mercado Pago pede o nome e o CPF de quem paga para emitir a cobrança.
          </p>
        </div>
      </div>
    </div>
  )
}

/**
 * Quanto tempo o QR ainda vale, em frase.
 *
 * `null` quando o Mercado Pago não manda validade ou manda algo que não é data — nesse caso a
 * linha não aparece, que é melhor do que escrever uma data inventada numa tela de pagamento.
 */
function validadeDoQr(expiraEm: string | null): string | null {
  if (!expiraEm) return null
  const fim = new Date(expiraEm)
  if (Number.isNaN(fim.getTime())) return null

  const minutos = Math.round((fim.getTime() - Date.now()) / 60_000)
  if (minutos <= 0) return 'O QR Code venceu. Gere outro.'
  if (minutos < 60) return `O QR Code expira em ${minutos} minuto${minutos === 1 ? '' : 's'}.`
  const horas = Math.round(minutos / 60)
  return `O QR Code expira em ${horas} hora${horas === 1 ? '' : 's'}.`
}

/**
 * Um campo.
 *
 * `mascara` é aplicada **na entrada**, e não na exibição: assim o cursor nunca fica numa posição
 * que não existe, e o que está no estado é sempre o texto já formatado.
 */
function Campo({
  id,
  rotulo,
  placeholder,
  valor,
  onValor,
  mascara,
  autoComplete,
  inputMode = 'numeric',
  erro,
}: {
  id: string
  rotulo: string
  placeholder: string
  valor: string
  onValor: (valor: string) => void
  mascara?: (valor: string) => string
  autoComplete?: string
  inputMode?: 'numeric' | 'text'
  erro?: string | null
}) {
  return (
    <>
      <label htmlFor={id} className="sr-only">
        {rotulo}
      </label>
      <input
        id={id}
        inputMode={inputMode}
        autoComplete={autoComplete}
        placeholder={placeholder}
        value={valor}
        aria-invalid={erro ? true : undefined}
        onChange={(evento) => onValor(mascara ? mascara(evento.target.value) : evento.target.value)}
        className={[
          'h-14 w-full rounded-xl bg-koda-panel px-4 text-[14px] text-koda-fg',
          'ring-1 transition-shadow duration-150 outline-none',
          erro ? 'ring-rose-500/45' : 'ring-koda-fg/10',
          'placeholder:text-koda-fg/30 focus:ring-2',
          erro ? 'focus:ring-rose-500/60' : 'focus:ring-koda-accent/70',
        ].join(' ')}
      />
      {erro ? <p className="text-[11.5px] text-rose-400/90">{erro}</p> : null}
    </>
  )
}

/**
 * O cartão de resumo, com o botão dentro.
 *
 * Os ícones são todos no accent: quatro cores diferentes competiriam com o roxo que marca a
 * ação, e a lista ficaria mais barulhenta que o botão.
 */
function Resumo({
  compra,
  centavos,
  fase,
  pronto,
  onAssinar,
  onEditar,
}: {
  compra: CompraDoCheckout
  /** O total a pagar, em centavos — já resolvido para o produto desta compra. */
  centavos: number
  // O resumo só é desenhado depois da espera: nas fases `preparando` e `gerando` a tela é só a
  // rodinha, e o componente sai antes de chegar aqui.
  fase: 'preencher' | 'aguardando'
  pronto: boolean
  onAssinar: () => void
  onEditar: () => void
}) {
  const reais = centavos / 100

  return (
    <aside className="h-fit rounded-3xl bg-koda-panel p-6 ring-1 ring-koda-fg/8">
      <h2 className="text-[20px] font-semibold text-koda-fg">
        {compra.tipo === 'plano' ? compra.plano.nome : `${compra.creditos.toLocaleString('pt-BR')} créditos`}
      </h2>

      {compra.tipo === 'plano' ? (
        <>
          <p className="mt-5 text-[12.5px] text-koda-fg/45">O que está incluído</p>
          <ul className="mt-3.5 flex flex-col gap-3">
            <Beneficio icone={<Clock className="h-4 w-4" strokeWidth={1.8} />}>
              {compra.plano.horasPorDia} horas por dia
            </Beneficio>
            <Beneficio icone={<Coins className="h-4 w-4" strokeWidth={1.8} />}>
              {compra.plano.moedasPorMes} moedas por mês
            </Beneficio>
            {/* O «+» não é enfeite: as moedas do mês e as do dia **somam**, e sem ele a linha
                pareceria repetição da de cima. Mesma convenção da tela de venda. */}
            <Beneficio icone={<CalendarPlus className="h-4 w-4" strokeWidth={1.8} />}>
              + {compra.plano.moedasPorDia} moedas por dia
            </Beneficio>
            <Beneficio icone={<Sigma className="h-4 w-4" strokeWidth={1.8} />}>
              ≈ {compra.plano.moedasPorMes + compra.plano.moedasPorDia * 30} moedas por mês no total
            </Beneficio>
          </ul>
        </>
      ) : (
        <>
          {/* No pacote não há lista de benefícios para repetir — o que a pessoa está comprando
              é o crédito, e o que ela precisa saber é **quando** ele entra e **até quando**
              vale. É isso que a lista diz aqui. */}
          <p className="mt-5 text-[12.5px] text-koda-fg/45">Como funciona</p>
          <ul className="mt-3.5 flex flex-col gap-3">
            <Beneficio icone={<Coins className="h-4 w-4" strokeWidth={1.8} />}>
              Entram depois dos créditos do seu plano
            </Beneficio>
            <Beneficio icone={<Clock className="h-4 w-4" strokeWidth={1.8} />}>
              Valem {DIAS_DE_VALIDADE_DO_PACOTE} dias a partir do pagamento
            </Beneficio>
          </ul>
        </>
      )}

      <div className="mt-6 border-t border-koda-fg/8 pt-4">
        <div className="flex items-baseline justify-between gap-3 text-[13px]">
          <span className="text-koda-fg/55">
            {compra.tipo === 'plano' ? 'Assinatura mensal' : 'Créditos avulsos'}
          </span>
          <span className="tabular-nums text-koda-fg/75">{precoEmTexto(reais)}</span>
        </div>
        <div className="mt-3 flex items-baseline justify-between gap-3">
          <span className="text-[14px] font-medium text-koda-fg">Total hoje</span>
          <span className="text-[14px] font-medium tabular-nums text-koda-fg">
            {precoEmTexto(reais)}
          </span>
        </div>
      </div>

      {/* Na fase de festa o cartão de resumo **não** tem botão: quem manda na ação ali é o
          painel da esquerda, e duas portas para o mesmo lugar só espalham a atenção. */}
      {fase === 'aguardando' ? (
        // O caminho da frente agora é pagar, não mexer no formulário — por isso o botão fica
        // secundário. Voltar aqui não perde a cobrança: ela já existe no servidor, e gerar de
        // novo devolve a mesma.
        <button
          type="button"
          onClick={onEditar}
          className="mt-5 flex h-12 w-full items-center justify-center rounded-full bg-koda-fg/8 text-[14px] font-medium text-koda-fg/80 transition-colors duration-150 hover:bg-koda-fg/12 hover:text-koda-fg focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
        >
          Editar os dados
        </button>
      ) : (
        // O `disabled` aqui é a régua do formulário — enquanto falta dado não há o que cobrar.
        <button
          type="button"
          onClick={onAssinar}
          disabled={!pronto}
          className={[
            'mt-5 flex h-12 w-full items-center justify-center rounded-full text-[14px] font-medium',
            'transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none',
            pronto
              ? 'bg-koda-accent text-koda-bg hover:bg-koda-accent-strong'
              : 'cursor-not-allowed bg-koda-fg/8 text-koda-fg/35',
          ].join(' ')}
        >
          Assinar
        </button>
      )}
      <p className="mt-3 text-center text-[11px] leading-4 text-koda-fg/30">
        Assinatura mensal, renovada automaticamente.
      </p>
    </aside>
  )
}

/** Uma linha do que o plano dá. */
function Beneficio({ icone, children }: { icone: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3 text-[13px] leading-5 text-koda-fg/80">
      <span className="mt-0.5 shrink-0 text-koda-accent">{icone}</span>
      <span className="min-w-0">{children}</span>
    </li>
  )
}

/**
 * O que está errado no CPF — ou `null`.
 *
 * **Só acusa quando o número está completo.** Enquanto a pessoa digita, `123.456` não é um CPF
 * errado: é um CPF pela metade, e marcar de vermelho a cada tecla ensina a ignorar o vermelho.
 */
function erroDeDocumento(valor: string): string | null {
  const d = valor.replace(/\D/g, '')
  if (d.length === 0 || d.length < 11) return null
  if (d.length === 11) return cpfValido(d) ? null : 'CPF inválido'
  return null
}

/**
 * O CPF pelos **dois dígitos verificadores** — não pelo comprimento.
 *
 * Onze dígitos quaisquer passam por CPF para quem só conta dígitos, e é assim que entra CPF
 * errado numa cobrança: o Mercado Pago recusa depois, e a pessoa não entende por quê.
 *
 * O `111.111.111-11` é recusado à parte porque ele **passa** na conta dos verificadores — e é
 * justamente o que todo mundo digita para testar.
 */
function cpfValido(valor: string): boolean {
  const d = valor.replace(/\D/g, '')
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false
  for (const corte of [9, 10]) {
    let soma = 0
    for (let i = 0; i < corte; i += 1) soma += Number(d[i]) * (corte + 1 - i)
    if (((soma * 10) % 11) % 10 !== Number(d[corte])) return false
  }
  return true
}

/** `000.000.000-00`. Os pontos entram sozinhos — pedir para digitar é pedir que erre. */
function mascaraCpf(valor: string): string {
  return valor
    .replace(/\D/g, '')
    .slice(0, 11)
    .replace(/^(\d{3})(\d)/, '$1.$2')
    .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2')
}
