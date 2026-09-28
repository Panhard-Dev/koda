import { useEffect, useState } from 'react'
import { ChevronUp, CornerDownRight, Folder, FolderPlus, HardDrive, Loader2, X } from 'lucide-react'
import { listFolders } from '../api/client'
import type { Pastas } from '../api/client'

/**
 * Escolher a pasta onde o Koda vai trabalhar.
 *
 * Nada de nome inventado: a pessoa abre a pasta que existe no disco, ou cria uma nova
 * dentro da que estiver aberta. O caminho completo é o que fica salvo — é ele que abre a
 * mesma pasta em qualquer PC.
 *
 * O navegador é do próprio app (o backend lista as subpastas) em vez de um diálogo do
 * sistema: funciona igual no app instalado e no navegador de desenvolvimento, e nunca
 * fica preso a um permissão do Windows.
 */
export function ProjectPicker({
  onFechar,
  onUsar,
  onCriar,
  ocupado = false,
  erro = null,
}: {
  onFechar: () => void
  onUsar: (caminho: string) => void
  onCriar: (pastaPai: string, nome: string) => void
  ocupado?: boolean
  erro?: string | null
}) {
  const [aba, setAba] = useState<'existente' | 'nova'>('existente')
  const [pastas, setPastas] = useState<Pastas | null>(null)
  const [nome, setNome] = useState('')
  const [carregando, setCarregando] = useState(true)
  const [falha, setFalha] = useState<string | null>(null)

  const ir = (caminho?: string | null) => {
    setCarregando(true)
    setFalha(null)
    listFolders(caminho)
      .then((lista) => {
        setPastas(lista)
        setCarregando(false)
      })
      .catch(() => {
        setFalha('Não consegui ler essa pasta.')
        setCarregando(false)
      })
  }

  useEffect(() => {
    let cancelado = false
    listFolders(null)
      .then((lista) => {
        if (!cancelado) {
          setPastas(lista)
          setCarregando(false)
        }
      })
      .catch(() => {
        if (!cancelado) {
          setFalha('Não consegui ler as suas pastas.')
          setCarregando(false)
        }
      })
    return () => {
      cancelado = true
    }
  }, [])

  const caminhoAtual = pastas?.caminho ?? ''

  const abaClasse = (valor: 'existente' | 'nova') =>
    [
      'flex-1 rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors duration-150',
      aba === valor
        ? 'bg-koda-surface text-koda-fg ring-1 ring-koda-fg/10'
        : 'text-koda-fg/55 hover:text-koda-fg/85',
    ].join(' ')

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/45 p-4 sm:items-center">
      <div className="msg-in w-full max-w-xl overflow-hidden rounded-2xl bg-koda-panel ring-1 ring-koda-fg/12">
        <div className="flex items-center gap-2 border-b border-koda-fg/8 px-4 py-3">
          <Folder className="h-4 w-4 shrink-0 text-koda-accent" strokeWidth={1.7} />
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-semibold text-koda-fg">Pasta de trabalho</p>
            <p className="truncate text-[11.5px] text-koda-fg/45">{caminhoAtual}</p>
          </div>
          <button
            type="button"
            aria-label="Fechar"
            onClick={onFechar}
            className="shrink-0 rounded-lg p-1.5 text-koda-fg/45 transition-colors hover:bg-koda-fg/8 hover:text-koda-fg focus-visible:outline-none"
          >
            <X className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </div>

        <div className="flex gap-1 bg-koda-fg/4 p-1">
          <button type="button" onClick={() => setAba('existente')} className={abaClasse('existente')}>
            Usar pasta existente
          </button>
          <button type="button" onClick={() => setAba('nova')} className={abaClasse('nova')}>
            Começar do zero
          </button>
        </div>

        <div className="max-h-80 overflow-y-auto px-2 py-2">
          {pastas && (pastas.atalhos.length > 0 || pastas.unidades.length > 0) ? (
            <div className="flex flex-wrap gap-1.5 px-1.5 pb-2">
              {[...pastas.unidades, ...pastas.atalhos].map((atalho) => (
                <button
                  key={atalho.caminho}
                  type="button"
                  onClick={() => ir(atalho.caminho)}
                  className="flex items-center gap-1.5 rounded-lg bg-koda-fg/6 px-2 py-1 text-[12px] text-koda-fg/70 transition-colors hover:bg-koda-fg/12 hover:text-koda-fg focus-visible:outline-none"
                >
                  <HardDrive className="h-3 w-3" strokeWidth={1.7} />
                  {atalho.nome}
                </button>
              ))}
            </div>
          ) : null}

          {pastas?.pai ? (
            <button
              type="button"
              onClick={() => ir(pastas.pai)}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-koda-fg/60 transition-colors hover:bg-koda-fg/6 hover:text-koda-fg focus-visible:outline-none"
            >
              <ChevronUp className="h-4 w-4 shrink-0" strokeWidth={1.7} />
              Subir uma pasta
            </button>
          ) : null}

          {carregando ? (
            <p className="flex items-center gap-2 px-2.5 py-3 text-[12.5px] text-koda-fg/45">
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
              Lendo as pastas…
            </p>
          ) : pastas && pastas.pastas.length > 0 ? (
            pastas.pastas.map((pasta) => (
              <button
                key={pasta.caminho}
                type="button"
                onClick={() => ir(pasta.caminho)}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-koda-fg/6 focus-visible:outline-none"
              >
                <Folder className="h-4 w-4 shrink-0 text-koda-fg/45" strokeWidth={1.7} />
                <span className="min-w-0 flex-1 truncate text-[13px] text-koda-fg/85">
                  {pasta.nome}
                </span>
              </button>
            ))
          ) : (
            <p className="px-2.5 py-3 text-[12.5px] text-koda-fg/45">
              Nenhuma subpasta aqui.
            </p>
          )}
        </div>

        {falha || erro ? (
          <p role="alert" className="px-4 pb-2 text-[12px] text-red-400">
            {falha ?? erro}
          </p>
        ) : null}

        <div className="border-t border-koda-fg/8 px-4 py-3">
          {aba === 'existente' ? (
            <div className="flex items-center justify-between gap-3">
              <p className="min-w-0 flex-1 truncate text-[11.5px] leading-4 text-koda-fg/45">
                O Koda vai trabalhar dentro de <span className="text-koda-fg/70">{caminhoAtual}</span>.
              </p>
              <button
                type="button"
                disabled={ocupado || !caminhoAtual}
                onClick={() => onUsar(caminhoAtual)}
                className="flex shrink-0 items-center gap-1.5 rounded-xl bg-koda-accent-strong px-3 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-koda-accent-strong/85 focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none disabled:opacity-50"
              >
                {ocupado ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} /> : <CornerDownRight className="h-3.5 w-3.5" strokeWidth={1.9} />}
                Usar esta pasta
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <FolderPlus className="h-4 w-4 shrink-0 text-koda-fg/45" strokeWidth={1.7} />
              <input
                autoFocus
                value={nome}
                onChange={(evento) => setNome(evento.target.value)}
                onKeyDown={(evento) => {
                  if (evento.key === 'Enter' && nome.trim() && caminhoAtual) {
                    onCriar(caminhoAtual, nome.trim())
                  }
                }}
                placeholder="nome da pasta nova"
                maxLength={120}
                className="h-9 min-w-0 flex-1 rounded-xl bg-koda-input px-3 text-[13px] text-koda-fg ring-1 ring-koda-fg/10 outline-none placeholder:text-koda-fg/30 focus:ring-2 focus:ring-koda-accent"
              />
              <button
                type="button"
                disabled={ocupado || !nome.trim() || !caminhoAtual}
                onClick={() => onCriar(caminhoAtual, nome.trim())}
                className="flex shrink-0 items-center gap-1.5 rounded-xl bg-koda-accent-strong px-3 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-koda-accent-strong/85 focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none disabled:opacity-50"
              >
                {ocupado ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                ) : (
                  <FolderPlus className="h-3.5 w-3.5" strokeWidth={1.9} />
                )}
                Criar aqui
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default ProjectPicker
