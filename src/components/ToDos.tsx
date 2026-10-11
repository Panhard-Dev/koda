import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Check, ListTodo } from 'lucide-react'
import type { ApiTodo } from '../api/client'

/**
 * O plano da tarefa, como **menu do canto**: um botão com a contagem do que falta, no
 * alto à direita (logo abaixo dos controles da janela), que abre o painel com a lista.
 *
 * Existe porque tarefa grande sem plano vira uma pilha de ferramentas soltas: quem está
 * olhando não sabe quantas etapas faltam nem onde o trabalho parou. A lista é do agente —
 * ele cria com `update_todos` e vai marcando cada item conforme termina —, e aqui ela
 * aparece como uma coisa só, que encolhe ou cresce conforme o trabalho anda.
 *
 * O número no balão responde a pergunta que a conversa não respondia: **quanto falta**.
 * Sem nada em andamento, o balão some e o painel diz que está vazio — em vez de a tela
 * carregar para sempre o plano de uma tarefa que já acabou.
 *
 * `rodando` é o que separa «o agente está neste item agora» de «o agente parou neste item».
 * Sem ele, o arco girando continuava girando depois de a rodada morrer — uma conversa
 * interrompida ficava com um item «em andamento» para sempre, parecendo trabalho em curso
 * que ninguém estava fazendo.
 */
export default function ToDosMenu({
  todos,
  rodando = false,
}: {
  todos: ApiTodo[]
  rodando?: boolean
}) {
  const [aberto, setAberto] = useState(false)
  const raizRef = useRef<HTMLDivElement>(null)

  const feitos = todos.filter((item) => item.feito).length
  const pendentes = todos.length - feitos
  const acabou = todos.length > 0 && pendentes === 0

  // Fechar no clique fora e no Esc — o mesmo comportamento dos outros menus do app.
  useEffect(() => {
    if (!aberto) return
    const aoClicar = (evento: PointerEvent) => {
      if (!raizRef.current?.contains(evento.target as Node)) setAberto(false)
    }
    const aoTeclar = (evento: KeyboardEvent) => {
      if (evento.key === 'Escape') setAberto(false)
    }
    document.addEventListener('pointerdown', aoClicar)
    document.addEventListener('keydown', aoTeclar)
    return () => {
      document.removeEventListener('pointerdown', aoClicar)
      document.removeEventListener('keydown', aoTeclar)
    }
  }, [aberto])

  return (
    <div ref={raizRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={aberto}
        aria-label={pendentes > 0 ? `To-dos: ${pendentes} em aberto` : 'To-dos'}
        title="To-dos"
        onClick={() => setAberto((valor) => !valor)}
        className={[
          'flex h-8 items-center gap-1.5 rounded-xl px-2.5 text-[13px] font-medium',
          'ring-1 transition-colors duration-150',
          'focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none',
          aberto
            ? 'bg-koda-fg/12 text-koda-fg ring-koda-fg/12'
            : todos.length > 0
              ? 'text-koda-fg/80 ring-koda-fg/10 hover:bg-koda-fg/8 hover:text-koda-fg'
              : 'text-koda-fg/40 ring-transparent hover:bg-koda-fg/8 hover:text-koda-fg/70',
        ].join(' ')}
      >
        <ListTodo className="h-[17px] w-[17px]" strokeWidth={1.7} />
        <span className="hidden sm:inline">To-dos</span>
        {/* O balão: quantas etapas ainda faltam. Some quando não falta nenhuma. */}
        {pendentes > 0 ? (
          <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-koda-accent-strong px-1 text-[11px] leading-none font-semibold text-white tabular-nums">
            {pendentes}
          </span>
        ) : acabou ? (
          <Check className="h-3.5 w-3.5 text-koda-accent" strokeWidth={2.6} />
        ) : null}
      </button>

      {aberto ? (
        <div
          role="menu"
          className={[
            'menu-in absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-2xl',
            'bg-koda-surface/95 ring-1 ring-koda-fg/10 backdrop-blur-xl',
            'shadow-[0_28px_60px_-24px_var(--koda-shadow)]',
          ].join(' ')}
        >
          <div className="flex items-center gap-2 px-3.5 py-2.5 text-[12px] font-semibold tracking-wider text-koda-fg/45 uppercase">
            <ListTodo className="h-3.5 w-3.5" strokeWidth={2} />
            <span>To-dos</span>
            {todos.length > 0 ? (
              <span className="ml-auto flex items-center gap-1.5 tabular-nums normal-case">
                {/* O plano de pé sem ninguém trabalhando nele: a tela diz isso, em vez de
                    deixar o arco girando como se houvesse trabalho em curso. */}
                {!rodando && pendentes > 0 ? (
                  <span className="text-koda-fg/30">parado</span>
                ) : null}
                <span className={acabou ? 'text-koda-accent/80' : 'text-koda-fg/45'}>
                  {feitos}
                </span>
                <span className="text-koda-fg/30">/{todos.length}</span>
              </span>
            ) : null}
          </div>

          {todos.length === 0 ? (
            <div className="border-t border-koda-fg/8 px-3.5 py-4">
              <p className="text-[13.5px] text-koda-fg/70">Nada em andamento</p>
              <p className="mt-1 text-[12px] leading-4 text-koda-fg/40">
                Peça uma tarefa grande e o plano aparece aqui, item por item.
              </p>
            </div>
          ) : (
            <ul className="max-h-[60vh] overflow-y-auto border-t border-koda-fg/8 px-1.5 py-1.5">
              {todos.map((item, indice) => (
                <li
                  key={`${indice}-${item.texto}`}
                  className="flex items-start gap-2.5 rounded-lg px-2 py-1.5"
                >
                  <span className="mt-[2px] flex h-4 w-4 shrink-0 items-center justify-center">
                    {item.feito ? (
                      <Check className="h-3.5 w-3.5 text-koda-accent" strokeWidth={2.6} />
                    ) : item.atual ? (
                      rodando ? (
                        <AroGirando />
                      ) : (
                        <Parado />
                      )
                    ) : (
                      <span className="h-3 w-3 rounded-full border border-koda-fg/20" />
                    )}
                  </span>
                  <span
                    className={[
                      'flex-1 text-[13.5px] leading-snug',
                      item.feito
                        ? 'text-koda-fg/35 line-through decoration-koda-fg/20'
                        : item.atual
                          ? 'text-koda-fg/90'
                          : 'text-koda-fg/65',
                    ].join(' ')}
                  >
                    {item.texto}
                  </span>
                  {item.atual && !item.feito ? (
                    <ArrowRight
                      className="mt-[3px] h-3.5 w-3.5 shrink-0 text-koda-accent"
                      strokeWidth={2}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}

/**
 * O item onde o trabalho **parou**.
 *
 * Duas barras, e não o arco girando: parado é parado. Um giro na tela promete movimento, e
 * a conversa interrompida ficava com essa promessa de pé para sempre.
 */
function Parado() {
  return (
    <span aria-hidden className="flex h-3.5 w-3.5 items-center justify-center gap-[2px]">
      <span className="h-2.5 w-[2px] rounded-full bg-koda-fg/35" />
      <span className="h-2.5 w-[2px] rounded-full bg-koda-fg/35" />
    </span>
  )
}

/** O item em execução: o mesmo arco girando das ferramentas, para a conversa não parar. */
function AroGirando() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5 text-koda-accent" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth={2} opacity="0.2" />
      <path
        d="M21 12a9 9 0 00-9-9"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        className="tool-spin"
      />
    </svg>
  )
}
