# Auditoria dos provedores — streaming e ferramentas

> Revisão feita em 01/11/2026, com o backend rodando em `127.0.0.1:8787` e as contas já
> logadas em `backend/data/koda.db`. Cada provedor conectado foi testado com o adaptador
> real (`ContaProvider`), não com um mock. Nenhum token é reproduzido neste relatório.

---

## 1. Resumo executivo

As duas percepções estavam certas.

1. **O streaming estava desligado no modo agente para todos os provedores de conta.**
   Quando as ferramentas estão ativas, o `loop.py` usa `step()`; o `ContaProvider` não tem
   `step_streaming`, então o passo inteiro volta de uma vez e a interface recebe **um único
   evento `delta`**. Com ferramentas desligadas, o mesmo modelo entrega 59 eventos `delta`.
   Medido no `/api/chat`: `tools:false` → 59 deltas; `tools:true` → 1 delta.
   **Corrigido em 01/11/2026** — ver §4 (P0) e §8. Depois da correção, o mesmo teste mede
   **46 deltas** com `tools:true` (CodeBuddy) e **93 deltas + 3 chamadas de ferramenta**
   (OpenAI).
2. **As falhas de ferramenta não são só comportamento de modelo.** Havia causas de código:
   o Windsurf chamava um caminho que hoje responde 404; o Kiro quebrava em ferramenta sem
   argumentos; o Grok CLI mandava a versão no cabeçalho errado; o GitHub listava justamente
   os modelos que a integração recusa; o iFlow escondia a recusa num HTTP 200. **Todas
   corrigidas** — ver §9.

**Números depois das correções:** 29 provedores no catálogo, 17 conectados,
**6 com conversa em streaming e chamada de ferramenta completas** (OpenAI, GitHub, Kiro,
Nous, Kilocode, Grok CLI), 1 com ferramenta mas cota intermitente (CodeBuddy), e 10 que
falham por **estado da conta** (saldo, assinatura, fila ou plano) — nenhum por defeito de
código conhecido.

---

## 2. Como foi testado

Para cada provedor conectado, com o modelo indicado:

| Teste | O que prova |
| --- | --- |
| `provider.stream(...)` com "Conte de 1 a 30" | se o SSE entrega pedaços incrementais de verdade |
| `provider.step(...)` com o **catálogo completo** (40 ferramentas) e pedido de `read_file` | se o provedor aceita todos os esquemas e devolve `tool_calls` |
| `provider.step(...)` com `get_environment` (ferramenta sem argumentos) | separa "não chama" de "não aceita o esquema" |
| `POST /api/chat` com `tools:true` | o laço agêntico real: `tool_call` → `tool_result` → resposta |
| `POST /api/chat` com `tools:false` | o caminho de texto puro, para comparar o streaming |

O catálogo tem **40 ferramentas**. O teste de catálogo completo usa todas as 40 de uma vez;
é o teste mais duro de compatibilidade de esquema.

---

## 3. Matriz dos 17 provedores conectados

