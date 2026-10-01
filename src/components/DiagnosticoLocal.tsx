import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Loader2, RefreshCw, Stethoscope } from 'lucide-react'
import { DENTRO_DO_TAURI } from './WindowControls'

/**
 * O retrato do serviço local que o app monta sozinho (`diagnostico` no lado Rust).
 *
 * Existe porque um app instalado não tem onde olhar: quando o Koda foi para outro PC, a
 * única pista era uma frase na tela dizendo que o backend respondeu 422 — sem dizer se o
 * Python empacotado subiu, se a porta estava ocupada, nem onde estava o log.
 */
type Diagnostico = {
  versao: string
  /** O backend é o do instalador ou o `backend/.venv` do projeto? */
  empacotado: boolean
  hostPorta: number
  hostNoAr: boolean
  backendPorta: number
  backendNoAr: boolean
  python: string | null
  pythonExiste: boolean
  pythonVersao: string | null
  /** Vazio quando o interpretador importa `uvicorn` e `fastapi`; senão, o erro dele. */
  pythonModulos: string | null
  banco: string | null
  logDesktop: string
  logBackend: string
  /** Últimas linhas do log do backend — o que ele escreveu ao subir, ou ao morrer. */
  backendUltimas: string[]
}

function bolinha(noAr: boolean) {
  return noAr ? 'bg-emerald-400' : 'bg-red-400'
}

function Linha({ nome, valor }: { nome: string; valor: string }) {
  return (
    <div className="flex flex-col gap-1 border-b border-koda-fg/8 px-5 py-3 last:border-b-0 sm:flex-row sm:items-start sm:gap-4">
      <dt className="w-32 shrink-0 text-koda-fg/45">{nome}</dt>
      <dd className="min-w-0 break-all font-mono text-[12.5px] text-koda-fg/85">{valor}</dd>
    </div>
  )
}

