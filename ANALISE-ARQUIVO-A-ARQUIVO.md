# Koda — Inventário arquivo-a-arquivo

> Gerado em: 2026-11-09 · Koda 0.8.5 · host/gateway-local 0.37.1
> Nada foi alterado. Leitura dos docstrings e cabeçalhos.
> Snapshot; em caso de conflito, o código vence.

Este arquivo é um retrato do repositório em 2026-11-09, não fonte de verdade. Se alguém editar código e não atualizar aqui, o código vence. Releia o código antes de decidir qualquer mudança.

## Backend — `backend/app/`

### Raiz
- `__init__.py` — só `__version__` do pacote.
- `main.py` (401) — app FastAPI: monta os 20 routers, CORS, rotas abertas (`/api/health`, `/api/handshake`), desliga `/docs` no app empacotado.
- `config.py` (359) — `pydantic-settings`: token, provider (`auto`/`host`), `KODA_CONTEXTO_TOKENS` (1M), portas, cloud. Tudo com default, roda sem `.env`.
- `deps.py` (47) — ponte estado app ↔ SQLite (async → thread) e dependência de token.
- `schemas.py` (621) — Pydantic de entrada/saída: chat (`text/model/effort/reasoning/web/project/attachments/tools`), contas, modelos.
- `db.py` (292) — SQLite: 1 conexão por operação, schema, WAL.
- `repository.py` (543) — SQL de conversas/mensagens/uso/contas.
- `seguranca.py` (178) — token por execução (stdin, nunca env no app) + HMAC handshake; deny-by-default em `/api`.
- `identidade.py` (491) — voz do assistente, nome de apresentação vs. identidade do serviço, o que fazer quando ele esquece.
- `limits.py` (171) — tetos compartilhados (`RuntimeLimits`): tokens, passos, tamanho de anexo. Infraestrutura compartilhada, não é camada.
- `anexos.py` (399) — store de anexos separado do workspace: arquivo escolhido na conversa vive aqui, nunca vira arquivo do projeto.
- `projects.py` (427) — pastas de trabalho, detecção de projeto, permissões do prompt box.
- `semente.py` (180) — semeia `data/` (MCPs, skills, modelos) na 1ª execução e a cada update.
- `live.py` (266) — rodadas ao vivo: trabalho pertence ao backend, não à conexão HTTP; se o cliente desconecta, continua e grava.
- `navegador.py` (403) — automação de browser para o agente ver sites (CDP).
- `remoto.py` (360) — acesso remoto PC↔celular.
- `tunel.py` (272) — túnel Cloudflare do `koda-link`.
- `transferencias.py` (168) — manda arquivo do PC p/ celular; id de 128 bits é a credencial (`send_to_phone`).
- `video.py` (370) — metadados + frames + transcrição de vídeo p/ IA.
- `transcricao.py` (107) — transcreve WAV 16kHz mono exportado pelo front (coluna do editor de vídeo).
- `economia.py` (789) — 5 modos da área Economia: RTK (remove tokens redundantes de saída de ferramenta), Headroom, Context Mode...
- `nuvem.py` (281) — check de versão, changelog, download do instalador (status/progresso).
- `instalador.py` (218) — baixa o instalador pelo backend (não pelo navegador) e prepara a instalação.
- `skills.py` (424) — descoberta/leitura de skills (pacotes de instruções, não executam nada).
- `subagentes.py` (174) — registro dos sub-agentes (prompt próprio, skills e MCPs escolhidos).
- `provider_state.py` (58) — estado de provedor persistido entre turnos (retém reasoning/tool continuations).
- `koda_headers.py` (114) — User-Agent/identificação do Koda ao falar com provedores externos.
- `koda_tool_protocol.py` (37) — conversão de tool-calls e eventos do protocolo Koda.
- `ui_documento.py` (1.181) — protocolo Koda UI: documento JSON validado, nunca HTML/JSX do modelo; card de compactação, diff de turno, etc.
- `ui_generativa.py` (279) — validação de blocos `koda-ui` e rebaixamento dos que não passam.
- `transport_grpc.py` (27) — leitor incremental de quadros gRPC-Web compartilhado por provedores.
- `provedores_koda.json` / `provedores_oauth.json` — dados: catálogo de provedores logados e OAuth.
- `cursor_canal_koda.mjs` — ponte Node do canal Cursor.
- `TERCEIROS_MIT.LICENSE` — licença de terceiros (MIT).