| Provedor | Conversa (`stream`) | Ferramentas (catálogo 40) | Ferramenta sem args | Diagnóstico |
| --- | --- | --- | --- | --- |
| **openai** | ✅ 59 pedaços | ✅ `read_file` | ✅ | Melhor caso. Laço agêntico completo funcionou. |
| **github** | ✅ 59 pedaços (`gpt-4.1`) | ✅ | ✅ | **Corrigido:** a lista vem ao vivo do `/models` e mostra os 10 modelos habilitados para esta conta. |
| **codebuddy-intl** | ✅ 11 pedaços | ✅ | ✅ | Laço agêntico completo funcionou. |
| **kiro** | ✅ 8 pedaços | ✅ | ✅ | **Corrigido:** ferramenta sem argumentos (`input` vazio) vira `{}`. |
| **nous** | ✅ 79 pedaços | ✅ | ✅ | Funciona com `upstage/solar-mini4:free`; o `longcat` grátis virou pago. |
| **kilocode** | ✅ 25 pedaços | ⚠️ devolveu o JSON da chamada como **texto** | ✅ | Modelo grátis `kilo-auto/free`; modelos pagos exigem crédito. |
| **qoder** | ✅ 167 pedaços (`ultimate`) | ❌ "modelo na fila" | ❌ | Lista agora vem do catálogo da conta (15). A fila é do servidor: estado da conta. |
| **grok-cli** | ✅ 23 pedaços (`grok-4.7`) | ✅ | ✅ | **Corrigido:** `x-grok-client-version: 1.0.13` e UA `grok-cli/1.0.13`. |
| **windsurf** | ❌ `unauthenticated` | ❌ | ❌ | Protocolo reescrito (Connect + protobuf): catálogo e perfil funcionam, o chat remoto recusa a chave sintética da conta. Ver §9. |
| **clinepass** | ❌ 402 sem créditos | ❌ | ❌ | Lista alinhada ao catálogo atual (9 ids). Estado da conta. |
| **iflow** | ❌ 435 (teste vencido) | ❌ | ❌ | **Corrigido o diagnóstico:** o erro agora diz "o modelo não está liberado para esta conta… teste gratuito terminou". O servidor responde `试用结束` (teste encerrado). |
| **cline** | ❌ 402 sem créditos | ❌ | ❌ | Estado da conta. |
| **xai** | ❌ 402 sem créditos | ❌ | ❌ | Estado da conta. |
| **kimi** | ❌ 403 sem assinatura | ❌ | ❌ | Estado da conta. |
| **minimax-code-global** | ❌ 402 saldo | ❌ | ❌ | Estado da conta. |
| **glm** | ❌ 429 saldo | ❌ | ❌ | Estado da conta. |
| **zed** | ❌ sem modelos | não testado | não testado | Lista ao vivo e catálogo estático vazios — nada habilitado nesta conta. |

### 3.1 Provedores não conectados (12)

`anthropic`, `antigravity`, `codebuddy-cn`, `cursor`, `gemini-cli`, `gitlab`, `kimchi`,
`minimax-code`, `muse`, `qoder-cn`, `trae`, `xiaomi-mimo`.

Dois deles já têm problema de código visível sem login:

- **Windsurf** — `windsurf_koda.linhas(conta, modelo, mensagens)` não recebe `tools`.
- **Trae** — `trae_koda.linhas(conta, modelo, mensagens)` também não recebe `tools`.

Ou seja, mesmo que a conta fosse conectada, esses dois não chamariam ferramenta nenhuma.
O Cursor tem dois caminhos: o de texto (`cursor_koda`) não recebe ferramentas; o de agente
(`cursor_agent_koda`) recebe.

---

## 4. Causas por severidade

### P0 — Streaming do modo agente estava desligado para todos os provedores de conta — **corrigido**

**Onde:** `backend/app/providers/conta.py` (não existe `step_streaming`) e
`backend/app/agent/loop.py:3193-3195`.

```python
streamar = getattr(modelo, "step_streaming", None)
if streamar is None:
    result = await modelo.step(historico, tools, model)
```

O `HostProvider` tem `step_streaming`; o `ContaProvider` não. Resultado: com ferramentas
ligadas, todo provedor de conta cai no `step()`, que devolve o passo inteiro. O texto só
aparece na tela quando o passo termina.

**Evidência medida:**

| Requisição | Eventos `delta` |
| --- | --- |
| `/api/chat` com `tools:false` | **59** |
| `/api/chat` com `tools:true` | **1** |

**Correção:** implementar `step_streaming` no `ContaProvider`. O caminho mais direto é um
gerador genérico para os provedores OpenAI-compatíveis (a maioria), mais um para Anthropic
Messages e um para OpenAI Responses. O `openai_compat.py:585` já tem o padrão de
`step_streaming` que o laço espera.

### P0 — GitHub Copilot: a lista mostra os modelos que a integração recusa

