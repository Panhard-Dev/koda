import { copyFileSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')
const versao = JSON.parse(readFileSync(join(raiz, 'src-tauri', 'tauri.conf.json'), 'utf8')).version
const pastaBundle = join(raiz, 'src-tauri', 'target', 'release', 'bundle', 'nsis')
const instaladorNsis = join(pastaBundle, `Koda_${versao}_x64-setup.exe`)
const instaladorInterno = join(pastaBundle, `Koda_${versao}_x64-setup-nsis.exe`)
const simbolos = join(pastaBundle, `Koda_${versao}_x64-setup.pdb`)
const fonte = join(raiz, 'scripts', 'installer-launcher', 'main.rs')
const assinaturaLauncher = Buffer.from('KODA_TEMP_OVERRIDE_WRAPPER_V1')

const mb = (caminho) => (statSync(caminho).size / 1048576).toFixed(1)

const publicoExiste = existsSync(instaladorNsis)
const jaEhLauncher = publicoExiste && readFileSync(instaladorNsis).includes(assinaturaLauncher)

if (jaEhLauncher) {
  // Já está pronto. Recompilar daria o mesmo arquivo, e o NSIS interno não é mantido entre
  // execuções (ver o `rmSync` no fim) — então não há de onde tirá-lo.
  console.log(`Lançador universal já pronto: ${instaladorNsis} (${mb(instaladorNsis)} MB)`)
  process.exit(0)
}

if (!publicoExiste) {
  throw new Error(`O instalador NSIS não existe: ${instaladorNsis}`)
}

// O `tauri build` acabou de gravar o NSIS real neste nome — ele é a fonte do que vai ser
// embutido no lançador. O sufixo `-nsis` é só o nome de trabalho durante a compilação:
// o arquivo é apagado no fim, para não sobrar intermediário na pasta do bundle.
copyFileSync(instaladorNsis, instaladorInterno)

const resultado = spawnSync(
  'rustc',
  [
    '--edition=2021',
    '-C',
    'opt-level=s',
    '-C',
    'panic=abort',
    // Sem isto o linker do MSVC grava um `.pdb` ao lado do executável — símbolo de
    // depuração de um lançador de 20 KB, que não serve para nada e só suja a pasta.
    '-C',
    'debuginfo=0',
    '-o',
    instaladorNsis,
    fonte,
  ],
  {
    env: { ...process.env, KODA_INNER_INSTALLER: instaladorInterno },
    encoding: 'utf8',
    stdio: 'inherit',
  },
)

if (resultado.error) throw resultado.error
if (resultado.status !== 0) {
  throw new Error(`Falha ao criar o lançador do instalador (rustc saiu com ${resultado.status}).`)
}

// A pasta do bundle fica só com o que se distribui: o lançador. O NSIS interno e o
// `.pdb` (se o linker ainda gravar um) saem daqui.
for (const resto of [instaladorInterno, simbolos]) {
  rmSync(resto, { force: true })
}

console.log(`Lançador universal gerado: ${instaladorNsis} (${mb(instaladorNsis)} MB)`)
