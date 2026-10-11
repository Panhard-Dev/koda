# F03 — os MCPs do Koda dependiam de um Node instalado

Documento do conserto. Causa, prova medida e o que mudou.

---

## 1. A causa

Os dois servidores que o app traz são programas **Node**, e o `mcps.json` os chama pelo
**nome**:

```json
{ "name": "navegador", "command": "node", "params": "../mcp/dev-browser/server.mjs" },
{ "name": "logs",      "command": "node", "params": "../mcp/dev-logs/server.mjs" }
```

O cliente resolve esse nome pelo `PATH` (`subprocess.Popen(argv)`, sem `shell`), e o
instalador levava `host/c-host.exe`, `mcp/`, `skills/`, o Python e o código do backend — mas
**não** levava Node nenhum. Numa máquina sem Node:

```
navegador  FORA   erro=não foi possível iniciar 'node': [WinError 2] The system cannot find the file specified
logs       FORA   erro=não foi possível iniciar 'node': [WinError 2] The system cannot find the file specified
catalogo: 0
```

O estado era informado corretamente (nada de silêncio), mas o Painel Dev ficava sem 33
ferramentas — e o instalador dizia, com todas as letras, que não era preciso instalar
"nenhum outro programa".

**Medido antes de decidir:** os dois servers usam `fetch` e `WebSocket` globais
(`mcp/dev-browser/server.mjs:364-365`), então o Node mínimo é o **22**. O `node.exe` sozinho
tem 83 MB.

---

## 2. A decisão

O dono escolheu **empacotar o Node**. As outras duas opções ficaram registradas:

- manter Node como pré-requisito custaria zero de tamanho, mas o recurso não funcionaria numa
  máquina limpa — que é onde um instalador precisa funcionar;
- reescrever os dois servidores em Python tiraria a dependência de vez (o app já leva Python),
  mas é reescrita grande e não cobriria servidor de terceiro.

**O que continua valendo para terceiro:** quem cadastrar um servidor MCP que use `npx`,
`uvx` ou um binário próprio continua dependendo do que a máquina tiver. O que o pacote
resolve é o que **ele mesmo entrega**.

**A versão empacotada é a 22.22.2** (LTS), e não a 24.19.0 que está em `C:\Program Files`
nesta máquina: foi a versão com que os dois servidores foram exercitados aqui, e é a que o
`npm run app:node` valida como mínima.

---

## 3. A prova (medida, não deduzida)

Script `diagnostico-anexos/f03-prova.py`: sobe os dois servidores com o `PATH` **vazio** e o
`mcps.json` dizendo `"command": "node"`, rodando de `<koda>/backend` (que é de onde o app roda
o backend, e o que faz o `params` relativo `../mcp/...` apontar certo).

| | navegador | logs | catálogo |
|---|---|---|---|
| **antes** (sem o Node que viaja com o app) | FORA · `[WinError 2]` | FORA · `[WinError 2]` | 0 |
| **depois** | conectado · 26 ferramentas | conectado · 7 ferramentas | **33** |

Saída depois do conserto:

```
node que viaja com o app: ...\src-tauri\runtime\node\node.exe

com o PATH vazio:
  navegador  conectado  ferramentas=26
  logs       conectado  ferramentas=7

catálogo: 33 ferramenta(s)

VEREDITO: os MCPs subiram sem Node no PATH (F03 corrigido)
```

---

## 4. O que mudou

### 4.1 O `mcps.json` continua dizendo `"command": "node"`

Isso é de propósito: um **nome** faz o mesmo arquivo valer em qualquer máquina, e deixa quem
quiser apontar para o Node dele escrevendo o caminho por extenso. Quem troca o nome pelo Node
que veio junto é o gerenciador:

```python
    def _comando_de_verdade(self, comando: str) -> str:
        """Troca `node`/`node.exe` pelo Node que **viaja com o Koda**, quando ele existe.
        ...
        Comando que já é caminho (tem pasta) passa intacto: quem escreveu escolheu.
        """
        if self._node is None or not self._node.is_file():
            return comando
        if len(Path(comando).parts) > 1:
            return comando
        if comando.strip().lower() not in ("node", "node.exe"):
            return comando
        return str(self._node)
```

`mcp.configurar(caminho, node)` ganhou o segundo parâmetro (opcional — sem ele o comando vale
como está, que é o comportamento dos testes), e o `main.py` passa `config.node_path`.

### 4.2 Onde o backend acha o Node — `backend/app/config.py`

Mesma conta do `_skills_do_koda`, que já resolvia isso para as skills:

```python
def _node_do_koda() -> Path | None:
    """O `node.exe` que viaja com o Koda, achado pelo lugar onde este arquivo está.
    ...
    """
    raiz = Path(__file__).resolve().parent.parent.parent
    for candidato in (
        raiz / "node" / "node.exe",
        raiz / "src-tauri" / "runtime" / "node" / "node.exe",
    ):
        if candidato.is_file():
            return candidato
    return None
```

