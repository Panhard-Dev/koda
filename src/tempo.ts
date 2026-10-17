/**
 * O tempo do dia que ainda resta — e o que faz ele andar.
 *
 * **Ele só anda enquanto o agente trabalha.** É a regra: a hora é gasta respondendo, não
 * esperando. Uma conversa parada na tela não consome um segundo, e é por isso que isto não é
 * um `setInterval` solto ligado na montagem: ele liga e desliga com o trabalho, e parado não
 * há sequer um tique rodando à toa.
 *
 * Mora fora do `Composer` de propósito. A caixa é desmontada quando a pessoa sai do chat
 * (Ajustes, a área do presente), e um contador que vive dentro dela recomeçaria do zero a cada
 * ida e volta — dando à pessoa horas que ela não tem. Quem liga e desliga é o App, que não
 * desmonta e é de onde o `busy` vem.
 *
 * Quem sabe o gasto de verdade é o **backend**: cada resposta grava o `elapsed_ms` na tabela
 * `messages`, e `/api/usage` soma a janela do dia. Este arquivo é o que faz o número **andar
 * na frente da pessoa** — e `sincronizar()` reaponta ele para o que o servidor gravou a cada
 * leitura. O rascunho cobre só a janela em que o backend não responde.
 *
 * O rascunho **sobrevive à recarga** (ver `CHAVE`): guardado só em memória, o tempo voltava ao
 * cheio a cada F5, a cada atualização do app e a cada edição no dev — ninguém nunca chegava ao
 * `00:00` e a hora grátis virava infinita.
 */

import { useSyncExternalStore } from 'react'

import { PLANO_FREE } from './plano'

/**
 * Quantas horas o dia dá.
 *
 * **É a do plano da conta**, e não mais a constante do Free: quem tem Koda Plus tem 4 h por
 * dia, e a aba tem de dizer isso. Chega por `definirHorasDoDia()`, que o `App` chama quando a
 * sonda de sessão traz o plano (`/api/account/me` → `plano.horas_por_dia`). Enquanto o plano
 * não chegou — ou quando a conta está no Free —, vale a do `PLANO_FREE`: é o degrau de baixo, e
 * mostrar 0 h antes da primeira resposta seria pior do que mostrar o que a conta tem.
 */
let horasDoDia = PLANO_FREE.horasPorDia

/** O dia cheio, em segundos, segundo o plano em vigor. */
const cheio = () => horasDoDia * 3600

/**
 * Onde o rascunho mora entre uma sessão e outra.
 *
 * O sufixo segue as outras chaves do app (`koda.conta`, `koda.aviso-versao`).
 *
 * **A chave é por conta** (ver `chaveDe()`): o rascunho é um paliativo para quando o backend
 * não responde, e um paliativo que atravessa contas é pior que nenhum — trocar de conta no
 * mesmo PC mostrava o tempo que a anterior tinha deixado.
 */
const CHAVE = 'koda.tempo-do-dia'

/** O e-mail da conta logada, normalizado. `null` = ninguém logado. */
let contaAtual: string | null = null

/** A chave do rascunho **desta** conta. */
const chaveDe = () => (contaAtual ? `${CHAVE}:${contaAtual}` : CHAVE)

/** O dia de calendário local, no formato da comparação (`2026-10-10`). */
function diaDeHoje(): string {
  const agora = new Date()
  const mes = String(agora.getMonth() + 1).padStart(2, '0')
  const dia = String(agora.getDate()).padStart(2, '0')
  return `${agora.getFullYear()}-${mes}-${dia}`
}

/**
 * O dia a que o `gastos` de agora pertence — é o que faz a virada da meia-noite zerar a
 * conta. Guardar o **dia**, e não um "expira em", porque o tempo é do dia de calendário: a
 * virada é a mesma para todo mundo, e não 24 horas desde a última recarga.
 */
let diaDoGasto = diaDeHoje()

/**
 * O que já foi gasto hoje, em segundos.
 *
 * Guardar o **gasto** (e não o que sobra) é o que deixa o plano trocar sem perder a conta: o
 * que a pessoa gastou não muda quando ela muda de plano, e o que sobra é `cheio() − gastos`
 * calculado na hora. Com o "restante" guardado, trocar de plano teria de adivinhar como
 * converter um número do plano velho para o novo.
 */
let gastos = 0

/**
 * Lê o rascunho guardado — e devolve **zero gasto** quando não há nada de hoje.
 *
 * Três casos caem no zero, e são o mesmo caso: primeira abertura, dia virado (o tempo é do dia)
 * e rascunho ilegível. Nada aqui pode lançar: sem `localStorage` (janela privada, armazenamento
 * bloqueado) o app tem de continuar contando — só que sem lembrar entre sessões.
 */
