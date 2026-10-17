/**
 * A galeria dos blocos visuais — tudo que o Koda desenha, em conversas de verdade.
 *
 * ## Por que galeria, e não vitrine
 *
 * Uma vitrine mostra uma peça bonita por tipo e não deixa mexer. Aqui cada cartão é uma
 * conversa: a pessoa pergunta, o Koda responde com o bloco — pelo **mesmo caminho da
 * conversa** (`BolhaUsuario` e `FalaDoModelo`, que é o `RichText` de sempre), não por um
 * atalho. Se o desenho sai torto aqui, sai torto lá, e é isso que se quer descobrir.
 *
 * ## Muitas variações do mesmo tipo
 *
 * O ponto não é listar 20 nomes: é mostrar o **mesmo** bloco em situações diferentes —
 * barra fina com onze categorias, barra gorda com quatro, deitada com nome comprido.
 * É a resposta a "e se eu quiser X?" sem precisar editar JSON nenhum.
 *
 * ## O botão `ver json`
 *
 * Mostra o bloco exato que a IA escreveria — crases e linguagem `koda-*` incluídas — e o
 * `copiar` entrega isso pronto para colar num pedido de verdade. O que se vê no cartão é
 * o que a conversa desenharia com aquele texto.
 *
 * ## Tudo é interativo de verdade
 *
 * Balão no mouse, destaque no clique, `Esc` limpa — a mecânica é a mesma dos blocos no
 * chat (`BlocosInteracao`). O quiz vai além: guarda a resposta e marca certo e errado.
 */

import { Fragment, useState } from 'react'
import { createRoot } from 'react-dom/client'

import BolhaUsuario from './components/BolhaUsuario'
import FalaDoModelo from './components/FalaDoModelo'
import './index.css'

/** O bloco exatamente como a IA escreveria — é o que o cartão desenha e o JSON mostra. */
const bloco = (linguagem: string, json: string) => '```' + linguagem + '\n' + json + '\n```'

type Exemplo = {
  /** O nome do desenho, no canto do cartão. */
  nome: string
  /** O que a pessoa escreveu. */
  pergunta: string
  /** O que o modelo respondeu, sem o bloco. */
  fala: string
  /** O bloco, cru, com as crases. */
  bloco: string
  /** Ocupa as duas colunas — para os desenhos grandes. */
  largo?: boolean
}

type Secao = { id: string; titulo: string; texto: string; exemplos: Exemplo[] }

