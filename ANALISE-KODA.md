# Koda — Análise Completa do Projeto

> Análise feita em 11/10/2026 sobre o working copy em `C:/Users/Administrator/Downloads/koda`
> (versão `0.6.9`, branch da semana). Projeto proprietário — leitura/avaliação apenas.

---

## 1. O que é

Koda é uma **área de código com cara de chat**: o usuário escreve o que precisa e o app **executa**
(lê/escreve arquivos, roda comandos, Python, git, pesquisa na web), em vez de só responder.
A persona toda é em pt-BR — README, interface, nomes de ferramentas e prompts de sistema.

Produto em três peças locais + uma nuvem opcional:

| Peça | Stack | Pasta |
| --- | --- | --- |
| Interface | React 19.2, Vite 8, Tailwind 4, TypeScript 6 | `src/` (~19.000 linhas) |
| Backend | FastAPI, uvicorn, httpx, pydantic-settings, pypdf | `backend/app/` (~20.000 linhas Python) |
| App desktop | Tauri 2 + Rust | `src-tauri/` (~2.340 linhas Rust) |
| Host de modelos | binário proprietário `c-host.exe` (não versionado) | `host/` |
| Nuvem (opcional) | Cloudflare Workers + Hono + D1 + zod + bcryptjs | `server/` (~10.600 linhas TS) |
| MCP | 2 servidores Node embutidos + cliente Python | `mcp/` + `backend/app/mcp/` |
| Skills | 3 skills `.md` + índice JSON | `skills/` |
| Build/instalador | scripts Node (NSIS, launcher, runtime) | `scripts/` (~4.800 linhas) |

**Total estimado: ~60.000 linhas** fora `node_modules`/artefatos de build.

---

## 2. Arquitetura

`Interface (React) → Backend FastAPI → Host (modelos)` , com o launcher Rust subindo e
derrubando Host + Backend junto com a janela. A nuvem só é consultada quando a tela pede.

### Backend FastAPI (`backend/app/`)

- **`agent/loop.py` (3.143 linhas)** — o coração. Porta do projeto original "TOOLS", adaptado a
  assíncrono e a eventos SSE: cada chamada de ferramenta nasce como evento na stream, então a
  interface mostra a ferramenta rodando em vez de esperar em silêncio. Detalhe importante:
  `tool_calls` são **ecoadas exatamente** como chegaram do host (id + string de argumentos),
  porque o host casa a assinatura pelo id.
- **`agent/contexto.py` (459 linhas)** — compactação de contexto: a 1.000.000 de tokens
  (`KODA_CONTEXTO_TOKENS`) o histórico antigo vira resumo; o resumo fica **na conversa**
  (`conversations.resumo`), então não é recalculado a cada pedido. Compactação aparece como
  cartão na conversa, não como linha solta.
- **`agent/repeticao.py` (217)** — detector de resposta vazia/repetida; conta como uma das
  travas de loop infinito (junto com o botão de parar e o provedor fora do ar).
- **`agent/subagente.py` (315)** — sub-agentes (ferramenta `sub_agente`, máx. 3 por rodada),
  definidos em `backend/data/subs.agentes.md`.
- **`policy/approvals.py` + `guards.py`** — três modos de permissão (`manual`/`default`/`auto`)
  com regras "sempre/nunca" persistidas (`approval_rules`), e os **quatro portões de parada**:
  lista com item aberto, código mudado sem execução posterior, resposta que *promete* o próximo
  passo, e tarefa de ação onde nenhuma ferramenta funcionou. A "cobrança da promessa" reengaja o
  modelo nomeando a ferramenta faltada no histórico antes de fechar.
- **`tools/`** — catálogo com **39 ferramentas canônicas** (~40 declarações de schema
  espalhadas pelos domínios; `browser` é alias de `url_reader`), em 7 domínios, cada schema
  declarado no próprio domínio (`registry.py` só agrega):

  | Domínio | Ferramentas |
  | --- | --- |
  | arquivos (21) | `read_file`, `read_attachment`, `write_file`, `edit_file`, `str_replace_editor`, `search_files`, `search_codebase`, `regex_search`, `vector_search`, `get_problems`, `apply_patch`, `move/copy/rename/delete_file`, `create/delete_directory` … |
  | execução (5) | `shell`, `code_interpreter`, `install_package`, `uninstall_package` |
  | git (6) | `status`, `diff`, `log`, `commit`, `pull`, `push` |
  | web (5) | `web_search` (Bing, scraping), `url_reader`, `browser`, `download_file`, `upload_file` |
  | plano (1) | `update_todos` |
  | skills (1) | `use_skill` |
  | agentes (1) | `sub_agente` |

  Robustez notável: **apelidos** (`run_command`→`shell`, `list_directory`→`list_dir`, …) e
  **sinônimos de argumento** (`path`→`caminho`, `content`→`conteudo`, …), porque "quem escreve o
  nome é o modelo, não a interface" — sem isso a tarefa morria por "ferramenta desconhecida".
  Restrição por domínio: `FERRAMENTAS_WEB/LOCAIS/SHELL/ARQUIVO/AMBIENTE` é o que faz o pedido
  negativo ("não use arquivos") virar proibição real.