**Onde:** `backend/app/provedores.py` (`_ao_vivo`, linha 789) não tem ramo para `github`;
a tela cai no catálogo estático `provedores_koda.json`.

O endpoint `/models` do Copilot devolve 47 modelos, mas cada um traz
`policy.state` (`enabled`/`disabled`) e `supported_endpoints`. Os 28 modelos do catálogo
estático são justamente os `disabled` (GPT-6, Claude Fable 5.1 etc.). Os `enabled` —
`gpt-4.1`, `gpt-4o`, `gpt-4o-mini` — não estão na lista. Além disso, `gpt-6.1-sol` só
suporta `/responses`; o Koda fala `/chat/completions`.

**Evidência:** `gpt-5-mini` e `gpt-5.4` → `400 model_not_available_for_integrator`;
`gpt-4.1` e `gpt-4o` → resposta normal e ferramentas funcionando.

**Correção:** buscar `/models` ao vivo com o token do Copilot, filtrar
`policy.state == "enabled"` e `capabilities.supports.tool_calls`, e escolher o endpoint
conforme `supported_endpoints` (ou limitar a lista a quem suporta `/chat/completions`).

### P0 — Windsurf: caminho removido

**Onde:** `backend/app/windsurf_koda.py:17`.

```python
CAMINHO = "/exa.language_server_pb.LanguageServerService/GetChatMessage"
```

Esse caminho responde **404 page not found**. O caminho
`/exa.api_server_pb.ApiServerService/GetChatMessage` responde **200** no mesmo host
(`server.self-serve.windsurf.com`). Trocar só o caminho não basta: o corpo/`protobuf`
também precisa ser revalidado — com o caminho novo, o servidor aceita a conexão mas devolve
"encerrou a resposta sem conteúdo".

### P1 — Kiro quebra em ferramenta sem argumentos

**Onde:** `backend/app/kiro_koda.py:510`.

```python
entrada = json.loads(parcial["input"]) if isinstance(parcial["input"], str) else parcial["input"]
```

Quando o modelo chama uma ferramenta sem argumentos, o Kiro manda `input` vazio; `json.loads("")`
levanta `ValueError` e o passo inteiro falha com "argumentos de ferramenta incompletos".
O catálogo completo funciona porque `read_file` tem argumentos.

**Correção:** tratar vazio como `{}` antes do `json.loads`.

### P1 — Grok CLI: versão no cabeçalho errado

**Onde:** `backend/app/providers/conta.py:719-724`.

O servidor lê `x-grok-client-version`; o `_grok_cabecalhos` manda só
`user-agent: grok-cli/0.2.1`. Resposta: `426 Your Grok CLI version (none) is outdated`.
Com `x-grok-client-version: 1.0.13`, `grok-4.7` e `grok-4.5` conversam e chamam
ferramentas. `grok-build` está sem crédito; `grok-4.5-high/medium/low` não existem para
esta conta.

### P1 — iFlow devolve erro com HTTP 200

**Onde:** `backend/app/providers/conta.py` (`_compativel_stream` / `_compativel_step`).

O iFlow responde `200 application/json` com `{"status":"435","msg":"Model not support"}`.
Como não há linhas `data:`, o Koda conclui "resposta sem escolhas" e perde a mensagem real.
Além disso, todos os modelos testados (`qwen3-coder-plus`, `qwen3-max`, `deepseek-v3.2`,
`kimi-k2`, `qwen3-32b`) foram recusados com 435 — a lista de modelos não corresponde ao
que a conta alcança.

### P1 — ClinePass: lista de modelos não corresponde ao entitlement

`cline-pass/glm-5.2`, `kimi-k2.6` e `deepseek-v4-flash` → `404 model not found`;
`cline-pass/qwen3.7-plus` → `403 ENTITLEMENT_ERROR`. A conta existe, mas a lista exibida
não é a lista usável.

### P2 — Qoder: conversa funciona, ferramentas ficam na fila

