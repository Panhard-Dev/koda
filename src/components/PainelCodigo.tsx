import { useEffect, useRef, useState } from 'react'
import { ChevronRight, File, Folder, FolderOpen, LoaderCircle } from 'lucide-react'
import {
  fraseDeFalha,
  lerArquivo,
  limparMudancas,
  listarArquivos,
  listarMudancas,
} from '../api/client'
import type {
  ApiProject,
  ArquivoLido,
  ItemDeArvore,
  LinhaDeDiff,
  MudancaDeArquivo,
} from '../api/client'

/**
 * A aba **Código** do painel lateral: a árvore do projeto de um lado, o arquivo do outro.
 *
 * Duas áreas, e a divisão é o pedido: à esquerda a lista (pasta ▸ arquivo), à direita o
 * código real do que foi clicado. Não é um editor — não escreve nada no disco. É leitura: o
 * mesmo conteúdo que o agente vê quando abre o arquivo, mostrado para quem está olhando.
 *
 * A árvore carrega **um nível por vez**. Uma árvore inteira não cabe numa tela: a pasta
 * `src-tauri` deste projeto tem milhares de arquivos, e trazer tudo de uma vez para mostrar
 * o que ninguém vai ler seria travar a tela em nome de nada. Quem abre uma pasta pede os
 * filhos dela — e o que já foi aberto fica guardado, então reabrir não volta ao disco.
 *
 * ## O verde e o vermelho
 *
 * O arquivo que a IA mexeu **nesta execução** aparece com o que entrou em verde e o que saiu
 * em vermelho, e a linha dele na árvore ganha o `+n −m`. Quem sabe o que mudou é o backend
 * (`app/contracts/mudancas.py`): ele guarda o texto de antes de cada escrita, e é a
 * comparação com o de depois que produz o diff. O front não adivinha nada — sem mudança
 * anotada, ele mostra o arquivo como ele está, sem pintar.
 *
 * A aba **acompanha** a IA: sonda `/api/fs/mudancas` a cada 2,5 s (leitura barata, só memória
 * do backend) e, quando o conjunto de mudanças muda, relê o arquivo aberto e as pastas
 * abertas. Sem isso o painel mostraria o retrato de quando foi aberto — e o assunto dele é
 * justamente o que a IA está fazendo agora.
 *
 * **Sem realce de sintaxe, e é de propósito.** O projeto não tem biblioteca de realce e não
 * vai ganhar uma por causa disto. O que a tela promete é o código *real*, com os números de
 * linha — e isso ela entrega sem dependência nenhuma.
 */

/** O que já se sabe de uma pasta da árvore. */
type Ramo = {
  /** `null` = ainda não foi buscada. Lista vazia é pasta vazia de verdade, e são coisas
   *  diferentes: uma pede o disco, a outra não. */
  itens: ItemDeArvore[] | null
  aberto: boolean
  carregando: boolean
  /** Por que não deu para listar, quando é o caso. Vazio = sem aviso. */
  erro: string
}

/**
 * A identidade de um caminho para procurar as marcas.
 *
 * No Windows `C:\Pasta\x.ts` e `c:/pasta/X.TS` são o mesmo arquivo. O backend normaliza a
 * chave do mesmo jeito; comparar as duas formas cruas daria «não mudou» para um arquivo que
 * mudou — e o defeito apareceria como «o diff não aparece», que não parece ser de caminho.
 */
const chave = (caminho: string) => caminho.replace(/\\/g, '/').toLowerCase()