- **`providers/`** — `local` (offline, explícito), `openai_compat.py` (954 linhas; o cliente do
  host + streaming), `pensamento.py` (reasoning visível). **Não existe provider de terceiro**:
  o caminho OpenAI-compatible BYOK saiu do produto (achado F05 do QA) — `OPENAI_*` é ignorado.
- **`mcp/cliente.py` (800 linhas)** — cliente MCP: sobe processo, handshake, `tools/list` com
  paginação por cursor, stderr vira estado na tela. Bug tratado: cursor `""` ≠ `null`
  (achado F04, corrigido).
- **`routers/`** — 15 routers: chat (SSE), conversations, usage, account, models, mcps, skills,
  projects, attachments, store, nuvem, agentes, host, dev_browser, dev_logs.
- **`config.py` (350 linhas)** — tudo com padrão: sem `.env` o backend roda (provider local +
  banco em `data/koda.db`). Sem teto de passos (`max_steps=0`) e sem tempo de tarefa por decisão
  explícita do dono — tarefa grande não é truncada no meio.
- **`db.py`** — SQLite WAL, 7 tabelas: `conversations` (com `resumo`), `messages` (steps, todos,
  desfecho `incompleto/motivo/pendentes/executou/retomavel`, tokens e `conta`), `account`,
  `projects`, `app_settings`, `approval_rules`, `attachments` (índice; conteúdo no store fora do
  workspace). Migração aditiva coluna a coluna.

### Segurança (backend + launcher)

- API **deny-by-default**: toda rota `/api` exige `Bearer`. O token é sorteado pelo launcher
  **uma vez por execução** e entregue pelo `stdin` (não pelo ambiente, que o código do agente lê)
  — é o que impede o agente de chamar `PUT /api/permissions` e se dar modo `auto`.
- Só 3 rotas abertas: `OPTIONS`, `GET /api/health`, `GET /api/handshake` (desafio HMAC nonce, para
  reutilizar porta só com outro Koda).
- No app empacotado, `/docs`, `/redoc`, `/openapi.json` e `/` desligam.
- Ferramentas de arquivo **presas ao workspace** (`acesso_livre=False` por padrão).
- Anexos fora do workspace, lidos por `read_attachment` (id), não por caminho.

### Interface (`src/`, 37 componentes + ~20 módulos TS)

`App.tsx` tem 3.041 linhas (o maior arquivo do front) e ~35 componentes: `Composer`,
`ToolSteps`, `ApprovalCard`, `ToDos`, `Reasoning`, `Compactacao` (o cartão), `SettingsScreen`,
`CheckoutScreen`/`Store`/`Subs` (loja e cobrança em "moedas"), `AccountSection`, `ContextRing`,
`DiagnosticoLocal`, `PainelLateral`, etc. Módulos de domínio bem separados: `models.tsx`
(catálogo vindo do host, ordenado por tier), `effort.ts` (7 níveis: auto/minimal/low/medium/high/
xhigh/max, com queda-para-o-próximo quando o modelo recusa), `compactacao.ts`, `permissao.ts`,
`custo.ts`, `duracao.ts` (régua "47 ms → 1,4 s → 2,7 min"), `api/` (client, cloud, cobranca).

### App desktop (`src-tauri/`, Rust)

