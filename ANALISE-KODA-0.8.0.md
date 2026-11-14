# Koda 0.8.0 — Análise do projeto

> Revisão feita em 01/11/2026 sobre a branch `codex/koda-0.8.0-todas-mudancas`
> (versão `0.8.0`, commit `32b5e05`). Leitura de código, documentação e execução das
> verificações possíveis neste ambiente. Nenhum arquivo do projeto foi alterado além deste
> relatório.

---

## 1. Veredito

O Koda é um projeto **tecnicamente acima da média**: arquitetura local bem separada, um
agente que executa de verdade, segurança pensada contra o próprio agente e documentação
rara em projetos desse tamanho. A engenharia de backend, o cuidado com o ciclo de vida de
processos e o modelo de permissões são sólidos.

Os riscos que realmente importam **não são de código, são de produto e de processo**:

1. **A camada de 29 provedores por login** (Claude Code, Codex, Copilot, Cursor, Windsurf,
   Qoder, Zed, Trae, Kiro, GitLab Duo, Gemini CLI…) reutiliza clientes OAuth, protocolos
   reversos e um binário de terceiro (`magpie`) para consumir assinaturas alheias. Isso
   concentra **risco jurídico, de conformidade e de segurança** muito acima do resto do
   projeto — e contradiz a documentação, que afirma não existir provedor de terceiro.
2. **O repositório não tem rede de segurança**: os testes são explicitamente ignorados pelo
   Git, não há CI, e o working copy está com 264 arquivos alterados apenas por fim de linha.
3. **Arquivos gigantes** (`loop.py` 3.335 linhas, `App.tsx` 3.555) e duplicação de dados
   tornam a manutenção caras.

Nota por dimensão (0–10, opinião fundamentada):

| Dimensão | Nota | Comentário |
| --- | --- | --- |
| Arquitetura | 8 | Camadas claras; acoplamentos pontuais ruins |
| Segurança do app local | 8 | Token por execução, Host check, workspace travado |
| Segurança do subsistema de provedores | 3 | Credenciais de terceiros, impersonação, binário externo |
| Qualidade/manutenção | 5 | God files, sem CI, testes fora do repo |
| Documentação | 7 | Excelente no geral, mas desatualizada/contraditória |
| Higiene do repositório | 3 | CRLF em massa, banco versionado, artefatos locais |
| **Conformidade / jurídico** | **2** | Reuso de OAuth e protocolos de terceiros |

---

## 2. O que é e como está montado

Área de código com cara de chat: o modelo pede ferramentas, o backend executa na máquina do
usuário e cada passo vira evento SSE na conversa.

| Peça | Stack | Onde | ~LOC |
| --- | --- | --- | --- |
| Interface | React 19, Vite 8, Tailwind 4, TS 6 | `src/` | 28.972 |
| Backend | FastAPI, SSE, SQLite | `backend/app/` | 32.874 |
| App desktop | Tauri 2 + Rust | `src-tauri/src/` | 2.464 |
| Nuvem | Cloudflare Worker + Hono + D1 | `server/src/` | 10.834 |
| MCP embutido | Node | `mcp/` | 4.234 |
| Build/instalador | Node | `scripts/` | 2.141 |
| Host de modelos | binário proprietário | `host/` (não versionado) | — |

**Total ≈ 81 mil linhas** de código próprio, fora `node_modules` e artefatos.

Fluxo: `React → FastAPI → Host (c-host.exe)` ou → `provider de conta`. O launcher Rust sobe e
derruba host + backend junto com a janela, com job object no Windows para não deixar órfãos.

### Backend (`backend/app/`)

- `agent/loop.py` — o coração (3.335 linhas): laço agêntico, streaming, ferramentas,
  compactação, retomada.
- `agent/contexto.py` — compactação de contexto; resumo persistido em `conversations.resumo`.
- `agent/repeticao.py`, `agent/budget.py`, `agent/plans.py`, `agent/subagente.py`.
- `policy/` — 5 modos (`plan`, `manual`, `default`, `auto`, `livre`), regras persistentes e
  guarda de despacho *fail-closed*.
