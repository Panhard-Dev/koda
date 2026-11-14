# QA do Koda — navegador, MCP, Skills, Painel Dev e integrações

**Data:** 2026-11-12  
**Versão observada:** 0.8.6  
**Branch:** `codex/koda-0.8.0-todas-mudancas`  
**Escopo:** verificação e relatório. Nenhum arquivo de código, configuração de produto, build, instalação, provedor, MCP, Skill, permissão ou pacote foi alterado deliberadamente.

## Resumo executivo

O login, o catálogo de modelos, a navegação de Skills, MCPs, Store, Celular e a estrutura do Painel Dev funcionaram no navegador. A suíte focada de inicialização, túnel, MCP e catálogo passou; `tsc -b` e o lint direcionado passaram. O túnel Cloudflare abriu, respondeu `200` publicamente e foi fechado com sucesso em uma repetição controlada.

**A IA está respondendo.** Um teste adicional, feito depois da primeira versão deste relatório, enviou prompts inofensivos pelo chat real e pelo endpoint `/api/chat`. A interface exibiu a resposta completa em ~4,9 s; o stream terminou com `done` e `completed: true`. Os cinco modelos do catálogo (`layze-2.1-flash`, `liz-4.5-super`, `koda-2-pro`, `koda-1` e `mx-lz1-teste`) responderam depois de uma sessão válida. Detalhes na seção «Resposta da IA (teste adicional)».

**Não está tudo verde.** A primeira tentativa de abrir o túnel pela interface falhou: o backend levantou `RuntimeError: o túnel não ficou alcançável: ConnectError`, devolveu `500` sem `Access-Control-Allow-Origin`, e o navegador apresentou isso como erro de CORS. Três MCPs locais estão fora do ar porque a configuração aponta para um `node.exe` Windows, sem permissão de execução no Linux; um quarto MCP tem um caminho Windows inválido. O Painel Dev responde, mas seus feeds de estado estão obsoletos e a imagem vem de uma captura antiga. A suíte completa do backend mantém 3 falhas Windsurf pré-existentes. Há também um `403` isolado no console, não reproduzido nas execuções seguintes, que merece observação. Durante o teste de chat, uma chamada de diagnóstico com token de conta vazio limpou a sessão do host e fez todos os modelos devolverem `401` de credencial diária; um novo login no navegador restaurou a sessão e as respostas. Isso é comportamento esperado do logout/limpeza, mas mostra que a IA depende de uma sessão de conta ativa.

**Conclusão:** as áreas principais da interface estão utilizáveis, mas MCP/Painel Dev **não** estão plenamente funcionais neste ambiente de desenvolvimento Linux, e a abertura do túnel é intermitente. Não foi feita nenhuma correção, conforme solicitado.

## Como foi testado

- Ambiente local efêmero: backend em `127.0.0.1:8787` e Vite em `127.0.0.1:5173`, ambos encerrados ao final.
- Chromium headless real, com login usando a conta de teste fornecida. A senha foi passada somente por variável de ambiente ao processo de teste; não foi gravada neste relatório, em arquivos do projeto nem em logs.
- Instrumentação de respostas HTTP, falhas de requisição e erros de console.
- Navegação por papéis/ rótulos acessíveis: menus, abas, switches, formulário e iframe.
- Consultas `GET`/`OPTIONS` deAPI, preflight CORS e uma abertura/fechamento controlados de túnel.
- Testes automatizados e verificações estáticas, sem executar builds nem instaladores.
- Não foram usados: cadastro/edição/exclusão de Skills ou MCPs, ativação da Store, alteração de permissões, envio de chat com ferramentas, login em provedores, downloads, deploy ou ações administrativas.