/**
 * Lê o rascunho de **uma chave específica** — a de «ninguém» ou a de outra conta.
 *
 * O corpo é o do `carregar()`, que passa a ser só um atalho para a chave da conta atual.
 */
function carregarNa(chave: string): number {
  try {
    const cru = window.localStorage.getItem(chave)
    if (!cru) return 0
    const guardado = JSON.parse(cru) as { dia?: string; gastos?: number; restante?: number }
    if (guardado.dia !== diaDeHoje()) return 0
    if (typeof guardado.gastos === 'number' && Number.isFinite(guardado.gastos)) {
      return Math.max(0, Math.floor(guardado.gastos))
    }
    // Formato antigo (guardava o que sobrava, no orçamento do Free): converte para gasto.
    if (typeof guardado.restante === 'number' && Number.isFinite(guardado.restante)) {
      return Math.max(0, PLANO_FREE.horasPorDia * 3600 - Math.floor(guardado.restante))
    }
    return 0
  } catch {
    return 0
  }
}

function carregar(): number {
  return carregarNa(chaveDe())
}

gastos = carregar()
let relogio: ReturnType<typeof setInterval> | null = null
const ouvintes = new Set<() => void>()

function avisar() {
  for (const ouvinte of ouvintes) ouvinte()
}

/** Grava o rascunho do dia. Falhar aqui não pode parar a contagem. */
function guardar() {
  try {
    window.localStorage.setItem(chaveDe(), JSON.stringify({ dia: diaDoGasto, gastos }))
  } catch {
    // Sem localStorage: o rascunho vale só para esta sessão.
  }
}

/** Grava o rascunho **numa chave específica** — a da conta que está saindo. */
function guardarNa(chave: string) {
  try {
    window.localStorage.setItem(chave, JSON.stringify({ dia: diaDoGasto, gastos }))
  } catch {
    // Sem localStorage: o rascunho vale só para esta sessão.
  }
}

function parar() {
  if (relogio === null) return
  clearInterval(relogio)
  relogio = null
}

/**
 * Troca o orçamento do dia — o `horas_por_dia` do plano da conta.
 *
 * Chamado quando a sonda de sessão traz o plano. Não zera nada: o gasto continua o mesmo, e o
 * que sobra é recalculado. Um plano maior, portanto, **devolve** as horas que faltavam sem
 * apagar o que já foi usado — é o que a pessoa espera ao assinar.
 */
export function definirHorasDoDia(horas: number): void {
  const valor = Number.isFinite(horas) && horas > 0 ? horas : PLANO_FREE.horasPorDia
  if (valor === horasDoDia) return
  horasDoDia = valor
  guardar()
  avisar()
}

/**
 * Diz de **quem** é o rascunho — trocar de conta troca o rascunho.
 *
 * Quem chama é o `App`, quando a conta entra ou sai. O valor que estava na conta anterior
 * fica onde está (a chave é dela): voltar para aquela conta reencontra o rascunho, e o
 * backend, quando responde, corrige os dois pelo que ele gravou.
 *
 * **Trocar de conta não pode apagar o que esta sessão já contou.** A sonda de sessão
 * leva um tempo para dizer quem está aqui, e uma resposta pode sair antes dela: os
 * segundos contados nesse intervalo ficavam na chave de «ninguém» e morriam quando a
 * conta chegava — a pessoa via `07:59:56`, reiniciava (ou a conta caía) e o relógio
 * voltava a `08:00:00`, com o backend **tendo** o gasto gravado. Por isso:
 *
 * - **ninguém → conta**: os segundos sem dono são de quem chegou. Se a conta nova não
 *   tem rascunho de hoje, eles passam a ser dela (e são gravados na chave nova);
 * - **conta → conta**: o que foi contado desde a última troca é da conta que está
 *   saindo — é fechado na chave **dela** antes de a nova ser carregada.
 */
export function definirConta(identificador: string | null): void {
  const limpo = (identificador ?? '').trim().toLowerCase() || null
  if (limpo === contaAtual) return
  const gastosDaSessao = gastos
  const veioDeNinguem = contaAtual === null
  const chaveAntiga = chaveDe()
  contaAtual = limpo
  const daNovaConta = carregar()
  if (veioDeNinguem) {
    // Sem dono, os segundos são de quem chegou — e o rascunho de «ninguém» também:
    // uma resposta pode ter sido contada antes de a sonda dizer quem era (ou depois de
    // um reload, que só lê a chave genérica no init). Esse tempo está na chave de
    // ninguém e morreria se a chave da conta fosse a única lida. Fica o maior dos três.
    gastos = Math.max(gastosDaSessao, daNovaConta, carregarNa(CHAVE))
  } else {
    if (gastosDaSessao > 0) guardarNa(chaveAntiga)
    gastos = daNovaConta
  }
  diaDoGasto = diaDeHoje()
  guardar()
  avisar()
}

