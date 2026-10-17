import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Blocks, Bot, Cable, ExternalLink, LoaderCircle, Puzzle } from 'lucide-react'
import {
  ativarConector,
  baixarConector,
  entrarNoConector,
  estadoDaBaixa,
  estadoDoLogin,
  listStoreMcps,
} from '../api/client'
import type { ApiConector, ApiLogin, ApiTarefa } from '../api/client'
import { LogoDoConector } from './LogosDosConectores'

/**
 * As vistas da Store. O `id` é o estado; o rótulo é o que se lê.
 *
 * A ordem é a da descoberta: primeiro o que a pessoa **já tem** na máquina (skills, MCPs), e
 * por último o que ela **compõe** com isso (sub-agentes). Abrir pela composição seria pedir
 * que ela montasse antes de conhecer as peças.
 */
const ABAS = [
  { id: 'skills', rotulo: 'Skills', icone: Puzzle },
  { id: 'mcps', rotulo: 'MCPs', icone: Cable },
  { id: 'agentes', rotulo: 'Sub-agentes', icone: Bot },
] as const

/** Exportado porque quem guarda em que vista a área abre é o `App`. */
export type AbaDaLoja = (typeof ABAS)[number]['id']

/** O que cada aba promete, enquanto ela ainda é só o esqueleto. */
const ESQUELETO: Record<string, { titulo: string; descricao: string }> = {
  skills: {
    titulo: 'Skills publicadas',
    descricao:
      'A vitrine das skills que dá para instalar com um clique. As que já estão na máquina continuam em Ajustes → Skills, com o ligar/desligar de sempre.',
  },
  agentes: {
    titulo: 'Sub-agentes prontos',
    descricao:
      'A vitrine dos sub-agentes de fábrica — revisor, pesquisador, o que mais vier. Os seus continuam em Ajustes → Sub-agentes, onde dá para editar prompt, skills e MCPs.',
  },
}

/**
 * A Store — a área nova do menu das três barrinhas.
 *
 * **Só a aba MCPs está construída**; Skills e Sub-agentes seguem no esqueleto, com o lugar
 * reservado e um estado vazio honesto — nada de vitrine de mentira.
 *
 * O caminho de um conector é o que o dono pediu, e é o que a aba mostra:
 *
 * 1. **Baixar** — o servidor entra em `mcps.json` **desligado** e o pacote é pré-baixado.
 * 2. **Entrar** — o login é o **do provedor**, pelo navegador: o backend roda o comando que o
 *    provedor publica, devolve a URL que o CLI imprimiu (e **abre** ela, que é o que o dono
 *    pediu) e mostra o código de uso único quando o provedor pede um — sem ele, abrir a URL
 *    não leva a lugar nenhum. O token nunca passa pela interface.
 * 3. **Ativar** — liga o servidor, que aí aparece em *Ajustes → MCPs* e no submenu do cabeçalho.
 *
 * Os dois primeiros passos demoram (é `npm`, é uma pessoa autorizando no navegador), então
 * ambos rodam em segundo plano e a tela **pergunta** em vez de esperar.
 */
