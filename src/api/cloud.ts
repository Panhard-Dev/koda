/**
 * A conta do Koda — quem entra, com que sessão e por quanto tempo ela dura.
 *
 * Quem manda é o **painel** (Koda Cloud): a conta existe lá, a senha é conferida lá e a
 * sessão é emitida lá (JWT curto + token de renovação rotativo, com o registro de acesso
 * e o banimento no mesmo lugar). Nesta máquina não mora credencial, chave nem regra de
 * conta nenhuma — só o que o painel devolveu.
 *
 * O que fica guardado aqui é o **token de renovação** e o e-mail (para a tela não piscar no
 * primeiro quadro) — e, junto deles, o token de acesso com o prazo dele: reabrir a janela
 * dentro desse prazo reaproveita o token em vez de girar a sessão no painel. A renovação é
 * rotativa e de **uso único** — cada uso devolve um token novo e invalida o anterior —,
 * então girar sem precisar é o caminho mais curto para o painel desconfiar de reuso e
 * derrubar a sessão inteira.
 *
 * A única coisa que este módulo faz de útil além de conversar é **traduzir**: o painel
 * responde códigos (`invalid_credentials`, `email_em_uso`, …) e a tela mostra frases na
 * voz do app, sem repassar texto de servidor.
 */

const bruto = import.meta.env.VITE_CLOUD_URL as string | undefined

/** Endereço do painel. Em produção é o Worker do Koda Cloud; `VITE_CLOUD_URL` troca. */
export const painelUrl = (bruto ?? 'https://koda-cloud-api.studiosluxgames.workers.dev').replace(
  /\/+$/,
  '',
)

export type Conta = {
  id: string
  email: string
  nome?: string | null
}

/** Chave do token de renovação no armazenamento do webview. */
const CHAVE = 'koda.conta'

/** O token de acesso em vigor. `prazo_ms` é a validade que o painel deu a ele. */
type Acesso = { token: string; expira_em: number; prazo_ms: number }

/**
 * O que fica guardado nesta máquina: a sessão da conta.
 *
 * `acesso` vai junto de propósito. Guardar só o token de renovação parecia mais fechado,
 * mas custava caro: toda reabertura da janela precisava girar a sessão no painel (o token
 * de acesso morava só na memória) e a rotação do painel é de **uso único** — uma renovação
 * que ficou no ar quando a janela recarregou já bastava para o painel considerar o token
 * reutilizado, derrubar a família inteira e pedir login de novo. Com o token de acesso no
 * disco, reabrir dentro do prazo dele não gira nada. O que um disco copiado entrega já era
 * o token de renovação, que vale dias; o de acesso, minutos, não muda o que está em jogo.
 */
type Guardada = { refresh_token: string; conta: Conta; acesso?: Acesso }

/** Token de acesso em vigor nesta execução (memória). */
let acesso: Acesso | null = null

/**
 * Fração final do prazo em que a renovação passa a ser devida.
 *
 * Renovar com 40% do token ainda no bolso é o que evita o pior intervalo possível: o
 * backend guardando uma credencial vencida, com o serviço de modelos recusando a conversa
 * no meio do uso.
 */
const FOLGA = 0.4

export class ErroDaConta extends Error {
  /** Código estável do painel (`invalid_credentials`, `email_em_uso`, …). */
  readonly codigo: string
  /** Status HTTP da resposta (0 quando nem chegou a haver resposta). */
  readonly status: number

  constructor(codigo: string, mensagem: string, status = 0) {
    super(mensagem)
    this.codigo = codigo
    this.status = status
  }
}

