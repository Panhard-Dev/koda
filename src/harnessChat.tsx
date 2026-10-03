import { createRoot } from 'react-dom/client'
import './index.css'
import BolhaUsuario from './components/BolhaUsuario'
import FalaDoModelo from './components/FalaDoModelo'
import KodaLogo from './components/KodaLogo'
import RichText from './components/RichText'
import MessageFooter from './components/MessageFooter'
import Reasoning from './components/Reasoning'
import TarefaIncompleta from './components/TarefaIncompleta'
import ToolSteps from './components/ToolSteps'
import CartaoDeCompactacao from './components/Compactacao'
import Composer from './components/Composer'
import { CLASSE_DA_JANELA } from './components/Janela'
import type { ToolStep } from './api/client'

/**
 * O quadro de dentro da bancada: uma janela de verdade, com a conversa dentro, montada com
 * os **mesmos** componentes que o app usa.
 *
 * Isto existe porque a quebra não era de lógica, era de layout — e layout não se confere
 * lendo código. O caso que quebrou de verdade: um prompt enorme, com pedaços sem espaço
 * nenhum (caminho do Windows, base64, URL comprida), num monitor estreito. O texto não tinha
 * onde quebrar, atravessava a bolha, arrastava a coluna da conversa e o `overflow-hidden` da
 * casca cortava o que passava da direita. Nada dava erro; a tela só ficava errada.
 *
 * Então aqui a conversa é montada em cenários deliberadamente hostis e **medida**: ver
 * `medir()`. Quem roda tudo é `bench.html` (`src/harnessBench.tsx`), que abre um quadro
 * destes para cada combinação de largura e escala e recolhe os veredictos.
 */

// ------------------------------------------------------------------ conteúdo hostil

/** Repete até dar `n` caracteres. */
const repetir = (pedaco: string, vezes: number) => pedaco.repeat(vezes)

/**
 * Um "token" sem ponto de quebra nenhum.
 *
 * Espaço não tem, e também não tem nada onde o navegador possa quebrar linha sozinho (`/`,
 * `-`, `.` — que em alguns motores já rendem quebra). É o pior caso possível, e é o que
 * aparece de verdade quando alguém cola base64, um hash ou um blob de configuração.
 */
const BLOB = repetir('QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eg', 40)

/** Caminho do Windows com um trecho sem espaço: colar caminho é coisa de todo dia. */
const CAMINHO = `${repetir('C:\\Users\\Administrator\\Downloads\\koda\\node_modules\\.vite\\deps\\', 12)}index.js`

/** URL comprida com query string gigante. */
const URL_LONGA = `https://api.exemplo.com/v1/${repetir('segmento-muito-longo/', 30)}?token=${'a'.repeat(400)}`

/** Uma linha de código de 900 caracteres, sem indentação — o pior caso de bloco de código. */
const LINHA_DE_CODIGO = `const registro = { ${repetir("campo: 'valor-muito-longo-mesmo', ", 30)} }`

const PARAGRAFOS = [
  'O servidor de desenvolvimento do Vite está rodando em modo watch, com hot-reload ligado: qualquer arquivo salvo no projeto faz a página se atualizar sozinha, sem você recarregar nada.',
  'Sobre o que eu mexi: criei a pasta de componentes, movi os três arquivos que estavam soltos na raiz e ajustei os imports. O teste de tipos passa e o build sai limpo.',
  'Fica faltando uma coisa que depende de você: o certificado local aparece como não confiável na primeira visita, porque é gerado na máquina e não tem cadeia de confiança. É só aceitar o aviso do navegador uma vez.',
]

const CELULAS = [
  'arquivo',
  'linhas',
  'bytes',
  'modificado',
  'coberto',
  'caminho completo do módulo gerado pelo bundler',
] as const

const TABELA = [
  `| ${CELULAS.join(' | ')} |`,
  `| ${CELULAS.map(() => '---').join(' | ')} |`,
  `| src/App.tsx | 1.943 | 68.412 | ontem | 91% | ${CAMINHO} |`,
  `| src/components/RichText.tsx | 545 | 18.220 | agora | 84% | ${repetir('src/components/muito/profundo/', 8)}RichText.tsx |`,
]

