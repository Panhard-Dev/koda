/**
 * Reconexão da conversa: quando a conexão com o serviço local cai no meio de uma
 * resposta, o Koda tenta de novo **sozinho** antes de dizer que falhou.
 *
 * Sem isto, qualquer queda — o backend reiniciando, a porta sumindo, o fluxo fechando
 * no meio, o serviço travando calado — encerrava a rodada com «a conexão caiu» e a
 * pessoa tinha de clicar em Continuar à mão, se lembrasse de qual era a tarefa. A
 * reconexão é o mesmo comportamento que o backend já tem com o provedor (o evento
 * `aviso`), trazido para a conexão de rede, que é a que falha sem avisar.
 *
 * A regra do dono: **qualquer erro** reconecta — acertando, o contexto continua de
 * onde parou (o backend guarda a conversa, e a retomada usa `resume` para não repetir
 * a mensagem do usuário); batendo 10 tentativas, a rodada para e **diz o erro** —
 * nada de laço infinito. A decisão de tentar até os erros de pedido (401/422/404) é
 * deliberada: dez tentativas custam menos que uma resposta que morre sem explicação,
 * e a linha «Reconectando…» deixa claro que o Koda está tentando, não travado.
 *
 * O silêncio também é erro: conexão viva que não manda nada (backend travado, host
 * engasgado, proxy furando) nunca lançava — a rodada ficava pendurada para sempre,
 * sem erro e sem fechamento. O sinal de vida (`lerComSinalDeVida`) estoura esse
 * silêncio e o transforma em `QuedaDeConexao`, que cai no mesmo laço.
 */

/** Quantas vezes o Koda tenta reconectar antes de desistir e avisar o erro. */
export const TENTATIVAS_DE_RECONEXAO = 10

/**
 * Quanto esperar antes da tentativa `tentativa` (1 = depois da primeira falha), em ms.
 *
 * Sobe de um em um segundo e para em 8: o serviço que caiu por acaso volta em
 * segundos, e uma espera que crescesse para sempre faria a pessoa esperar minutos
 * por uma conexão que não vem.
 */
export function esperaDaTentativa(tentativa: number): number {
  return Math.min(Math.max(tentativa, 1), 8) * 1000
}

/**
 * O silêncio do fluxo, em ms. São **dois** limites, porque os dois silêncios são
 * diferentes:
 *
 * - **antes do primeiro byte** (`ESPERA_DO_PRIMEIRO_BYTE_MS`): o modelo pensando
 *   antes de escrever a primeira palavra. É legítimo e pode ser longo — daí o dobro.
 * - **no meio** (`INATIVIDADE_MS`): a conexão já provou vida. Silêncio depois disso
 *   é quase sempre travamento (ou ferramenta longa, que o sinal de vida do backend
 *   cobre: comentários SSE a cada 15 s mantêm o fluxo acordado).
 *
 * Os dois são generosos de propósito: cortar uma resposta legítima no meio é pior
 * que esperar mais um pouco por uma travada.
 */
export const ESPERA_DO_PRIMEIRO_BYTE_MS = 120_000
export const INATIVIDADE_MS = 60_000

/**
 * A conexão fechou no meio da resposta — o fluxo acabou sem `done` e sem `error`.
 *
 * É um erro de conexão disfarçado: o backend não escolheu parar, a rede parou por
 * ele. Representado como erro para cair no mesmo caminho da falha de rede.
 * O sinal de vida (silêncio estourado) usa a mesma classe.
 */
export class QuedaDeConexao extends Error {
  constructor(mensagem = 'a conexão fechou no meio da resposta') {
    super(mensagem)
    this.name = 'QuedaDeConexao'
  }
}

/**
 * Lê o próximo pedaço do fluxo, mas desiste de esperar depois de `limiteMs` sem
 * que **nada** chegue.
 *
 * É o sinal de vida do lado do cliente: enquanto bytes chegarem (eventos, deltas,
 * ou os comentários de sinal de vida do backend), a leitura segue normalmente. Se
 * o limite estourar, lança `QuedaDeConexao` — quem chama aborta a conexão (senão o
 * fluxo velho continua aberto no backend e a tentativa seguinte duplicaria o
 * trabalho) e o laço da reconexão decide o que fazer.
 *
 * Falha de leitura de verdade (a rede cair com o pedido pendente) é repassada como
 * veio — o caminho é o mesmo.
 */
export async function lerComSinalDeVida(
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
  limiteMs: number,
): Promise<{ done: boolean; value?: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const desistir = (erro: unknown) => {
      clearTimeout(timer)
      reject(erro)
    }
    const timer = setTimeout(
      () =>
        desistir(
          new QuedaDeConexao(
            limiteMs >= 1000
              ? `a conexão ficou ${Math.round(limiteMs / 1000)}s sem enviar nada`
              : `a conexão ficou ${limiteMs}ms sem enviar nada`,
          ),
        ),
      limiteMs,
    )
    reader.read().then(
      (resultado) => {
        clearTimeout(timer)
        resolve(resultado)
      },
      (erro) => desistir(erro),
    )
  })
}

/**
 * O backend respondeu que a rodada não deu — falha do provedor/modelo (cota
 * esgotada, host estourado, modelo que recusou).
 *
 * Não é queda de conexão: o serviço está de pé e respondeu. Entra no laço como
 * qualquer outro erro (regra do dono: **todo** erro tenta), mas **não** marca o
 * backend como caído — ele está vivo, só não conseguiu.
 */
export class ErroDoServico extends Error {
  constructor(mensagem: string) {
    super(mensagem)
    this.name = 'ErroDoServico'
  }
}

/**
 * Esta falha foi a **conexão** caindo (e não o serviço respondendo que não)?
 *
 * Serve para duas coisas que não são a decisão de repetir — repetir é sempre:
 * marcar o backend como fora (o serviço que respondeu 422 está de pé, só recusou) e
 * escolher a frase do fim da rodada.
 *
 * Sem `instanceof ApiError` de propósito: este módulo não importa o cliente (o
 * cliente importa este), e o `status` é o único campo que interessa aqui.
 */
export function ehFalhaDeConexao(erro: unknown): boolean {
  if (erro instanceof QuedaDeConexao) return true
  if (erro instanceof TypeError) return true
  const status = (erro as { status?: unknown } | null)?.status
  return typeof status === 'number' && status >= 500
}

/** Espera `ms`, ou até o sinal disparar — o Parar não espera a reconexão acabar. */
export function dormir(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // Sinal **já** abortado (o Parar veio antes desta espera): não espera nada. Sem
    // esta checagem, `addEventListener('abort')` num sinal que já abortou não dispara
    // — o evento só corre na transição —, e a espera ficaria pendurada no tempo cheio.
    if (signal.aborted) {
      resolve()
      return
    }
    const fim = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', fim)
      resolve()
    }
    const timer = setTimeout(fim, ms)
    signal.addEventListener('abort', fim, { once: true })
  })
}