- `tools/` — catálogo por domínio (arquivos, shell, git, web, plano, skills, agentes, MCP).
- `providers/` — `host`, `local` e o caminho "pela conta" (`conta.py`, 1.610 linhas).
- `provedores.py` (1.650) + `oauth_login.py` (2.013) + 12 adaptadores (`kiro_koda.py`,
  `cursor_koda.py`, `qoder_koda.py`, `zed_koda.py`, `windsurf_koda.py`, `trae_koda.py`,
  `gitlab_koda.py`, `glm_login_koda.py`, `mimo_conta_koda.py`, `google_conta_koda.py`…).
- `routers/` — 18 routers; `chat.py` sozinho tem 1.609 linhas.

### Frontend (`src/`)

43 componentes. `App.tsx` (3.555), `BlocosVisuais.tsx` (2.927), `SettingsScreen.tsx`
(2.848), `Composer.tsx` (1.662), `client.ts` (1.588). Zero `any` no código TypeScript —
bom sinal.

### Nuvem (`server/src/`)

Hono + D1: autenticação JWT com refresh rotativo e detecção de reuso, TOTP para admin,
rate limit, auditoria, Mercado Pago, créditos e assinaturas. As mudanças desta branch em
`billingController.ts` / `payments.ts` / `subscriptions.ts` são **endurecimento real**:
checagem de divergência entre cobrança e pagamento, proteção contra replay que recriaria
assinatura estornada, e crédito só conta se o pagamento está `approved`.

---

## 3. Pontos fortes (com evidência)

1. **Segurança local bem pensada.** `seguranca.py` implementa token por execução entregue
   por `stdin` (não pelo ambiente, que o agente lê), comparação em tempo constante e
   *deny-by-default* por prefixo — rota nova nasce protegida. `main.py` ainda valida o
   cabeçalho `Host` contra DNS rebinding e exige sessão de conta por janela.
2. **O agente é tratado como ameaça.** A guarda de despacho (`policy/guards.py`) é
   *fail-closed*: se a própria guarda quebrar, nega. É a diferença entre "pedir" e
   "impedir" que o projeto explicita na docstring.
3. **Ferramentas presas ao workspace** com resolução de symlink e `..`, e modo `plan` que
   separa decisão de execução.
4. **Ciclo de vida de processos levado a sério.** `execution/processo.py` mata a árvore,
   detecta inatividade, limita saída e encerra tudo no shutdown — inclusive MCP e downloads.
5. **Documentação de engenharia de verdade.** `docs/auditoria-*`, relatórios F01–F08 do MCP,
   `INCIDENTE-429.md` com reprodução, correção e **limite do que foi provado**. É raro.
6. **Nuvem com postura defensiva**: refresh token só como hash, piso de emissão de token,
   auditoria imutável, idempotência de cobrança.
7. **Build disciplinado**: `tsc -b` passa; `compileall` do backend passa; o instalador
   verifica hash/tamanho do host.

---

## 4. Achados por severidade

### P0 — Jurídico/Conformidade: subsistema de 29 provedores por login

`backend/app/provedores_koda.json` lista 29 provedores e o código conversa com eles por
protocolos próprios ou reversos. Evidências:

- **Clientes OAuth de outros produtos.** O catálogo inclui, por exemplo, o `clientId` do
  Claude Code para `claude.ai/oauth/authorize` com escopo `user:inference`
  (`provedores_koda.json`). O mesmo padrão aparece para Codex, Gemini CLI, Antigravity,
  xAI, Cline, Windsurf, Qoder, Zed, Trae, Kiro, GitLab Duo, Copilot.
- **Protocolos reversos.** `windsurf_koda.py` fala gRPC-Web; `cursor_koda.py` usa Connect e
  varint; `kiro_koda.py` decodifica Amazon EventStream binário com CRC; `qoder_cosy.py` é
  declaradamente portado de um plugin de terceiro.
- **Impersonação de cliente.** `providers/conta.py` fixa
  `CODEX_UA = "codex_cli_rs/0.162.0 (Windows 10; x86_64) vscode"`; `koda_headers.py` usa
  `User-Agent: MiniMaxAgent` e `x-api-key: sk-xxx`. O objetivo é parecer o CLI oficial.