`ultimate` entrega 167 pedaços em streaming. O caminho `step()` com ferramentas responde
"o modelo Qoder está na fila; tente novamente em alguns segundos" e não conclui. A lista
também mistura modelos que o adaptador recusa (`lite`, `performance`, `qmodel`) com os que
existem (`ultimate`, `auto`).

### P2 — Kilocode: chamada de ferramenta como texto

Com `kilo-auto/free` e o catálogo de 40 ferramentas, o modelo devolveu
`{"name": "functions.read_file", "arguments": {...}}` no campo de texto, sem `tool_calls`.
Com uma ferramenta só (`get_environment`), a chamada veio estruturada. É comportamento do
modelo grátis, mas o Koda poderia reconhecer JSON de chamada no texto e recuperar.

### P2 — Listas de modelos desatualizadas em geral

O mesmo padrão aparece em GitHub, ClinePass, iFlow, Grok e Qoder: a lista exibida é o
catálogo estático ou uma lista sem filtro de entitlement. O teste "Testar" do provedor
não é o mesmo caminho da conversa, então a tela pode dizer "conectado" e a conversa falhar.

---

## 5. Ferramentas: o que foi executado de verdade

Além do teste de esquema por provedor, 26 ferramentas foram executadas diretamente com
`ferramentas.executar`, em uma pasta temporária:

| Grupo | Ferramentas | Resultado |
| --- | --- | --- |
| Arquivos | `write_file`, `read_file`, `edit_file`, `str_replace_editor`, `copy_file`, `move_file`, `rename_file`, `create_directory`, `list_dir`, `delete_file`, `delete_directory`, `apply_patch` | ✅ todas |
| Busca | `search_files`, `grep`, `regex_search` | ✅ todas |
| Ambiente | `get_environment`, `code_interpreter`, `shell`, `terminal` | ✅ todas |
| Git (leitura) | `git_status`, `git_diff`, `git_log` | ✅ todas |
| Plano | `update_todos` | ✅ |
| Diagnóstico | `get_problems`, `linter` | ✅ (só `.py`; em `.txt` respondem "sem linter") |

**Não executadas de propósito:** `git_commit`, `git_push`, `git_pull`,
`install_package`, `uninstall_package`, `sub_agente`, `web_search`, `url_reader`,
`browser`, `download_file`, `upload_file`, `read_attachment` e `use_skill`. As primeiras
mexem no repositório/sistema ou na rede; `use_skill` precisa do índice de skills que o
laço monta (fora do laço, responde "índice indisponível").

**Correção de um achado anterior (era falso):** eu havia escrito que `search_codebase`
não achava `ContaProvider`. A ferramenta é uma varredura em Python puro — o problema real
era outro: ela percorria `src-tauri/target` (~40 mil arquivos) e estourava o orçamento de
5 s **antes** de chegar em `backend/`, e então respondia "(nenhuma ocorrência)" como se a
busca tivesse terminado. Corrigido em três frentes: `target`, `dist`, `build`, `coverage`,
`.next`, `.nuxt`, `.turbo`, `.cache`, `.gradle`, `Pods` entraram na lista de pastas
ignoradas; a mensagem de truncamento agora diz que a busca **parou** e sugere uma subpasta;
e `search_codebase`, `vector_search`, `grep` e `regex_search` ganharam o parâmetro
`caminho` para limitar a raiz.

---

## 6. O que fazer, em ordem — situação