/** Código do painel -> frase do app. O que não está aqui vira aviso de indisponibilidade. */
const MENSAGENS: Record<string, string> = {
  invalid_credentials: 'E-mail ou senha não conferem.',
  email_em_uso: 'Já existe uma conta com este e-mail.',
  account_banned: 'Esta conta está bloqueada. Fale com o estúdio.',
  account_suspended: 'Esta conta está suspensa por enquanto.',
  too_many_attempts: 'Muitas tentativas. Espere alguns minutos e tente de novo.',
  cadastro_fechado: 'O cadastro está fechado no momento.',
  invalid_request: 'Confira o que foi digitado e tente de novo.',
  missing_token: 'Sua sessão expirou. Entre de novo.',
  token_revoked: 'Sua sessão expirou. Entre de novo.',
  invalid_token: 'Sua sessão expirou. Entre de novo.',
  token_expired: 'Sua sessão expirou. Entre de novo.',
  refresh_reuse: 'Sua sessão expirou. Entre de novo.',
  sem_conexao: 'Não consegui falar com o painel do Koda. Confira a internet.',
}

/** Códigos que significam "essa sessão não vale mais". */
const SESSAO_MORTA = new Set([
  'missing_token',
  'invalid_token',
  'token_revoked',
  'token_expired',
  'refresh_reuse',
  'account_banned',
  'account_suspended',
])

/**
 * A sessão acabou?
 *
 * Além dos códigos conhecidos, **qualquer 401/403 na renovação** significa sessão morta:
 * o painel só recusa um token de renovação quando ele não vale mais (expirado, revogado,
 * reutilizado, conta barrada). Sem isso, uma sessão revogada lá continuaria abrindo o app
 * aqui — que é o pior dos mundos: a tela entra e nada do que ela pedir funciona.
 */
function sessaoMorreu(falha: unknown): boolean {
  if (!(falha instanceof ErroDaConta)) return false
  if (falha.status === 401 || falha.status === 403) return true
  return SESSAO_MORTA.has(falha.codigo)
}

function mensagemDe(codigo: string): string {
  return MENSAGENS[codigo] ?? 'Não consegui falar com o painel do Koda. Tente de novo.'
}

/**
 * Confere a senha antes de mandar para o painel.
 *
 * É a mesma régua do servidor (12 caracteres, variedade mínima, sem repetir o e-mail) —
 * aqui só para a pessoa saber na hora o que corrigir, porque o painel responde a recusa
 * sem detalhe de propósito.
 */
export function conferirSenha(senha: string, email: string): string | null {
  if (senha.length < 12) return 'A senha precisa de pelo menos 12 caracteres.'
  if (new Set(senha).size < 5) return 'A senha repete caracteres demais.'
  const local = email.split('@')[0]?.toLowerCase() ?? ''
  if (local.length >= 4 && senha.toLowerCase().includes(local)) {
    return 'A senha não pode conter o seu e-mail.'
  }
  return null
}

async function pedir<T>(
  caminho: string,
  init: { metodo?: string; corpo?: unknown; token?: string } = {},
): Promise<T> {
  let resposta: Response
  try {
    resposta = await fetch(`${painelUrl}${caminho}`, {
      method: init.metodo ?? 'GET',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
      ...(init.corpo === undefined ? {} : { body: JSON.stringify(init.corpo) }),
    })
  } catch {
    // Sem rede (ou painel fora do ar): o app não inventa sessão nem apaga a que existe.
    throw new ErroDaConta('sem_conexao', mensagemDe('sem_conexao'))
  }

  const texto = await resposta.text()
  let corpo: Record<string, unknown> = {}
  if (texto.trim() !== '') {
    try {
      corpo = JSON.parse(texto) as Record<string, unknown>
    } catch {
      corpo = {}
    }
  }

  if (!resposta.ok) {
    const codigo = typeof corpo.error === 'string' ? corpo.error : `http_${resposta.status}`
    throw new ErroDaConta(codigo, mensagemDe(codigo), resposta.status)
  }
  return corpo as T
}

// ---------------------------------------------------------------- sessão em disco

function ler(): Guardada | null {
  try {
    const cru = window.localStorage.getItem(CHAVE)
    if (!cru) return null
    const dados = JSON.parse(cru) as Guardada
    if (
      typeof dados.refresh_token !== 'string' ||
      !dados.refresh_token ||
      typeof dados.conta?.email !== 'string'
    ) {
      window.localStorage.removeItem(CHAVE)
      return null
    }
    return dados
  } catch {
    // Sem armazenamento (ou conteúdo estranho): a sessão vale só para esta execução.
    return null
  }
}