- **Binário de terceiro executado sem verificação.** `provedores.py` (`garantir_gateway`)
  procura `magpie-windows-amd64.exe` na Área de Trabalho e em `Downloads` e o executa com
  `subprocess.Popen` para assinar pedidos do Qoder. É dependência oculta, não documentada,
  não versionada e não verificada por hash — qualquer arquivo com esse nome na pasta de
  downloads roda com os privilégios do usuário.
- **Credenciais em texto claro.** A tabela `provedor_contas` guarda `acesso`, `refresh` e
  `id_token`. No banco de execução (`backend/data/koda.db`, fora do Git) há **18 contas**.
  Além disso, `oauth_login.py` também grava `data/provedores/<id>.json` com `0600`. São
  dois lugares para o mesmo segredo. O agente roda `shell` como o mesmo usuário do sistema:
  em `auto`/`livre` nada impede um comando — ou uma injeção de prompt vinda de conteúdo web
  — de ler esses tokens.

**Por que isso é P0:** reutilizar credenciais e clientes OAuth de outro produto para acessar
inferência paga tende a violar os termos de uso de cada fornecedor e pode ser enquadrado
como acesso não autorizado/circunvenção em várias jurisdições. Também cria dependência
frágil (qualquer mudança de protocolo quebra o produto) e um alvo de alto valor para
malware. Recomendação: **revisão jurídica antes de distribuir**, separar o subsistema do
produto principal, e nunca executar binário achado em `Downloads` sem pin de hash e
assinatura.

### P1 — O repositório não tem rede de segurança

- **Testes fora do versionamento.** `.gitignore` contém `/backend/tests/`, `/tests/`,
  `**/test_*.py`, `**/*.test.*`, `**/*.spec.*` com o comentário "Testes mantidos somente
  localmente". Existem 93 testes locais nos adaptadores — bons testes, aliás — mas eles
  **não estão no Git** e não rodam em lugar nenhum automaticamente.
- **Sem CI.** Não existe `.github/` nem pipeline equivalente. `npm run verificar` é manual.
- Consequência: nenhuma regressão é pega antes do merge; a branch atual tem mudanças de
  cobrança e de provedores sem uma suíte que as cubra no repositório.

### P1 — Working copy com 264 arquivos alterados só por fim de linha

- `git diff --stat`: **285 arquivos, +76.308/−76.093**.
- `git diff -w --stat`: **21 arquivos, +411/−196**.
- `file` confirma: os arquivos de trabalho estão em **CRLF**; a versão no `HEAD` está em
  **LF**. Não há `.gitattributes` nem `core.autocrlf` configurado.
- Efeito prático: revisão de PR impossível, `git blame` inútil, merges com conflito em
  arquivos que ninguém tocou. O checkout parece ter vindo de uma máquina Windows (o
  `oxlint` instalado também é o binding de outra plataforma).
- Correção: adicionar `.gitattributes` com `* text=auto eol=lf`, normalizar o índice em um
  commit isolado (`git add --renormalize .`) e só então revisar as 21 mudanças reais.

### P1 — Dados de usuário versionados

- `data/koda.db` está no Git e aparece modificado no working copy. Contém 3 conversas,
  8 mensagens e uma regra de aprovação — ou seja, **histórico real de uso no repositório**.
- O schema já inclui `provedor_contas` (vazia nesse arquivo, mas o risco é o padrão).
- `data/` e `backend/data/` convivem com bancos diferentes; qual é usado depende do
  diretório de execução (`KODA_DATABASE_PATH` relativo). Isso já era um ponto de atenção na
  análise anterior e continua.
- Correção: remover o banco do índice (`git rm --cached`), manter só um `schema.sql`/seed,
  e resolver a ambiguidade de caminho com um caminho absoluto derivado do app.

### P2 — Arquivos gigantes (risco de manutenção)