### `agent/` — motor atual (pensa, decide o turno e fecha)
- `loop.py` (3.807) — o laço: recebe pedido → classifica (pergunta × ação) → chama provedor → executa tools → devolve resultado. Portado de `nucleo/loop_agente.py` do projeto TOOLS.
- `contexto.py` (510) — orçamento de contexto: reenvia histórico, compacta a 64K (saídas antigas viram linha, miolo vira resumo), cartão na conversa.
- `budget.py` (60) — orçamento compartilhado (passos, retries, subagentes) via `ContextVar`.
- `completion.py` (118) — conferência local somente leitura pós-trabalho, sem pedir nova edição ao modelo.
- `dsml.py` (268) — parser das tool-calls que vazam como texto (formato DSML do DeepSeek/Kiro e do host).
- `historico_ferramentas.py` (24) — recupera respostas de ferramenta faltantes sem apagar mensagens.
- `instrucoes_projeto.py` (35) — injeta instruções do projeto (AGENTS.md etc.) no system sem alterar permissões do executor.
- `plans.py` (239) — planos imutáveis com hash/decisão explícita; texto do modelo não concede permissão.
- `prompts.py` (45) — instruções de apresentação; permissões e efeitos são impostos pelo executor.
- `repeticao.py` (346) — detecção de resposta degenerada por repetição (portado do `DUP-repetition_guard.py` do Koda).
- `subagente.py` (315) — sub-agente: mesmo laço, regras próprias; não é processo separado.
- `validacao_ferramentas.py` (28) — valida argumentos das ferramentas nativas contra o catálogo efetivo do turno.

### `tools/` — o que o modelo pode chamar
- `ferramentas.py` (3.264) — catálogo + handlers: arquivos, shell, Python, web, git, memória, `send_to_phone`... Portado do projeto TOOLS.
- `registry.py` (382) — registro: nome/descrição/argumento de cada ferramenta (`_def`), habilitação por pedido classificado.
- `patch_marcado.py` (181) — aplica patches com marcadores usando os controles de arquivo do Koda.
- `domains/files/schema.py` (247) — dono do schema de arquivos.
- `domains/shell/schema.py` (76) — schema de execução (comandos, shell).
- `domains/git/schema.py` (35) — schema de git.
- `domains/plano/schema.py` (88) — schema de plano de tarefas.
- `domains/agentes/schema.py` (62) — schema da ferramenta que lança sub-agente; descrição decide se o modelo usa ou faz ele mesmo.
- `domains/skills/schema.py` (27) — `use_skill` devolve o texto da skill.
- `domains/web/schema.py` (28) — schema de web (busca/página).
- `domains/dados/schema.py` (67) — dados reais verificáveis: clima, câmbio, imagens licenciadas, memória durável.
- `domains/interface/schema.py` (96) — schema da Koda UI (interface inteligente).

### `providers/` — adaptadores de modelo
- `base.py` (220) — interface comum: stream, tool-calling, lista de modelos.
- `local.py` (149) — provider offline/explícito sem chave: responde sem fingir que está pensando.
- `openai_compat.py` (1.217) — OpenAI/Groq/OpenRouter/Ollama em `/v1` (só quando o usuário configura `OPENAI_*`).
- `conta.py` (2.544) — conversas logadas: GLM, MiMo, Gemini CLI/Antigravity... (login do usuário, sem ler cookies de outro programa).
- `host_boot.py` (463) — descobre/sobe o `host/gateway-local` (portas 8790–8799/21128; headless 8794).
- `pensamento.py` (215) — reasoning: `reasoning_effort` por modelo/esforço (Automático/Mínimo/Baixo/Médio/Alto).
- `presentation.py` (215) — apresentação do modelo (nome, força, fallback «Outros» sem lista fixa no front).