| # | Item | Situação |
| --- | --- | --- |
| 1 | `step_streaming` no `ContaProvider` | ✅ feito (§8) |
| 2 | GitHub listar só os modelos habilitados | ✅ feito — `/models` ao vivo, 10 modelos |
| 3 | Windsurf: caminho e protocolo | ✅ reescrito (§9) — bloqueio restante é da conta |
| 4 | Kiro: `input` vazio vira `{}` | ✅ feito |
| 5 | Grok CLI: cabeçalho de versão | ✅ feito |
| 6 | iFlow: mostrar o motivo real | ✅ feito — e o motivo é o teste vencido |
| 7 | ClinePass / Qoder / Zed: alinhar listas | ✅ feito para Qoder (catálogo da conta) e ClinePass (ids atuais); Zed não tem nada habilitado |
| 8 | Windsurf/Trae: `tools` na assinatura | ✅ assinatura aceita `tools`; o Trae SOLO não expõe esquema de ferramenta no protocolo, então o adaptador as ignora de propósito |
| 9 | `search_codebase` com orçamento estourado | ✅ feito (ver §5) |
| 10 | Preflight CORS recusado quando o Vite anda de porta | ✅ feito — qualquer porta local é aceita; origem estrangeira continua 400 |

## 7. Limites desta auditoria

- Só foram testadas as **17 contas conectadas**. Os 12 provedores sem login não têm como
  ser exercitados sem credencial.
- Os testes de conta consumiram cota real. Onde a conta está sem saldo/assinatura, o
  resultado é estado da conta, não defeito de código.
- O teste de ferramentas por provedor usa o catálogo completo, mas **não executa** a
  ferramenta: verifica se o provedor aceita o esquema e devolve a chamada. A execução real
  foi testada à parte (26 ferramentas) e de ponta a ponta com OpenAI, CodeBuddy, Kiro e Nous.
- O `README.md` grande no teste do Kiro gerou uma resposta genérica; com um arquivo pequeno
  o Kiro leu e respondeu corretamente. Fica como suspeita de tamanho/contexto, não como
  falha do adaptador.

---

## 8. Correção do streaming (01/11/2026)

O "streaming desligado no modo agente" tinha **três** portas fechadas, não uma. Abrir só a
primeira não mudava nada na tela.

| # | Arquivo | O que estava | O que ficou |
| --- | --- | --- | --- |
| 1 | `backend/app/providers/conta.py` | não existia `step_streaming`; o laço caía no `step()` | `step_streaming` com um parser para cada protocolo: OpenAI SSE (texto, raciocínio, `tool_calls` por índice), Anthropic Messages (`text_delta`, `thinking_delta`, `input_json_delta`) e OpenAI Responses (`output_text.delta`, `function_call_arguments.delta`). Provedor sem caminho próprio (Muse) continua entregando o passo inteiro. |
| 2 | `backend/app/providers/openai_compat.py` | `HostProvider.step_streaming` fazia `yield await da_conta.step(...)` para modelo de conta — o passo inteiro num `Piece` só | delega para `da_conta.step_streaming(...)` |
| 3 | `backend/app/agent/loop.py` | `_executar_passo` acumulava os pedaços e emitia **um** `delta` no fim | emite cada pedaço na hora e marca `estado["mostrou"]` no primeiro texto; o fecho só completa o que faltou, sem repetir o que já apareceu |

`backend/app/providers/local.py` ganhou o mesmo repasse: modelo de conta continua narrando
mesmo quando o host está fora do ar (é quando o `local` entra).

**Kiro (P1 junto):** `kiro_koda.py` tratava `input` vazio como JSON inválido e derrubava o
passo em ferramenta sem argumentos (`get_environment`). Vazio agora vira `{}`.

### Medições depois da correção

| Requisição | Antes | Depois |
| --- | --- | --- |
| `/api/chat` CodeBuddy `tools:false` | 12 deltas | 12 deltas |
| `/api/chat` CodeBuddy `tools:true` | **1** delta | **46** deltas |
| `/api/chat` OpenAI `tools:true` + `list_dir` | 1 delta | **93** deltas, 3 `tool_call`, 3 `tool_result`, 3 `reasoning`, 3 passos |
| `/api/chat` GitHub `gpt-4.1` `tools:true` | 1 delta | 49 deltas |
| `/api/chat` Kiro `tools:true` | 1 delta | 64 deltas |