export default function Store({
  onClose,
  abaInicial = 'mcps',
  onConectoresMudaram,
}: {
  onClose: () => void
  /** Em que vista a área abre. Hoje só o cabeçalho abre a Store, e ela abre nos MCPs. */
  abaInicial?: AbaDaLoja
  /**
   * Aviso de que um conector mudou de estado, para o `App` reler a lista de MCPs — é o que
   * faz o conector ativado aparecer na área MCP **sem** a pessoa sair e voltar daqui.
   */
  onConectoresMudaram?: () => void
}) {
  const [aba, setAba] = useState<AbaDaLoja>(abaInicial)
  const [conectores, setConectores] = useState<ApiConector[] | null>(null)
  const [origem, setOrigem] = useState<'nuvem' | 'casa'>('casa')
  const [erro, setErro] = useState<string | null>(null)
  /** Baixas e logins em curso, por slug — é o que a sondagem acompanha. */
  const [tarefas, setTarefas] = useState<Record<string, ApiTarefa>>({})
  const [logins, setLogins] = useState<Record<string, ApiLogin>>({})
  const ocupado = useRef<Set<string>>(new Set())

  const carregar = useCallback(async () => {
    try {
      const dados = await listStoreMcps()
      setConectores(dados.conectores)
      setOrigem(dados.origem)
      setErro(null)
    } catch {
      setErro('Não foi possível ler o catálogo do backend.')
    }
  }, [])

  /**
   * A primeira leitura do catálogo, **uma vez**.
   *
   * O `useRef` é o que faz valer o «uma vez»: pôr `conectores` nas dependências faria o efeito
   * rodar de novo a cada leitura — que é justamente o que ele mesmo provoca — e a tela
   * recarregaria o catálogo para sempre. Depois daqui, quem relê são as ações (baixar, entrar,
   * ativar) e a sondagem, que é onde a mudança aconteceu de verdade.
   */
  const jaLeu = useRef(false)
  useEffect(() => {
    if (aba !== 'mcps' || jaLeu.current) return
    jaLeu.current = true
    void carregar()
  }, [aba, carregar])

  /**
   * Sondagem: enquanto houver baixa ou login em curso, pergunta de 2 em 2 s.
   *
   * Esperar o POST travaria a tela por minutos — um `npm install` não é instantâneo e um
   * login depende de alguém autorizar no navegador. Aqui a pessoa continua usando o app e o
   * cartão muda sozinho quando termina.
   */
  useEffect(() => {
    const emCurso = [
      ...Object.entries(tarefas)
        .filter(([, t]) => t.status === 'baixando')
        .map(([s]) => s),
      ...Object.entries(logins)
        .filter(([, l]) => l.status === 'rodando')
        .map(([s]) => s),
    ]
    if (emCurso.length === 0) return
    const id = window.setInterval(() => {
      for (const slug of emCurso) {
        void estadoDaBaixa(slug).then((estado) => {
          setTarefas((atual) => ({ ...atual, [slug]: estado }))
          if (estado.status !== 'baixando') void carregar()
        })
        void estadoDoLogin(slug).then((estado) => {
          setLogins((atual) => ({ ...atual, [slug]: estado }))
          if (estado.status !== 'rodando') void carregar()
        })
      }
    }, 2000)
    return () => window.clearInterval(id)
  }, [tarefas, logins, carregar])

  const baixar = async (slug: string) => {
    if (ocupado.current.has(slug)) return
    ocupado.current.add(slug)
    try {
      const estado = await baixarConector(slug)
      setTarefas((atual) => ({ ...atual, [slug]: estado }))
      if (estado.status !== 'baixando') void carregar()
    } catch {
      setErro('O backend recusou o download deste conector.')
    } finally {
      ocupado.current.delete(slug)
    }
  }

  const entrar = async (slug: string) => {
    if (ocupado.current.has(slug)) return
    ocupado.current.add(slug)
    try {
      const estado = await entrarNoConector(slug)
      setLogins((atual) => ({ ...atual, [slug]: estado }))
      if (estado.status !== 'rodando') void carregar()
    } catch {
      setErro('O backend não conseguiu começar o login deste conector.')
    } finally {
      ocupado.current.delete(slug)
    }
  }

  const ativar = async (slug: string) => {
    if (ocupado.current.has(slug)) return
    ocupado.current.add(slug)
    try {
      await ativarConector(slug)
      await carregar()
      onConectoresMudaram?.()
    } catch {
      setErro('Não foi possível ativar este conector.')
    } finally {
      ocupado.current.delete(slug)
    }
  }

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
        {aba === 'mcps' && origem === 'casa' ? (
          // Dizer a verdade sobre a origem: sem resposta do painel, a lista é a da casa — e a
          // pessoa precisa saber que o que ela lê pode não ser o catálogo do dia.
          <span className="ml-auto rounded-full bg-koda-fg/6 px-2.5 py-1 text-[10.5px] font-semibold tracking-wider text-koda-fg/40 uppercase">
            Catálogo da casa
          </span>
        ) : null}
      </div>

      {/*
       * A mesma cápsula do header e da área do presente (`bg-koda-surface`, `rounded-full`,
       * `p-1`): já é a forma do app para um grupo de botões, e um seletor de vistas não
       * precisa inventar outra.
       *
       * **Sem `pt-`**: a barra de cima já termina com os 12px do `py-3` do «Voltar», e somar
       * um recuo próprio aqui empurrava a pílula para o meio do vazio — ela nascia a 28px do
       * botão, longe de tudo. Encostada na barra, ela fica colada ao que a governa: o seletor
       * é a continuação do topo, não um bloco solto no meio da tela.
       */}
      <div className="flex shrink-0 justify-center">
        <div
          role="tablist"
          aria-label="Vistas da Store"
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

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        {erro ? (
          <p className="mx-auto max-w-md text-center text-[12.5px] text-red-400">{erro}</p>
        ) : aba === 'mcps' ? (
          conectores === null ? (
            <p className="text-center text-[12.5px] text-koda-fg/40">Carregando o catálogo…</p>
          ) : conectores.length === 0 ? (
            <p className="mx-auto max-w-md text-center text-[12.5px] text-koda-fg/40">
              O catálogo não publicou nenhum conector.
            </p>
          ) : (
            /*
             * A grade é do tamanho da tela, e não uma filera de dois.
             *
             * Com `max-w-2xl` + `sm:grid-cols-2` a vitrine era sempre duas colunas, e a
             * maior parte da janela ficava vazia — o dono pediu «até quando a tela caber».
             * `auto-fit` + `minmax(15rem, 1fr)` abre quantas colunas couberem (quatro numa
             * janela de ~1100 px) e estica cada uma para preencher a linha. Sem largura
             * máxima: o que sobra de tela é usado, em vez de sobrar.
             */
            <div className="grid grid-cols-[repeat(auto-fit,minmax(15rem,1fr))] gap-2.5">
              {conectores.map((item) => (
                <Cartao
                  key={item.slug}
                  conector={item}
                  baixa={tarefas[item.slug]}
                  login={logins[item.slug]}
                  onBaixar={() => void baixar(item.slug)}
                  onEntrar={() => void entrar(item.slug)}
                  onAtivar={() => void ativar(item.slug)}
                />
              ))}
            </div>
          )
        ) : (
          <Esqueleto aba={aba} />
        )}
      </div>
    </div>
  )
}