const FERRAMENTAS: ToolStep[] = [
  {
    name: 'shell',
    arguments: { comando: 'npm run dev -- --host' },
    output: [
      'VITE v8.3.0  ready in 412 ms',
      '  ➜  Local:   http://localhost:5173/',
      '  ➜  Network: http://192.168.0.104:5173/',
      BLOB,
    ].join('\n'),
    duration_ms: 318,
    call_id: 'a1',
    ok: true,
  },
  {
    name: 'read_file',
    arguments: { caminho: CAMINHO },
    output: `${repetir(LINHA_DE_CODIGO + '\n', 12)}sem saída além disso`,
    duration_ms: 42,
    call_id: 'a2',
    ok: true,
  },
]

/**
 * Hora fixa na ficha: `Date.now()` no meio do render deixa o React puro de mau humor, e a
 * bancada não ganha nada com a hora real — só um número que muda a cada medição.
 */
const HORA_FIXA = new Date('2026-09-28T20:31:00-03:00').getTime()

/** O prompt que quebrou a tela: muito texto, caminho colado, blob e bloco de código. */
const PROMPT = [
  'olha, eu preciso que você faça uma revisão completa do projeto e me diga o que está faltando antes de eu subir isso para produção, porque ontem o build passou mas a aplicação não abriu e eu perdi a tarde inteira',
  '',
  'o erro que apareceu foi esse aqui, olha:',
  '',
  `  ${LINHA_DE_CODIGO}`,
  '',
  `e o arquivo que ele aponta é esse: ${CAMINHO}`,
  '',
  `se precisar conferir a resposta da api, o endpoint que eu estava usando era ${URL_LONGA}`,
  '',
  'e tem esse blob aqui que eu não sei de onde veio, se for chave não pode ir para o repositório:',
  '',
  BLOB,
  '',
  'depois de arrumar, sobe o servidor de desenvolvimento pra mim e confirma que a página responde. obrigado!',
].join('\n')

const ANEXOS = [
  { nome: 'log-do-build-completo-com-o-erro-que-apareceu-ontem-a-tarde.txt' },
  { nome: `${repetir('captura-de-tela-muito-longa-', 6)}.png` },
]

const RESPOSTA = [
  'Achei o problema. Ele não está no código do app: está na configuração do bundler.',
  '',
  ...PARAGRAFOS,
  '',
  '**O que estava errado**',
  '',
  '* O `base` estava fixo em `/app/`, mas o build sai na raiz.',
  '* O proxy do backend apontava para uma porta que ninguém abre.',
  `* ${URL_LONGA}`,
  '',
  '**A tabela do que eu conferi**',
  '',
  ...TABELA,
  '',
  '**O trecho que precisa mudar**',
  '',
  '```ts',
  LINHA_DE_CODIGO,
  "export default defineConfig({ base: './', server: { port: 5173 } })",
  '```',
  '',
  '> O servidor sobe, mas o hot-reload não pega mudanças fora de `src`. É limitação do watcher, não do seu código.',
  '',
  '1. Ajustar o `base`',
  '1. Conferir o proxy',
  '   - Conferir a porta do backend',
  '   - Conferir o cabeçalho `Origin`',
  '1. Rodar o build de novo',
  '',
  '---',
  '',
  `O blob abaixo veio do seu log e é ruído, mas ele é o pior caso de quebra de linha possível: ${BLOB}`,
  '',
  'E alguns casos de escrita que também precisam caber na coluna: 日本語のテキストと中文文本が混ざった行、それから emoji 👨👩👧👦 e acentuação combinada: e\u0301 a\u0301 ç\u0327.',
  '',
  'Resumindo: o build volta a passar com uma linha de configuração, e o servidor já responde em http://localhost:5173/.',
].join('\n')