`step_streaming` testado direto (sem a rota) nos provedores conectados que respondem:
OpenAI 39 pedaços, CodeBuddy 20, Kiro 9, Nous 31, GitHub 39, Kilocode 16 — todos com o
texto narrado igual ao `StepResult` final e chamada de `get_environment` funcionando.
Qoder segue na fila (`TransientProviderError`, estado da conta) e Grok CLI segue no 426 do
cabeçalho — os dois são os itens 5 e 7 da lista acima, ainda abertos.

**Custo assumido:** com o texto saindo na hora, uma queda de rede no meio do passo já não
pode ser repetida em silêncio — `_com_tentativas` vê `mostrou` e avisa em vez de reenviar.
Era exatamente o motivo do buffer antigo; a escolha foi narrar ao vivo e avisar na queda.

---

## 9. Segunda rodada (02/11/2026) — o que mudou, arquivo por arquivo

Esta rodada partiu da matriz completa (§3) e fechou tudo o que era **código**. O que sobrou
é estado de conta, e está dito assim na coluna de diagnóstico.

### 9.1 Grok CLI — versão no cabeçalho

`backend/app/providers/conta.py` ganhou `GROK_CLI_VERSAO = "1.0.13"` e a função de módulo
`grok_cabecalhos(conta, modelo)`, que manda `x-grok-client-identifier: grok-cli`,
`x-grok-client-version: 1.0.13` e UA `grok-cli/1.0.13`. Antes o servidor respondia
`426 Your Grok CLI version (none) is outdated`. `backend/app/provedores.py`
(`_chamar_modelo_grok`) usa a mesma função, então lista e conversa falam igual.

**Depois:** `grok-4.7` → 23 pedaços de texto e `get_environment` chamada.

### 9.2 iFlow — a recusa vinha dentro de um HTTP 200

`_erro_no_corpo()` extrai `status`/`msg`/`message`/`error` de um corpo JSON, e `_sse()`
passou a detectar `content-type` que não é `text/event-stream`: lê o corpo, e se houver
motivo levanta `ProviderError` com ele em vez de "resposta sem escolhas".

O código 435 ganhou tradução: o iFlow responde 435 para **todos** os modelos quando o teste
da conta acabou (`试用结束`), então a mensagem agora diz isso, e não "Model not support".

### 9.3 GitHub Copilot — lista ao vivo

`_ao_vivo()` em `backend/app/provedores.py` ganhou o ramo `github`: troca o token do GitHub
pelo do Copilot, lê `/models`, e filtra `policy.state == "enabled"`, `capabilities.type`
compatível, endpoint `/chat/completions` e tokenizer conhecido; descarta `copilot-*` e ids
com data (`-2024-11-20`). Ordena os habilitados primeiro.

**Antes:** 28 modelos, todos recusados com `400 model_not_available_for_integrator`.
**Depois:** 10 modelos, e `gpt-4.1` conversa com ferramentas.

### 9.4 Qoder e Windsurf — listas vindas da conta

- `qoder_koda.modelos(identificador, conta)` lê o catálogo da conta (15 modelos `chat`).
- `windsurf_koda.modelos(conta)` lê `GetCascadeModelConfigsForSite` e mostra só os
  habilitados (1 nesta conta: `swe-1-6-slow`).
- `ClinePass` no `provedores_koda.json` foi reescrito com os 9 ids que o catálogo atual
  oferece.

### 9.5 Windsurf — protocolo reescrito, e o limite que sobrou

O adaptador antigo chamava `LanguageServerService/GetChatMessage` no host da conta, que
responde **404**. O `windsurf_koda.py` foi reescrito para o servidor remoto
(`web-backend.windsurf.com`), com Connect/protobuf escrito à mão:

| Peça | Detalhe |
| --- | --- |
| Perfil | `SeatManagementService/GetCurrentUser` — devolve a chave sintética, `account-…` e `org-…` |
| Catálogo | `ApiServerService/GetCascadeModelConfigsForSite` — unário, `application/proto` |
| Chat | `ApiServerService/GetChatMessage` — stream, `application/connect+proto` |
| Auth unária | token de **sessão** em `X-Auth-Token` (a chave sintética dá 401) |
| Auth do chat | chave sintética em `X-Auth-Token` + token de sessão em `X-Devin-Session-Token` |
| Chave | vem aninhada em campos protobuf; só um decodificador recursivo pega os 101 caracteres |

**O limite:** o chat remoto responde `an internal error occurred (unauthenticated)` para
todas as combinações testadas (chave, sessão, `Authorization: Bearer`, `x-api-key`), e
`Cascade session` quando o token de sessão vai no corpo. Os métodos `StartCascade`,
`SendUserCascadeMessage` e `RawGetChatMessage` **não existem** no servidor remoto (404) —
só `GetChatMessage` e `GetCascadeModelConfigsForSite`. A chave que a conta guarda é
`devin-synthetic-apikey$…`, que vale para o **language server local** do editor, não para a
API remota. O adaptador agora diz isso em português, em vez de repetir o texto do servidor.

### 9.6 Kiro — ferramenta sem argumentos

`input` vazio ou só espaço vira `{}` antes do `json.loads`. `get_environment` (zero
argumentos) passou a funcionar; era a diferença entre "funciona com `read_file`" e
"funciona".

### 9.7 `modelos()` chamado de dentro de um laço

`backend/app/provedores.py` chamava `asyncio.run(...)` em 13 pontos. Dentro de um handler
`async` isso levanta `RuntimeError: asyncio.run() cannot be called from a running event
loop` — e a lista de modelos caía no catálogo estático sem avisar. Novo `_rodar(coro)`:
usa `asyncio.run` quando não há laço, e manda a corrotina para uma thread com laço próprio
quando há. Verificado chamando `modelos()` de dentro de `asyncio.run` para Kiro, Qoder,
Windsurf, Zed e GitHub: as cinco listas ao vivo respondem.

### 9.8 CORS: o Vite muda de porta e a interface quebra com 400

O log do backend mostrava `OPTIONS /api/* → 400`. A causa: `cors_origins` lista a 5173, e
quando ela está ocupada o Vite sobe na 5174 — todo preflight passa a ser recusado, e a tela
mostra erro de rede sem explicar nada. `app/main.py` agora aceita
`allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$"`. O backend
só escuta em localhost e `_so_host_local` já recusa `Host` não local, então nada se abre
para fora. Verificado: origem `127.0.0.1:5174` → 200; `evil.com` → 400.

### 9.9 `search_codebase` — correção de um achado meu que estava errado

Ver §5: não era falta de `ripgrep`. Era `src-tauri/target` consumindo o orçamento de 5 s e
uma mensagem que dizia "nenhuma ocorrência" quando a busca tinha parado no meio.

### 9.10 Resultado da matriz depois de tudo

| Provedor | Texto em streaming | Ferramenta | Observação |
| --- | --- | --- | --- |
| openai | ✅ 23 pedaços | ✅ | `gpt-5.6-sol` |
| github | ✅ 23 pedaços | ✅ | `gpt-4.1`, lista ao vivo |
| kiro | ✅ 4 pedaços | ✅ | `claude-haiku-4.5` |
| nous | ✅ 15 pedaços | ✅ | `upstage/solar-mini4:free` |
| kilocode | ✅ 9 pedaços | ✅ | `kilo-auto/free` |
| grok-cli | ✅ 23 pedaços | ✅ | `grok-4.7` |
| codebuddy-intl | ⚠️ cota intermitente | ✅ | "sem cota agora" nesta rodada |
| qoder | ❌ fila | ❌ | estado do servidor |
| iflow | ❌ 435 | ❌ | teste gratuito vencido |
| windsurf | ❌ unauthenticated | ❌ | chave só vale no app |
| cline / clinepass | ❌ 402 | ❌ | sem créditos |
| xai | ❌ 402 | ❌ | limite de gasto |
| kimi | ❌ 403 | ❌ | assinatura |
| minimax | ❌ 402 | ❌ | saldo |
| glm | ❌ 429 | ❌ | cota |
| zed | ❌ sem modelos | — | nada habilitado |