/** O estado vazio de uma aba que ainda não foi construída. */
function Esqueleto({ aba }: { aba: string }) {
  const vista = ESQUELETO[aba]
  const Icone = ABAS.find((item) => item.id === aba)?.icone ?? Blocks
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-koda-fg/6 text-koda-fg/50">
        <Icone className="h-5 w-5" strokeWidth={1.7} />
      </span>
      <p className="text-[14px] font-medium text-koda-fg/85">{vista.titulo}</p>
      <p className="max-w-sm text-[12.5px] leading-5 text-koda-fg/45">{vista.descricao}</p>
      <span className="mt-1 rounded-full bg-koda-fg/6 px-2.5 py-1 text-[10.5px] font-semibold tracking-wider text-koda-fg/40 uppercase">
        Em construção
      </span>
    </div>
  )
}

/** O selo de estado, com as cores que o app já usa para estado em outros lugares. */
function Selo({ conector }: { conector: ApiConector }) {
  if (conector.ativo && conector.conectado) {
    return (
      <span className="inline-flex shrink-0 items-center rounded-full bg-emerald-400/10 px-2 py-0.5 text-[10.5px] font-semibold tracking-wider text-emerald-400 uppercase">
        Ativo
      </span>
    )
  }
  if (conector.ativo) {
    return (
      <span className="inline-flex shrink-0 items-center rounded-full bg-amber-400/10 px-2 py-0.5 text-[10.5px] font-semibold tracking-wider text-amber-400 uppercase">
        Ligado
      </span>
    )
  }
  if (conector.instalado) {
    return (
      <span className="inline-flex shrink-0 items-center rounded-full bg-koda-fg/6 px-2 py-0.5 text-[10.5px] font-semibold tracking-wider text-koda-fg/45 uppercase">
        Baixado
      </span>
    )
  }
  return null
}

