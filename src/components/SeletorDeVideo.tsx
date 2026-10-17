import { useEffect, useState } from 'react'
import {
  ChevronUp,
  FileVideo,
  Folder,
  HardDrive,
  Loader2,
  Video,
  X,
} from 'lucide-react'
import { listVideos } from '../api/client'
import type { Videos } from '../api/client'

/**
 * Seletor de vídeo — a mesma cara do «Pasta de trabalho» (`ProjectPicker`), para
 * ninguém precisar encarar o diálogo do sistema.
 *
 * Navega de pasta em pasta pelos **atalhos e subpastas** (a mesma rota do seletor de
 * pastas) e lista os **vídeos** da pasta atual. Clicar num vídeo devolve o caminho —
 * quem carrega os bytes é o editor, pelo backend.
 */
export function SeletorDeVideo({
  onFechar,
  onEscolher,
}: {
  onFechar: () => void
  onEscolher: (caminho: string) => void
}) {
  const [lista, setLista] = useState<Videos | null>(null)
  const [carregando, setCarregando] = useState(true)
  const [falha, setFalha] = useState<string | null>(null)

  const ir = (caminho?: string | null) => {
    setCarregando(true)
    setFalha(null)
    listVideos(caminho)
      .then((dados) => {
        setLista(dados)
        setCarregando(false)
      })
      .catch(() => {
        setFalha('Não consegui ler essa pasta.')
        setCarregando(false)
      })
  }

  useEffect(() => {
    let cancelado = false
    listVideos(null)
      .then((dados) => {
        if (!cancelado) {
          setLista(dados)
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

  const caminhoAtual = lista?.caminho ?? ''

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/45 p-4 sm:items-center">
      <div className="msg-in w-full max-w-xl overflow-hidden rounded-2xl bg-koda-panel ring-1 ring-koda-fg/12">
        <div className="flex items-center gap-2 border-b border-koda-fg/8 px-4 py-3">
          <Video className="h-4 w-4 shrink-0 text-koda-accent" strokeWidth={1.7} />
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-semibold text-koda-fg">Escolher vídeo</p>
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

        <div className="max-h-80 overflow-y-auto px-2 py-2">
          {lista && (lista.atalhos.length > 0 || lista.unidades.length > 0) ? (
            <div className="flex flex-wrap gap-1.5 px-1.5 pb-2">
              {[...lista.unidades, ...lista.atalhos].map((atalho) => (
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

          {lista?.pai ? (
            <button
              type="button"
              onClick={() => ir(lista.pai)}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-koda-fg/60 transition-colors hover:bg-koda-fg/6 hover:text-koda-fg focus-visible:outline-none"
            >
              <ChevronUp className="h-4 w-4 shrink-0" strokeWidth={1.7} />
              Subir uma pasta
            </button>
          ) : null}

          {carregando ? (
            <p className="flex items-center gap-2 px-2.5 py-3 text-[12.5px] text-koda-fg/45">
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
              Lendo…
            </p>
          ) : falha ? (
            <p className="px-2.5 py-3 text-[12.5px] text-koda-fg/45">{falha}</p>
          ) : (
            <>
              {lista?.pastas.map((pasta) => (
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
              ))}

              {lista && lista.videos.length > 0 ? (
                <>
                  <p className="px-2.5 pt-2 pb-1 text-[11px] font-medium tracking-wide text-koda-fg/55 uppercase">
                    Vídeos desta pasta
                  </p>
                  {lista.videos.map((arquivo) => (
                    <button
                      key={arquivo.caminho}
                      type="button"
                      onClick={() => onEscolher(arquivo.caminho)}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-koda-fg/6 focus-visible:outline-none"
                    >
                      <FileVideo
                        className="h-4 w-4 shrink-0 text-koda-accent"
                        strokeWidth={1.7}
                      />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-koda-fg/85">
                        {arquivo.nome}
                      </span>
                    </button>
                  ))}
                </>
              ) : (
                <p className="px-2.5 py-3 text-[12.5px] text-koda-fg/40">
                  Nenhum vídeo nesta pasta. Entre numa pasta que tenha mp4, webm, mov,
                  m4v ou ogv.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default SeletorDeVideo