function gravar(guardada: Guardada): void {
  try {
    window.localStorage.setItem(CHAVE, JSON.stringify(guardada))
  } catch {
    // Não consegui guardar: entra agora e pede login na próxima abertura.
  }
}

function limpar(): void {
  acesso = null
  try {
    window.localStorage.removeItem(CHAVE)
  } catch {
    // nada a fazer
  }
}

/** Conta guardada nesta máquina, sem consultar ninguém (usada no primeiro quadro). */
export function contaGuardada(): Conta | null {
  return ler()?.conta ?? null
}

// ----------------------------------------------------------------------- chamadas

type RespostaSessao = {
  access_token: string
  refresh_token: string
  expires_in: number
  conta: Conta
}

function adotar(dados: RespostaSessao): Conta {
  const segundos = Number(dados.expires_in) || 0
  // O prazo guardado junto é o que deixa a renovação ser marcada pelo relógio da própria
  // credencial, e não por um intervalo fixo chutado em outro arquivo.
  acesso = {
    token: dados.access_token,
    expira_em: Date.now() + segundos * 1000,
    prazo_ms: segundos * 1000,
  }
  gravar({ refresh_token: dados.refresh_token, conta: dados.conta, acesso })
  return dados.conta
}

/**
 * O token de acesso em vigor — o da memória ou, depois de reabrir a janela, o que ficou
 * guardado com a sessão.
 */
function acessoEmVigor(): Acesso | null {
  if (acesso) return acesso
  const salvo = ler()?.acesso
  if (!salvo || typeof salvo.token !== 'string' || !salvo.token) return null
  const expira = Number(salvo.expira_em) || 0
  if (expira <= Date.now()) return null
  acesso = { token: salvo.token, expira_em: expira, prazo_ms: Number(salvo.prazo_ms) || 0 }
  return acesso
}

/**
 * Quanto falta para a renovação ser devida, em milissegundos.
 *
 * A conta sai do **prazo** do token: a renovação é devida quando ainda restam 40% dele. Sem
 * isso, o app só renovava quando o token já estava vencido (ou quase) — e nesse intervalo o
 * host, que confia na credencial por dez minutos antes de perguntar ao painel de novo,
 * recebia um "não" do painel e a conversa parava no meio.
 *
 * `null` = não há token de acesso em memória: ninguém entrou, ou ele já venceu.
 */
export function msAteRenovar(): number | null {
  const atual = acessoEmVigor()
  if (!atual) return null
  return atual.expira_em - atual.prazo_ms * FOLGA - Date.now()
}

/** Já passou da hora de renovar? (Sem token em memória, sim.) */
function renovacaoDevida(): boolean {
  const falta = msAteRenovar()
  return falta === null || falta <= 0
}

/** Entra com e-mail e senha. */
export async function entrar(email: string, senha: string): Promise<Conta> {
  const dados = await pedir<RespostaSessao>('/api/auth/login', {
    metodo: 'POST',
    corpo: { email: email.trim(), senha },
  })
  return adotar(dados)
}

/** Cria a conta e já entra — o painel devolve a sessão do cadastro. */
export async function registrar(email: string, senha: string, nome?: string): Promise<Conta> {
  const dados = await pedir<RespostaSessao>('/api/auth/register', {
    metodo: 'POST',
    corpo: { email: email.trim(), senha, ...(nome?.trim() ? { nome: nome.trim() } : {}) },
  })
  return adotar(dados)
}

async function renovarUmaVez(refreshToken: string): Promise<Conta> {
  try {
    const dados = await pedir<RespostaSessao>('/api/auth/refresh', {
      metodo: 'POST',
      corpo: { refresh_token: refreshToken },
    })
    return adotar(dados)
  } catch (falha) {
    // Só apaga a sessão quando quem falhou é o token que ainda está guardado. Um 401 de
    // um token já rotacionado (duas renovações ao mesmo tempo) não pode derrubar a sessão
    // nova que a outra chamada acabou de gravar.
    if (sessaoMorreu(falha) && ler()?.refresh_token === refreshToken) limpar()
    throw falha
  }
}