/** Tamanho em bytes como a mão lê: `412 B`, `3,4 KB`, `1,2 MB`. */
function tamanhoLegivel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} KB`
  return `${(kb / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`
}

/** As marcas por caminho normalizado, para a árvore achar a linha de cada arquivo. */
function porCaminho(itens: MudancaDeArquivo[]): Record<string, MudancaDeArquivo> {
  return Object.fromEntries(itens.map((item) => [chave(item.caminho), item]))
}

/** O retrato de uma lista de mudanças, para comparar duas sem olhar os outros campos. */
function assinaturaDe(itens: MudancaDeArquivo[]): string {
  return itens
    .map((item) => `${chave(item.caminho)}:${item.vezes}`)
    .sort()
    .join('|')
}

/**
 * O `+n −m` de um arquivo alterado, como ele aparece na árvore e no cabeçalho.
 *
 * Sem contagem (arquivo grande demais para o diff) fica um ponto — dizer «+0 −0» seria
 * afirmar um número que ninguém mediu.
 */
function Contagem({ mais, menos }: { mais: number | null; menos: number | null }) {
  if (mais === null || menos === null) {
    return <span className="text-[10.5px] text-koda-accent">•</span>
  }
  return (
    <span className="font-mono text-[10.5px] tabular-nums">
      <span className="text-emerald-400">+{mais}</span>
      {menos > 0 ? <span className="text-red-400"> −{menos}</span> : null}
    </span>
  )
}

/**
 * Uma linha da árvore — e, quando é pasta aberta, as linhas dela logo abaixo.
 *
 * O recuo é o `paddingLeft` calculado, e não uma margem por nível: com margem, o fundo do
 * `hover` começaria depois do recuo e a faixa ficaria torta a cada nível.
 */
function Linha({
  item,
  profundidade,
  ramos,
  marcas,
  escolhido,
  onAlternarPasta,
  onAbrirArquivo,
}: {
  item: ItemDeArvore
  profundidade: number
  ramos: Record<string, Ramo>
  marcas: Record<string, MudancaDeArquivo>
  escolhido: string
  onAlternarPasta: (caminho: string) => void
  onAbrirArquivo: (caminho: string) => void
}) {
  const ramo = ramos[item.caminho]
  const aberto = Boolean(ramo?.aberto)
  const ativo = !item.pasta && escolhido === item.caminho
  const marca = marcas[chave(item.caminho)]
  const recuo = 6 + profundidade * 12

  return (
    <>
      <button
        type="button"
        title={item.caminho}
        onClick={() => (item.pasta ? onAlternarPasta(item.caminho) : onAbrirArquivo(item.caminho))}
        style={{ paddingLeft: recuo }}
        className={[
          'flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[12px] transition-colors duration-100',
          'focus-visible:ring-1 focus-visible:ring-koda-accent focus-visible:outline-none',
          ativo
            ? 'bg-koda-accent/15 text-koda-fg'
            : 'text-koda-fg/75 hover:bg-koda-fg/8 hover:text-koda-fg',
        ].join(' ')}
      >
        {item.pasta ? (
          <ChevronRight
            strokeWidth={2}
            className={[
              'h-3.5 w-3.5 shrink-0 text-koda-fg/35 transition-transform duration-150',
              aberto ? 'rotate-90' : '',
            ].join(' ')}
          />
        ) : (
          // O vão do chevron, para o nome do arquivo alinhar com o da pasta irmã.
          <span aria-hidden className="h-3.5 w-3.5 shrink-0" />
        )}

        {item.pasta ? (
          aberto ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-koda-accent/80" strokeWidth={1.8} />
          ) : (
            <Folder className="h-3.5 w-3.5 shrink-0 text-koda-accent/60" strokeWidth={1.8} />
          )
        ) : (
          <File className="h-3.5 w-3.5 shrink-0 text-koda-fg/35" strokeWidth={1.8} />
        )}

        <span className="truncate">{item.nome}</span>

        {ramo?.carregando ? (
          <LoaderCircle
            className="ml-auto h-3 w-3 shrink-0 animate-spin text-koda-fg/35"
            strokeWidth={2}
          />
        ) : marca ? (
          <span className="ml-auto shrink-0 pl-1.5">
            <Contagem mais={marca.mais} menos={marca.menos} />
          </span>
        ) : null}
      </button>

      {item.pasta && aberto ? (
        <>
          {ramo?.erro ? (
            <p
              style={{ paddingLeft: recuo + 20 }}
              className="py-1 pr-2 text-[11px] leading-snug text-amber-500"
            >
              {ramo.erro}
            </p>
          ) : null}
          {ramo?.itens?.length === 0 ? (
            <p
              style={{ paddingLeft: recuo + 20 }}
              className="py-1 pr-2 text-[11px] text-koda-fg/30"
            >
              pasta vazia
            </p>
          ) : null}
          {(ramo?.itens ?? []).map((filho) => (
            <Linha
              key={filho.caminho}
              item={filho}
              profundidade={profundidade + 1}
              ramos={ramos}
              marcas={marcas}
              escolhido={escolhido}
              onAlternarPasta={onAlternarPasta}
              onAbrirArquivo={onAbrirArquivo}
            />
          ))}
        </>
      ) : null}
    </>
  )
}

/**
 * O código como ele está agora.
 *
 * O fundo é opaco de propósito: a coluna dos números é `sticky` para não sumir quando o
 * arquivo é largo e a linha anda para o lado — e sobre um fundo translúcido ela deixaria o
 * código passar por baixo dela.
 *
 * O embrulho `w-max min-w-full` existe para o `sticky` funcionar. Sem ele, a caixa de cada
 * linha é só a largura visível, e a coluna dos números não tem para onde deslizar: ela sai da
 * tela junto com o resto assim que a linha larga rola para o lado.
 */
function CodigoSimples({ texto }: { texto: string }) {
  const linhas = texto.split('\n')
  return (
    <pre className="min-h-0 flex-1 overflow-auto bg-koda-bg py-2 font-mono text-[11.5px] leading-[1.6] text-koda-fg/90">
      <span className="flex w-max min-w-full flex-col">
        {linhas.map((linha, indice) => (
          <span key={indice} className="flex">
            <span className="sticky left-0 w-11 shrink-0 bg-koda-bg pr-3 text-right text-koda-fg/25 select-none">
              {indice + 1}
            </span>
            <span className="whitespace-pre">{linha === '' ? ' ' : linha}</span>
          </span>
        ))}
      </span>
    </pre>
  )
}

/**
 * O arquivo com a marca da mudança: verde no que entrou, vermelho no que saiu.
 *
 * A coluna dos números mostra a numeração **nova**; nas linhas que saíram, que não têm
 * numeração nova, fica a antiga — em vermelho apagado, para não parecer que o arquivo tem
 * duas linhas 40.
 *
 * As linhas que saíram aparecem com o texto apagado, e não escondidas atrás de um «−3
 * linhas»: quem está lendo precisa ver **o que** saiu, senão o diff não diz nada.
 */
function CodigoComDiff({ linhas }: { linhas: LinhaDeDiff[] }) {
  return (
    <pre className="min-h-0 flex-1 overflow-auto bg-koda-bg py-2 font-mono text-[11.5px] leading-[1.6] text-koda-fg/90">
      <span className="flex w-max min-w-full flex-col">
        {linhas.map((linha, indice) => {
          const entrou = linha.tipo === 'entrou'
          const saiu = linha.tipo === 'saiu'
          return (
            <span
              key={indice}
              className={['flex', entrou ? 'bg-emerald-500/14' : saiu ? 'bg-red-500/14' : ''].join(
                ' ',
              )}
            >
              <span
                className={[
                  'sticky left-0 w-11 shrink-0 bg-koda-bg pr-3 text-right select-none',
                  saiu ? 'text-red-400/45' : 'text-koda-fg/25',
                ].join(' ')}
              >
                {linha.novo ?? linha.antigo}
              </span>
              <span
                aria-hidden
                className={[
                  'w-4 shrink-0 text-center select-none',
                  entrou ? 'text-emerald-400' : saiu ? 'text-red-400' : 'text-transparent',
                ].join(' ')}
              >
                {entrou ? '+' : saiu ? '−' : '·'}
              </span>
              <span className={['whitespace-pre', saiu ? 'text-koda-fg/55' : ''].join(' ')}>
                {linha.texto === '' ? ' ' : linha.texto}
              </span>
            </span>
          )
        })}
      </span>
    </pre>
  )
}

export function AbaCodigo({ projeto }: { projeto: ApiProject | null }) {
  /**
   * A pasta do projeto — só quando ela ainda existe no disco. Pasta apagada não é raiz de
   * nada: a aba diz que sumiu em vez de mostrar uma árvore vazia sem explicar.
   */
  const raiz = projeto?.existe ? projeto.caminho : null

  const [ramos, setRamos] = useState<Record<string, Ramo>>({})
  const [marcas, setMarcas] = useState<Record<string, MudancaDeArquivo>>({})
  const [arquivo, setArquivo] = useState<ArquivoLido | null>(null)
  const [escolhido, setEscolhido] = useState('')
  const [lendo, setLendo] = useState(false)
  const [erroArquivo, setErroArquivo] = useState('')

  /**
   * O número do pedido de leitura em curso.
   *
   * Sem ele, clicar em dois arquivos depressa faz o mais lento chegar depois e pintar a tela
   * com o arquivo errado — a resposta antiga não sabe que foi abandonada. Quem confere é
   * quem tem o número mais alto.
   */
  const pedido = useRef(0)

  /**
   * O que a sondagem precisa saber sem depender do render.
   *
   * O efeito da sondagem não pode depender de `escolhido` nem de `ramos`: ele seria
   * desmontado e remontado a cada clique, o relógio de 2,5 s recomeçaria, e a aba nunca
   * acompanharia nada. Uma ref com o valor do último render resolve isso sem prender o
   * efeito — e as funções que ela alimenta só tocam refs e `setState`, então uma versão
   * antiga delas continua correta.
   */
  const vivo = useRef({ escolhido: '', abertos: [] as string[] })
  /** A marca da última lista de mudanças vista — é o que diz se algo mudou de verdade. */
  const assinatura = useRef('')
  /** A primeira leitura (árvore + marcas) já terminou? Antes disso, sondar não faz sentido. */
  const pronto = useRef(false)

  const abrirArquivo = async (caminho: string) => {
    const meu = (pedido.current += 1)
    setEscolhido(caminho)
    setErroArquivo('')
    setLendo(true)
    try {
      const lido = await lerArquivo(caminho)
      if (meu !== pedido.current) return
      setArquivo(lido)
    } catch (erro) {
      if (meu !== pedido.current) return
      setArquivo(null)
      setErroArquivo(fraseDeFalha(erro))
    } finally {
      if (meu === pedido.current) setLendo(false)
    }
  }

  const alternarPasta = async (caminho: string) => {
    const ramo = ramos[caminho]
    if (ramo?.aberto) {
      setRamos({ ...ramos, [caminho]: { ...ramo, aberto: false } })
      return
    }
    // Já buscada uma vez: reabrir não volta ao disco.
    if (ramo?.itens) {
      setRamos({ ...ramos, [caminho]: { ...ramo, aberto: true, erro: '' } })
      return
    }

    setRamos({ ...ramos, [caminho]: { itens: null, aberto: true, carregando: true, erro: '' } })
    try {
      const dados = await listarArquivos(caminho)
      setRamos((atual) => ({
        ...atual,
        [caminho]: { itens: dados.itens, aberto: true, carregando: false, erro: '' },
      }))
    } catch (erro) {
      setRamos((atual) => ({
        ...atual,
        [caminho]: { itens: null, aberto: true, carregando: false, erro: fraseDeFalha(erro) },
      }))
    }
  }

  /**
   * Relê o que está à vista depois de a IA mexer em algo.
   *
   * As pastas abertas, porque um arquivo que a IA acabou de criar só aparece na árvore se os
   * filhos forem pedidos de novo. E o arquivo aberto, porque é ele que mostra o verde e o
   * vermelho — e ele mudou debaixo da tela.
   */
  const atualizarAVista = async () => {
    for (const pasta of vivo.current.abertos) {
      try {
        const dados = await listarArquivos(pasta)
        setRamos((atual) => ({
          ...atual,
          [pasta]: { itens: dados.itens, aberto: true, carregando: false, erro: '' },
        }))
      } catch {
        // Pasta que sumiu: fica na tela o que já estava, com o erro que a próxima abertura der.
      }
    }
    const alvo = vivo.current.escolhido
    if (alvo) await abrirArquivo(alvo)
  }

  // O valor do último render para a sondagem. Roda a cada render de propósito: é assim que a
  // ref fica sempre com o que está na tela agora.
  useEffect(() => {
    vivo.current.escolhido = escolhido
    vivo.current.abertos = Object.entries(ramos)
      .filter(([, ramo]) => ramo.aberto)
      .map(([caminho]) => caminho)
  })

  // Trocar de projeto zera a aba: a árvore do projeto anterior não é árvore deste.
  useEffect(() => {
    pedido.current += 1
    pronto.current = false
    assinatura.current = ''
    setRamos({})
    setMarcas({})
    setArquivo(null)
    setEscolhido('')
    setErroArquivo('')
    setLendo(false)
    if (!raiz) return

    let parado = false
    const abrir = async () => {
      // Árvore e marcas em paralelo: são dois pedidos independentes, e um não espera o outro.
      const [arvore, lista] = await Promise.allSettled([listarArquivos(raiz), listarMudancas()])
      if (parado) return
      if (arvore.status === 'fulfilled') {
        setRamos({
          [raiz]: { itens: arvore.value.itens, aberto: true, carregando: false, erro: '' },
        })
      } else {
        setRamos({
          [raiz]: {
            itens: null,
            aberto: true,
            carregando: false,
            erro: fraseDeFalha(arvore.reason),
          },
        })
      }
      if (lista.status === 'fulfilled') {
        assinatura.current = assinaturaDe(lista.value.itens)
        setMarcas(porCaminho(lista.value.itens))
      }
      pronto.current = true
    }
    void abrir()
    return () => {
      parado = true
    }
  }, [raiz])

  /**
   * A sondagem que faz a aba acompanhar a IA.
   *
   * Só age quando a lista de mudanças muda de verdade — `caminho:vezes` por arquivo. Comparar
   * a lista inteira a cada 2,5 s e reler tudo por causa de um campo que ninguém vê (o
   * `quando`) faria a aba ir ao disco sem motivo.
   */
  useEffect(() => {
    if (!raiz) return
    let parado = false

    const passo = async () => {
      if (parado || !pronto.current) return
      try {
        const { itens } = await listarMudancas()
        if (parado) return
        const marca = assinaturaDe(itens)
        if (marca === assinatura.current) return
        assinatura.current = marca
        setMarcas(porCaminho(itens))
        await atualizarAVista()
      } catch {
        // Backend fora do ar: a aba segue mostrando o que já tem, sem apagar nada.
      }
    }

    const id = window.setInterval(() => void passo(), 2500)
    return () => {
      parado = true
      window.clearInterval(id)
    }
  }, [raiz])

  /** Esquece as marcas — o arquivo no disco fica onde está. */
  const esquecer = async () => {
    try {
      await limparMudancas()
    } catch {
      // Não deu: a lista volta na próxima sondagem, e o botão continua ali.
    }
    assinatura.current = ''
    setMarcas({})
    if (escolhido) await abrirArquivo(escolhido)
  }

  if (!raiz) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6">
        <p className="max-w-[38ch] text-center text-[12.5px] leading-relaxed text-koda-fg/40">
          {projeto && !projeto.existe
            ? `A pasta «${projeto.nome}» não está mais no disco. Abra outra para ver o código dela aqui.`
            : 'Nenhum projeto aberto. Abra uma pasta e o código dela aparece aqui: a árvore de um lado, o arquivo do outro.'}
        </p>
      </div>
    )
  }

  const daRaiz = ramos[raiz]
  const mudanca = arquivo?.mudanca ?? null
  const temMarcas = Object.keys(marcas).length > 0

  return (
    <div className="flex min-h-0 flex-1">
      {/*
       * A raiz **não** é uma linha da árvore, é o cabeçalho da coluna: ela fica sempre
       * aberta. Uma pasta de projeto recolhida deixaria a coluna vazia, e um clique que
       * esvazia a tela não serve para nada.
       */}
      <div className="flex min-h-0 w-[236px] shrink-0 flex-col border-r border-koda-fg/10">
        <div className="flex shrink-0 items-center gap-1.5 border-b border-koda-fg/8 px-2.5 py-2">
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-koda-accent/80" strokeWidth={1.8} />
          <span className="truncate text-[12px] font-medium text-koda-fg/85" title={raiz}>
            {projeto?.nome ?? 'projeto'}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
          {!daRaiz ? (
            <p className="px-2 py-1 text-[11.5px] text-koda-fg/40">Lendo a pasta…</p>
          ) : null}
          {daRaiz?.erro ? (
            <p className="px-2 py-1 text-[11.5px] leading-snug text-amber-500">{daRaiz.erro}</p>
          ) : null}
          {daRaiz?.itens?.length === 0 ? (
            <p className="px-2 py-1 text-[11.5px] text-koda-fg/30">Nada de código nesta pasta.</p>
          ) : null}
          {(daRaiz?.itens ?? []).map((item) => (
            <Linha
              key={item.caminho}
              item={item}
              profundidade={0}
              ramos={ramos}
              marcas={marcas}
              escolhido={escolhido}
              onAlternarPasta={(caminho) => void alternarPasta(caminho)}
              onAbrirArquivo={(caminho) => void abrirArquivo(caminho)}
            />
          ))}
        </div>

        {/* O que ficou de fora, dito na tela: esconder pasta sem avisar faria o dono
            procurar o que não está lá. */}
        <div className="flex shrink-0 items-center gap-2 border-t border-koda-fg/8 px-2.5 py-1.5">
          <p className="min-w-0 flex-1 text-[10.5px] leading-snug text-koda-fg/30">
            node_modules, target e pastas que começam com «.» ficam de fora.
          </p>
          {temMarcas ? (
            <button
              type="button"
              onClick={() => void esquecer()}
              title="Esquece as marcas de alteração. Os arquivos no disco não são tocados."
              className="shrink-0 rounded px-1.5 py-0.5 text-[10.5px] text-koda-fg/45 transition-colors duration-100 hover:bg-koda-fg/10 hover:text-koda-fg focus-visible:ring-1 focus-visible:ring-koda-accent focus-visible:outline-none"
            >
              limpar marcas
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {arquivo ? (
          <>
            <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-koda-fg/8 px-3 py-2">
              <span className="text-[12.5px] font-medium text-koda-fg">{arquivo.nome}</span>
              <span className="text-[10.5px] text-koda-fg/40">
                {arquivo.linhas.toLocaleString('pt-BR')} linha
                {arquivo.linhas === 1 ? '' : 's'}
              </span>
              <span className="text-[10.5px] text-koda-fg/30">
                {tamanhoLegivel(arquivo.tamanho)}
              </span>
              {mudanca ? (
                <>
                  <span className="rounded bg-koda-accent/15 px-1.5 py-0.5 text-[10.5px] text-koda-accent">
                    {mudanca.criado ? 'criado pela IA' : 'alterado pela IA'}
                  </span>
                  <Contagem mais={mudanca.mais} menos={mudanca.menos} />
                </>
              ) : null}
              {arquivo.truncado ? (
                <span className="rounded bg-amber-400/20 px-1.5 py-0.5 text-[10.5px] text-amber-600">
                  cortado no fim
                </span>
              ) : null}
            </div>

            {mudanca?.linhas ? (
              <CodigoComDiff linhas={mudanca.linhas} />
            ) : (
              <>
                {mudanca ? (
                  <p className="shrink-0 border-b border-koda-fg/8 bg-amber-400/10 px-3 py-1.5 text-[10.5px] leading-snug text-amber-600">
                    A IA mexeu neste arquivo, mas ele é grande demais para o diff linha a linha —
                    o código abaixo é o de agora, sem as marcas.
                  </p>
                ) : null}
                <CodigoSimples texto={arquivo.texto} />
              </>
            )}
          </>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center px-6">
            <p className="max-w-[34ch] text-center text-[12.5px] leading-relaxed text-koda-fg/40">
              {lendo
                ? 'Lendo o arquivo…'
                : erroArquivo || 'Clique num arquivo da lista para ver o código dele aqui.'}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

export default AbaCodigo