Evidências temporárias geradas fora do repositório: `/tmp/koda-qa-estado.json`, `/tmp/koda-qa-ui.json`, `/tmp/koda-qa-ui2.json`, `/tmp/koda-qa-integracao.json`, `/tmp/koda-qa-login.png`, `/tmp/koda-qa-painel-dev.png`, `/tmp/koda-qa-store.png`, `/tmp/koda-qa-tunel.png`, `/tmp/koda-qa-api.log` e `/tmp/koda-qa-web.log`.

## Resultados por área

| Área | Resultado | Evidência |
|---|---|---|
| Subida local | **PASSOU** | `/api/health` e Vite responderam `200`; token de desenvolvimento alinhado. |
| Login da conta | **PASSOU** | Login em nuvem `200`, `POST /api/host/sessao` `200`, `koda.conta` presente; chat e ferramentas carregaram. Duas execuções adicionais terminaram sem erros de rede ou console. |
| Proteção da API | **PASSOU** | `200` com ACAO em health; `401` sem token também com ACAO; preflight `OPTIONS` `200` com ACAO; `Host` não local devolveu `403`. |
| Catálogo de modelos | **PASSOU** | `GET /api/models` e `/api/models/testados` devolveram 5 modelos: `liz-4.5-super`, `koda-2-pro`, `koda-1`, `mx-lz1-teste`, `layze-2.1-flash`. `GET /api/provedores` listou 31 provedores. |
| Health detalhado | **PASSOU** | `provider: host`, `provider_ready: true`, `tools_ready: true`, `version: 0.8.6`, 44 ferramentas listadas. |
| Skills — leitura e UI | **PASSOU** | `GET /api/skills` devolveu 5 Skills ativas; menu exibiu «5 ativas · 0 desativadas»; tela de ajustes exibiu nomes, escopo, estado e descrições. Não houve escrita. |
| MCP — leitura e UI | **PARCIAL** | `GET /api/mcps` e as telas/menu/listas funcionaram: 5 itens, `github` conectado com 26 ferramentas. Outros 4 estão fora do ar; detalhes abaixo. |
| Store — leitura e UI | **PASSOU COM LIMITE** | Vistas «Skills», «MCPs» e «Sub-agentes» abriram; catálogo MCP da casa carregou. «Skills publicadas» mostra «EM CONSTRUÇÃO». `GET /api/store/mcps` `200`; `GET /api/store/skills` não existe (`404`), aparentemente porque a vista é estática. Nenhum download/ativação foi feito. |
| Painel Dev — UI | **PASSOU** | Botão abriu a barra lateral; abas «Painel Dev», «Código», «Subs» e «Logs» alternaram com `aria-selected=true`; campo «Endereço» abriu `/chat.html` em iframe com `sandbox`; `/@local/...` serviu `index.html` com `200`. |
| Painel Dev — feeds | **PARCIAL** | `GET /api/dev-browser/tela` devolveu PNG `200` com `Cache-Control: no-store`, porém `GET /api/dev-browser` e `/api/dev-logs` informaram `vivo: false`, «a sessão parou de publicar» e idade superior a 11 dias. A captura é antiga, não um frame ao vivo desta execução. |
| Celular — UI | **PASSOU** | Tela «Conectar celular», modos «Túnel público» / «Mesma Wi-Fi» / «Meu servidor», switch «Entrada pela rede local» (`aria-checked=true`) e avisos de segurança apareceram. Nenhum switch foi alterado. |
| Túnel Cloudflare | **INTERMITENTE** | Primeira abertura pela UI falhou; repetição pela API abriu com `200`, QR/sala gerados, `/api/health` público `200` com `{"ok":true,"nome":"koda-link","versao":"0.1.0"}`; túnel foi fechado e o estado final ficou `aberto: false`. Nenhum túnel deste QA ficou aberto. |
| Encerramento | **PASSOU** | Backend, Vite, LizProxy e MCP GitHub iniciados para o QA foram encerrados; configuração temporária de preview removida. |

## Achados e observações

### 1. Abertura intermitente do túnel e erro apresentado como CORS — prioridade alta

