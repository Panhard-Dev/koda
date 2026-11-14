# Como gerar os instaladores do Koda no Windows

Este roteiro usa o projeto em `C:\Users\panhard\Downloads\Koda-TUDO-2026-10-17\koda` e gera os dois pacotes da versão definida em `package.json` e `src-tauri/tauri.conf.json`: instalador NSIS (`.exe`) e MSI (`.msi`). Os dois arquivos são recriados com o mesmo nome se a versão não mudar. Confira sempre a data e o hash antes de distribuir.

## 1. Abra o PowerShell na pasta certa

```powershell
cd C:\Users\panhard\Downloads\Koda-TUDO-2026-10-17\koda
```

Use esta janela até o fim; as variáveis configuradas nela não passam para outra janela.

## 2. Confira as ferramentas

```powershell
$env:PATH = 'C:\Users\panhard\.cargo\bin;' + $env:PATH
node --version
npm --version
cargo --version
rustc --version
Test-Path backend\.venv\pyvenv.cfg
Test-Path host\c-host.exe
```

O Node precisa ser x64 e versão 22 ou superior. `cargo` e `rustc` precisam funcionar. O ambiente `backend\.venv` precisa ter as dependências do backend; `backend\.venv\pyvenv.cfg` aponta para o Python 3.13 usado no pacote. Se esse Python foi movido ou apagado, recrie o ambiente com `uv sync` dentro de `backend` antes de gerar o instalador. O Rust para Windows precisa do toolchain MSVC e das ferramentas de compilação C++ do Visual Studio. O Tauri usa NSIS e WiX para criar os dois formatos.

Na primeira preparação, se `node_modules` não existir, rode `npm ci` na raiz. Para os testes do Worker, rode `npm ci` também na pasta `server`. Se `backend\.venv` não existir, instale o `uv`, entre em `backend`, rode `uv sync --extra test` e volte à raiz. Essas instalações iniciais são dispensáveis nas próximas gerações enquanto as dependências não mudarem.

## 3. Confira o host e rode os testes principais

```powershell
npm run app:host
node --test server\tests\*.test.mjs
npm run verificar
```

`app:host` compara o tamanho de `host\c-host.exe` com `KODA_HOST_BYTES` em `src-tauri\installer\hooks.nsh`. Se o host foi recompilado, atualize esse número para o tamanho exato. `npm run verificar` pode mostrar avisos de lint e ainda assim terminar com código 0.

Para testar o backend com o Python deste projeto, abra `backend`, configure o diretório temporário e execute:

```powershell
cd backend
New-Item -ItemType Directory -Force .test-temp | Out-Null
$env:TEMP = (Resolve-Path .test-temp).Path
$env:TMP = $env:TEMP
$env:PYTHONPATH = (Resolve-Path .venv\Lib\site-packages).Path
& 'C:\Users\panhard\.workbuddy-ai\binaries\python\versions\3.13.12\python.exe' -m pytest tests\test_host_dinamica.py -q
cd ..
```

Esse caminho absoluto do Python é o `home` indicado no `backend\.venv\pyvenv.cfg` desta máquina. Se o seu `home` for outro, use o caminho mostrado nesse arquivo. Em um ambiente virtual normal, `backend\.venv\Scripts\python.exe -m pytest ...` também funciona. A configuração de `TEMP` e `TMP` evita falhas de permissão do diretório temporário desta sessão.

## 4. Gere os instaladores

```powershell
npm run app:build
```

O comando faz, nesta ordem: confere o host; monta o Python portátil e o código do backend; copia e verifica o Node portátil; compila frontend e shell Rust; gera NSIS e MSI; acrescenta o lançador do NSIS; verifica se o host está dentro do pacote. Aguarde a mensagem `Instalador ... conferido` e confirme que o processo terminou sem erro. A primeira compilação Rust pode levar muitos minutos; compilações seguintes reaproveitam o cache em `src-tauri\target`.

Se aparecer `cargo metadata ... program not found`, execute novamente a linha que acrescenta `C:\Users\panhard\.cargo\bin` ao `PATH` na mesma janela e repita `npm run app:build`. Se o erro for `host tem N bytes`, ajuste `KODA_HOST_BYTES` para `N`. Se o `backend\.venv` apontar para um Python inexistente, recrie o ambiente antes de repetir. Não use um arquivo antigo só porque ele tem o nome da versão atual.

## 5. Confirme os arquivos finais