### Catálogo e adapters `*_koda.py`
- `provedores.py` (1.938, raiz de `app/`) — catálogo central: ordem Haiku 5.5 → GLM 5.3 Flash → Qwen 3.8 Flash → Legacy, kwota reais (commit atual), modelos bloqueados.
- `accio_koda.py` (877) — Accio (protocolo próprio ADK/SSE, sem API OpenAI).
- `kiro_koda.py` (535) — Kiro: cliente de conversa + leitura incremental do Amazon EventStream.
- `zed_koda.py` (569) — Zed: transporte + conversão dos protocolos dos modelos hospedados.
- `windsurf_koda.py` (382) — Windsurf via Connect (`web-backend.windsurf.com`).
- `qoder_api.py` (305) / `qoder_koda.py` (255) / `qoder_cosy.py` (196) — Qoder e variantes.
- `cursor_agent_koda.py` (221) — protocolo de agente Cursor + ponte de ferramentas.
- `cursor_koda.py` (184) — conversa simples Cursor via Connect.
- `trae_koda.py` (157) — Trae SOLO.
- `mimo_conta_koda.py` (150) — sessão de conta MiMo informada pelo usuário.
- `google_conta_koda.py` (152) — Gemini CLI e Antigravity.
- `gitlab_koda.py` (78) — GitLab Duo.
- `glm_login_koda.py` (68) — login de dispositivo GLM + recuperação da chave do plano.
- `oauth_login.py` (2.113) — fluxos OAuth/PKCE de login nos provedores com sessão/banco de tokens.
- `host_auth.py` (176) — credencial que o backend apresenta ao host: sessão da conta, não chave de API.
- `host_dinamica.py` (217) — senha dinâmica do dia: credencial que o painel da nuvem entrega ao Koda; fail-closed sem ela.

### `mcp/`
- `cliente.py` (882) — cliente MCP stdio: JSON-RPC 2.0, lista tools, invoca.
- `__init__.py` (602) — servidores configurados viram ferramentas de verdade p/ o agente (até 0.6.2 era só lista de `{name, command}`).
- `store_mcp.py` (666, raiz de `app/`) — Store de conectores: catálogo, instalação, login (Supabase, Cloudflare, Firebase...).

### `contracts/` — contratos que todos importam (não é camada)
- `turn.py` (123) — o que provedor entrega × agente consome (`StepResult`).
- `mudancas.py` (298) — o que a IA mudou nos arquivos (antes/depois): daqui a aba Código tira verde/vermelho.
- `control.py` (33) — feedback do orquestrador é controle, nunca fala da pessoa.
- `tools.py` (27) — como se declara o schema de uma ferramenta.
- `approval.py` (17) — identidade e prazo da decisão que desbloqueia chamada em espera.
- `tool_result.py` (15) — estado de execução ≠ apresentação textual.

### `policy/` — permissões
- `approvals.py` (205) — modo `auto` × cartão de aprovação da ferramenta.
- `guards.py` (112) — guardas: o que nunca executa sem confirmação.
- `capabilities.py` (11) — capacidades declaradas.

### `execution/` — camada folha: como rodar processo
- `processo.py` (835) — a máquina de processo: rodar comando, timeout, capturar saída, não perder vista.
- `paths.py` (189) — operações de arquivo no Windows com handles nativos (anti race/anti delete enquanto usa).
- `tempo.py` (57) — prazos e cancelamento da execução.