- instalado: `<instalação>/resources/node/node.exe`;
- dev: `koda/src-tauri/runtime/node/node.exe` (o `koda/node` não existe, e é o certo — em dev
  quem desenvolve já tem Node no `PATH`).

### 4.3 O que vai para o instalador

`src-tauri/tauri.conf.json`, no `bundle.resources`:

```json
      "runtime/backend/python": "backend/python",
      "runtime/backend/app": "backend/app",
      "runtime/node": "node"
```

E `scripts/gerar-runtime-node.mjs` monta `src-tauri/runtime/node/` a partir do Node que
**roda o próprio script** (ou de `KODA_NODE`), conferindo a versão:

```js
const origem = process.env.KODA_NODE || process.execPath
const versao = execFileSync(origem, ['-v'], { encoding: 'utf8' }).trim()
const principal = Number.parseInt(versao.replace(/^v/, '').split('.')[0], 10)

if (!Number.isFinite(principal) || principal < MINIMO) {
  throw new Error(
    `o Node em ${origem} é ${versao}, e os servidores MCP do Koda precisam de ${MINIMO}+ ` +
      `(usam \`fetch\` e \`WebSocket\` globais). Aponte um Node mais novo em KODA_NODE.`
  )
}
```

Entrou no `app:build`, que já montava o runtime do backend:

```json
    "app:node": "node scripts/gerar-runtime-node.mjs",
    "app:build": "npm run app:host && npm run app:runtime && npm run app:node && tauri build && npm run app:launcher && npm run app:bundle:host"
```

`src-tauri/runtime/` é gitignored (`src-tauri/.gitignore`), então os 83 MB não vão para o
repositório — são montados no build, como o Python.

### 4.4 A mensagem do instalador — `src-tauri/installer/hooks.nsh`

A frase era **falsa** ("Você não precisa instalar Python nem nenhum outro programa") enquanto
o Node fosse exigido. Agora ela é verdadeira para o que o app entrega, e o aviso do navegador
é do **recurso**, não do app:

```nsis
  ; O Painel Dev abre um navegador que **já existe** na máquina: nada é baixado. É a única
  ; coisa de fora que o Koda usa, e é de um recurso só — por isso a checagem é sobre ele, e o
  ; aviso diz o que fazer, em vez de dar o app inteiro como incompleto.
  StrCpy $0 "O Painel Dev abre o Chrome ou o Edge que já existe nesta máquina, e não encontrei nenhum dos dois. O Painel Dev fica sem a aba de navegador; o resto do Koda funciona igual. Instale um deles para usar esse recurso.$\r$\n$\r$\n"
  IfFileExists "$PROGRAMFILES\Google\Chrome\Application\chrome.exe" koda_tem_navegador
  IfFileExists "$PROGRAMFILES32\Google\Chrome\Application\chrome.exe" koda_tem_navegador
  IfFileExists "$LOCALAPPDATA\Google\Chrome\Application\chrome.exe" koda_tem_navegador
  IfFileExists "$PROGRAMFILES\Microsoft\Edge\Application\msedge.exe" koda_tem_navegador
  IfFileExists "$PROGRAMFILES32\Microsoft\Edge\Application\msedge.exe" koda_tem_navegador
  Goto koda_aviso_python_caixa
  koda_tem_navegador:
    StrCpy $0 ""
  koda_aviso_python_caixa:
```

E a caixa passou a dizer o que o app realmente traz:

```
O Koda já traz o Python e o Node que ele precisa.

O serviço local (a parte em Python que conversa com os modelos) e os servidores do Painel Dev
foram instalados junto com o app, com os interpretadores deles. Você não precisa instalar
Python nem Node.

[Se não achou navegador:] O Painel Dev abre o Chrome ou o Edge que já existe nesta máquina,
e não encontrei nenhum dos dois. ...