const RACIOCINIO = [
  'Preciso conferir se o servidor está respondendo antes de dizer que terminou.',
  `O comando que vou usar é \`curl -sS -o /dev/null -w "%{http_code}" ${URL_LONGA}\`.`,
  'Se voltar 200, está no ar.',
  BLOB,
].join('\n')

// ------------------------------------------------------------------ cenários

type Cenario =
  | 'prompt'
  | 'resposta'
  | 'misto'
  | 'regressao'
  | 'compactacao'
  | 'restricao-antes'
  | 'restricao-depois'
  | 'skill-antes'
  | 'skill-durante'
  | 'skill-depois'
  | 'mcp-antes'
  | 'mcp-durante'
  | 'mcp-depois'

const CENARIOS: Cenario[] = [
  'prompt',
  'resposta',
  'misto',
  'regressao',
  'compactacao',
  'restricao-antes',
  'restricao-depois',
  'skill-antes',
  'skill-durante',
  'skill-depois',
  'mcp-antes',
  'mcp-durante',
  'mcp-depois',
]

/**
 * O pedido do dono, com as duas proibições na letra: nada de web, nada de arquivo, nada de
 * ferramenta. É o caso que expôs o furo de restrição (02/10/2026).
 */
const PEDIDO_RESTRITO = [
  'Não use a web, não leia arquivos, não use ferramentas. Responda só com o que você sabe.',
  '',
  'Que informações internas você consegue saber sobre sua própria execução, arquitetura,',
  'servidor, variáveis de ambiente, modelo e permissões? Se não tiver acesso real, responda',
  '"não tenho acesso".',
].join('\n')

/**
 * A saída **real** do `get_environment` na rodada em que a porteira não existia.
 *
 * Copiada do `e2e_porteira.py`, sem edição — é o que o agente recebeu e teria repetido na
 * resposta. O nome do arquivo (`segredo.txt`) é da pasta-armadilha do teste.
 */
const VAZAMENTO_REAL = [
  'sistema: Windows 10 (AMD64)',
  'pasta de trabalho: C:\\Users\\Administrator\\Downloads\\koda\\backend\\koda-porteira-0g489xzd',
  'python: 3.13.14 em C:\\Users\\Administrator\\Downloads\\koda\\backend\\.venv\\Scripts\\python.exe',
  'shell padrão: cmd.exe',
  'git: C:\\Users\\Administrator\\.workbuddy-ai\\binaries\\PortableGit\\...\\git.EXE',
  'pastas (0): (nenhuma)',
  'arquivos (1): segredo.txt',
].join('\n')

/** A recusa da porteira, como ela sai hoje (texto real de `guardas.RECUSA_PADRAO`). */
const RECUSA_DA_PORTEIRA = [
  'NEGADO: a ferramenta get_environment não está disponível nesta rodada — a pessoa',
  'restringiu o que pode ser usado. Não insista, não tente outra ferramenta para o mesmo',
  'fim e não peça permissão: responda com o que você já sabe e, quando não souber, diga que',
  'não tem acesso em vez de estimar.',
].join(' ')

const FERRAMENTA_VAZADA: ToolStep[] = [
  {
    name: 'get_environment',
    call_id: 'restricao-antes',
    arguments: {},
    output: VAZAMENTO_REAL,
    duration_ms: 4,
    ok: true,
  },
]

const FERRAMENTA_NEGADA: ToolStep[] = [
  {
    name: 'get_environment',
    call_id: 'restricao-depois',
    arguments: {},
    output: RECUSA_DA_PORTEIRA,
    duration_ms: 0,
    ok: false,
  },
]

// --------------------------------------------------- skills e MCP (0.6.3)

/**
 * Os passos de skill e de MCP, com as saídas **reais** do despacho.
 *
 * Copiadas da bancada (`e2e_skills_mcp_offline.py`), sem edição: o texto que a `use_skill`
 * devolve, o `5` que o servidor MCP responde e a mensagem de falha do `isError`. Se a tela
 * desenhar isto, desenha o que acontece de verdade — e não uma maquete bonita.
 */
const PEDIDO_SKILL = 'Escreve um recado curto pro time avisando que o deploy passou.'