### `motor_koda/` — geração anterior do motor
- `__init__.py` — exporta `BackendClient`, `apply_hunks`, `apply_patch`.
- `__main__.py` — entrypoint standalone de apply-patch.
- `client.py` (84) — cliente do backend de motor.
- `agent_tools.py` (166) — ferramentas do agente desse motor.
- `commands.py` (209) — comandos do motor.
- `config_merge.py` (117) — fusão de config.
- `exec_policy.py` (83) — política de execução.
- `instructions.py` (72) / `local_files.py` (72) — instruções e arquivos locais.
- `mcp_stdio.py` (316) — MCP stdio desse motor.
- `model_client.py` (282) — cliente de modelo.
- `patch_files.py` (70) / `patch_parser.py` (168) / `patch_update.py` (116) — aplicar e parsear patches.
- `rpc.py` (148) — RPC.
- `server.py` (352) — servidor do motor.
- `threads.py` (383) — threads/sessões.
- `turns.py` (249) — turnos.

### `nucleo_turno/` — outra geração, fina e a mais testada
- `turno.py` (132) — o turno em si.
- `modelo.py` (284) — protocolos de modelo (stream, tool-calling).
- `controle.py` (108) — controle do turno (parar, continuar).
- `politica_execucao.py` (92) — quando executar tool.
- `historico.py` (70) — histórico do turno.
- `validacao.py` (68) — validação de entrada/saída do turno.
- `instrucoes.py` (71) — instruções do turno.
- `plano.py` (54) — plano do turno.
- `pedido_modelo.py` (44) — pedido ao modelo.
- `tentativas.py` (47) — tentativas/retry.
- `janela_contexto.py` (36) — janela de contexto do turno.
- `limite_saida.py` (41) — teto de saída.
- `repeticao_fluxo.py` (26) — repetição no fluxo.
- `origem_chamada.py` (24) — de onde veio a chamada.
- `despacho_comandos.py` (26) — despacha comandos do turno.
- `exposicao_ferramentas.py` (51) — quais ferramentas ficam expostas no turno.

### `routers/` — HTTP, um por domínio
- `chat.py` (1.838) — `POST /api/chat`: SSE (`start/delta/.../done`), grava conversa, abort parcial salvo.
- `remoto.py` (589) — rotas do koda-link vistas pelo app do PC.
- `navegador.py` (420) — navegador do celular (4 famílias de rota).
- `projects.py` (417) — projetos e permissões.
- `models.py` (172) — `GET /api/models`: o que o provedor atual aceita; o seletor mostra catálogo do gateway + isto.
- `mcps.py` (157) — `GET/POST /api/mcps`: servidores configurados, do jeito que o submenu usa.
- `prompt.py` (152) — melhorar rascunho (botão folha no composer; modo escolhido, texto volta).
- `store.py` (114) — aba MCPs da Store: catálogo+instalar+login em 4 rotas.
- `skills.py` (123) — `GET/POST /api/skills`: instaladas e cadastradas; lógica mora em `app/skills.py`.
- `host.py` (111) — status/sobida do host por API.
- `dev_browser.py` (95) — feed do navegador do Painel Dev (console/rede).
- `nuvem.py` (95) — aviso de atualização, changelog, download do instalador (quase tudo leitura).
- `provedores.py` (89) — provedores com login: quais existem, o login vale, que modelos há...
- `agentes.py` (74) — sub-agentes: CRUD.
- `conversations.py` (73) — lista/cria/lê/apaga conversas.
- `live.py` (69) — rodadas ao vivo p/ reconectar.
- `attachments.py` (62) — anexos por API.
- `dev_logs.py` (59) — logs do processo de trás p/ o Painel Dev.
- `account.py` (57) — conta, telefone e Google vinculados.
- `economia.py` (45) — modos de economia por API.
- `usage.py` (34) — `GET /api/usage`: cotas diária/semanal/mensal + totais.
- `transferencias.py` (30) — `GET /api/transfer/<id>`: entrega arquivo preparado p/ celular.

