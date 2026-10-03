import { useState } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import ToDosMenu from './components/ToDos'
import Composer, { ICONE_DO_MODO } from './components/Composer'
import type { ApiTodo } from './api/client'
import type { ModoPermissao } from './api/client'

const comTarefas: ApiTodo[] = [
  { texto: 'Refatorar: remover era gemini-proxy (config + provider + routers)', feito: true, atual: false },
  { texto: 'Atualizar testes que usam GeminiProxyProvider', feito: true, atual: false },
  { texto: 'Atualizar .env (KODA_HOST_URL)', feito: false, atual: true },
  { texto: 'Tauri: empacotar host/ + ciclo de vida do c-host', feito: false, atual: false },
  { texto: 'pytest + rebuild + relançar + validar', feito: false, atual: false },
]

function Faixa() {
  return (
    <div className="flex items-center gap-3 p-5">
      <span className="text-[13px] text-koda-fg/50">header…</span>
      <div className="-mr-2 ml-auto flex items-center gap-0.5 text-koda-fg/55">
        <span className="px-3 text-[13px]">— ▢ ✕</span>
      </div>
    </div>
  )
}

function Bloco({ titulo, todos }: { titulo: string; todos: ApiTodo[] }) {
  return (
    <div className="mb-8">
      <p className="mb-2 px-5 text-[11px] tracking-wider text-koda-fg/35 uppercase">{titulo}</p>
      <Faixa />
      <div className="relative z-20 -mt-2 flex shrink-0 justify-end px-5">
        <ToDosMenu todos={todos} />
      </div>
      <div className="p-5 text-[13px] text-koda-fg/30">conversa…</div>
    </div>
  )
}

function Harness() {
  return (
    <div className="min-h-screen bg-koda-bg">
      <Bloco titulo="com tarefas em andamento" todos={comTarefas} />
      <Bloco titulo="nada em andamento" todos={[]} />
      <Bloco
        titulo="tudo feito"
        todos={comTarefas.map((item) => ({ ...item, feito: true, atual: false }))}
      />
    </div>
  )
}

/**
 * A caixa de entrada nos três modos de permissão, com o medidor de contexto ao lado do
 * modelo. Serve para conferir cor/ícone/anel sem passar pelo login — e sem depender de
 * uma tarefa de verdade para o anel ter número.
 */
function ComposerHarness() {
  const modelos = [
    { value: 'liz-4', label: 'Liz 4', janela: 1_000_000 },
    { value: 'koda-1', label: 'Koda 1', janela: 1_000_000 },
    { value: 'layze-2', label: 'Layze 2', janela: 1_000_000 },
  ]
  // Um de cada faixa de cor: verde (35%), amarelo (72%), vermelho (91%).
  const contexto = { 'liz-4': 350_000, 'koda-1': 720_000, 'layze-2': 910_000 }

  return (
    <div className="bg-koda-bg">
      {(['manual', 'default', 'auto', 'livre'] as ModoPermissao[]).map((modo) => (
        <div key={modo} className="border-b border-koda-fg/5 pb-10">
          <p className="mb-2 px-5 text-[11px] tracking-wider text-koda-fg/35 uppercase">
            permissão: {modo}
          </p>
          <Composer
            variant="chat"
            permissionMode={modo}
            model="liz-4"
            remoteModels={modelos}
            contextoPorModelo={contexto}
            contextoJanela={1_000_000}
          />
        </div>
      ))}
    </div>
  )
}

/**
 * Os três ícones do seletor de permissão, um por linha, do jeito que aparecem no menu.
 *
 * Existe porque o menu fechado não vai para o DOM — sem isto, conferir cor e forma do
 * ícone exigiria abrir o dropdown na mão a cada ajuste.
 */
function IconesHarness() {
  const linhas: { rotulo: string; icone: ReactNode }[] = [
    { rotulo: 'Perguntar sempre', icone: ICONE_DO_MODO.manual },
    { rotulo: 'Padrão', icone: ICONE_DO_MODO.default },
    { rotulo: 'Auto', icone: ICONE_DO_MODO.auto },
    { rotulo: 'Livre — arquivos no computador inteiro', icone: ICONE_DO_MODO.livre },
  ]
  return (
    <div className="bg-koda-bg p-5">
      <p className="mb-2 text-[11px] tracking-wider text-koda-fg/35 uppercase">
        ícones do seletor de permissão
      </p>
      {linhas.map((linha) => (
        <div key={linha.rotulo} className="flex items-center gap-2 py-1.5 text-[13px] text-koda-fg">
          {linha.icone}
          {linha.rotulo}
        </div>
      ))}
    </div>
  )
}

/**
 * A caixa com o menu do "/" e o que ela manda ao agente.
 *
 * Existe para conferir o menu sem passar pelo login: o que o Enter escolhe aparece na lista
 * de baixo, e dá para ver que o comando vira pedido de verdade em vez de sair cru para o
 * modelo.
 */
function ComandosHarness() {
  const [enviados, setEnviados] = useState<string[]>([])

  return (
    <div className="bg-koda-bg p-5">
      <p className="mb-2 text-[11px] tracking-wider text-koda-fg/35 uppercase">
        menu de comandos do "/"
      </p>
      <Composer
        variant="chat"
        model="liz-4"
        onSend={(payload) => setEnviados((atual) => [...atual, payload.text])}
      />
      <ul className="mt-4 flex flex-col gap-2">
        {enviados.map((texto, indice) => (
          <li
            key={indice}
            data-enviado=""
            className="rounded-lg bg-koda-fg/6 p-3 text-[12.5px] whitespace-pre-wrap text-koda-fg/80"
          >
            {texto}
          </li>
        ))}
      </ul>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <div>
    <ComandosHarness />
    <ComposerHarness />
    <IconesHarness />
    <Harness />
  </div>,
)