`main.rs` (860 linhas) sobe **host → backend**, porta efêmera no instalado (21128/8787 em dev),
token por `invoke`, job object do Windows para matar os serviços mesmo se o app morrer sem
passar pelo código, vigia que reergue serviço caído. `portas.rs` identifica o dono da porta e só
reutiliza **outra janela do Koda`; `acesso.rs`, `servicos.rs`, `diagnostico.rs` completam.
`npm run app:build` valida `host/c-host.exe`, monta runtime Python + Node embutidos, gera o
instalador NSIS e um launcher (`scripts/criar-launcher-instalador.mjs`).

### Nuvem (`server/`, Cloudflare Worker + D1)

Hono, rotas em 4 grupos (`public`, `app`, `admin`, `painel`), 13 controllers, 18 serviços
(auth com JWT, TOTP 2FA admin, rate limit, auditoria imutável via triggers, uploads, Mercado
Pago, versões/releases, MCP do catálogo). Público: `/health`, `/version`, `/changelog`, `/models`,
`/host/authorize`, planos e webhook do Mercado Pago. Painel admin em HTML server-rendered.
Decisão documentada: Workers+D1 porque era a conta disponível; domínio não depende do runtime.

### Skills e MCP

- **Skills = instrução**: só nome/descrição vão no prompt; `use_skill` puxa o conteúdo. Pasta do
  projeto (`skills/`) vence a global; nome repetido é recusado. Estado em `skills-state.json`.
  3 skills: `design-taste-frontend`, `diagnosticar-logs`, `validar-front`.
- **MCP = ferramenta**: 2 servidores Node embutidos — `dev-browser` (2.929 linhas: abre site,
  clica, digita; alimenta o Painel Dev) e `dev-logs` (812 linhas: erros de console/rede/servidor
  sem repetição, com correlação front/back). Mudar config reabre a conexão sem reiniciar o app.
  Documentação viva em `mcp/F01…F08` (relatórios de QA e consertos).

### Host e modelos

`c-host.exe` proprietário (não versionado), porta 21128; publica catálogo em `/v1/models`
(Liz 4, Liz 3 Flash, Liz Mini 2/1.3, Liz Nano, Koda 1, Layze 2 — ordem por tier no seletor).
O backend mantém lista curada de quem **enxerga imagem** (medição de 10/10/2026 documentada).
O app sobe e cai com o host; sem ele, a interface entra em modo offline antes de fingir.

---

## 3. Saúde do repositório

- **Git ativo**: histórico em pt-BR, PRs recentes #21–#26 (MCP, provider do host, catálogo,
  Node embutido). Commits descritivos com "o que era/por que mudou".
- **Documentação forte**: README principal (277 linhas, muito bem escrito), `backend/README.md`,
  `server/README.md`, `server/OWASP.md`, e a pasta `mcp/` com relatórios de QA numerados.
- **Qualidade**: `npm run verificar` = `tsc -b` + `oxlint`. Testes Python existem (ex.
  `test_mcp_servidor_que_morre_na_subida_mostra_o_codigo` citado no doc de conserto).
- **Cultura de medição antes de afirmar**: os docs de F05–F08 mostram verificação no código,
  reprodução, correção e reteste; o que ficou pendente está declarado (ex.: `hooks.nsh` do
  instalador revisado só à mão).

### Pontos de atenção (observados, não necessariamente problemas)

1. **Arquivos muito grandes** — `loop.py` (3.143), `App.tsx` (3.041), `ferramentas.py` (2.544),
   `dev-browser/server.mjs` (2.929). Concentram risco de manutenção; o próprio código já
   reconhece e mitiga isso nos tools (registry por domínio, "impede o ferramentas.py de voltar a
   ter 4 mil linhas").
2. **Dados em dois lugares** — `data/` (raiz) e `backend/data/` têm, cada um, `koda.db` e
   `mcps.json`; o caminho efetivo depende do diretório de execução (`KODA_DATABASE_PATH` relativo).
   `backend/data/` é onde vivem o store de anexos, `skills-state.json`, `subs.agentes.md` e os
   JSONs do Painel Dev.
3. **Bug latente conhecido em `GET /api/models`** — `routers/models.py` faz
   `if not isinstance(engine, HostProvider): return []`, mas `build_provider()`
   (`providers/__init__.py`) **sempre** embrulha o provider em `ComTeto`, então
   `app.state.provider` nunca é um `HostProvider` e a rota curto-circuita para lista vazia: o
   catálogo publicado pelo host não chega ao seletor. Sem impacto visível hoje (a interface cai
   na lista da casa, que cobre o que o host publica), mas quebra a promessa de "modelo novo do
   host entra na lista sozinho". Correção mínima: desembrulhar antes do `isinstance`
   (`getattr(engine, "_provider", engine)`). Achado em sessão anterior, **não aplicado**.
4. **Pendência conhecida (F03, 2ª rodada)** — `node.exe` do pacote falhou uma vez com
   `0xC0000142` (`STATUS_DLL_INIT_FAILED`) numa máquina remota; não reproduzido no ambiente de
   dev. Mitigação já no código (código de saída agora aparece na tela) e no build
   (`gerar-runtime-node.mjs` confere arquitetura PE + hash; execução é aviso por causa de
   `EBUSY` do sandbox). Se reaparecer: antivírus/EDR/AppLocker na máquina-alvo — verificar hash
   com `certutil`.
4. **Binário proprietário obrigatório no build** — sem `host/c-host.exe`, `app:build` falha por
   design; a release precisa provisionar o binário oficial.
5. **`src-tauri/target/` com 7.555 arquivos** versionados no working copy — artefatos de build
   Rust pesam muito o diretório; normalmente deveriam estar fora do Git.

---

## 4. Veredito

Projeto **maduro, bem documentado e coerente**: arquitetura de 3 peças locais com nuvem
genuinamente opcional, agente que executa de verdade (39 ferramentas, planos, sub-agentes,
compactação de 1M tokens), segurança pensada contra o próprio agente (token por execução,
handshake HMAC, workspace travado, 3 modos de permissão) e uma disciplina rara de consertar
**com prova** (relatórios F01–F08 com reprodução e reteste). Riscos principais são de
manutenção (arquivos grandes, build Rust pesado) e a dependência do host proprietário.

---

*Relatório gerado a partir da leitura do código e da documentação do repositório; nenhum arquivo
do projeto foi modificado além da criação deste relatório.*
