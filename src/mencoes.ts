/**
 * As menções do menu do `@` do prompt box.
 *
 * Igual ao menu do `/`: é um **completador**, não um atalho que escreve por você. Escolher
 * `@mcp.navegador` só põe o token na caixa — o que vai para o modelo é o que você escrever,
 * do jeito que você escreveu. Quem lê a marca é o backend, e ele trata o que está marcado
 * como **ordem**: `@mcp.navegador` é «use este servidor», `@sub.revisor` é «quem faz isto é
 * aquele agente», `@skill.revisao` é «siga as instruções desta skill».
 *
 * O ponto separa o tipo do nome (`@mcp.navegador`), e é ele que deixa a mão escolher a lista
 * sem abrir menu nenhum: digitar `@mcp.` já filtra só os servidores.
 *
 * Mora fora do `Composer` porque é dado puro: quem filtra e reconhece são funções sem React.
 */

import type { ApiAgente, ApiMcp, ApiSkill } from './api/client'

export type TipoDeMencao = 'sub' | 'mcp' | 'skill'

export type Mencao = {
  /** O que entra na caixa, sem o `@`: `mcp.navegador`. */
  token: string
  tipo: TipoDeMencao
  /** O nome, como ele existe no backend. */
  nome: string
  /** Uma linha, para a lista: de onde veio e o que é. */
  descricao: string
}

/** O rótulo de cada tipo, como a lista mostra. */
export const ROTULO_DO_TIPO: Record<TipoDeMencao, string> = {
  sub: 'Sub-agente',
  mcp: 'MCP',
  skill: 'Skill',
}

/** Os tipos que o menu reconhece, na ordem em que aparecem. */
const TIPOS: TipoDeMencao[] = ['sub', 'mcp', 'skill']

/**
 * A cor de cada tipo — a **mesma** na lista do menu e no texto da caixa.
 *
 * Três cores fixas, e não o destaque do app: o destaque muda com o tema (`data-accent`), e
 * em quem escolheu azul ou verde dois tipos ficariam da mesma cor. Cor fixa é o que faz a
 * marca ser reconhecida de relance, que é para o que ela serve.
 */
export const COR_DO_TIPO: Record<TipoDeMencao, string> = {
  sub: 'text-violet-400',
  mcp: 'text-sky-400',
  skill: 'text-emerald-400',
}

/** Um pedaço do texto: ou é marca (com o tipo), ou é o resto. */
export type ParteDoTexto = { texto: string; tipo: TipoDeMencao | null }

/**
 * A marca **dentro do texto**, para pintar.
 *
 * Mesma régua do menu: começa no começo do texto ou depois de um espaço (um `@` no meio de
 * um e-mail não é marca), e o nome aceita letra, número, `-`, `_` e `.` — inclusive
 * **vazio**, porque `@mcp.` já é marca enquanto está sendo digitada. Sem isso a cor
 * acenderia só no fim da palavra, e a caixa piscaria a cada letra.
 */
const MARCA = /(?<=^|\s)@(sub|agente|mcp|skill)\.([\w.-]*)/gi

/** O texto em pedaços, para pintar as marcas sem perder o resto. */
export function partesDaMencao(texto: string): ParteDoTexto[] {
  const partes: ParteDoTexto[] = []
  let ultimo = 0
  for (const achado of texto.matchAll(MARCA)) {
    const inicio = achado.index ?? 0
    if (inicio > ultimo) partes.push({ texto: texto.slice(ultimo, inicio), tipo: null })
    const bruto = achado[1].toLowerCase()
    partes.push({
      texto: achado[0],
      tipo: (bruto === 'agente' ? 'sub' : bruto) as TipoDeMencao,
    })
    ultimo = inicio + achado[0].length
  }
  if (ultimo < texto.length) partes.push({ texto: texto.slice(ultimo), tipo: null })
  return partes
}

/** A primeira linha do prompt, para a lista caber em uma linha. */
function primeiraLinha(texto: string): string {
  return (texto.split('\n').find((linha) => linha.trim()) ?? '').trim().slice(0, 90)
}

/**
 * Tudo o que dá para marcar, a partir do que o backend tem.
 *
 * Skill e servidor **desligados** ficam de fora: marcar o que está desligado seria pedir ao
 * agente uma coisa que ele não alcança — e a lista mostraria uma porta que não abre.
 */
export function mencoesDe(
  agentes: ApiAgente[] = [],
  skills: ApiSkill[] = [],
  mcps: ApiMcp[] = [],
): Mencao[] {
  return [
    ...agentes.map(
      (item): Mencao => ({
        token: `sub.${item.nome}`,
        tipo: 'sub',
        nome: item.nome,
        descricao: item.prompt ? primeiraLinha(item.prompt) : 'Sem prompt próprio',
      }),
    ),
    ...skills
      .filter((item) => item.enabled)
      .map(
        (item): Mencao => ({
          token: `skill.${item.name}`,
          tipo: 'skill',
          nome: item.name,
          descricao: item.description || 'Skill instalada',
        }),
      ),
    ...mcps
      .filter((item) => item.enabled)
      .map(
        (item): Mencao => ({
          token: `mcp.${item.name}`,
          tipo: 'mcp',
          nome: item.name,
          descricao: item.conectado
            ? `Servidor conectado · ${item.ferramentas} ferramenta(s)`
            : 'Servidor configurado, fora do ar',
        }),
      ),
  ]
}

/**
 * O que está sendo digitado como menção, ou `null` quando não é menção.
 *
 * A marca vale em qualquer lugar do texto (ao contrário do `/`, que só vale no começo): a
 * pessoa escreve a frase e marca no meio dela. Por isso a busca é pelo **último** `@`, e o
 * que vier depois dele tem de ser só nome — `@` no meio de um e-mail (`a@b`) não abre menu.
 *
 * `inicio` é onde o `@` está: quem troca o texto precisa saber o que apagar.
 */
export function mencaoDigitada(
  texto: string,
): { tipo: TipoDeMencao | null; consulta: string; inicio: number } | null {
  const inicio = texto.lastIndexOf('@')
  if (inicio < 0) return null
  if (inicio > 0 && !/\s/.test(texto[inicio - 1])) return null

  const resto = texto.slice(inicio + 1)
  if (!/^[\w.-]*$/.test(resto)) return null

  const ponto = resto.indexOf('.')
  if (ponto < 0) return { tipo: null, consulta: resto, inicio }

  const tipo = resto.slice(0, ponto).toLowerCase()
  if (!TIPOS.includes(tipo as TipoDeMencao)) return null
  return { tipo: tipo as TipoDeMencao, consulta: resto.slice(ponto + 1), inicio }
}

/** As menções que casam com o tipo e o que está sendo digitado. */
export function filtrarMencoes(
  mencoes: Mencao[],
  tipo: TipoDeMencao | null,
  consulta: string,
): Mencao[] {
  const alvo = consulta.trim().toLowerCase()
  return mencoes.filter((item) => {
    if (tipo && item.tipo !== tipo) return false
    if (!alvo) return true
    return `${item.token} ${item.descricao}`.toLowerCase().includes(alvo)
  })
}

/** O que entra na caixa ao escolher: o token e um espaço, para você continuar escrevendo. */
export const textoDaMencao = (mencao: Mencao) => `@${mencao.token} `
