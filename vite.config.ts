import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'

/**
 * Só em desenvolvimento: serve um arquivo do disco para o navegador do Painel Dev.
 *
 * ## Por que isto existe
 *
 * O navegador **proíbe** uma página servida por http(s) de carregar `file://` num iframe. É
 * regra de segurança do navegador, não tem contorno do lado do JavaScript. No app instalado o
 * caminho é outro — o protocolo `asset` do Tauri (`assetProtocol` no `tauri.conf.json` +
 * `convertFileSrc`), que o webview aceita. Mas em dev não há Tauri, então sem isto o Painel
 * Dev não abre arquivo local nenhum e o dono fica sem a ferramenta justo quando está
 * desenvolvendo.
 *
 * A saída é o próprio servidor de dev servir o disco: `/@local/C:/pasta/arquivo.html`.
 *
 * ## O preço, dito sem enfeite
 *
 * Enquanto `npm run dev` estiver no ar, **qualquer página aberta neste navegador** consegue
 * pedir arquivos do disco por esse caminho — inclusive os seus. É por isso que o plugin é
 * `apply: 'serve'`: ele **não existe** no build, não vai para o `dist` e não tem como chegar
 * ao app instalado. Se um dia essa conveniência incomodar mais do que ajuda, apagar este
 * plugin quebra só o dev.
 */
function arquivoLocal(): Plugin {
  /** O que o navegador precisa saber para desenhar cada tipo em vez de baixar. */
  const TIPOS: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
    '.csv': 'text/plain; charset=utf-8',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.pdf': 'application/pdf',
  }

  const escapar = (texto: string) =>
    texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  /** Uma pasta vira uma listagem simples, como o navegador faz com `file://`. */
  const listar = (pasta: string) => {
    const itens = readdirSync(pasta, { withFileTypes: true })
      .filter((item) => !item.name.startsWith('.'))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    const linhas = itens
      .map((item) => {
        const alvo = `${pasta.replace(/\\/g, '/')}/${item.name}${item.isDirectory() ? '/' : ''}`
        const href = `/@local/${encodeURI(alvo)}`
        return `<li><a href="${href}">${escapar(item.name)}${item.isDirectory() ? '/' : ''}</a></li>`
      })
      .join('')
    const pai = pasta.replace(/\\/g, '/').replace(/\/[^/]+\/?$/, '')
    const voltar = pai && pai !== pasta ? `<li><a href="/@local/${encodeURI(pai)}">..</a></li>` : ''
    return `<!doctype html><meta charset="utf-8"><title>${escapar(pasta)}</title>
<style>
  body { background: #fff; color: #111; font: 14px/1.7 system-ui, sans-serif; padding: 20px }
  h1 { font-size: 14px; font-weight: 500; margin: 0 0 12px; word-break: break-all }
  ul { list-style: none; margin: 0; padding: 0 }
  a { color: #1a56db; text-decoration: none }
  a:hover { text-decoration: underline }
</style>
<h1>${escapar(pasta)}</h1><ul>${voltar}${linhas}</ul>`
  }

  return {
    name: 'koda-arquivo-local',
    apply: 'serve',
    configureServer(servidor) {
      servidor.middlewares.use('/@local', (requisicao, resposta) => {
        const bruto = (requisicao.url ?? '').split('?')[0]
        // `/@local/C:/pasta/x.html` chega aqui como `/C:/pasta/x.html`; a barra da frente não
        // faz parte do caminho do Windows.
        const alvo = decodeURIComponent(bruto.replace(/^\//, ''))
        if (!alvo) {
          resposta.statusCode = 400
          resposta.end('sem caminho')
          return
        }

        let info
        try {
          info = statSync(alvo)
        } catch {
          resposta.statusCode = 404
          resposta.setHeader('Content-Type', 'text/plain; charset=utf-8')
          resposta.end(`não encontrei: ${alvo}`)
          return
        }

        try {
          if (info.isDirectory()) {
            resposta.setHeader('Content-Type', 'text/html; charset=utf-8')
            resposta.end(listar(alvo))
            return
          }
          resposta.setHeader(
            'Content-Type',
            TIPOS[extname(alvo).toLowerCase()] ?? 'application/octet-stream',
          )
          resposta.end(readFileSync(alvo))
        } catch (erro) {
          resposta.statusCode = 500
          resposta.setHeader('Content-Type', 'text/plain; charset=utf-8')
          resposta.end(`não consegui ler: ${(erro as Error).message}`)
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), arquivoLocal()],
  server: {
    // **`127.0.0.1`, e não o padrão.** Sem isto o Vite escuta só em `[::1]` nesta máquina, e
    // `http://127.0.0.1:5173` — o endereço que a mão digita — dá conexão recusada. O sintoma
    // engana: parece servidor fora do ar, e o servidor está no ar, só em IPv6.
    //
    // `127.0.0.1` e não `0.0.0.0`: o servidor de dev tem o plugin que serve o disco inteiro
    // (`/@local/`), e isso não pode ficar exposto na rede local.
    host: '127.0.0.1',
    watch: {
      // A pasta `host/` guarda binários que ficam em execução dentro do projeto. O watcher
      // do Vite tenta abrir o arquivo, leva EBUSY (resource busy or locked) e derruba o
      // servidor de desenvolvimento inteiro — não é erro de HMR, é o processo morrendo.
      // Como nada aqui é código do frontend, o jeito é não vigiar a pasta. O mesmo vale
      // para o estado de ferramenta (`.mimosa/`), os artefatos do Tauri
      // (`src-tauri/target`) e o ambiente virtual do backend (`backend/.venv`).
      ignored: [
        '**/host/**',
        '**/.mimosa/**',
        '**/src-tauri/target/**',
        '**/backend/.venv/**',
      ],
    },
  },
})
