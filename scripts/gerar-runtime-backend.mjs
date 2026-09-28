/**
 * Monta o runtime do backend que vai **dentro do instalador**.
 *
 * O app instalado tem que subir o backend sozinho, e para isso precisa de um Python na
 * própria pasta de instalação: a máquina de destino não tem projeto, não tem `uv` e pode
 * não ter Python nenhum. Este script monta
 *
 *   src-tauri/runtime/backend/
 *     python/   interpretador portátil + as dependências que o backend usa
 *     app/      o código do backend
 *
 * a partir do ambiente virtual que já existe em `backend/.venv` — a fonte da verdade das
 * dependências continua sendo o `pyproject.toml` do backend; isto aqui só empacota o que
 * o `uv` já resolveu.
 *
 * O interpretador sai do `home` do `pyvenv.cfg`: o `.venv` não tem o Python dentro, ele
 * aponta para onde o `uv` o instalou. Como a pasta do `uv` é completa (Lib, DLLs,
 * `vcruntime140.dll`), ela roda em qualquer Windows sem instalar nada.
 *
 * Rode com `node scripts/gerar-runtime-backend.mjs` (o `npm run app:build` faz isso).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..')
const VENV = join(RAIZ, 'backend', '.venv')
const DESTINO = join(RAIZ, 'src-tauri', 'runtime', 'backend')

/** Pasta do interpretador, do jeito que o `.venv` a registra. */
function interpretador() {
  const pyvenv = join(VENV, 'pyvenv.cfg')
  if (!existsSync(pyvenv)) {
    throw new Error(`não achei ${pyvenv} — rode "cd backend && uv sync" antes de empacotar`)
  }
  const linha = readFileSync(pyvenv, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.toLowerCase().startsWith('home'))
  const home = linha?.split('=')[1]?.trim()
  if (!home || !existsSync(join(home, 'python.exe'))) {
    throw new Error(`o "home" do pyvenv.cfg não tem python.exe: ${home ?? '(vazio)'}`)
  }
  return home
}

/**
 * Fora do pacote: lixo do próprio venv e o que só serve para desenvolver.
 *
 * `_virtualenv.pth` sai porque roda na inicialização do Python e tenta reconfigurar os
 * caminhos do venv — dentro do interpretador portátil ele é corpo estranho. O `pip` sai
 * porque instalar pacote dentro da pasta de instalação não é coisa que se faça.
 */
const FORA = [
  /[\\/]_virtualenv\.pth$/,
  /[\\/]_virtualenv\.py$/,
  /[\\/]pip$/,
  /[\\/]pip-[^\\/]*\.dist-info$/,
  /[\\/]__pycache__$/,
  /[\\/]\.pytest_cache$/,
]

const incluir = (caminho) => !FORA.some((padrao) => padrao.test(caminho))

/**
 * Copia recursivamente respeitando o filtro.
 *
 * `dereference` é obrigatório: o `uv` guarda o Python numa pasta versionada
 * (`cpython-3.13.14-…`) e deixa `cpython-3.13-…` como **symlink** para ela. Sem seguir o
 * link, o pacote levava o link e não os 61 MB do interpretador — e o instalador sairia
 * apontando para uma pasta do `uv` que na máquina do cliente não existe.
 */
function copia(origem, destino) {
  cpSync(origem, destino, { recursive: true, filter: incluir, dereference: true })
}

const python = interpretador()
console.log(`interpretador: ${python}`)

rmSync(DESTINO, { recursive: true, force: true })
mkdirSync(DESTINO, { recursive: true })

// 1. O interpretador inteiro, do jeito que ele é.
copia(python, join(DESTINO, 'python'))

// 2. As dependências do backend por cima do `site-packages` dele.
const siteOrigem = join(VENV, 'Lib', 'site-packages')
const siteDestino = join(DESTINO, 'python', 'Lib', 'site-packages')
mkdirSync(siteDestino, { recursive: true })
for (const item of readdirSync(siteOrigem)) {
  copia(join(siteOrigem, item), join(siteDestino, item))
}

// 3. O código do backend.
copia(join(RAIZ, 'backend', 'app'), join(DESTINO, 'app'))

let arquivos = 0
let bytes = 0
;(function conta(pasta) {
  for (const entrada of readdirSync(pasta, { withFileTypes: true })) {
    const caminho = join(pasta, entrada.name)
    if (entrada.isDirectory()) conta(caminho)
    else {
      arquivos += 1
      bytes += statSync(caminho).size
    }
  }
})(DESTINO)

console.log(
  `runtime gerado em ${relative(RAIZ, DESTINO).split(sep).join('/')} ` +
    `(${arquivos} arquivos, ${(bytes / 1048576).toFixed(1)} MB)`,
)