/** Renovação em andamento, para não disparar duas com o mesmo token. */
let renovando: Promise<Conta> | null = null

/**
 * Renova a sessão — **uma vez só**, mesmo com vários pedidos ao mesmo tempo.
 *
 * O token de renovação é rotativo: quem chega depois usa um token que já foi consumido e
 * leva 401. Isso acontece de verdade (o React monta efeitos duas vezes em
 * desenvolvimento, e duas abas do app renovam juntas), então a segunda chamada espera a
 * primeira em vez de tentar por conta própria.
 */
function renovar(refreshToken: string): Promise<Conta> {
  if (renovando) return renovando
  const promessa = renovarUmaVez(refreshToken)
  renovando = promessa
  const soltar = () => {
    renovando = null
  }
  void promessa.then(soltar, soltar)
  return promessa
}

/**
 * Quem está logado agora, renovando se preciso.
 *
 * Sem token guardado, `null`. Com token ainda válido, a conta sai da memória (nenhuma
 * requisição). Vencido, o painel renova. Se a renovação for **recusada**, a sessão morreu
 * (expirou, foi revogada ou a conta foi banida) e a cópia local vai junto — é o que faz a
 * tela de login voltar. Sem rede, a conta guardada continua valendo: o login é obrigatório,
 * mas não é refém da internet.
 */
export async function sessaoAtual(): Promise<Conta | null> {
  const guardada = ler()
  if (!guardada) return null
  if (acessoEmVigor() && !renovacaoDevida()) return guardada.conta
  try {
    return await renovar(guardada.refresh_token)
  } catch {
    // Sem rede a conta guardada continua valendo; sessão recusada já foi apagada lá em cima.
    return ler() ? guardada.conta : null
  }
}

/**
 * A sessão da conta, como o app precisa dela para autorizar o serviço de modelos.
 *
 * Quem apresenta a sessão ao backend precisa saber **por que** ela não veio quando não
 * vem, porque a resposta certa é diferente em cada caso: sem rede, tentar de novo sozinho
 * resolve; com a sessão recusada pelo painel, só entrar de novo resolve. Antes tudo isso
 * era um `null` só, e a tela pedia para a pessoa tentar de novo até quando não havia o que
 * tentar.
 */
export type SessaoDaConta =
  | { estado: 'pronta'; token: string }
  /** Não há sessão nesta máquina: ninguém entrou (ou a cópia foi apagada). */
  | { estado: 'sem-sessao' }
  /** O painel recusou a renovação: a sessão morreu e só um login novo devolve acesso. */
  | { estado: 'morta'; motivo: string }
  /** O painel não foi alcançado (rede, Wi-Fi caindo, painel fora do ar). */
  | { estado: 'sem-rede' }

export async function sessaoParaOHost(): Promise<SessaoDaConta> {
  const guardada = ler()
  if (!guardada) return { estado: 'sem-sessao' }

  const atual = acessoEmVigor()
  // Fora do prazo de renovação, o que está guardado serve: nenhuma rotação no painel.
  if (atual && !renovacaoDevida()) return { estado: 'pronta', token: atual.token }

  try {
    await renovar(guardada.refresh_token)
  } catch (falha) {
    return sessaoMorreu(falha)
      ? {
          estado: 'morta',
          motivo:
            falha instanceof ErroDaConta ? falha.message : 'Sua sessão expirou. Entre de novo.',
        }
      : { estado: 'sem-rede' }
  }

  const renovado = acessoEmVigor()
  return renovado ? { estado: 'pronta', token: renovado.token } : { estado: 'sem-sessao' }
}

/**
 * Sai da conta: encerra a sessão no painel (o token de renovação é revogado lá) e apaga a
 * cópia local. Mesmo se o painel não responder, o que está nesta máquina sai agora.
 */
export async function sair(): Promise<void> {
  const guardada = ler()
  limpar()
  if (!guardada) return
  try {
    await pedir('/api/auth/logout', {
      metodo: 'POST',
      corpo: { refresh_token: guardada.refresh_token },
    })
  } catch {
    // Já saiu daqui; o token que ficou lá vence sozinho no prazo dele.
  }
}