/**
 * Diz se o agente está trabalhando.
 *
 * É o que liga e desliga o relógio, e é chamado a cada mudança do `busy`. Chamar com `true`
 * duas vezes não cria dois relógios — o segundo não faz nada.
 */
export function ligar(ativo: boolean): void {
  if (!ativo) {
    parar()
    return
  }
  if (relogio !== null) return
  relogio = setInterval(() => {
    // Virou o dia com o app aberto: o tempo volta ao começo, como à meia-noite.
    const hoje = diaDeHoje()
    if (hoje !== diaDoGasto) {
      diaDoGasto = hoje
      gastos = 0
    }
    gastos += 1
    if (gastos >= cheio()) parar()
    guardar()
    avisar()
  }, 1000)
}

/**
 * Reaponta o rascunho para o que o **servidor gravou** do dia.
 *
 * É o que tira o mostrador do rascunho. O gasto de verdade está na tabela `messages` do
 * backend — `/api/usage` devolve a janela do dia com o `elapsed_ms` somado —, e é ele que
 * manda aqui. O tique local continua: ele é o que faz o número **andar durante a resposta**,
 * antes de a mensagem ser gravada; quando ela é, esta leitura corrige o que o tique estimou.
 *
 * **A invariante: dentro do mesmo dia, o gasto nunca diminui.** Só a virada da meia-noite
 * (no tique) e a troca de conta de propósito fazem o número descer — tudo o mais só sobe.
 * Uma leitura atrasada do servidor, portanto, nunca devolve horas já gastas: o pior que
 * ela faz é chegar com um número menor, e o `max` a ignora.
 */
export function sincronizar(segundosGastos: number): void {
  const doServidor = Number.isFinite(segundosGastos)
    ? Math.max(0, Math.floor(segundosGastos))
    : 0
  const hoje = diaDeHoje()
  // Virou o dia com o app aberto: o gasto de ontem morreu — sem isto, o `max` abaixo
  // carregaria para hoje as horas de ontem. É a **única** queda legítima do dia.
  //
  // Daqui para baixo o gasto **só sobe**: o número do servidor é um piso, nunca um teto,
  // e nenhuma leitura atrasada — sonda rodando no meio da rodada, consulta que tropeça,
  // painel que ainda não gravou a resposta em curso — pode devolver horas que a pessoa
  // já gastou. Foi assim que o dono perdeu 2 h no mostrador durante um turno longo: a
  // aba pulou de `06:00:00` para perto de `07:00:00`, e a verdade só voltava quando a
  // rodada fechava e o servidor finalmente sabia dela. Antes havia um ramo que
  // **substituía** o gasto quando o dia não batia; agora o dia é tratado antes, e o
  // `max` é incondicional.
  if (hoje !== diaDoGasto) {
    diaDoGasto = hoje
    gastos = 0
  }
  gastos = Math.max(gastos, doServidor)
  guardar()
  avisar()
}

/** O tempo do dia na forma da aba: `03:00:00`. */
export function tempoEmTexto(segundos: number): string {
  const dois = (valor: number) => String(valor).padStart(2, '0')
  const horas = dois(Math.floor(segundos / 3600))
  const minutos = dois(Math.floor(segundos / 60) % 60)
  return `${horas}:${minutos}:${dois(segundos % 60)}`
}

/**
 * O tempo na forma curta: `2h 14min`.
 *
 * É o formato dos cartões de uso, e não o `03:00:00` da aba. Lá o número é **acompanhado** — ele
 * anda na frente da pessoa e a forma fixa evita o texto dançando de largura. Aqui ele é
 * **relido**: «00:02:14» obriga a contar os dois-pontos para saber que são duas horas.
 */
export function tempoCurto(segundos: number): string {
  if (segundos < 60) return `${segundos}s`
  const horas = Math.floor(segundos / 3600)
  const minutos = Math.floor(segundos / 60) % 60
  return horas > 0 ? `${horas}h ${minutos}min` : `${minutos}min`
}

export function assinar(ouvinte: () => void): () => void {
  ouvintes.add(ouvinte)
  return () => {
    ouvintes.delete(ouvinte)
  }
}

export function ler(): number {
  return Math.max(0, cheio() - gastos)
}

/**
 * Os segundos que ainda restam do dia.
 *
 * Devolve o **número**, e não o texto: quem mostra precisa dele das duas formas — a aba da
 * caixa escreve `03:00:00`, e a ficha do plano desenha a barra com a fração que sobrou. Formatar
 * aqui obrigaria a ficha a desfazer o texto para calcular.
 */
export function useSegundosDoDia(): number {
  return useSyncExternalStore(assinar, ler)
}
