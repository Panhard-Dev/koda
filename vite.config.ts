import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    watch: {
      // A pasta `host/` guarda binários que ficam em execução dentro do projeto. O watcher
      // do Vite tenta abrir o arquivo, leva EBUSY (resource busy or locked) e derruba o
      // servidor de desenvolvimento inteiro — não é erro de HMR, é o processo morrendo.
      // Como nada aqui é código do frontend, o jeito é não vigiar a pasta.
      ignored: ['**/host/**'],
    },
  },
})