Sequência observada na primeira execução pela interface:

1. `POST /api/remoto/tunel/abrir` não produziu QR em 120 s.
2. O console do Chromium exibiu: `Access to fetch at '.../api/remoto/tunel/abrir' ... blocked by CORS policy: No 'Access-Control-Allow-Origin' header`.
3. Uma consulta de estado sem os cabeçalhos completos devolveu `401`.
4. Requisição controlada posterior identificou a causa real: `HTTP/1.1 500 Internal Server Error` **sem ACAO** e exceção no backend:

```text
backend/app/tunel.py:291  RuntimeError: o túnel não ficou alcançável: ConnectError
backend/app/routers/remoto.py:569  abrir_tunel
```

Ou seja, a validação pública do túnel não conseguiu conectar `8` vezes. Quando uma exceção não tratada atravessa `BaseHTTPMiddleware`, o `CORSMiddleware` não consegue acrescentar o cabeçalho; o navegador então reporta CORS, escondendo o `500`. O preflight `OPTIONS` e os casos `200`/`401`/`403` têm ACAO correto. A repetição controlada abriu o túnel em `200` com ACAO e health público `200`, confirmando intermitência da conectividade/edge, não uma quebra permanente da rota.

**Impacto:** o usuário pode ver «erro de CORS» e não receber QR mesmo quando o problema é falha de conexão pública. Como este QA é somente relatório, nenhuma correção foi aplicada.

### 2. MCPs locais fora do ar neste Linux — prioridade alta para QA de dev

`GET /api/mcps` mostrou:

| MCP | Estado | Motivo apresentado |
|---|---|---|
| `github` | **conectado**, 26 ferramentas | Funcionando via `npx`. |
| `navegador` | fora do ar | Tentou iniciar `src-tauri/runtime/node/node.exe`; `[Errno 13] Permission denied`. |
| `logs` | fora do ar | Mesmo erro. |
| `video-analizar` | fora do ar | Mesmo erro. |
| `filesystem-e2e` | fora do ar | Configuração com `C:/tmp`; o servidor recusou `/home/eupanhard/Downloads/koda/backend/C:/tmp`. |

Inspeção adicional: `src-tauri/runtime/node/node.exe` é um executável PE32+ de Windows, com modo `0664` e sem bit executável. É esperado que não rode em Linux. A causa é uma mistura de runtime Windows/configuração de teste com caminho Windows no checkout de desenvolvimento, não uma indisponibilidade do protocolo MCP em si: o conector GitHub prova que o cliente MCP funciona.

**Impacto:** Painel Dev e logs não recebem estado ao vivo; captura e erros ficam obsoletos. Não alterei `data/mcps.json`, permissões nem processos para preservar o pedido de «não mexer nada».

### 3. `403` isolado no console — baixa prioridade / observação

Na primeira execução de login, houve uma única mensagem `Failed to load resource: the server responded with a status of 403 (Forbidden)`, sem URL associada nos eventos de resposta capturados. As 65 respostas `/api` e `/v1` daquela execução foram `2xx`; duas execuções posteriores de login terminaram com zero erros de console. Não foi possível atribuir o `403` a um recurso específico. Fica registrado como intermitente não reproduzido, não como aprovação de que todo o console está permanentemente limpo.

### 4. Erros de seletor nos primeiros roteiros não são defeitos do app

Dois roteiros iniciais de automação usaram `menuitem` para itens que o componente expõe como `menuitemradio`, e procuraram o switch de rede local sem antes abrir a aba «Mesma Wi-Fi». Após corrigir apenas o roteiro de teste, todas essas telas abriram e foram validadas. Esses timeout são erro do harness, não falha do produto.

### 5. Store de Skills «EM CONSTRUÇÃO»

A aba «Skills» da Store abre, mas exibe «EM CONSTRUÇÃO». `GET /api/store/skills` devolve `404`; a aba «MCPs» carrega o catálogo da casa com `200`. Isso parece ser estado atual do produto, não regressão observada nesta execução.