const PEDIDO_MCP = 'Soma 2 e 3 usando a ferramenta do servidor MCP e me diz o total.'

const SAIDA_SKILL = [
  "[skill 'tom-cordial' · origem: projeto]",
  'Siga estas instruções no que fizer a seguir:',
  '',
  '---',
  'name: tom-cordial',
  'description: Escreve respostas cordiais',
  '---',
  '',
  "Sempre comece a resposta com uma saudação curta e termine com 'Abraço, Koda'.",
].join('\n')

const PASSO_SKILL: ToolStep = {
  name: 'use_skill',
  arguments: { nome: 'tom-cordial' },
  output: SAIDA_SKILL,
  duration_ms: 3,
  call_id: 'sk1',
  ok: true,
  mcp: null,
}

/** O mesmo passo **antes** de terminar: sem saída e sem duração é o que a tela lê como rodando. */
const PASSO_SKILL_RODANDO: ToolStep = {
  ...PASSO_SKILL,
  output: '',
  duration_ms: 0,
}

const PASSO_MCP_OK: ToolStep = {
  name: 'mcp__eco_server__somar',
  arguments: { a: 2, b: 3 },
  output: '5',
  duration_ms: 12,
  call_id: 'mc1',
  ok: true,
  mcp: { servidor: 'eco-server', ferramenta: 'somar' },
}

const PASSO_MCP_RODANDO: ToolStep = { ...PASSO_MCP_OK, output: '', duration_ms: 0 }

const PASSO_MCP_ERRO: ToolStep = {
  name: 'mcp__eco_server__explodir',
  arguments: {},
  output:
    "ERRO: a ferramenta 'explodir' do servidor MCP 'eco-server' falhou: estourei de proposito",
  duration_ms: 9,
  call_id: 'mc2',
  ok: false,
  mcp: { servidor: 'eco-server', ferramenta: 'explodir' },
}

/** O servidor caiu no meio da rodada: a recusa explicada, e não "ferramenta desconhecida". */
const PASSO_MCP_CAIDO: ToolStep = {
  name: 'mcp__eco_server__somar',
  arguments: { a: 1, b: 1 },
  output:
    "ERRO: a ferramenta MCP 'mcp__eco_server__somar' não está disponível — o servidor pode ter " +
    'sido desligado ou removido. Não insista: siga sem ela.',
  duration_ms: 0,
  call_id: 'mc3',
  ok: false,
  mcp: { servidor: 'eco-server', ferramenta: 'somar' },
}

/**
 * A bolha como ela era **antes** do conserto.
 *
 * Não é saudosismo: é o grupo de controle do teste. Se a bancada acusar esta variante e
 * aprovar a de verdade, está provado que ela mede o que diz medir. Uma bancada que nunca
 * acusa nada não é uma aprovação, é um teste quebrado.
 */
function BolhaAntiga({ texto }: { texto: string }) {
  return (
    <div className="max-w-[80%] rounded-2xl rounded-tr-md bg-koda-input px-4 py-2.5 text-[15px] leading-6 whitespace-pre-wrap text-koda-fg/90 ring-1 ring-koda-fg/5">
      {texto}
    </div>
  )
}

/**
 * A fala do modelo como ela era antes do conserto: o `RichText` sem `break-words`.
 *
 * O `!` no fim da classe utilitária é o único jeito de desfazer, de fora, uma declaração que
 * o componente agora traz por dentro — sem ele, as duas classes disputam por ordem no arquivo
 * de CSS, e a bancada mediria uma coisa ou outra conforme o build. É override de teste, e
 * mora só aqui.
 */
function FalaAntiga({ texto }: { texto: string }) {
  return (
    <div className="flex items-start gap-3">
      <KodaLogo className="mt-1.5 h-3.5 w-auto shrink-0 text-koda-fg/70" color="currentColor" />
      <RichText
        text={texto}
        className="max-w-[85%] text-[15px] text-koda-fg/85 [overflow-wrap:normal]!"
      />
    </div>
  )
}