### Dados / ambiente do backend
- `backend/data/` — `koda.db` (+ WAL/SHM), `mcps.json`, `skills.json`, `memoria.json`, `economia.json`, `rede-local.json`, `.bak` pré-auditoria, `dev-browser.json` + png.
- `backend/.env` (existe no disco — confirme fora do Git), `.env.example`, `pyproject.toml` / `uv.lock` / `requirements.txt`, `COMO-REFAZER-O-AMBIENTE.txt`, `backend-dev.log`.
- `backend/tests/` — `test_koda_provider_adapters.py` (1.292) + `test_koda_remaining_providers.py` (1.016), `test_gateway_porta.py` (184), `test_ui_documento.py` (200), `test_classificacao_pedido.py` (110), `test_integracao_motor_koda.py` (106), `test_restricoes_pedido.py` (95), resto pequenos, mais suítes `motor_koda/` (18) e `nucleo_turno/` (17).

## Frontend — `src/` (~34K linhas)
- `App.tsx` (4.183) — tela inteira e estado global (conversa, streaming, listas, modais). Monolito.
- `api/client.ts` (1.884) — cliente HTTP: chat/SSE, conversas, projetos, conta, provedores, gramática de token.
- `api/cloud.ts` (762) — update/check/changelog/download do instalador.
- `api/cobranca.ts` (180) — cobrança e pagamentos.
- `blocos.tsx` (987) — blocos de mensagem (texto, código, diff, ferramentas).
- `components/BlocosVisuais.tsx` (2.940) — render visual dos blocos. Monolito.
- `components/SettingsScreen.tsx` (2.933) — tela de Ajustes inteira. Monolito.
- `components/Composer.tsx` (1.670) — caixa de mensagem, anexos, esforço, menções.
- `components/KodaUI/desenho.tsx` (1.155) / `extras.tsx` (985) / `protocolo.ts` (332) / `utilidades.ts` (48) — design system próprio.
- `components/PainelLateral.tsx` (875) — histórico e navegação de conversas.
- `components/CheckoutScreen.tsx` (803) — checkout/pagamento.
- `components/RichText.tsx` (776) — Markdown + código renderizado.
- `components/CelularSection.tsx` (724) — seção celular (link/QR).
- `components/PainelCodigo.tsx` (638) — aba Código (verde/vermelho).
- `components/Subs.tsx` (628) — assinaturas/planos.
- `components/Header.tsx` (573) — topo do app.
- `components/EditorDeVideo.tsx` (556) — editor de vídeo na conversa.
- `components/AccountSection.tsx` (535) — conta (telefone/Google).
- `components/Store.tsx` (482) — aba MCPs da Store.
- `components/Presente.tsx` (477) — presente da ferramenta (cards ricos).
- `components/Menu.tsx` (318) — menus.
- `components/UiGenerativa/avaliador.ts` (837) / `componentes.tsx` (692) / `parser.ts` (322) / `index.tsx` (251) / `eventos.ts` (94) / `deteccao.ts` (17) — UI generativa do front.
- Demais componentes e utils (18–330 linhas cada): `ApprovalCard`, `AvisoDeArraste`, `BarraLateralCamera`, `BlocosInteracao`, `BolhaUsuario`, `Compactacao`, `ContextRing`, `DiagnosticoLocal`, `DiffDoPasso`, `EconomiaSection`, `FalaDoModelo`, `FolhaTesouro`, `Janela`, `KodaLogo`, `LogosDosConectores`, `MessageFooter`, `MoedaKoda`, `PorquinhoComMoedas`, `ProjectPicker`, `Reasoning`, `ReconnectingLine`, `SeletorDeVideo`, `TarefaIncompleta`, `ThinkingMark`, `ToDos`, `ToolIcon`, `ToolSteps`, `WindowControls`, `WorkingLine`.
- `tempo.ts` (313) — escala humana de tempo (47ms → 1,4s → 2,7min). `models.tsx` (266), `tools.ts` (199), `plano.ts` (192), `chat-solto.tsx` (188), `mencoes.ts` (176), `reconectar.ts` (161), `compactacao.ts` (122), `custo.ts` (113), resto <100 linhas.
- `main.tsx` (16) — bootstrap React. `index.css` (532) — Tailwind 4 + tokens.
- `assets/provedores/` — logos SVG dos provedores.