## Testes automatizados e verificações

| Verificação | Resultado |
|---|---|
| `pytest tests/test_inicializacao_host.py tests/test_tunel_remoto.py tests/motor_koda/test_mcp.py tests/test_catalogo_modelos.py -q` | **12 passed**. |
| `pytest -q` (backend completo) | **558 passed, 96 subtests passed, 3 failed**. Falhas: `test_windsurf_grpc_web_e_modelo_sem_motor_antigo`, `test_windsurf_recusa_quadro_incompleto_e_host_estranho`, `test_windsurf_erro_grpc_nao_e_sucesso`. Erro comum: `AttributeError: 'Cliente' object has no attribute 'post'` em `app/windsurf_koda.py:181`. É a incompatibilidade pré-existente entre testes que mockam API gRPC antiga e implementação Connect atual; não foi introduzida por este QA. |
| `npx tsc -b --pretty false` | **PASSOU**. |
| `npx oxlint` nos arquivos de UI/API/Vite examinados | **PASSOU**, com 2 avisos pré-existentes de `react-hooks` em `src/components/SettingsScreen.tsx:1368` e `:1371`. |
| `node scripts/verificar-reconexao.mjs` | **PASSOU**: «tudo verde (4 retries curtos para falhas transitórias e erro permanente imediato)». |
| `node scripts/verificar-painel-webview.mjs` | **NÃO EXECUTADO**: dependência `jsdom` ausente (`ERR_MODULE_NOT_FOUND`). Não instalei nada para preservar o escopo. |
| Harnesses de build/release | Não executados: não fazem parte deste QA e poderiam alterar artefatos. |

## Rede e console — números das execuções

| Execução | Respostas `/api` observadas | Não-2xx | Falhas de requisição | Console |
|---|---:|---:|---:|---|
| Login 1 | 65 | 0 | 0 | 1 aviso `403` isolado |
| Login 2 | não contabilizado separadamente | 0 | 0 | 0 |
| Login 3 (observação de 24 s) | não contabilizado separadamente | 0 | 0 | 0 |
| UI principal (Skills/MCP/Ajustes/Painel Dev) | 208 | 0 | 0 | 0 |
| UI Celular/Store | 68 | 0 | 0 | 0 |
| Integração CORS/túnel | 524 | 1 `401` em consulta sem cabeçalho de sessão | 1 `net::ERR_FAILED` no `POST` que virou `500` | 4 mensagens derivadas da mesma falha de túnel |

O `401` da consulta de estado na última linha veio de uma chamada auxiliar do próprio roteiro sem o cabeçalho de sessão exigido; o backend aplicou deny-by-default corretamente. As requisições controladas com os cabeçalhos corretos devolveram `200`.

## Estado final e não verificado

- Nenhum túnel aberto pelo QA: `tunel.aberto=false`, `public_url=null`, `sala=null`. O link local permanece como já estava antes do QA (`link.rodando=true`, porta `8798`); não foi ligado nem desligado por este teste.
- Um processo `cloudflared` de uma instância AppImage já existente antes do QA (`/tmp/.mount_Koda_0lcFjIM/...`, PID observado `67969`) foi deixado intacto por não pertencer a esta execução.
- Backend, Vite, LizProxy e MCP GitHub iniciados para o QA foram encerrados; `.claude/launch.json` temporário foi removido.
- A conta de teste foi usada apenas para login local. Não houve logout remoto, revogação de sessão, alteração de plano, compra, escrita de Skill/MCP ou exclusão.
- **Não verificado:** instalação/execução dos pacotes 0.8.6, app Tauri empacotado, webview nativo do Painel Dev, pareamento real com celular, chamada de ferramentas MCP que exigem escrita/credenciais, fluxos de cobrança/admin e comportamento em outra máquina. O Painel Dev foi testado no modo iframe do Vite, não no webview Tauri.
- O repositório já estava extensivamente modificado antes deste QA. Não foi feito commit, push, PR nem qualquer alteração intencional de código; o único arquivo novo entregue é este relatório.

