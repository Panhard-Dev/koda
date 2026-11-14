# Dependências para gerar o EXE do Koda

O código fonte e os comandos de build ficam no repositório. A pasta
`C:\Users\panhard\Desktop\dependencias` reúne uma cópia local dos insumos da versão
0.8.0: executáveis do host, runtime portátil de Python e Node, servidores MCP, skills,
manifestos de dependências, JSON de fábrica e um banco SQLite vazio com o esquema atual.

O banco `banco-limpo/koda.db` é só um modelo sem conversas, contas ou credenciais.
O instalador cria o banco da pessoa no primeiro uso. Os arquivos de `data/` gerados
durante o uso, `.env`, tokens, logs e bancos pessoais não devem entrar no PR nem no EXE.
Os logins Google e Antigravity usam, respectivamente, `KODA_GOOGLE_CLIENT_ID` e
`KODA_ANTIGRAVITY_CLIENT_ID` no ambiente. Configure esses IDs de cliente OAuth no
computador que executará o aplicativo; eles não são gravados no repositório.

## Gerar o instalador neste computador

Abra o PowerShell na raiz do repositório e execute:

```powershell
$env:PATH = 'C:\Users\panhard\.cargo\bin;' + $env:PATH
npm run app:host
npm run verificar
npm run app:build
```

O build usa `node_modules`, `backend/.venv`, Node 22+ x64, Rust MSVC e as ferramentas
de C++ do Visual Studio instalados neste computador. O script `app:build` recria
`src-tauri/runtime/backend` e `src-tauri/runtime/node` antes de empacotar. Se precisar
refazer o ambiente Python, instale as versões de `backend/requirements.txt` (inclui
as bibliotecas de vídeo) e consulte `COMO-REFAZER-O-AMBIENTE.txt` nesta pasta.
O kit inclui também cópias de `node_modules` e `backend/.venv` em `build-local/`.
Elas aceleram a recomposição neste mesmo computador. A virtualenv guarda um caminho
absoluto para o Python e precisa ser recriada em outra máquina.

O resultado da versão 0.8.0 fica em:

```text
src-tauri/target/release/bundle/nsis/Koda_0.8.0_x64-setup.exe
src-tauri/target/release/bundle/msi/Koda_0.8.0_x64_pt-BR.msi
```

Confira a data e o SHA-256 dos arquivos gerados antes de distribuir. O roteiro
detalhado está em `COMO-GERAR-INSTALADORES-2026-10-23.md`, copiado para esta pasta.
Ele registra uma geração anterior e usa nomes da versão 0.7.9 nos exemplos; substitua
esses nomes pela versão atual.

## Conteúdo da pasta

- `host/`: binários exigidos pelo pacote.
- `runtime/backend` e `runtime/node`: dependências portáteis que o instalador leva.
- `build-local/`: dependências já instaladas usadas pelo processo de build nesta máquina.
- `mcp/` e `skills/`: recursos distribuídos com o aplicativo.
- `json/`: configurações de fábrica, sem dados de conta.
- `banco-limpo/koda.db`: esquema SQLite vazio para conferência.
- `manifestos/`: arquivos que fixam ou descrevem as dependências do build.

Essa pasta é um kit local de referência. O build continua sendo executado na raiz
do repositório, onde estão o código fonte e o toolchain Rust/MSVC.