## Desktop — `src-tauri/src/`
- `main.rs` — shell Tauri 2: sobe host → backend nessa ordem, portas efêmeras, entrega token+portas por `invoke`. Contém `URL_DO_PAINEL` (fail-closed sem ela) e `CHAVE_DA_CONFIG_SELADA` (lê `SERVE_LIZ_BLOB_KEY` do ambiente).
- `acesso.rs` — token por execução (32 bytes aleatórios) + handshake HMAC + porta efêmera.
- `servicos.rs` — ciclo de vida dos filhos: Job Object do Windows (morre junto com o app) + vigia (5 tentativas, depois a cada 5 min).
- `portas.rs` — quem ocupa a porta: ninguém / outra janela / alheio / sobra nossa (só sobra sai da frente).
- `diagnostico.rs` — retrato do serviço local p/ Ajustes (Python empacotado, portas, últimas linhas do log).
- `capabilities/default.json` — permissões do Tauri.
- `runtime/` (454MB) e `runtime-linux/` — venvs Python empacotados (gerados por `scripts/gerar-runtime-*.mjs`).
- `gen/` — schemas gerados. `tauri.conf.json` — janela 1280×820, CSP, bundle NSIS/MSI, recursos (mcp, skills, backend/python, backend/app, node).

## `host/gateway-local/` (Node/Express, código ofuscado)
- `src/server.js` — Express: saúde, contas, modelos, settings, RTK, login, refresh de créditos.
- `src/gateway.js` — router OpenAI-compatível: `/v1/chat/completions` (stream + non-stream), `/v1/models`, retry + failover de conta, `applyStyle` (modo telegráfico).
- `src/config.js` — catálogo (`claude-haiku-5.5`, `glm-5.3-flash`, `qwen-3.8-flash`, `qwen-3.8-flash-legacy`), portas (`ACCIO_PORT` 8790/8794 headless), `appVersion 0.37.1`, upstream, multiplicadores.
- `src/headless.js` — sobe sem window: importa contas legadas, escuta na próxima porta livre a partir de 8794.
- `src/auth.js` — login e refresh de créditos/contas (callbacks).
- `src/store.js` — store de contas (`accounts.json`, `.store-key`, criptografia).
- `src/phoenix.js` — upstream (`streamChat`, `refreshTokens`, `warmDevice`, erros 401/429/5xx).
- `src/rtk.js` — economia de tokens (bytes antes/depois, hits).
- `src/loop-guard.js` — detecção de tool-call repetido + instrução de objetivo.
- `src/logger.js` / `src/settings.js` — logs em memória + settings persistidas.
- `host/bin/` — `ffmpeg/ffplay/ffprobe.exe` (não versionados no Git).
- `koda-host-dinamica.json` — config dinâmica do host.

## Nuvem — `server/` (Cloudflare Worker, Hono + D1)
- `src/index.ts` — Hono: contexto → segurança → https → CORS → cobrança/em manutenção → garante admin do ambiente; rotas `/api/public`, `/api`, `/admin`.
- `src/types.ts` — tipos `Aplicacao`, `Ator`, `Variaveis` (requestId, ator, ip, csrf).
- `routes/public.ts` — health, version, changelog, models (públicos).
- `routes/app.ts` — conta/uso/host do app.
- `routes/admin.ts` — gestão de contas, modelos, releases, auditoria.
- `routes/painel.ts` — servidor HTML do painel.
- `controllers/admin*` (5) — admin: contas, auditoria, auth, modelos, releases.
- `controllers/app*` (3) — app: conta, host, uso.
- `controllers/panel*` (4) — painel HTML.
- `controllers/billingController.ts` — cobrança.
- `controllers/publicController.ts` — público.
- `models/*.ts` (16) — SQL parametrizado com `bind()` (users, payments, subscriptions, usage, releases, rateLimits, refreshTokens, loginAttempts, plans, creditGrants, notifications, auditLog, userModels, catalogModels, catalogMcps, assets).
- `services/*.ts` (18) — auth, conta, auditoria, mercadoPago, senhaDinamica, totp, token, upload, version, mcp, modelo, rateLimit, reembolso, creditosAvulsos, billingMaintenance, bootstrap, paymentIntent.
- `middlewares/` (8) — autenticacao, contexto, cors, csrf, erros, https, limite, seguranca, validacao.
- `utils/` (7) — crypto, jwt, datas, documento, errosDoPainel, html, logger, request, semver.
- `views/` (4) — layout, login, painel, catálogo.
- `migrations/0001–0006` — esquema D1 (init, pagamentos, créditos avulsos, uso, mcps, payment applications) com triggers de imutabilidade.
- `scripts/` — gerar env, hash de senha, semear modelos.
- `tests/` — `audit-security.test.mjs`, `senha-dinamica.test.mjs`.
- `wrangler.jsonc` — deploy Cloudflare.