| Arquivo | Linhas |
| --- | --- |
| `backend/app/agent/loop.py` | 3.335 |
| `src/App.tsx` | 3.555 |
| `src/components/BlocosVisuais.tsx` | 2.927 |
| `src/components/SettingsScreen.tsx` | 2.848 |
| `backend/app/tools/ferramentas.py` | 2.648 |
| `backend/app/oauth_login.py` | 2.013 |
| `backend/app/provedores.py` | 1.650 |
| `backend/app/providers/conta.py` | 1.610 |
| `backend/app/routers/chat.py` | 1.609 |

O próprio código reconhece o problema em comentários ("impede o `ferramentas.py` de voltar a
ter 4 mil linhas"), mas a tendência voltou. `loop.py` e `App.tsx` concentram tantas
responsabilidades que qualquer mudança é de alto risco.

### P2 — Documentação contradiz o produto

- `README.md` (raiz) ainda diz: *"Ou traga o seu provedor. Com `OPENAI_API_KEY` e
  `OPENAI_BASE_URL` o backend fala com qualquer serviço OpenAI-compatível"*.
- `backend/README.md` diz o oposto: *"Não existe provider de terceiro… As variáveis
  `OPENAI_*` são ignoradas"*.
- Nenhum dos dois menciona a feature real de 29 provedores por login, que está exposta em
  `SettingsScreen.tsx` (importa `backend/app/provedores_koda.json` diretamente).

Isso é mais do que texto desatualizado: é uma decisão de produto grande, com implicações
legais, que não está registrada na documentação principal.

### P2 — Acoplamento frontend → backend por arquivo

`src/components/SettingsScreen.tsx:33` faz
`import catalogoProvedores from '../../backend/app/provedores_koda.json'`. O build do
frontend passa a depender do layout interno do backend, e o catálogo (com os `clientId`s)
viaja para o bundle do cliente. O correto é o backend servir o catálogo por rota — que já
existe (`GET /api/provedores`) — e o front consumir a API.

### P3 — Higiene

- `$null` na raiz (117 bytes, artefato de PowerShell) versionado.
- `host/` tem 5 cópias do binário (8 MB cada) e backups locais; `backups/`,
  `.tmp-windsurf-*`, `dist/`, `data/aviso-arraste-final.png` poluem o working copy.
- 34 `except Exception` no backend; a maioria é justificada em comentário (fail-closed,
  melhor esforço), mas vale auditoria pontual.
- `oxlint` não roda neste ambiente (binding nativo ausente) — o `npm run verificar` não é
  reproduzível fora da máquina original.

---

## 5. Análise por camada

### Backend — o que está bom

O desenho de segurança é o melhor que este projeto tem. A combinação
`stdin + deny-by-default + Host check + sessão por janela + workspace travado + guarda
fail-closed` fecha os ataques óbvios (DNS rebinding, auto-aprovação pelo agente, leitura
fora da pasta). A separação `policy/` (decide) × `tools/` (executa) × `agent/` (orquestra)
é correta, ainda que `loop.py` tenha absorvido demais.

### Backend — o que preocupa

- `loop.py` mistura orquestração, streaming, retomada, compactação e tratamento de
  ferramentas. É o arquivo mais crítico e o mais difícil de testar.
- `providers/conta.py` tem um `if self.provedor == ...` por fornecedor: é um registro por
  condicional, não por polimorfismo. Adicionar o 30º provedor mexe no mesmo arquivo.
- O subsistema de provedores tem dois caminhos de persistência de token (`provedor_contas` e
  `data/provedores/*.json`) e dois clientes HTTP concorrentes (`httpx` síncrono e assíncrono).
- O incidente de 429 documentado em `docs/auditoria-2026-10-23/INCIDENTE-429.md` **não foi
  resolvido** — o próprio documento manda não distribuir instalador como correção sem
  demonstrar resposta no app instalado.

### Frontend

- Tipagem limpa (0 `any`), módulos de domínio bem separados (`models.tsx`, `effort.ts`,
  `custo.ts`, `duracao.ts`, `permissao.ts`).
- `App.tsx` com 3.555 linhas e `SettingsScreen.tsx` com 2.848 são os pontos de ruptura.
  `SettingsScreen` acumula catálogo, login, teste de modelo, saldo, conta e preferências.
- O token de dev vem de `VITE_API_TOKEN`; no app desktop vem por `invoke`. Correto.

### Desktop (Tauri/Rust)

- `main.rs` (985), `servicos.rs` (530), `acesso.rs` (465), `portas.rs` (304),
  `diagnostico.rs` (180). Porta efêmera no instalado, job object, vigia de serviço caído,
  reutilização de porta só com outro Koda (handshake HMAC). Bem feito.
- Dependência dura do binário proprietário `c-host.exe` no build — por design, mas é um
  ponto único de falha de distribuição.

### Nuvem (Worker/D1)

- Boa postura: refresh como hash, rotação com detecção de reuso, CSRF, rate limit, TOTP,
  auditoria, idempotência. As mudanças desta branch endurecem a cobrança.
- Ponto de atenção: `server/src/controllers/billingController.ts` (620 linhas) concentra
  cartão, Pix, créditos e assinatura; e o `mercadopagoService` faz chamadas externas dentro
  do fluxo de request. Vale separar em serviço de domínio testável.

### MCP e Skills

- `dev-browser` (2.929 linhas) e `dev-logs` (812) são programas sérios, com correlação
  front/back. O tamanho do `dev-browser` é o mesmo problema dos god files.
- Skills como instrução (só nome/descrição no prompt) e MCP como ferramenta é uma distinção
  bem feita.

---

## 6. O que foi verificado nesta revisão

| Verificação | Resultado |
| --- | --- |
| `python3 -m compileall backend/app` | **Passou** (sem erro de sintaxe) |
| `node node_modules/typescript/bin/tsc -b` | **Passou** (exit 0) |
| `pytest` do backend | **Não executado** — não há `uv` nem `.venv` neste ambiente |
| `oxlint` | **Não executado** — binding nativo ausente (`@oxlint/binding-linux-x64-gnu`) |
| Testes locais | 93 funções de teste presentes, mas fora do Git |
| `git diff -w` | 21 arquivos com mudança real; 264 só fim de linha |

---

## 7. Plano de ação sugerido (ordem de retorno)

**Antes de qualquer release**

1. Revisão jurídica do subsistema de provedores por login. Decidir explicitamente se ele
   faz parte do produto; se sim, documentar risco e consentimento, isolar em módulo, e
   remover a execução automática de binário achado em `Downloads`.
2. Tirar `data/koda.db` do Git e parar de versionar dados de uso.
3. Colocar os testes no repositório e um CI mínimo (`pytest` + `tsc` + `oxlint`).

**Curto prazo**

4. `.gitattributes` + `git add --renormalize .` em commit isolado; revisar as 21 mudanças
   reais separadamente.
5. Alinhar `README.md` e `backend/README.md` com o produto real (ou remover a feature).
6. Unificar a persistência de tokens em um único cofre com criptografia em repouso
   (chave derivada do usuário/OS), e impedir que o `shell` do agente leia esse diretório.

**Médio prazo**

7. Quebrar `loop.py` em `loop/` (orquestração, streaming, retomada, ferramentas) e
   `App.tsx`/`SettingsScreen.tsx` em componentes por seção.
8. Trocar o `if provedor ==` de `conta.py` por um registro de adaptadores com interface
   comum; isso também torna os 29 provedores testáveis um a um.
9. Resolver o incidente 429 com um teste de ponta a ponta no app instalado, como o próprio
   documento exige.
10. Servir o catálogo de provedores só por API; remover o import direto do JSON do backend
    no frontend.

---

## 8. Conclusão

Há dois projetos dentro deste repositório. Um é um agente local bem arquitetado, com
segurança acima da média e documentação exemplar — vale como produto. O outro é um
agregador de assinaturas de terceiros construído sobre engenharia reversa, que carrega
risco jurídico e de segurança desproporcional ao seu valor e que a documentação insiste em
não reconhecer. O primeiro merece investimento em testes, CI e refatoração dos arquivos
gigantes; o segundo precisa de uma decisão consciente antes de qualquer distribuição.