Se a conversa não responder, abra Ajustes > Sobre > Serviço local e clique em «Ver diagnóstico».
```

O `PREUNINSTALL` também passou a citar os dois runtimes.

---

## 5. O que **não** foi mexido

- **Chrome/Edge no `server.mjs`.** Já estava certo: procura os caminhos conhecidos, aceita
  `KODA_BROWSER`/`CHROME_PATH`, e quando não acha diz o que fazer
  (`não achei Chrome nem Edge nesta máquina — defina KODA_BROWSER com o caminho do
  executável`). O que faltava era o instalador não tratar isso como requisito do app — feito.
- **O `params` relativo.** Cheguei a suspeitar que `../mcp/dev-browser/server.mjs` estivesse
  errado, mas **não está**: o Rust sobe o backend com `current_dir(&backend.pasta)`
  (`src-tauri/src/main.rs:508`), que é `<instalação>/resources/backend` no instalado e
  `koda/backend` em dev. Daí `../mcp/...` cai em `resources/mcp/...` e `koda/mcp/...` — os
  dois existem.
- **Git.** Não é dependência de nenhum dos dois servidores.

---

## 6. Arquivos tocados

| Arquivo | O que mudou |
|---|---|
| `backend/app/config.py` | `_node_do_koda()` + `Settings.node_path` |
| `backend/app/mcp/__init__.py` | `configurar(caminho, node)` + `_comando_de_verdade` |
| `backend/app/main.py` | passa `config.node_path` |
| `src-tauri/tauri.conf.json` | `"runtime/node": "node"` no bundle |
| `src-tauri/installer/hooks.nsh` | mensagem verdadeira + aviso do navegador restrito ao recurso |
| `scripts/gerar-runtime-node.mjs` | **novo** — monta `runtime/node/` e valida a versão |
| `package.json` | `app:node` encadeado no `app:build` |

---

## 7. Segunda rodada: o `0xC0000142` no `node.exe` do pacote

Relato: o Node do pacote falha ao iniciar com `0xC0000142` (`STATUS_DLL_INIT_FAILED`), e com o
`PATH` sem Node global os dois MCPs ficam desconectados.

**O que foi medido, e o que não deu para reproduzir.**

| Medição | Resultado |
|---|---|
| `sha256` do `runtime/node/node.exe` contra a origem | **idêntico** (`ae1a50511be58e98`, 87.074.816 bytes) |
| Executar o binário do repo (`node.exe -v`) | `v22.22.2`, código de saída 0 |
| DLLs que o binário importa | **11, todas do sistema** (`KERNEL32`, `ADVAPI32`, `CRYPT32`, `IPHLPAPI`, `SHELL32`, `USER32`, `USERENV`, `WINMM`, `WS2_32`, `dbghelp`, `ole32`) |
| Alguma DLL do VC++ redist ou `api-ms-win-crt-*`? | **nenhuma** |
| Arquitetura | x64 |

Ou seja: o arquivo que está no repositório é íntegro, é autocontido e **inicia** nesta máquina.
A causa mais comum de `0xC0000142` — DLL de dependência que não carrega — **não se aplica a este
binário**, porque ele não depende de nenhuma DLL fora do sistema. Não consegui reproduzir o erro
aqui, e não vou dizer que sei qual foi.

**O que faltava, e foi corrigido: o diagnóstico.** Um `node.exe` que existe e não inicia não
aparece como "não encontrei o arquivo" — o `Popen` **funciona** e o processo morre logo depois.
Até agora o app dizia, nesse caso:

```
o servidor MCP 'navegador' não respondeu a 'initialize' em 8s
```

que não dá por onde começar. Agora o código de saída vai junto (`cliente.com_saida`):

```
o servidor MCP 'navegador' encerrou durante 'initialize' · o processo encerrou com o código 0xC0000142
```

Teste: `test_mcp_servidor_que_morre_na_subida_mostra_o_codigo`.

**O que mudou no build, para o problema não chegar ao pacote.** O
`scripts/gerar-runtime-node.mjs` passou a conferir **o que ficou**:

- **arquitetura**, lida do cabeçalho PE (e a assinatura `MZ`/`PE\0\0`, que pega um HTML de página
  de erro de proxy salvo como `node.exe`) — falha o build se não for x64;
- **hash** do copiado contra a origem — falha o build se diferir (cópia truncada, antivírus);
- **executar** o copiado, que é a prova mais direta — mas isso é **aviso** quando o ambiente
  recusa o `spawn` (`EBUSY`), e erro quando o binário roda e devolve erro.

Essa última parte é uma concessão medida: **neste ambiente o `spawn` a partir do Node devolve
`EBUSY`**, e não é do binário — acontece igual com o Node do `C:\Program Files`, e a cópia
também falha. Sem essa concessão o `npm run app:build` não rodaria aqui. Com ela, hash e
arquitetura continuam sendo bloqueio, e a execução vira aviso.

**Onde continuar, se o erro aparecer de novo.** Agora a tela diz o código. Se for `0xC0000142`
numa máquina onde o binário é este (hash confere), as causas que sobram são de ambiente, e não
do arquivo: antivírus/EDR bloqueando a imagem, política de Application Control, ou o arquivo
tendo sido substituído no pacote. A verificação é `certutil -hashfile <node.exe> SHA256` na
máquina de destino contra `ae1a50511be58e98…`.

---

## 8. O que **não** foi verificado

O instalador de verdade e uma VM limpa. O que está medido é o caminho do backend com o `PATH`
vazio (que decide se o servidor sobe), a integridade do binário e o script de build rodando. O
`hooks.nsh` foi revisado à mão — **não** foi compilado com o makensis, então a checagem de
navegador é a única parte deste conserto sem prova de execução.