## MCPs extras — `mcp/`
- `dev-browser/server.mjs` — MCP `koda-dev-browser`: controle o navegador de verdade via CDP (Chrome/Edge já instalado, zero dependência), DOM/clique/digitação, espelha sessão pro Painel Dev.
- `dev-logs/server.mjs` — MCP `koda-dev-logs`: junta logs do navegador + servidor com assinatura (10.000 repetições viram uma linha), teto de saída, nunca vazio por engano.
- `video-analizar/server.mjs` + `elementos.py` — `analisar_video` e `transcrever_video`: devolvem texto (transcrição com timestamps, metadados, momentos); visual fica com os frames anexados na conversa.
- `mcps.json` — seed de MCPs do Koda.
- `F01–F05-F08` — docs de design (despacho, cartão, node embutido, cliente, conserto).

## CLI — `CLI/`
- `bin/koda.js` + `index.js` (17.8K) — CLI em terminal com alt-screen, mouse, banner ASCII KODA, paleta roxa.
- `package.json` — pacote npm do CLI.

## Mobile / Link
- `mobile/` — PWA (`index.html` 29K, `mobile.js` 186K, `mobile.css` 94K, `blocos.js` 113K) + `koda-mobile-0.9.1.apk` (1.4M).
- `link/server.py` (38.8K) — mini servidor Python do `koda-link` (link compartilhável PC↔celular).
- `link/provedores/` — logos SVG dos provedores.

## Build, scripts e raiz
- `scripts/` — `verificar-host.mjs`, `verificar-bundle-host.mjs`, `criar-launcher-instalador.mjs`, `gerar-runtime-backend.mjs`, `gerar-runtime-node.mjs`, `gerar-icone.mjs`, `gerar-imagens-instalador.mjs`, `gerar-manifesto-skills.mjs`, `preparar-dependencias-exe.ps1`, `verificar-painel-webview.mjs`, `verificar-reconexao.mjs`, `verificar-restart-tempo.mjs`, `verificar-tempo-do-dia.mjs`, `verify-local-migration.py`, `installer-launcher/`.
- `docs/` — `auditoria-2026-10-22/` e `2026-10-23/` (50+ evidências de auditoria/deploy), `KODA-UI-MATRIZ-105.md`, `FIX_REASONING_TOOL_CONTINUATION.md`, `HTTP400_REASONING_HISTORY.md`, `COMO-GERAR-INSTALADORES-2026-10-23.md`, `DEPENDENCIAS-EXE.md`.
- `ANALISE-KODA.md`, `ANALISE-KODA-0.8.0.md`, `AUDITORIA-PROVEDORES.md` — análises anteriores.
- `vite.config.ts` (9.9K) — Vite + plugin de dev `/@local/` (serve disco p/ navegador em dev; só `serve`, não vai pro build).
- `package.json` — Koda 0.8.5: `dev`, `build`, `app`, `app:host`, `app:runtime`, `app:node`, `app:build`, `verificar`.
- `skills/` — 4 skills (`design-taste-frontend`, `diagnosticar-logs`, `validar-front`, `video-analizar`) + `skills.json`.
- `tsconfig*.json`, `.oxlintrc.json`.

