/**
 * Só o chat do Koda, numa página separada.
 *
 * Existe para testar a tela de conversa **isolada**: sem login, sem histórico, sem painel
 * lateral, sem barra de cima. Monta o `Composer` de verdade (o mesmo componente do app) e
 * fala com o mesmo backend, então o que se vê aqui é o comportamento real da caixa e da
 * conversa — não uma maquete.
 *
 * ## O que é reaproveitado, sem cópia
 *
 * `Composer`, `BolhaUsuario` e `FalaDoModelo` são os componentes do app, importados como
 * estão. Se a caixa mudar no app, muda aqui também: nada foi duplicado.
 *
 * ## O que NÃO tem
 *
 * - **Login**: assume que o backend já está no ar com o token desta execução
 *   (`VITE_API_TOKEN`). É o caso do `npm run dev`.
 * - **Histórico**: a conversa vive na memória desta aba. Recarregar começa de novo, e nada
 *   é gravado no banco (o `conversation_id` não é enviado).
 * - **Permissão de ferramenta**: o modo vai como `auto`, para a rodada não parar esperando
 *   um cartão que esta página não desenha.
 */

import { useCallback, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

import BolhaUsuario from './components/BolhaUsuario'
import Composer from './components/Composer'
import FalaDoModelo from './components/FalaDoModelo'
import ToolSteps from './components/ToolSteps'
import { lerModeloSalvo, salvarModelo } from './modelo-salvo'
import { streamChat } from './api/client'
import type { SendPayload } from './components/Composer'
import type { ApiAnexo, ToolStep } from './api/client'
import './index.css'

/** Uma fala na tela: o que a pessoa mandou, ou o que o modelo respondeu. */
type Fala =
  | { papel: 'usuario'; texto: string; anexos: ApiAnexo[] }
  | { papel: 'modelo'; texto: string; passos: ToolStep[] }

function ChatSolto() {
  const [falas, setFalas] = useState<Fala[]>([])
  // A mesma escolha da janela principal: esta página é uma segunda porta para o mesmo
  // seletor, e trocar de modelo aqui tem de valer lá — e depois de fechar também.
  const [modelo, setModelo] = useState(lerModeloSalvo)
  const [ocupado, setOcupado] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const pararRef = useRef<AbortController | null>(null)

  const enviar = useCallback(
    async (payload: SendPayload) => {
      if (ocupado) return
      setErro(null)
      setOcupado(true)

      // A fala da pessoa entra na hora; a do modelo é preenchida enquanto chega.
      setFalas((atual) => [
        ...atual,
        { papel: 'usuario', texto: payload.text, anexos: payload.attachments },
      ])
      const indice = { atual: -1 }
      setFalas((atual) => {
        indice.atual = atual.length
        return [...atual, { papel: 'modelo', texto: '', passos: [] }]
      })

      const alterarModelo = (mudanca: (fala: Extract<Fala, { papel: 'modelo' }>) => Fala) =>
        setFalas((atual) => {
          const copia = [...atual]
          const alvo = copia[indice.atual]
          if (alvo && alvo.papel === 'modelo') copia[indice.atual] = mudanca(alvo)
          return copia
        })

      const controle = new AbortController()
      pararRef.current = controle

      try {
        await streamChat(
          {
            text: payload.text,
            model: modelo,
            reasoning: payload.reasoning,
            effort: payload.effort,
            web: payload.web,
            project_path: payload.project_path,
            attachments: payload.attachments.map((a) => a.id),
            // Sem histórico nesta página: o backend não grava conversa nenhuma, e a
            // conversa vive só na memória da aba.
            conversation_id: null,
            tz_offset_minutes: new Date().getTimezoneOffset(),
          },
          {
            onDelta: (texto) =>
              alterarModelo((f) => ({ ...f, texto: f.texto + texto })),
            onToolResult: (dado) =>
              alterarModelo((f) => ({
                ...f,
                passos: [
                  ...f.passos,
                  {
                    name: dado.name,
                    arguments: {},
                    output: dado.output,
                    duration_ms: dado.duration_ms,
                    call_id: dado.id,
                    ok: dado.ok,
                  } as ToolStep,
                ],
              })),
            onError: (mensagem) => setErro(mensagem),
            onClosed: () => setOcupado(false),
            onDone: () => setOcupado(false),
            signal: controle.signal,
          },
        )
      } catch (falha) {
        setErro(falha instanceof Error ? falha.message : String(falha))
      } finally {
        setOcupado(false)
        pararRef.current = null
      }
    },
    [modelo, ocupado],
  )

  return (
    <div className="flex h-screen flex-col bg-koda-bg text-koda-fg">
      <header className="shrink-0 border-b border-koda-fg/10 px-4 py-2">
        <span className="text-[12px] text-koda-fg/45">
          Koda — só o chat (página de teste, sem histórico)
        </span>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
          {falas.length === 0 ? (
            <p className="pt-20 text-center text-[13.5px] text-koda-fg/35">
              Escreva alguma coisa abaixo — a conversa aparece aqui.
            </p>
          ) : null}

          {falas.map((fala, i) =>
            fala.papel === 'usuario' ? (
              <BolhaUsuario key={i} texto={fala.texto} anexos={fala.anexos} />
            ) : (
              <div key={i} className="flex flex-col gap-2">
                {fala.passos.length ? <ToolSteps steps={fala.passos} resumido /> : null}
                {fala.texto ? <FalaDoModelo texto={fala.texto} /> : null}
                {!fala.texto && !fala.passos.length && ocupado ? (
                  <p className="text-[13px] text-koda-fg/40">Pensando…</p>
                ) : null}
              </div>
            ),
          )}

          {erro ? (
            <p className="rounded-lg bg-red-500/10 px-3 py-2 text-[13px] text-red-300">
              {erro}
            </p>
          ) : null}
        </div>
      </main>

      <footer className="shrink-0 px-4 pb-5">
        <div className="mx-auto w-full max-w-3xl">
          <Composer
            onSend={enviar}
            onStop={() => pararRef.current?.abort()}
            busy={ocupado}
            variant={falas.length > 0 ? 'chat' : 'home'}
            model={modelo}
            onModelChange={(valor) => {
              setModelo(valor)
              salvarModelo(valor)
            }}
            // `auto` para a rodada não parar num cartão de permissão que esta página não
            // desenha — aqui o objetivo é ver a caixa e a conversa, não aprovar passo.
            permissionMode="auto"
          />
        </div>
      </footer>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<ChatSolto />)