/** Diagnóstico do serviço local: o que o app consegue ver sozinho, sem pedir nada a ninguém. */
export default function DiagnosticoLocal() {
  const [dados, setDados] = useState<Diagnostico | null>(null)
  const [carregando, setCarregando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [copiado, setCopiado] = useState(false)

  if (!DENTRO_DO_TAURI) return null

  const verificar = async () => {
    setCarregando(true)
    setErro(null)
    try {
      setDados(await invoke<Diagnostico>('diagnostico'))
    } catch (falha) {
      setErro(falha instanceof Error ? falha.message : String(falha))
    } finally {
      setCarregando(false)
    }
  }

  const texto = (diagnostico: Diagnostico) =>
    [
      `Koda v${diagnostico.versao} (${diagnostico.empacotado ? 'instalado' : 'do projeto'})`,
      `backend: ${diagnostico.backendNoAr ? 'no ar' : 'fora do ar'} em 127.0.0.1:${diagnostico.backendPorta}`,
      `host: ${diagnostico.hostNoAr ? 'no ar' : 'fora do ar'} em 127.0.0.1:${diagnostico.hostPorta}`,
      `python: ${diagnostico.python ?? '(não encontrado)'}`,
      `python versão: ${diagnostico.pythonVersao ?? '—'}`,
      `módulos (uvicorn/fastapi): ${diagnostico.pythonModulos === '' ? 'ok' : (diagnostico.pythonModulos ?? '—')}`,
      `banco: ${diagnostico.banco ?? '—'}`,
      `log do app: ${diagnostico.logDesktop}`,
      `log do backend: ${diagnostico.logBackend}`,
      '--- últimas linhas do backend ---',
      ...diagnostico.backendUltimas,
    ].join('\n')

  const copiar = async (diagnostico: Diagnostico) => {
    try {
      await navigator.clipboard.writeText(texto(diagnostico))
      setCopiado(true)
      window.setTimeout(() => setCopiado(false), 1400)
    } catch {
      // Sem área de transferência: o texto está na tela para copiar à mão.
    }
  }

  const modulosOk = dados?.pythonModulos === ''

  return (
    <section className="rounded-2xl bg-koda-panel ring-1 ring-koda-fg/8">
      <header className="flex flex-wrap items-start gap-3 px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-koda-fg">Serviço local</h2>
          <p className="mt-1 text-[13px] leading-5 text-koda-fg/45">
            Este é o retrato do serviço local — o backend em Python que responde às suas
            mensagens. Ele fica aqui, em <span className="text-koda-fg/70">Ajustes › Sobre</span>.
            Clique em <span className="text-koda-fg/70">«Ver diagnóstico»</span> e o app confere
            na hora, nesta ordem: se a API local e os serviços de modelos estão no ar; se o
            Python que o app traz consigo importa <span className="text-koda-fg/70">uvicorn</span> e{' '}
            <span className="text-koda-fg/70">fastapi</span>; onde ficam o banco e os arquivos de
            log; as portas em uso; e as últimas linhas que o backend escreveu. É isso que explica
            uma conversa que não responde. O botão <span className="text-koda-fg/70">«copiar
            diagnóstico»</span> leva o texto inteiro, pronto para colar.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void verificar()}
          disabled={carregando}
          className="ml-auto inline-flex shrink-0 items-center gap-2 rounded-lg bg-koda-fg/8 px-3 py-1.5 text-[12.5px] font-medium text-koda-fg/80 transition-colors duration-150 hover:bg-koda-fg/12 focus-visible:outline-none disabled:opacity-50"
        >
          {carregando ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
          ) : (
            <Stethoscope className="h-3.5 w-3.5" strokeWidth={1.8} />
          )}
          {dados ? 'Verificar de novo' : 'Ver diagnóstico'}
        </button>
      </header>

      {erro ? (
        <p className="border-t border-koda-fg/8 px-5 py-3.5 text-[12.5px] text-red-400/90">
          Não consegui rodar o diagnóstico: {erro}
        </p>
      ) : null}

      {dados ? (
        <>
          <div className="flex flex-wrap items-center gap-3 border-t border-koda-fg/8 px-5 py-3.5 text-[12.5px]">
            <span className="flex items-center gap-2 text-koda-fg/80">
              <span className={`h-2 w-2 rounded-full ${bolinha(dados.backendNoAr)}`} />
              API local {dados.backendNoAr ? 'no ar' : 'fora do ar'}
            </span>
            <span className="flex items-center gap-2 text-koda-fg/80">
              <span className={`h-2 w-2 rounded-full ${bolinha(dados.hostNoAr)}`} />
              serviços de modelos {dados.hostNoAr ? 'no ar' : 'fora do ar'}
            </span>
            <span className="flex items-center gap-2 text-koda-fg/80">
              <span className={`h-2 w-2 rounded-full ${bolinha(modulosOk)}`} />
              Python do app {modulosOk ? 'ok' : 'com problema'}
            </span>
            <button
              type="button"
              onClick={() => void copiar(dados)}
              className="ml-auto rounded-lg px-2.5 py-1 text-[12px] text-koda-fg/55 transition-colors duration-150 hover:bg-koda-fg/8 hover:text-koda-fg/85 focus-visible:outline-none"
            >
              {copiado ? 'copiado' : 'copiar diagnóstico'}
            </button>
          </div>

          <dl className="border-t border-koda-fg/8 text-[13px]">
            <Linha nome="Versão" valor={`v${dados.versao} · ${dados.empacotado ? 'instalado' : 'do projeto'}`} />
            <Linha nome="Python" valor={dados.python ?? '(não encontrado)'} />
            <Linha
              nome="Interpretador"
              valor={
                dados.pythonVersao
                  ? `${dados.pythonVersao}${modulosOk ? ' · uvicorn e fastapi ok' : ''}`
                  : 'não consegui rodar'
              }
            />
            {!modulosOk && dados.pythonModulos ? (
              <Linha nome="Erro do Python" valor={dados.pythonModulos} />
            ) : null}
            <Linha nome="Banco" valor={dados.banco ?? '—'} />
            <Linha nome="Log do app" valor={dados.logDesktop} />
            <Linha nome="Log do backend" valor={dados.logBackend} />
            <Linha
              nome="Portas"
              valor={`API ${dados.backendPorta} · modelos ${dados.hostPorta}`}
            />
          </dl>

          <div className="border-t border-koda-fg/8 px-5 py-4">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[10.5px] tracking-wide text-koda-fg/40 uppercase">
                últimas linhas do backend
              </span>
              <RefreshCw
                className="h-3 w-3 text-koda-fg/25"
                strokeWidth={1.8}
                onClick={() => void verificar()}
              />
            </div>
            <pre className="max-h-64 overflow-auto rounded-xl bg-koda-fg/4 p-3 font-mono text-[11.5px] leading-5 text-koda-fg/70 ring-1 ring-koda-fg/8">
              {dados.backendUltimas.length > 0
                ? dados.backendUltimas.join('\n')
                : '(o backend ainda não escreveu nada)'}
            </pre>
          </div>
        </>
      ) : null}
    </section>
  )
}