const SECOES: Secao[] = [
  {
    id: 'comparar',
    titulo: 'Comparar',
    texto:
      'barras em toda forma: fina quando tem muita categoria, gorda quando tem pouca, deitada quando o nome é comprido — e empilhada quando tem duas histórias na mesma barra.',
    exemplos: [
      {
        nome: 'barras · fina',
        pergunta: 'quantos arquivos tem em cada pasta do koda?',
        fala:
          'Contei agora. Quando tem muita categoria a barra fica fina — passa o mouse em cada uma pra ver o número exato.',
        bloco: bloco(
          'koda-grafico',
          `{
  "tipo": "barras",
  "titulo": "Arquivos por pasta",
  "legenda": "passe o mouse em cada barra",
  "dados": [
    { "rotulo": "backend", "valor": 81 },
    { "rotulo": "src", "valor": 68 },
    { "rotulo": "scripts", "valor": 15 },
    { "rotulo": "dist", "valor": 12 },
    { "rotulo": "data", "valor": 12 },
    { "rotulo": "mcp", "valor": 10 },
    { "rotulo": "skills", "valor": 5 },
    { "rotulo": "host", "valor": 4 },
    { "rotulo": "public", "valor": 3 },
    { "rotulo": "assets", "valor": 1 },
    { "rotulo": "imagens", "valor": 1 }
  ]
}`,
        ),
      },
      {
        nome: 'barras · gorda',
        pergunta: 'como eu divido meu tempo entre os projetos?',
        fala:
          'Pouca categoria, barra gorda: o número vem grande em cima. Clica numa pra destacar — o resto apaga sozinho.',
        bloco: bloco(
          'koda-grafico',
          `{
  "tipo": "barras",
  "titulo": "Onde vai o meu tempo",
  "dados": [
    { "rotulo": "koda", "valor": 62 },
    { "rotulo": "zyro", "valor": 18 },
    { "rotulo": "tools", "valor": 12 },
    { "rotulo": "outros", "valor": 8 }
  ]
}`,
        ),
      },
      {
        nome: 'barras · deitada',
        pergunta: 'qual etapa do build demora mais?',
        fala:
          'Deitada quando o nome é comprido: a etiqueta fica do lado esquerdo, inteira, sem encurtar.',
        bloco: bloco(
          'koda-grafico',
          `{
  "tipo": "barras",
  "horizontal": true,
  "titulo": "Tempo de build por etapa",
  "dados": [
    { "rotulo": "compilar rust", "valor": 8.5 },
    { "rotulo": "testes", "valor": 4.2 },
    { "rotulo": "empacotar", "valor": 1.8 },
    { "rotulo": "assinar", "valor": 0.6 }
  ]
}`,
        ),
      },
      {
        nome: 'barras · empilhadas',
        pergunta: 'como ficam os pedidos de site e app nessa semana?',
        fala:
          'Duas séries na mesma barra: a altura é o total, e o balão mostra quanto veio de cada canal.',
        bloco: bloco(
          'koda-grafico',
          `{
  "tipo": "empilhadas",
  "titulo": "Pedidos por canal e semana",
  "series": ["Site", "App"],
  "dados": [
    { "rotulo": "sem 1", "valor": 40, "valor2": 22 },
    { "rotulo": "sem 2", "valor": 55, "valor2": 31 },
    { "rotulo": "sem 3", "valor": 48, "valor2": 44 },
    { "rotulo": "sem 4", "valor": 62, "valor2": 58 }
  ]
}`,
        ),
      },
      {
        nome: 'comparação',
        pergunta: 'sqlite ou postgres pro koda?',
        fala:
          'Lado a lado, no peso: cada coluna é um caminho, com os pontos que pesam a favor e contra.',
        bloco: bloco(
          'koda-comparacao',
          `{
  "tipo": "comparacao",
  "titulo": "SQLite ou Postgres",
  "colunas": [
    { "titulo": "SQLite", "itens": ["é um arquivo só", "zero configuração", "ótimo pra um usuário", "trava com escrita simultânea"] },
    { "titulo": "Postgres", "itens": ["aguenta concorrência", "precisa de um servidor", "bom pra vários usuários", "mais uma peça pra manter"] }
  ]
}`,
        ),
      },
    ],
  },
  {
    id: 'tempo',
    titulo: 'Ao longo do tempo',
    texto: 'quando a ordem importa mais que a comparação: linha, área e história.',
    exemplos: [
      {
        nome: 'linhas',
        pergunta: 'como foi o uso essa semana?',
        fala: 'A semana em linha. Passa o mouse nos pontos — o balão mostra o dia e o número.',
        bloco: bloco(
          'koda-grafico',
          `{
  "tipo": "linhas",
  "titulo": "Conversas por dia",
  "dados": [
    { "rotulo": "seg", "valor": 12 },
    { "rotulo": "ter", "valor": 19 },
    { "rotulo": "qua", "valor": 8 },
    { "rotulo": "qui", "valor": 24 },
    { "rotulo": "sex", "valor": 31 },
    { "rotulo": "sab", "valor": 9 },
    { "rotulo": "dom", "valor": 14 }
  ]
}`,
        ),
      },
      {
        nome: 'área',
        pergunta: 'e os visitantes do mês?',
        fala:
          'A mesma coisa com a área embaixo — pra quando o volume importa tanto quanto a forma.',
        bloco: bloco(
          'koda-grafico',
          `{
  "tipo": "area",
  "titulo": "Visitantes no mês",
  "dados": [
    { "rotulo": "jan", "valor": 820 },
    { "rotulo": "fev", "valor": 940 },
    { "rotulo": "mar", "valor": 1310 },
    { "rotulo": "abr", "valor": 1180 },
    { "rotulo": "mai", "valor": 1620 }
  ]
}`,
        ),
      },
      {
        nome: 'linha do tempo',
        pergunta: 'como o koda chegou até aqui?',
        fala:
          'A história em ordem. O número do lado é a fase; o balão mostra de que fase cada passo é.',
        bloco: bloco(
          'koda-grafico',
          `{
  "tipo": "timeline",
  "titulo": "Como o Koda cresceu",
  "dados": [
    { "rotulo": "Nasceu a ideia", "grupo": "começo", "valor": 1 },
    { "rotulo": "Primeira tela respondendo", "grupo": "protótipo", "valor": 2 },
    { "rotulo": "Host local rodando modelos", "grupo": "motor", "valor": 3 },
    { "rotulo": "Versão instalável", "grupo": "lançamento", "valor": 4 },
    { "rotulo": "Nuvem e cobrança", "grupo": "realidade", "valor": 5 }
  ]
}`,
        ),
      },
    ],
  },
  {
    id: 'todo',
    titulo: 'Partes de um todo',
    texto: 'quando as partes somam 100%: pizza, rosca e o fluxo de valor.',
    exemplos: [
      {
        nome: 'pizza',
        pergunta: 'de onde vêm os pedidos?',
        fala: 'As fatias somam 100%. Clica numa fatia: ela cresce um pouco e o resto apaga.',
        bloco: bloco(
          'koda-grafico',
          `{
  "tipo": "pizza",
  "titulo": "De onde vêm os pedidos",
  "legenda": "clique numa fatia para destacar",
  "dados": [
    { "rotulo": "Site", "valor": 55 },
    { "rotulo": "App", "valor": 30 },
    { "rotulo": "Telefone", "valor": 15 }
  ]
}`,
        ),
      },
      {
        nome: 'rosca',
        pergunta: 'quanto do meu disco tá ocupado?',
        fala: 'Rosca é pizza com o miolo vazado — boa quando tem muitas fatias pequenas.',
        bloco: bloco(
          'koda-grafico',
          `{
  "tipo": "rosca",
  "titulo": "Uso de disco",
  "dados": [
    { "rotulo": "Vídeos", "valor": 48 },
    { "rotulo": "Fotos", "valor": 22 },
    { "rotulo": "Código", "valor": 18 },
    { "rotulo": "Outros", "valor": 12 }
  ]
}`,
        ),
      },
      {
        nome: 'sankey',
        pergunta: 'pra onde vai a receita do mês?',
        fala:
          'Fluxo de valor: a espessura da fita é o tamanho do fluxo. Passa o mouse na fita pra ver o número.',
        bloco: bloco(
          'koda-grafico',
          `{
  "tipo": "sankey",
  "titulo": "Pra onde vai a receita",
  "fluxos": [
    { "de": "Receita", "para": "Salários", "valor": 52 },
    { "de": "Receita", "para": "Servidores", "valor": 18 },
    { "de": "Receita", "para": "Marketing", "valor": 20 },
    { "de": "Receita", "para": "Lucro", "valor": 10 }
  ]
}`,
        ),
      },
    ],
  },
  {
    id: 'relacoes',
    titulo: 'Relações',
    texto: 'quando tem duas ou três variáveis ao mesmo tempo: dispersão, bolha e radar.',
    exemplos: [
      {
        nome: 'dispersão',
        pergunta: 'qual a relação entre preço e vendas dos produtos?',
        fala: 'Cada ponto é um produto: posição x é preço, y é quantidade vendida.',
        bloco: bloco(
          'koda-grafico',
          `{
  "tipo": "dispersao",
  "titulo": "Preço x quantidade vendida",
  "dados": [
    { "rotulo": "produto A", "valor": 10, "valor2": 90 },
    { "rotulo": "produto B", "valor": 25, "valor2": 55 },
    { "rotulo": "produto C", "valor": 40, "valor2": 38 },
    { "rotulo": "produto D", "valor": 55, "valor2": 22 },
    { "rotulo": "produto E", "valor": 70, "valor2": 11 }
  ]
}`,
        ),
      },
      {
        nome: 'bolhas',
        pergunta: 'compara essas cidades pra mim',
        fala:
          'Dispersão com terceira dimensão: o tamanho da bolha é a terceira variável — aqui, a área.',
        bloco: bloco(
          'koda-grafico',
          `{
  "tipo": "bolha",
  "titulo": "Cidades: população x renda x área",
  "dados": [
    { "rotulo": "São Paulo", "valor": 12, "valor2": 45, "tamanho": 90 },
    { "rotulo": "Campinas", "valor": 3, "valor2": 52, "tamanho": 30 },
    { "rotulo": "Santos", "valor": 2, "valor2": 40, "tamanho": 18 },
    { "rotulo": "Ribeirão", "valor": 4, "valor2": 38, "tamanho": 35 }
  ]
}`,
        ),
      },
      {
        nome: 'radar',
        pergunta: 'me dá uma nota do koda',
        fala:
          'Cinco eixos saindo do centro: a forma da teia é o perfil. Passa o mouse nos pontos pra ver a nota.',
        bloco: bloco(
          'koda-grafico',
          `{
  "tipo": "radar",
  "titulo": "Nota do Koda em 5 eixos",
  "dados": [
    { "rotulo": "Velocidade", "valor": 85 },
    { "rotulo": "Estabilidade", "valor": 62 },
    { "rotulo": "Suporte", "valor": 91 },
    { "rotulo": "Preço", "valor": 48 },
    { "rotulo": "Facilidade", "valor": 74 }
  ]
}`,
        ),
      },
    ],
  },
  {
    id: 'explicar',
    titulo: 'Explicar',
    texto: 'o que não é número: mapa mental, passo a passo e tabela.',
    exemplos: [
      {
        nome: 'mapa mental · grande',
        pergunta: 'me explica como o koda funciona por dentro',
        fala:
          'O mapa mental, do jeito que você pediu: centro é o tema, ramos saem dele, e cada ramo pode ter filhos. Passa o mouse nos ramos e clica num deles pra destacar o galho inteiro — Esc limpa.',
        bloco: bloco(
          'koda-mapa',
          `{
  "tipo": "mapa",
  "titulo": "Como o Koda funciona por dentro",
  "centro": "Koda",
  "ramos": [
    {
      "texto": "Interface",
      "filhos": [
        { "texto": "React 19 + Vite" },
        { "texto": "Composer (a caixa de escrever)" },
        { "texto": "Temas, zoom e fonte" }
      ]
    },
    {
      "texto": "Conversa",
      "filhos": [
        { "texto": "SSE: a resposta chega em pedaços" },
        { "texto": "Histórico e compactação" },
        { "texto": "Menções (@arquivo)" }
      ]
    },
    {
      "texto": "Backend",
      "filhos": [
        { "texto": "FastAPI" },
        { "texto": "22 ferramentas do agente" },
        { "texto": "SQLite (histórico)" },
        { "texto": "Anexos" }
      ]
    },
    {
      "texto": "Host local",
      "filhos": [
        { "texto": "Modelos rodam na máquina" },
        { "texto": "Chaves ficam no host" },
        { "texto": "Sem nuvem no meio" }
      ]
    },
    {
      "texto": "Nuvem",
      "filhos": [
        { "texto": "Login e cobrança" },
        { "texto": "Moeda koda" },
        { "texto": "Atualização automática" }
      ]
    }
  ]
}`,
        ),
        largo: true,
      },
      {
        nome: 'passo a passo',
        pergunta: 'como publico uma versão nova?',
        fala:
          'Em ordem, numerado. É a sequência real de publicação — passo a passo, sem pular nenhum.',
        bloco: bloco(
          'koda-passos',
          `{
  "tipo": "passos",
  "titulo": "Publicar uma versão nova",
  "passos": [
    { "titulo": "Gerar o host", "texto": "npm run app:host" },
    { "titulo": "Runtime do backend", "texto": "npm run app:runtime" },
    { "titulo": "Runtime do node", "texto": "npm run app:node" },
    { "titulo": "Build do Tauri", "texto": "tauri build" },
    { "titulo": "Launcher do instalador", "texto": "npm run app:launcher" },
    { "titulo": "Empacotar e subir", "texto": "npm run app:bundle:host" }
  ]
}`,
        ),
      },
      {
        nome: 'tabela',
        pergunta: 'o que cada arquivo do src faz?',
        fala:
          'Tabela de verdade: cabeçalho, linhas, e rolagem de lado se não couber. Passa o mouse na linha.',
        bloco: bloco(
          'koda-visual',
          `{
  "tipo": "tabela",
  "titulo": "O que cada arquivo faz",
  "colunas": ["Arquivo", "Papel", "Quando mexe"],
  "linhas": [
    ["main.tsx", "liga a interface", "quase nunca"],
    ["Composer.tsx", "a caixa de escrever", "quando muda a caixa"],
    ["RichText.tsx", "desenha a resposta", "quando muda o markdown"],
    ["BlocosVisuais.tsx", "os desenhos dos blocos", "quando nasce um bloco novo"]
  ]
}`,
        ),
      },
      {
        nome: 'mapa radial · constelação',
        pergunta: 'me mostra o time todo em volta de um centro',
        fala:
          'O mapa em constelação: o centro é o tema, os nós ficam na roda com a ligação curvada. Clica num nó — ou no nome aqui embaixo — e a barrinha acende mais forte. Clica de novo ou Esc limpa.',
        bloco: bloco(
          'koda-mapa',
          `{
  "tipo": "mapa-radial",
  "titulo": "A família",
  "centro": "FAMÍLIA LIZ",
  "centro_sub": "o time",
  "nos": [
    { "nome": "Liz", "sub": "o modelo principal" },
    { "nome": "Koda", "sub": "o shell de chat" },
    { "nome": "Layze", "sub": "o segundo par de olhos" },
    { "nome": "Nable", "sub": "o rápido do dia a dia" },
    { "nome": "Vídeos", "sub": "o motor de análise" },
    { "nome": "Identidade", "sub": "quem fala" }
  ]
}`,
        ),
        largo: true,
      },
    ],
  },
  {
    id: 'alem',
    titulo: 'Além dos gráficos',
    texto:
      'cinco desenhos novos, além dos gráficos: diff, árvore de arquivos, números em cartão, aviso colorido e um quiz que aceita resposta.',
    exemplos: [
      {
        nome: 'diffs',
        pergunta: 'o que você mudou no composer hoje?',
        fala:
          'Diff como no git: verde entrou, vermelho saiu, cinza é o que ficou igual. Clica numa linha pra destacar.',
        bloco: bloco(
          'koda-visual',
          `{
  "tipo": "diffs",
  "arquivo": "src/components/Composer.tsx",
  "linhas": [
    { "tipo": "ctx", "texto": "function Composer() {" },
    { "tipo": "ctx", "texto": "  const [texto, setTexto] = useState('')" },
    { "tipo": "del", "texto": "  const maximo = 280" },
    { "tipo": "add", "texto": "  const maximo = 2000" },
    { "tipo": "add", "texto": "  // o composer cresce: mandar texto longo não pode truncar" },
    { "tipo": "ctx", "texto": "}" }
  ]
}`,
        ),
      },
      {
        nome: 'árvore de arquivos',
        pergunta: 'como tá organizada a pasta src?',
        fala:
          'A pasta em árvore: pasta tem o quadradinho cheio, arquivo tem vazado. Passa o mouse pra ver o que é.',
        bloco: bloco(
          'koda-visual',
          `{
  "tipo": "arvore",
  "titulo": "A pasta src de hoje",
  "itens": [
    {
      "nome": "components",
      "filhos": [
        { "nome": "BolhaUsuario.tsx" },
        { "nome": "Composer.tsx" },
        { "nome": "FalaDoModelo.tsx" },
        { "nome": "RichText.tsx" },
        { "nome": "BlocosVisuais.tsx" },
        { "nome": "BlocosInteracao.tsx" }
      ]
    },
    { "nome": "api", "filhos": [{ "nome": "client.ts" }, { "nome": "cloud.ts" }] },
    { "nome": "App.tsx" },
    { "nome": "main.tsx" },
    { "nome": "blocos.tsx" },
    { "nome": "index.css" }
  ]
}`,
        ),
      },
      {
        nome: 'cartões de número',
        pergunta: 'resumo do mês em números',
        fala:
          'Os números grandes em cartões. A variação vem colorida embaixo — pra ler de relance.',
        bloco: bloco(
          'koda-visual',
          `{
  "tipo": "metrica",
  "titulo": "O mês em números",
  "cartoes": [
    { "rotulo": "Conversas", "valor": "1.284", "variacao": "+12%" },
    { "rotulo": "Mensagens", "valor": "9.412", "variacao": "+8%" },
    { "rotulo": "Tokens", "valor": "2,4M", "variacao": "+18%" },
    { "rotulo": "Custo", "valor": "R$ 318", "variacao": "-4%" }
  ]
}`,
        ),
      },
      {
        nome: 'aviso colorido',
        pergunta: 'posso apagar a pasta dist?',
        fala: 'Aviso colorido — quando a resposta tem um cuidado que não pode passar batido.',
        bloco: bloco(
          'koda-visual',
          `{
  "tipo": "citacao",
  "tom": "aviso",
  "titulo": "cuidado antes de apagar",
  "texto": "a pasta dist é o build do app inteiro. apagar não quebra o código — mas o instalador deixa de existir até o próximo build."
}`,
        ),
      },
      {
        nome: 'quiz',
        pergunta: 'faz um quiz pra eu testar',
        fala:
          'Esse é diferente dos outros: ele aceita resposta. Clica numa opção e ele marca se acertou — na hora, sem servidor.',
        bloco: bloco(
          'koda-visual',
          `{
  "tipo": "quiz",
  "pergunta": "a IA mandou um bloco com o JSON quebrado. o que aparece na conversa?",
  "opcoes": [
    "a resposta inteira some",
    "um aviso discreto no lugar do bloco — e o resto do texto continua legível",
    "o JSON cru, do jeito que veio"
  ],
  "correta": 1,
  "explicacao": "o contrato é tolerante de propósito: chave faltando ou valor virado não derruba a resposta. é o que faz o bloco poder confiar na conversa."
}`,
        ),
      },
      {
        nome: 'plano · antes de aceitar',
        pergunta: 'refatora a pasta de testes do projeto',
        fala:
          'Tarefa grande, então o plano vem inteiro antes de eu tocar em qualquer coisa: de que é, pra que serve, por que assim, como, as mudanças e o resultado esperado. Passa o mouse nas mudanças — e só executo depois do seu sim.',
        bloco: bloco(
          'koda-visual',
          `{
  "tipo": "plano",
  "titulo": "Renomear a pasta de testes",
  "o_que_e": "mover os testes de test/ para tests/ e atualizar os caminhos que apontam para eles",
  "pra_que": "hoje as duas pastas existem, e o nome no plural é o padrão — a duplicação confunde",
  "por_que": "mover e atualizar os caminhos num passe só é mais seguro do que deixar os dois vivos",
  "como": [
    { "titulo": "Mapear os caminhos", "texto": "procurar tudo que aponta para test/" },
    { "titulo": "Mover a pasta", "texto": "git mv test tests" },
    { "titulo": "Atualizar as referências", "texto": "edit_file em cada arquivo que apontava" },
    { "titulo": "Rodar os testes", "texto": "confirmar que nada quebrou" }
  ],
  "mudancas": [
    { "arquivo": "package.json", "texto": "o script de teste aponta para o caminho novo" },
    { "arquivo": "src/app.test.ts", "texto": "importa de tests/ em vez de test/" }
  ],
  "resultado": "uma pasta tests/ só, com os testes rodando verde e nenhum caminho morto"
}`,
        ),
      },
    ],
  },
]