function Cartao({
  conector,
  baixa,
  login,
  onBaixar,
  onEntrar,
  onAtivar,
}: {
  conector: ApiConector
  baixa?: ApiTarefa
  login?: ApiLogin
  onBaixar: () => void
  onEntrar: () => void
  onAtivar: () => void
}) {
  const baixando = baixa?.status === 'baixando'
  const logando = login?.status === 'rodando'
  /**
   * O próximo passo, e só ele. Mostrar os três botões de uma vez faria a pessoa adivinhar em
   * que pé está; mostrar só o próximo é o caminho que o dono descreveu (baixar → entrar →
   * ativar), e é o que a tela diz.
   */
  const faltaCredencial = conector.precisa_login && !conector.credencial
  const podeAtivar = conector.instalado && !conector.ativo && !faltaCredencial

  return (
    <div className="flex flex-col gap-2 rounded-2xl bg-koda-surface p-4 ring-1 ring-koda-fg/8">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-koda-fg/6 text-koda-fg/70">
          <LogoDoConector slug={conector.slug} className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-medium text-koda-fg/90">{conector.nome}</p>
          <p className="mt-0.5 text-[12px] leading-4 text-koda-fg/45">{conector.descricao}</p>
        </div>
        <Selo conector={conector} />
      </div>

      {logando && login?.codigo ? (
        /*
         * O código que a página do navegador vai **pedir**.
         *
         * O device flow do GitHub imprime «First copy your one-time code: 1234-5678» e a
         * página tem só um campo para ele — abrir a URL sem o código não levava a lugar
         * nenhum. Era exatamente onde o dono travou: o navegador pedia um código que o app
         * nunca mostrava.
         */
        <div className="flex items-baseline gap-2 rounded-xl bg-koda-fg/6 px-2.5 py-2">
          <span className="text-[10.5px] font-semibold tracking-wider text-koda-fg/40 uppercase">
            Código
          </span>
          <code className="font-mono text-[15px] font-medium tracking-[0.14em] text-koda-fg">
            {login.codigo}
          </code>
        </div>
      ) : null}

      {logando && login?.url ? (
        // A URL que o CLI do provedor imprimiu. O navegador **já foi aberto** pelo backend
        // quando ela apareceu — é ele que abre sem esbarrar em bloqueio de pop-up, e vale
        // para todos os conectores. Este link fica para o caso de a abertura não ter pegado.
        <a
          href={login.url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 text-[12px] text-koda-accent underline decoration-koda-accent/40 underline-offset-2 hover:decoration-koda-accent"
        >
          <ExternalLink className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
          Abrir o login no navegador
        </a>
      ) : null}

      {logando && !login?.url ? (
        <p className="flex items-center gap-1.5 text-[12px] text-koda-fg/45">
          <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" strokeWidth={2} />
          {/* A última linha do CLI diz mais do que uma espera muda: é ali que o provedor
              conta o que está fazendo (ou o que deu errado). */}
          <span className="min-w-0 truncate">
            {login?.saida?.at(-1) ?? 'Esperando o endereço de login…'}
          </span>
        </p>
      ) : null}

      {!logando && login?.status === 'erro' ? (
        <p className="text-[12px] leading-4 text-red-400">{login.motivo ?? 'o login falhou'}</p>
      ) : null}

      {!baixando && baixa?.status === 'erro' ? (
        <p className="text-[12px] leading-4 text-red-400">{baixa.motivo ?? 'o download falhou'}</p>
      ) : null}

      {conector.ativo && conector.erro ? (
        <p className="text-[12px] leading-4 text-koda-fg/45">{conector.erro}</p>
      ) : null}

      <div className="mt-auto flex items-center gap-2 pt-1">
        {!conector.instalado ? (
          <Botao onClick={onBaixar} ocupado={baixando} ocupadoRotulo="Baixando…">
            Baixar
          </Botao>
        ) : faltaCredencial ? (
          <Botao onClick={onEntrar} ocupado={logando} ocupadoRotulo="Entrando…">
            Entrar
          </Botao>
        ) : podeAtivar ? (
          <Botao onClick={onAtivar}>Ativar</Botao>
        ) : (
          <span className="text-[12px] text-koda-fg/40">
            {conector.conectado ? 'Ativo — aparece em Ajustes → MCPs' : 'Ativo — ainda sem conexão'}
          </span>
        )}

        {conector.doc ? (
          <a
            href={conector.doc}
            target="_blank"
            rel="noreferrer"
            className="ml-auto text-[11.5px] text-koda-fg/35 hover:text-koda-fg/70"
          >
            Documentação
          </a>
        ) : null}
      </div>
    </div>
  )
}

/** O botão da ação. `ocupado` troca o rótulo e trava o clique. */
function Botao({
  children,
  onClick,
  ocupado = false,
  ocupadoRotulo,
}: {
  children: string
  onClick: () => void
  ocupado?: boolean
  ocupadoRotulo?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={ocupado}
      className="flex items-center gap-1.5 rounded-xl bg-koda-accent px-3 py-1.5 text-[12.5px] font-semibold text-koda-bg transition-opacity duration-150 hover:opacity-90 disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none"
    >
      {ocupado ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" strokeWidth={2} /> : null}
      {ocupado && ocupadoRotulo ? ocupadoRotulo : children}
    </button>
  )
}