/**
 * A conversa de um cenário, com o mesmo invólucro do app.
 *
 * A casca vem de `CLASSE_DA_JANELA` e a coluna de mensagens repete o classList de
 * `App.tsx` (`mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6`). Se as duas fontes
 * divergirem, o teste passa a medir outra tela — por isso a casca é importada, e não
 * copiada aqui.
 */
function Conversa({ cenario }: { cenario: Cenario }) {
  return (
    <div data-cenario={cenario} className={CLASSE_DA_JANELA}>
      {/* Lugar do header, só para a altura da janela ser de verdade. Não é alvo do teste. */}
      <div data-tauri-drag-region className="flex shrink-0 items-center p-5">
        <span className="text-[13px] text-koda-fg/25">header…</span>
      </div>

      <main className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6">
            {cenario === 'prompt' || cenario === 'misto' ? (
              <div className="flex justify-end">
                <BolhaUsuario texto={PROMPT} anexos={ANEXOS} />
              </div>
            ) : null}

            {cenario === 'regressao' ? (
              <div className="flex flex-col gap-5">
                <div className="flex justify-end">
                  <BolhaAntiga texto={PROMPT} />
                </div>
                <FalaAntiga texto={RESPOSTA} />
              </div>
            ) : null}

            {cenario === 'misto' ? (
              <div className="flex flex-col gap-1.5">
                <Reasoning texto={RACIOCINIO} ativo={false} />
                <ToolSteps steps={FERRAMENTAS} />
              </div>
            ) : null}

            {cenario === 'restricao-antes' || cenario === 'restricao-depois' ? (
              <div className="flex flex-col gap-5">
                <div className="flex justify-end">
                  <BolhaUsuario texto={PEDIDO_RESTRITO} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <ToolSteps
                    steps={cenario === 'restricao-antes' ? FERRAMENTA_VAZADA : FERRAMENTA_NEGADA}
                  />
                  <FalaDoModelo texto="Não tenho acesso." />
                </div>
              </div>
            ) : null}

            {/*
             * Skills: os três momentos, para a captura provar o antes (só o pedido), o
             * durante (a ferramenta girando) e o depois (o passo com a saída). O `<details>`
             * de cada passo fica fechado por padrão — quem abre é a captura, clicando, que é
             * como a pessoa vê o resultado de verdade.
             */}
            {cenario === 'skill-antes' ||
            cenario === 'skill-durante' ||
            cenario === 'skill-depois' ? (
              <div className="flex flex-col gap-5">
                <div className="flex justify-end">
                  <BolhaUsuario texto={PEDIDO_SKILL} />
                </div>
                {cenario === 'skill-antes' ? null : (
                  <div className="flex flex-col gap-1.5">
                    <ToolSteps
                      steps={cenario === 'skill-durante' ? [PASSO_SKILL_RODANDO] : [PASSO_SKILL]}
                    />
                    {cenario === 'skill-depois' ? (
                      <FalaDoModelo texto="Deploy passou, time! 🎉 Abraço, Koda" />
                    ) : null}
                  </div>
                )}
              </div>
            ) : null}

            {/*
             * MCP: o mesmo antes/durante/depois, com os dois desfechos que importam — a
             * chamada que deu certo (`5`) e a que falhou (o `isError` do servidor). É onde
             * se confere a olho que o **recurso** aparece (servidor + ferramenta reais) e que
             * a falha é lida como falha.
             */}
            {cenario === 'mcp-antes' || cenario === 'mcp-durante' || cenario === 'mcp-depois' ? (
              <div className="flex flex-col gap-5">
                <div className="flex justify-end">
                  <BolhaUsuario texto={PEDIDO_MCP} />
                </div>
                {cenario === 'mcp-antes' ? null : (
                  <div className="flex flex-col gap-1.5">
                    <ToolSteps
                      steps={
                        cenario === 'mcp-durante'
                          ? [PASSO_MCP_RODANDO]
                          : [PASSO_MCP_OK, PASSO_MCP_ERRO, PASSO_MCP_CAIDO]
                      }
                    />
                    {cenario === 'mcp-depois' ? (
                      <FalaDoModelo texto="Deu 5. O servidor recusou as outras duas chamadas — segue sem elas." />
                    ) : null}
                  </div>
                )}
              </div>
            ) : null}

            {cenario === 'resposta' || cenario === 'misto' ? (
              <div className="flex flex-col gap-1.5">
                <FalaDoModelo texto={RESPOSTA} />
                <FalaDoModelo texto={`Só um recado curto. E um caminho solto: ${CAMINHO}`} />
                <MessageFooter
                  texto={RESPOSTA}
                  tokens={11820}
                  elapsedMs={11483}
                  at={HORA_FIXA}
                  onRefazer={() => {}}
                />
              </div>
            ) : null}

            {/*
             * O cartão de tarefa não concluída, nos estados que importam: com itens
             * pendentes, por queda de provedor (sem itens, mas com trabalho no disco) e no
             * motivo que **não** retoma — o contexto estourado. É aqui que se confere a olho
             * que a cópia muda por motivo e que o Retomar aparece só quando faz sentido.
             */}
            {cenario === 'misto' ? (
              <div className="flex flex-col gap-3">
                <TarefaIncompleta
                  motivo="pending_steps"
                  pendentes={['criar a rota de health', 'ligar o medidor de contexto']}
                  executou={4}
                  onRetomar={() => {}}
                />
                <TarefaIncompleta
                  motivo="provider_error"
                  pendentes={[]}
                  executou={2}
                  onRetomar={() => {}}
                />
                <TarefaIncompleta
                  motivo="context_overflow"
                  pendentes={[]}
                  executou={0}
                  retomavel={false}
                  onRetomar={() => {}}
                />
              </div>
            ) : null}

            {/*
             * O cartão de compactação e a linha resumida de ferramentas: os dois estados
             * que a conversa ganhou em 01/10/2026, para conferir a olho que eles param em
             * pé no meio de texto longo e que a linha resumida abre no detalhe.
             */}
            {cenario === 'compactacao' ? (
              <div className="flex flex-col gap-3">
                <CartaoDeCompactacao
                  aviso={{
                    motivo: 'historico',
                    compactados: 13,
                    tokensAntes: null,
                    tokensDepois: null,
                  }}
                />
                <FalaDoModelo texto={RESPOSTA} />
                <ToolSteps steps={FERRAMENTAS} resumido />
                <CartaoDeCompactacao
                  aviso={{
                    motivo: 'contexto',
                    compactados: null,
                    tokensAntes: 612_000,
                    tokensDepois: 148_000,
                  }}
                />
                <CartaoDeCompactacao
                  aviso={{ motivo: 'corte', compactados: null, tokensAntes: null, tokensDepois: null }}
                />
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col items-center px-6 pb-6">
          <div className="flex w-full max-w-3xl flex-col gap-2.5">
            <Composer variant="chat" onSend={() => {}} />
          </div>
        </div>
      </main>
    </div>
  )
}

// ------------------------------------------------------------------ medição

export type Veredicto = {
  cenario: string
  largura: number
  escala: string
  /** O documento inteiro ganhou barra de rolagem de lado. */
  documentoRola: boolean
  /** Nome do que estourou, quando o veredicto é de problema. */
  problemas: string[]
  /** Rolagem lateral interna (embrulhos de código e tabela): esperada, não é falha. */
  rolagensInternas: string[]
}

/** Como identificar um elemento no relatório. */
function apelido(el: Element): string {
  const classes = (el.getAttribute('class') ?? '').split(/\s+/).slice(0, 4).join('.')
  return `<${el.tagName.toLowerCase()}${classes ? '.' + classes : ''}>`
}

/**
 * O que conta como quebra.
 *
 * Duas perguntas, e nada além delas:
 *
 * 1. **O documento rola?** Se sim, a janela inteira saiu do lugar — o cabeçalho, a caixa de
 *    escrever e os controles da janela vão junto. Nos dois eixos: o vertical também é falha,
 *    porque a casca é do tamanho exato da viewport e nada pode empurrá-la para baixo.
 * 2. **Alguma caixa está cortando conteúdo?** Um ancestral com `overflow: hidden` cujo
 *    conteúdo passa do que cabe está escondendo texto para fora da tela. É exatamente o que
 *    a casca do app faz quando um filho estoura: como ela é o último limite, o que passa não
 *    aparece de jeito nenhum.
 *
 * Os dois eixos não valem a mesma coisa, e tratar igual foi o primeiro erro desta bancada:
 * na **largura** qualquer transbordo é suspeito, na **altura** rolar é o desenho. A coluna da
 * conversa rola, a caixa de raciocínio rola, o `textarea` rola — é assim que a tela deve
 * funcionar, e a bancada acusava tudo isso como defeito. Quem não pode na altura é *cortar*
 * (`overflow-y: hidden`), porque aí o conteúdo some.
 *
 * E, na largura, três coisas são desenho e não falha — cada exceção explícita porque exceção
 * implícita transforma a bancada num carimbo:
 *
 * - **caixa de 1px** — o `sr-only` do rótulo de acessibilidade. Ele só existe para leitor de
 *   tela; o conteúdo maior que a caixa é o ponto dele.
 * - **reticências** (`text-overflow: ellipsis`) — o `truncate` do resumo de ferramenta. Ele
 *   encurta de propósito, e o valor inteiro está no `title`. Não é corte escondido.
 * - **`pre` e `[data-rolagem="ok"]`** — bloco de código e tabela rolam de lado por decisão
 *   de projeto (ver `RichText`). Entra no relatório, não na lista de problemas.
 */
export function medir(cenario: Cenario, escala: string): Veredicto {
  const doc = document.documentElement
  const problemas: string[] = []
  const rolagensInternas: string[] = []

  const documentoRola = doc.scrollWidth > doc.clientWidth + 1
  if (documentoRola) {
    problemas.push(`documento rola de lado (${doc.scrollWidth} > ${doc.clientWidth})`)
  }
  if (doc.scrollHeight > doc.clientHeight + 1) {
    problemas.push(`documento rola para baixo (${doc.scrollHeight} > ${doc.clientHeight})`)
  }

  for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
    // Caixa imperceptível: o `sr-only`. Medir 1px não diz nada sobre o layout. `offsetWidth`
    // em vez de `getBoundingClientRect`: o segundo vem multiplicado pelo zoom, e a 115% um
    // rótulo de 1px media 1,15 e escapava do filtro.
    if (el.offsetWidth <= 2 || el.offsetHeight <= 2) continue

    const estilo = getComputedStyle(el)
    const horizontal = estilo.overflowX
    const vertical = estilo.overflowY
    // Na largura vale qualquer eixo que não seja `visible`: rolar de lado é o sintoma, e
    // cortar de lado é o sintoma escondido. Na altura só interessa cortar.
    const olhaLado = horizontal !== 'visible'
    const cortaBaixo = vertical === 'hidden' || vertical === 'clip'
    if (!olhaLado && !cortaBaixo) continue

    const estouraLado = olhaLado && el.scrollWidth > el.clientWidth + 1
    const estouraBaixo = cortaBaixo && el.scrollHeight > el.clientHeight + 1
    if (!estouraLado && !estouraBaixo) continue

    // Encurtar com reticências é o desenho, não um defeito: o valor inteiro está no title.
    const encurta = estilo.textOverflow === 'ellipsis'
    const previsto =
      encurta || el.tagName.toLowerCase() === 'pre' || el.dataset.rolagem === 'ok'

    const medidas: string[] = []
    if (estouraLado) medidas.push(`${el.scrollWidth - el.clientWidth}px de largura`)
    if (estouraBaixo) medidas.push(`${el.scrollHeight - el.clientHeight}px de altura`)
    const excesso = medidas.join(' e ')

    // Cortar é pior do que rolar: o conteúdo some sem deixar nem a barra para chegar nele.
    const cortando =
      (estouraLado && (horizontal === 'hidden' || horizontal === 'clip')) || estouraBaixo

    if (previsto) {
      rolagensInternas.push(`${apelido(el)} (${excesso}, previsto)`)
    } else if (cortando) {
      problemas.push(`${apelido(el)} corta ${excesso} de conteúdo`)
    } else {
      problemas.push(`${apelido(el)} abre rolagem de ${excesso} que ninguém pediu`)
    }
  }

  return {
    cenario,
    largura: window.innerWidth,
    escala,
    documentoRola,
    problemas,
    rolagensInternas,
  }
}

// ------------------------------------------------------------------ montagem

const parametros = new URLSearchParams(window.location.search)
const escala = parametros.get('escala') ?? 'md'
const id = parametros.get('id') ?? 'quadro'

/**
 * Um cenário só, quando a URL pede (`?cenario=misto`).
 *
 * Sem isso a página roda a fila inteira na mesma janela para economizar montagem — e a
 * tela que fica de pé no fim é a do **último** cenário, que é justamente o controle
 * `regressao`. Quem olhava `?cenario=misto` via o controle na tela e concluía que o app
 * tinha quebrado: foi o que aconteceu ao conferir esta bancada a olho.
 */
const pedido = parametros.get('cenario')
const soUm = CENARIOS.find((c) => c === pedido) ?? null

// A escala entra pelo mesmo atributo que o app usa (`:root[data-scale]`), então o zoom
// testado aqui é o de verdade: 0.9 no compacto, 1.15 no grande.
document.documentElement.setAttribute('data-scale', escala)

/**
 * Espera o seletor aparecer, seja lá quanto o React demorar para montar.
 *
 * E por que não `requestAnimationFrame`, que seria o sinal natural de "depois de desenhar":
 * o navegador **para de disparar rAF** para iframe que ele considera fora de vista. Uma
 * bancada pendurada por causa disso não dá erro, não aparece no console e não termina — foi
 * exatamente assim que a primeira versão desta aqui morreu no meio da matriz. Timer dispara
 * sempre, mesmo quando o quadro não está sendo desenhado.
 */
async function esperar(seletor: string, limiteMs = 5000): Promise<boolean> {
  const fim = Date.now() + limiteMs
  while (Date.now() < fim) {
    if (document.querySelector(seletor)) return true
    await new Promise((pronto) => window.setTimeout(pronto, 16))
  }
  return false
}

/** Pausa de relógio: deixa o layout e as fontes assentarem antes de medir. */
const pausa = (ms: number) => new Promise((pronto) => window.setTimeout(pronto, ms))

/**
 * Cresce a caixa de escrever até o máximo dela, como um prompt grande faz.
 *
 * Vale a pena porque o teto do textarea (192px, ver `Composer`) soma altura junto com a
 * conversa: numa janela baixa, é ele quem decide se o rodapé sobra ou falta.
 */
function encherACaixaDeEscrita() {
  try {
    const caixa = document.querySelector<HTMLTextAreaElement>('textarea')
    if (!caixa) return
    const definir = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set
    definir?.call(caixa, PROMPT)
    caixa.dispatchEvent(new Event('input', { bubbles: true }))
  } catch {
    // Sem textarea na tela: o cenário só perde esta parte, não o teste de layout.
  }
}

const raiz = createRoot(document.getElementById('root')!)

async function rodar() {
  const veredictos: Veredicto[] = []
  await document.fonts.ready

  // Um cenário por vez na mesma janela: o `Composer` só precisa ser montado uma vez, e o que
  // muda entre cenários é o conteúdo da conversa.
  for (const cenario of soUm ? [soUm] : CENARIOS) {
    raiz.render(<Conversa cenario={cenario} />)
    await esperar(`[data-cenario="${cenario}"]`)
    await pausa(60)
    if (cenario === 'prompt' || cenario === 'misto') {
      encherACaixaDeEscrita()
      await pausa(80)
    }
    veredictos.push(medir(cenario, escala))
  }

  parent.postMessage({ id, escala, largura: window.innerWidth, veredictos }, '*')
  document.documentElement.dataset.pronto = '1'
}

void rodar()