const TOTAL_EXEMPLOS = SECOES.reduce((soma, secao) => soma + secao.exemplos.length, 0)

function Cartao({ exemplo }: { exemplo: Exemplo }) {
  const [verJson, setVerJson] = useState(false)
  const [copiado, setCopiado] = useState(false)

  const copiar = () => {
    void navigator.clipboard?.writeText(exemplo.bloco).catch(() => {})
    setCopiado(true)
    window.setTimeout(() => setCopiado(false), 1600)
  }

  // A fala do modelo é o texto mais o bloco — exatamente o que chegaria do servidor.
  const fala = exemplo.fala + '\n\n' + exemplo.bloco

  return (
    <article
      className={[
        'msg-in flex flex-col rounded-2xl border border-koda-fg/10 bg-koda-panel/50 p-4',
        exemplo.largo ? 'lg:col-span-2' : '',
      ].join(' ')}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="rounded-full bg-koda-fg/8 px-2.5 py-0.5 font-mono text-[11px] text-koda-fg/55">
          {exemplo.nome}
        </span>
        <div className="flex shrink-0 gap-1">
          {verJson ? (
            <button
              type="button"
              onClick={copiar}
              className="rounded-md px-2 py-0.5 text-[11.5px] text-koda-fg/50 transition-colors hover:bg-koda-fg/8 hover:text-koda-fg"
            >
              {copiado ? 'copiado!' : 'copiar'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setVerJson((v) => !v)}
            className="rounded-md px-2 py-0.5 text-[11.5px] text-koda-fg/50 transition-colors hover:bg-koda-fg/8 hover:text-koda-fg"
          >
            {verJson ? 'esconder' : 'ver json'}
          </button>
        </div>
      </div>

      <div className="flex flex-col items-end gap-1.5">
        <BolhaUsuario texto={exemplo.pergunta} />
      </div>
      <div className="mt-3">
        <FalaDoModelo texto={fala} />
      </div>

      {verJson ? (
        <pre className="mt-3 overflow-x-auto rounded-xl bg-koda-fg/4 p-3 font-mono text-[11.5px] leading-5 text-koda-fg/70 ring-1 ring-koda-fg/8">
          {exemplo.bloco}
        </pre>
      ) : null}
    </article>
  )
}

function Galeria() {
  return (
    <div className="flex h-full flex-col bg-koda-bg text-koda-fg">
      <header className="shrink-0 border-b border-koda-fg/10 px-5 py-4">
        <div className="mx-auto max-w-5xl">
          <p className="font-mono text-[11px] tracking-wide text-koda-accent/80 uppercase">
            koda · blocos visuais
          </p>
          <h1 className="mt-1 text-[22px] font-semibold">Tudo que o Koda desenha</h1>
          <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-koda-fg/55">
            não é vitrine: cada cartão é uma conversa de verdade, rodando o mesmo código do
            chat. passa o mouse, clica pra destacar, <kbd>Esc</kbd> limpa — e no fim tem um
            quiz que aceita resposta.
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <span className="rounded-full bg-koda-accent/12 px-2.5 py-1 text-[11.5px] text-koda-accent">
              22 tipos de bloco
            </span>
            <span className="rounded-full bg-koda-fg/8 px-2.5 py-1 text-[11.5px] text-koda-fg/60">
              {TOTAL_EXEMPLOS} conversas
            </span>
            <span className="rounded-full bg-koda-fg/8 px-2.5 py-1 text-[11.5px] text-koda-fg/60">
              100% interativo
            </span>
          </div>
          <nav className="mt-3 flex flex-wrap gap-1.5">
            {SECOES.map((secao) => (
              <a
                key={secao.id}
                href={`#${secao.id}`}
                className="rounded-full border border-koda-fg/12 px-2.5 py-1 text-[12px] text-koda-fg/60 transition-colors hover:bg-koda-fg/8 hover:text-koda-fg"
              >
                {secao.titulo}
              </a>
            ))}
          </nav>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-5xl gap-4 p-4 lg:grid-cols-2">
          {SECOES.map((secao) => (
            <Fragment key={secao.id}>
              <div id={secao.id} className="flex flex-col gap-0.5 pt-3 lg:col-span-2">
                <h2 className="text-[16px] font-semibold text-koda-fg/90">{secao.titulo}</h2>
                <p className="text-[12.5px] text-koda-fg/45">{secao.texto}</p>
              </div>
              {secao.exemplos.map((exemplo) => (
                <Cartao key={exemplo.nome} exemplo={exemplo} />
              ))}
            </Fragment>
          ))}
        </div>
      </main>
    </div>
  )
}

/**
 * Monta preservando o root entre recargas do HMR.
 *
 * `createRoot` no mesmo `<div>` duas vezes não é erro silencioso: o React avisa e **não
 * renderiza nada**. Como o Vite recarrega este módulo a cada edição, montar direto fazia
 * a página aparecer vazia depois da primeira mudança. Guardar o root no módulo resolve.
 */
const raiz = document.getElementById('root')!
let root = (window as unknown as { __kodaLabRoot?: ReturnType<typeof createRoot> }).__kodaLabRoot
if (!root) {
  root = createRoot(raiz)
  ;(window as unknown as { __kodaLabRoot?: typeof root }).__kodaLabRoot = root
}
root.render(<Galeria />)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    delete (window as unknown as { __kodaLabRoot?: typeof root }).__kodaLabRoot
  })
}