## Resposta da IA (teste adicional)

Pergunta do usuário: «as ia ta funcionando? ta respondendo?». O QA anterior não havia enviado uma mensagem ao chat, então foi feito um teste novo, também sem alterar código.

| Teste | Resultado |
|---|---|
| `POST /api/chat` com `text="Responda apenas PINGUIM_TESTE_123."`, `tools=false` | **PASSOU.** SSE `start → delta → done`; `delta` com `PINGUIM_TESTE_123`; `done` com `elapsed_ms=5080`, `tokens=19`. |
| Chat real no navegador, após login, com `Responda exatamente: PINGUIM_UI_456` | **PASSOU.** A interface mostrou `PINGUIM_UI_456`, `42 tok`, `0,0 moedas`, `Levou 4,9 s`. Stream `200` com eventos `start`, `delta`, `done`, `completed: true`, `steps: 0`, `executed: 0`; nenhum erro de console/rede e nenhuma resposta não-2xx nas 74 chamadas observadas. |
| Cinco modelos do catálogo, após novo login no navegador | **PASSOU.** `layze-2.1-flash` 2,7 s, `liz-4.5-super` 4,1 s, `koda-2-pro` 3,3 s, `koda-1` 3,0 s e `mx-lz1-teste` 4,4 s; todos devolveram `OK` com `delta` e sem evento `error`. |
| Chamada de diagnóstico com token de conta vazio a `/api/host/sessao` | Limpou a sessão (`autenticado: false`, `provider: local`) e, em seguida, todos os modelos devolveram `401` com «Credencial diária do Koda ausente, inválida ou expirada». Um novo login no navegador restabeleceu `autenticado: true`, `provider: host`, `tools_ready: true`; `/v1/models` do LizProxy voltou a `200` com a chave atual e `401` com chave errada. Todos os cinco modelos voltaram a responder. |

**Resposta direta:** sim, a IA está respondendo, inclusive pela interface, quando a conta de teste está autenticada e a credencial diária está sincronizada. O teste usou prompts triviais, sem ferramentas; não verifica raciocínio longo, execução de ferramentas, anexos nem todos os provedores externos. A dependência de sessão ativa é real: se a sessão for limpa ou a credencial diária expirar, o chat devolve o `401` do host.

Evidências adicionais: `/tmp/koda-qa-chat.json`, `/tmp/koda-qa-chat-ui.json`, `/tmp/koda-qa-chat-resposta.png`, `/tmp/koda-qa-chat-ui.png`, `/tmp/koda-qa-chat-api.log` e `/tmp/koda-qa-chat-web.log`. Backend, Vite e LizProxy iniciados para este teste foram encerrados.

## Recomendações para um próximo turno de correção (não executadas)

1. Tratar `RuntimeError`/exceções não previstas de `abrir_tunel` com uma resposta JSON de erro que preserve ACAO, para o navegador mostrar a falha real em vez de CORS; melhorar diagnóstico e retentativa de `confirmar_publico()` para `ConnectError`.
2. Separar a configuração de MCPs de desenvolvimento Linux do runtime Windows embalado, ou apontar os MCPs locais para um `node` executável do sistema; corrigir/remover a entrada de teste com `C:/tmp`.
3. Revalidar `/api/dev-browser` e `/api/dev-logs` depois que os MCPs locais publicarem estado novo — e não considerar o PNG `200` isolado como prova de captura ao vivo.
4. Investigar o `403` isolado com captura de `response` + `location` caso reapareça.
5. Atualizar os 3 testes Windsurf para a API Connect atual, ou adaptar o cliente para preservar o contrato que os testes esperam.
