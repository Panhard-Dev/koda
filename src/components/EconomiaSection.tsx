import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

import { alterarEconomia, economia } from '../api/client'
import type { ApiModoDeEconomia, ApiNivelDeEconomia } from '../api/client'

/**
 * Economia — os cinco modos que gastam menos tokens.
 *
 * A tela é só o interruptor: quem decide o que cada modo faz é o backend (`app/economia.py`),
 * e o estado mora lá, não no `localStorage`. É o que faz o ajuste valer para **todos** os
 * provedores e modelos — inclusive a API oficial — e sobreviver a fechar o app.
 *
 * O cartão inteiro é a explicação do escopo: ligado vale para tudo, desligado é o
 * comportamento de sempre. Sem essa frase, "Economia" pareceria um ajuste de um provedor
 * só, e a pessoa ligaria esperando economia onde não haveria.
 */
export default function EconomiaSection() {
  const [modos, setModos] = useState<ApiModoDeEconomia[] | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [salvando, setSalvando] = useState<string | null>(null)
  // Se a tela fechar no meio do `GET`, o `setState` não pode rodar num componente que já
  // saiu — o React avisa e, pior, o aviso aparece em cima de outra tela.
  const vivo = useRef(true)

  useEffect(() => {
    vivo.current = true
    economia()
      .then((estado) => {
        if (vivo.current) setModos(estado.modos)
      })
      .catch((falha: unknown) => {
        if (vivo.current) {
          setErro(falha instanceof Error ? falha.message : String(falha))
        }
      })
    return () => {
      vivo.current = false
    }
  }, [])

  const alternar = useCallback(
    async (modo: ApiModoDeEconomia) => {
      if (salvando) return
      const novo = !modo.ligado
      setSalvando(modo.id)
      setErro(null)
      // Otimista: o interruptor responde no clique, e o servidor confirma logo depois. Se
      // falhar, o estado volta ao que era — o contrário deixaria a tela mentindo sobre o
      // que o agente vai fazer na próxima mensagem.
      setModos((atual) =>
        atual?.map((item) => (item.id === modo.id ? { ...item, ligado: novo } : item)) ?? atual,
      )
      try {
        const estado = await alterarEconomia(modo.id, novo)
        if (vivo.current) setModos(estado.modos)
      } catch (falha) {
        if (vivo.current) {
          setModos((atual) =>
            atual?.map((item) =>
              item.id === modo.id ? { ...item, ligado: modo.ligado } : item,
            ) ?? atual,
          )
          setErro(falha instanceof Error ? falha.message : String(falha))
        }
      } finally {
        if (vivo.current) setSalvando(null)
      }
    },
    [salvando],
  )

  const mudarNivel = useCallback(
    async (modo: ApiModoDeEconomia, nivel: ApiNivelDeEconomia['id']) => {
      if (salvando || modo.nivel === nivel) return
      const anterior = modo.nivel
      setSalvando(modo.id)
      setErro(null)
      // O nível também responde no clique: a escolha é uma preferência, e a próxima
      // mensagem já usa o prompt novo. Se o servidor recusar, volta ao nível anterior.
      setModos((atual) =>
        atual?.map((item) => (item.id === modo.id ? { ...item, nivel } : item)) ?? atual,
      )
      try {
        const estado = await alterarEconomia(modo.id, modo.ligado, nivel)
        if (vivo.current) setModos(estado.modos)
      } catch (falha) {
        if (vivo.current) {
          setModos((atual) =>
            atual?.map((item) =>
              item.id === modo.id ? { ...item, nivel: anterior } : item,
            ) ?? atual,
          )
          setErro(falha instanceof Error ? falha.message : String(falha))
        }
      } finally {
        if (vivo.current) setSalvando(null)
      }
    },
    [salvando],
  )

  return (
    <div className="flex flex-col gap-3">
      <section className="rounded-2xl bg-koda-panel px-5 py-4 ring-1 ring-koda-fg/8">
        <p className="text-[13px] leading-5 text-koda-fg/55">
          Ligado, cada modo vale para <strong className="font-medium text-koda-fg/80">todos os
          provedores e modelos</strong> — inclusive a API oficial. Desligado, o Koda responde
          como sempre.
        </p>
      </section>

      {erro ? (
        <p className="rounded-xl bg-red-500/10 px-4 py-3 text-[12.5px] leading-5 text-red-300">
          Não deu para carregar a economia: {erro}
        </p>
      ) : null}

      {modos === null && !erro ? (
        <div className="flex items-center gap-2 px-1 py-6 text-[12.5px] text-koda-fg/40">
          <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.8} />
          Carregando os modos…
        </div>
      ) : null}

      {modos?.map((modo) => (
        <section
          key={modo.id}
          className="rounded-2xl bg-koda-panel ring-1 ring-koda-fg/8"
        >
          <div className="flex items-start gap-4 px-5 py-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <h3 className="text-[14px] font-semibold text-koda-fg">{modo.nome}</h3>
                <span
                  className={[
                    'rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold tracking-wider uppercase',
                    modo.ligado
                      ? 'bg-koda-accent/15 text-koda-accent'
                      : 'bg-koda-fg/6 text-koda-fg/35',
                  ].join(' ')}
                >
                  {modo.ligado ? 'Ligado' : 'Desligado'}
                </span>
              </div>
              <p className="mt-1 text-[12.5px] leading-5 text-koda-fg/45">{modo.descricao}</p>

              {modo.niveis.length ? (
                <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                  <div className="flex rounded-lg bg-koda-fg/6 p-0.5">
                    {modo.niveis.map((nivel) => {
                      const ativo = modo.nivel === nivel.id
                      return (
                        <button
                          key={nivel.id}
                          type="button"
                          aria-pressed={ativo}
                          disabled={salvando !== null}
                          onClick={() => void mudarNivel(modo, nivel.id)}
                          className={[
                            'rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors',
                            'disabled:cursor-wait disabled:opacity-60',
                            ativo
                              ? 'bg-koda-accent-strong text-white shadow-sm'
                              : 'text-koda-fg/50 hover:text-koda-fg/85',
                          ].join(' ')}
                        >
                          {nivel.nome}
                        </button>
                      )
                    })}
                  </div>
                  <span className="text-[11.5px] leading-4 text-koda-accent/85">
                    {modo.niveis.find((nivel) => nivel.id === modo.nivel)?.descricao}
                  </span>
                </div>
              ) : null}
            </div>

            <button
              type="button"
              role="switch"
              aria-checked={modo.ligado}
              aria-label={`${modo.nome}: ${modo.ligado ? 'ligado' : 'desligado'}`}
              disabled={salvando !== null}
              onClick={() => void alternar(modo)}
              className={[
                'relative mt-1 h-6 w-11 shrink-0 rounded-full transition-colors duration-150',
                'focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none',
                'disabled:cursor-wait disabled:opacity-60',
                modo.ligado ? 'bg-koda-accent-strong' : 'bg-koda-fg/12',
              ].join(' ')}
            >
              <span
                className={[
                  'absolute top-1 h-4 w-4 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.35)] transition-all duration-150',
                  modo.ligado ? 'left-6' : 'left-1',
                ].join(' ')}
              />
            </button>
          </div>
        </section>
      ))}

      {modos?.length ? (
        <p className="px-1 text-[11.5px] leading-4 text-koda-fg/35">
          Context Mode e Ponytail começam ligados. Caveman e Ponytail têm níveis
          Lite/Full/Ultra; os modos de compressão guardam o original: o agente pode
          consultá-lo com a ferramenta <code>consultar_saida</code>.
        </p>
      ) : null}
    </div>
  )
}