```powershell
Get-Item src-tauri\target\release\bundle\nsis\Koda_0.7.9_x64-setup.exe,
         src-tauri\target\release\bundle\msi\Koda_0.7.9_x64_pt-BR.msi |
  Select-Object FullName,Length,LastWriteTime
Get-FileHash src-tauri\target\release\bundle\nsis\Koda_0.7.9_x64-setup.exe -Algorithm SHA256
Get-FileHash src-tauri\target\release\bundle\msi\Koda_0.7.9_x64_pt-BR.msi -Algorithm SHA256
```

Se a versão mudar, substitua `0.7.9` nos nomes acima. `npm run app:bundle:host` repete a verificação do pacote NSIS. Guarde os hashes com os arquivos distribuídos. Gerar o pacote não instala o Koda; para um teste de instalação, execute o instalador em uma máquina ou ambiente de teste.

## Por que às vezes parece rápido

O `npm run app:build` reutiliza dependências já instaladas (`node_modules`, `backend\.venv`) e o cache de compilação Rust (`src-tauri\target`). Com tudo pronto, a etapa adicional é menor. Se faltar uma ferramenta, se o ambiente Python precisar ser recriado ou se o cache Rust não existir, a preparação e a compilação levam bem mais tempo. O perfil release do projeto usa otimização LTO e `codegen-units = 1`, por isso o trecho `Compiling koda` pode ficar vários minutos sem nova linha no terminal. Para saber se o build realmente terminou, use a mensagem final do comando, a data dos dois arquivos e os hashes, não apenas a existência dos arquivos.

## Resultado desta geração — 23/10/2026

- `npm run verificar`: passou; o lint exibiu avisos, sem erro fatal.
- `npm run check` em `server`: passou.
- `node --test server/tests/*.test.mjs`: 14 testes passaram, incluindo os quatro da senha dinâmica.
- `backend/tests/test_host_dinamica.py`: 11 testes passaram com `TEMP`/`TMP` em pasta gravável.
- `npm run app:host`: passou; `host/c-host.exe` tem 8.113.664 bytes.
- `tauri build`: compilou o shell Rust em 14m25s e gerou NSIS e MSI.
- `npm run app:launcher` e `npm run app:bundle:host`: passaram; a verificação confirmou host e lançador no NSIS.

| Arquivo | Bytes | Modificado (horário de Brasília) | SHA-256 |
| --- | ---: | --- | --- |
| `src-tauri/target/release/bundle/nsis/Koda_0.7.9_x64-setup.exe` | 99.497.472 | 23/10/2026 21:12:02 | `2E0AA883251C2E85BC7FD5D444248507550632DA59FE6DAEF05FA34B1F3A6DEB` |
| `src-tauri/target/release/bundle/msi/Koda_0.7.9_x64_pt-BR.msi` | 146.316.645 | 23/10/2026 21:07:49 | `11695EDF50D87699A023DAB4F22171846B2B9B541898BD99782BB5587A002B5C` |

O primeiro `npm run app:build` desta sessão chegou ao Tauri e encontrou `cargo` fora do `PATH`. Após configurar o caminho do Rust, uma tentativa confinada encontrou `Acesso negado` ao gravar `src-tauri/target/release/build/.../invoked.timestamp`. A compilação terminou quando a etapa do Tauri foi executada com permissão de escrita nessa pasta. Isso é uma restrição do ambiente de execução desta sessão, não um passo extra do projeto para uma janela PowerShell comum com acesso à pasta. A suíte completa do backend não foi concluída nesta sessão; os 11 testes específicos da senha dinâmica passaram. Os instaladores foram gerados e inspecionados, mas não executados para instalar o aplicativo nesta máquina.

## AppImage Linux e Wayland

Após gerar o AppImage Linux, execute no Linux (com `squashfs-tools` instalado):

```bash
scripts/corrigir-appimage-wayland.sh caminho/Koda_0.8.5_amd64.AppImage caminho/Koda_0.8.5_wayland_amd64.AppImage
```

O script preserva o AppImage original, remove do novo pacote a cópia de `libwayland-client.so.0` para usar a biblioteca do sistema e usa compressão Zstandard e testa a extração pelo próprio AppImage, além de conferir Cloudflare, servidor de link e arquivos mobile. Teste o novo pacote no sistema de destino; essa alteração trata uma causa conhecida de `EGL_BAD_PARAMETER`, mas outros problemas de driver ou WebKit também podem produzir tela preta.