### 9.11 Rótulos repetidos no seletor

O Copilot publica o **mesmo** `name` para modelos diferentes:
`mai-code-1-flash-4th`, `-secondary` e `-tertiary` chegam todos como
"MAI-Code-1.1-Flash", e `kimi-k3-base`/`kimi-k3-copilot` como "Kimi K3 (GitHub)".
No seletor isso virava três linhas idênticas — impossível escolher. `_desempatar_nomes()`
em `backend/app/provedores.py` entra no fim de `modelos()`, vale para todo provedor com
lista ao vivo, e acrescenta só o trecho do id que não está no nome:

| Antes | Depois |
| --- | --- |
| MAI-Code-1.1-Flash | MAI-Code-1.1-Flash · 4th / · secondary / · tertiary |
| Kimi K3 (GitHub) | Kimi K3 (GitHub) · base / · copilot |
| GPT-4o | GPT-4o · preview (só a variante que difere ganha sufixo) |

### 9.12 Teste no navegador (02/11/2026)

Feito na interface real, servida pelo Vite em `http://localhost:5174` (justamente a porta
que o CORS recusava), com o backend em `127.0.0.1:8787`:

| O que foi feito | Resultado |
| --- | --- |
| Abrir o app | Renderiza; 29 provedores no seletor, 17 conectados |
| Preflight CORS da origem `localhost:5174` | **200** (antes: 400) — `/api/provedores` responde no navegador |
| Abrir o seletor → GitHub Copilot | **10 modelos, todos com o ponto verde de habilitado** (antes: 28 desabilitados) |
| Rótulos repetidos | cada variante agora tem sufixo próprio |
| Conversa "Conte de 1 a 20" com `gpt-4.1` | **20 atualizações incrementais de texto** medidas no DOM ao longo de ~22 s; resposta completa; 40 tok |
| Conversa com ferramenta: "Liste backend/app/tools" | cartão **"1 ferramenta · 12 ms"**, `list_dir` executado, resposta correta (5 arquivos) em 28 s |

O primeiro teste de ferramenta falhou por um motivo que não é do provedor: o projeto ativo
era `github-v1(1)`, uma pasta sem `backend/`, e a ferramenta respondeu
`UnsafePath: diretório inválido`. Registrado o projeto `koda` e repetido — funcionou.

**Não verificado no navegador:** os provedores sem cota (o cartão de erro aparece igual ao
da API, mas não foi aberto um a um na tela) e o modo desktop/Tauri.

### 9.13 Ferramentas: nova passagem (02/11/2026)

18 ferramentas executadas de novo em `/tmp/koda-tools-check`, por causa das mudanças em
`search_codebase`/`grep`/`regex_search`/`search_files`/`vector_search` (parâmetro `caminho`
e lista de pastas ignoradas): `write_file`, `read_file`, `edit_file`, `str_replace_editor`,
`copy_file`, `move_file`, `rename_file`, `create_directory`, `list_dir`, `search_files`,
`grep`, `regex_search`, `search_codebase`, `vector_search`, `delete_file`,
`delete_directory`, `get_environment`, `update_todos`, `linter`. **Todas passaram.**

Duas coisas que pareceram falha e não eram:
- `edit_file`/`str_replace_editor` recusaram a chamada com "old_string vazio" porque eu
  mandei `antigo`/`novo` em vez de `old_string`/`new_string` — a validação funcionou.
- `vector_search` com uma frase inteira não acha nada: ele é **alias textual** de
  `search_codebase` (o próprio schema diz isso), não busca semântica. Com um termo literal,
  acha.

`search_codebase` na raiz do repositório agora encontra `ContaProvider` — o caso que antes
respondia "(nenhuma ocorrência)".

