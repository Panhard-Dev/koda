# Koda — backend

Servidor do Koda em Python: **FastAPI** para as rotas, **SSE** para o texto chegar
enquanto é gerado e **SQLite** para conversas, uso e conta. Sem `.env` nenhum ele já
funciona: o provider local responde de forma offline e explícita. Com o serviço de modelos
acessível ele é escolhido sozinho, e aí o chat passa a ter modelo e tool calling de verdade.

```bash
cd backend
uv sync                                  # cria o .venv e instala as dependências
uv run uvicorn app.main:app --reload --port 8787
```

Documentação interativa em `http://localhost:8787/docs`.

### O token da API local

A API é **deny-by-default**: toda rota sob `/api` exige `Authorization: Bearer <token>`.
Quem sorteia o token é o launcher do app desktop, **uma vez por execução**, e o entrega ao
backend pelo `stdin` — nunca pelo ambiente, que é o que o código do agente lê. É o que
impede o agente de chamar `PUT /api/permissions`, se dar o modo `auto` e passar a agir sem
cartão (era o achado crítico da auditoria de segurança).

Sem launcher (o `uv run uvicorn` acima) o backend **imprime** o token no terminal. Para
fixá-lo, use `KODA_API_TOKEN` — variável que só vale fora do app empacotado:

```bash
KODA_API_TOKEN=dev uv run uvicorn app.main:app --reload --port 8787
curl localhost:8787/api/models -H 'authorization: Bearer dev'
```

Três rotas escapam da exigência, e cada uma tem motivo: `OPTIONS` (o *preflight* do CORS
não manda `Authorization`), `GET /api/health` (responde só `ok` e a versão, para o launcher
saber que o serviço subiu) e `GET /api/handshake` (o desafio do launcher). O retrato
completo do backend fica em `GET /api/health/detalhado`, que exige o token. No app
empacotado `/docs`, `/redoc`, `/openapi.json` e `/` ficam desligados.

No app instalado, o launcher marca o backend com `KODA_BACKEND_PACKAGED=1` e o
provedor padrão é `host`. No desenvolvimento o padrão continua sendo `auto`; o marcador
é interno ao launcher, não precisa ser configurado pelo usuário. `KODA_PROVIDER`
definido explicitamente no ambiente ou no `.env` continua prevalecendo, inclusive `auto`.

**Não existe provider de terceiro.** Há um tempo havia um caminho OpenAI-compatible,
escolhido por uma `OPENAI_API_KEY` que estivesse no ambiente — inclusive a de outro
programa —, e ele fazia o seletor oferecer os modelos da casa (Liz, Koda, Layze) a um
serviço que não os tem: escolher "Liz 4" mandava o modelo do `.env`, sem avisar. Saiu do
produto. As variáveis `OPENAI_*` são ignoradas.

## Rotas

| Método | Rota | O que faz |
| --- | --- | --- |
| `GET` | `/api/health` | Só `ok` e a versão. **Aberta** (sem token), é o que o launcher bate |
| `GET` | `/api/health/detalhado` | Estado do servidor, provider ativo, banco, pasta de trabalho e ferramentas |
| `GET` | `/api/handshake?nonce=` | Prova que este processo conhece o token da execução (HMAC) |
| `POST` | `/api/chat` | Responde em `text/event-stream` e grava a conversa |
| `GET` | `/api/conversations` | Histórico, mais recente primeiro |
| `POST` | `/api/conversations` | Cria uma conversa vazia |
| `GET` | `/api/conversations/{id}` | Conversa com todas as mensagens |
| `DELETE` | `/api/conversations/{id}` | Apaga a conversa (e as mensagens, por cascata) |
| `GET` | `/api/usage?tz_offset_minutes=` | Cotas diária, semanal e mensal e totais |
| `GET` | `/api/account` | Conta, telefone e Google vinculados |
| `PATCH` | `/api/account` | Vincula/desvincula telefone e Google |
| `POST` | `/api/account/sign-out` | Limpa conversas e vínculos |
| `GET` | `/api/cloud/update?versao=&canal=&refresh=` | A nuvem publicou versão nova? |
| `GET` | `/api/cloud/changelog?canal=` | Notas das versões publicadas |
| `GET` | `/api/cloud/download` | Status do download do instalador (progresso) |
| `POST` | `/api/cloud/download` | Baixa o instalador publicado para a pasta de downloads |

### O stream do chat

```
$ curl -N -X POST localhost:8787/api/chat -H 'content-type: application/json' \
    -H 'authorization: Bearer dev' \
    -d '{"text":"oi","model":"liz-nano"}'

event: start
data: {"conversation_id": "5f0c…", "at": 1758561234567}

event: delta
data: {"text": "Sou"}

event: delta
data: {"text": " o"}

event: done
data: {"conversation_id": "5f0c…", "message_id": "…", "elapsed_ms": 812, "usage": {…}}
```

`error` substitui `done` quando o provider falha. Se o cliente fechar no meio (o botão de
parar aborta o `fetch`), o servidor guarda o texto que já saiu, para o histórico do banco
ficar igual ao da tela.

O corpo aceita, além de `text`/`model`/`reasoning`/`web`/`project`/`attachments`:

- `effort`: esforço de raciocínio do seletor ao lado do modelo — `auto` (padrão, quem decide
  é `reasoning`), `minimal`, `low`, `medium` ou `high`. Escolha explícita vira
  `reasoning_effort` no pedido ao provedor, e vale para os passos do agente também; valor
  fora da lista é **422**;
- `tools`: `false` responde sem ferramenta nesta mensagem (o padrão é a configuração do
  servidor);
- `max_steps`: teto de passos desta mensagem (1 a 40);
- `tz_offset_minutes`: fuso do cliente, para o uso contar no dia local.

### Agente (ferramentas)

Quando o provedor sabe chamar ferramenta, o chat **já é** o agente: o modelo recebe as
ferramentas locais e o loop roda até ele parar de pedir (ou até `max_steps`). Cada passo
sai como evento, então a interface mostra a ferramenta trabalhando:

```
event: tool_call
data: {"id":"call_1","name":"list_dir","arguments":{"caminho":"src"},"step":1}

event: tool_result
data: {"id":"call_1","name":"list_dir","output":"…","duration_ms":2,"ok":true,"step":1}

event: delta
data: {"text":"São 6 arquivos…"}
```

O `done` fecha com `steps` e `completed`. O que a tela mostra é o que fica no banco: os
passos são gravados na mensagem (coluna `steps`) e voltam no histórico.

Detalhe obrigatório: as `tool_calls` são ecoadas **exatamente** como vieram (id + string de
argumentos) — o serviço guarda a assinatura da chamada do lado dele e casa pelo id, como no
projeto anterior. Trocar o id, reserializar os argumentos ou reordenar o histórico quebra o
casamento e o passo volta com erro.

O corpo aceita `"tools": false` para responder **essa** mensagem sem ferramenta (e
`true` para exigir, que dá erro se o provedor não souber). No servidor, `KODA_TOOLS=off`
desliga o agente. Os limites do ciclo são configuráveis:

| Variável | Padrão | O que limita |
| --- | ---: | --- |
| `KODA_MAX_STEPS` | `0` | Respostas do modelo por tarefa (`0` = sem teto, como o projeto de origem) |
| `KODA_MAX_TOOL_CALLS` | `0` | Chamadas de ferramenta por tarefa (`0` = sem teto, como o projeto de origem) |
| `KODA_TOOL_CALL_TIMEOUT_S` | `120` s | Tempo de uma chamada de ferramenta (`0` desliga o teto) |
| `KODA_TOOL_TIMEOUT_S` | `0` | Tempo total da tarefa (`0` significa sem teto) |
| `KODA_COMANDO_TIMEOUT_S` | `600` s | Tempo total de um comando shell/terminal (`0` desliga o teto) |
| `KODA_COMANDO_INATIVIDADE_S` | `300` s | Tempo sem saída até o comando ser considerado travado |
| `KODA_COMANDO_OLHADA_S` | `240` s | Intervalo entre atualizações do shell ao modelo |
| `KODA_TOOL_OUTPUT_MAX_BYTES` | `50000` | Caracteres que uma ferramenta devolve ao modelo |
| `KODA_TOOL_OUTPUT_MAX_LINES` | `2000` | Linhas de uma listagem ou busca |
| `KODA_TOOL_OUTPUT_MAX_LINE_LENGTH` | `2000` | Caracteres de uma linha na leitura de arquivo |
| `KODA_FILE_READ_MAX_CHARS` | `100000` | Caracteres lidos de um arquivo ou anexo por vez (`file_read_max_chars`) |
| `KODA_TOOL_OUTPUT_LIMIT` | `50000` | Saída de cada ferramenta que fica na tela e no histórico |

Os tetos de saída são **os do projeto de origem**, que é a referência de comportamento do Koda:
os valores do `tool_output` (50 000 / 2 000 / 2 000) e o `file_read_max_chars` (100 000). Foi
lá que esses números foram medidos; o que os portou para cá tinha valores próprios e mais apertados
(4 000 na tela, 12 000 para o modelo, 800 numa listagem), o que fazia o agente pedir o mesmo
arquivo várias vezes.

Ao atingir o orçamento de ferramentas, o Koda para de oferecê-las ao modelo e pede um
resumo final. O teto também é aplicado dentro de lotes: nenhuma chamada acima do número
configurado é executada. Se a mesma ferramenta vier pela terceira vez com os mesmos
argumentos, pedido e plano, ela recebe um aviso para mudar de estratégia; se vier de novo
após esse aviso, o ciclo é encerrado como incompleto. O detector não conta polls `continuar`
do terminal, pois essas chamadas acompanham o processo existente.

Cada comando do terminal tem um teto absoluto (`KODA_COMANDO_TIMEOUT_S`, 10 min por padrão,
ampliável pelo modelo até uma hora) e é considerado travado após 5 min sem produzir saída
(`KODA_COMANDO_INATIVIDADE_S`). Enquanto estiver rodando, o modelo recebe uma olhada a cada
4 min (`KODA_COMANDO_OLHADA_S`) com a saída acumulada e pode continuar acompanhando ou parar
o processo. O backend mantém o processo registrado entre as olhadas e o encerra ao atingir
o teto absoluto ou ao detectar inatividade; o timeout genérico de 120 s não corta esse ciclo.
A referência de origem usa **180 s** neste mesmo teto; o Koda fica generoso de propósito, porque a olhada de
4 min só faz sentido com um teto acima dela — 180 s mataria o comando antes da primeira olhada.
Subprocessos diretos e requisições de rede usam o prazo da chamada para encerrar o trabalho
de forma cooperativa.

### O plano da tarefa (To-dos)

Tarefa grande sem plano vira uma pilha de ferramentas soltas: quem está olhando não sabe
quantas etapas faltam nem onde o trabalho parou. Então o agente **divide antes de executar**:
o pedido entra, ele registra a lista com `update_todos` e só então começa — item por item,
marcando cada um conforme termina.

Quando o pedido é grande, em `app/tools/loop.py`:

- `pedido_grande()` reconhece o caso por três sinais (pedido longo, etapas escritas como
  "fase 1" ou lista, ou mais ações diferentes do que cabe numa tacada). Tarefa de uma
  ferramenta só — ler um arquivo, criar um, rodar um teste — **não** ganha lista: aí ela
  só atrasaria o trabalho;
- a instrução `DIVIDIR_TAREFA` entra como mensagem junto do pedido, e se o agente arrancar
  a trabalho sem lista, `EXIGIR_PLANO` cobra uma vez;
- **registrar o plano não conta como trabalho feito.** Quem só escreveu a lista ainda não
  mudou nada no disco, e as cobranças de execução continuam valendo em cima disso.

O evento `todos` leva a lista para a interface na hora (`{"todos":[{"texto":…,"feito":…,
"atual":…}],"step":N}`), e a última lista fica gravada na mensagem (coluna `todos`) —
reabrir a conversa depois mostra o que foi feito e o que faltou. Vários itens podem chegar
como "em andamento", mas só o primeiro permanece: a interface não desenha dois "fazendo
agora".

Do lado de lá, `ToDos.tsx` desenha o painel: cabeçalho com o contador `feitos/total` (que
fica no tom de destaque quando fecha), item pendente com o aro vazio, o que está rodando com
o aro girando e o feito riscado.

**Onde o painel mora.** Ele não fica dentro da conversa: é um **menu do canto de cima à
direita**, logo abaixo dos controles da janela — um botão com a contagem do que falta, que
abre o painel com a lista (`ToDos.tsx`). O plano é estado do trabalho, não uma fala do
agente — dentro da bolha ele empurrava as mensagens e sumia para cima conforme a resposta
crescia. No canto ele acompanha a tarefa em curso: o balão mostra quantas etapas faltam,
a borda acende no item atual e some quando o trabalho termina; sem nada em andamento o
painel diz que está vazio. A lista vem da última resposta assistente: é ela que
`update_todos` mantém, e é ela que sobrevive a reabrir a conversa.

### Faça exatamente o que foi pedido — nada além

A regra do dono (01/10/2026), e ela vale **antes** do primeiro passo, não como conselho no
prompt: `classificar_pedido` olha o último pedido da pessoa e decide o que a rodada é.

- **Pergunta, resumo, explicação ou texto avulso** (sem relação com a pasta de trabalho) →
  `MODO_RESPOSTA`. O catálogo da rodada fica só com `read_attachment`: arquivo, shell, web e
  código ficam de fora. A resposta sai do que o modelo sabe e dos anexos da conversa.
- **Pedido que toca no projeto** — nome de arquivo com extensão, caminho com barra, ou o
  vocabulário do trabalho (pasta, código, teste, git, erro, instalar, README…) — ou que pede
  uma mudança de verdade → `MODO_CODIGO`. Aí o catálogo é o completo, e o trabalho é para ser
  feito por inteiro, validado antes de entregar.

Na dúvida, o veredito é `MODO_CODIGO`: negar ferramenta a quem pediu trabalho é pior do que
oferecer ferramenta a quem pediu conversa — quem só queria conversa recebe a resposta de
qualquer jeito. E "nunca troque o tipo de entrega" está escrito no `PROMPT_FERRAMENTAS`: o
prompt explica as duas categorias e o que cada uma pede.

**Instrução negativa explícita vira restrição de catálogo.** "Não use web nem arquivos" tira
as ferramentas de arquivo e de web daquela rodada (`restricoes_do_pedido`); "responda apenas
…" e "não use ferramenta nenhuma" rodam sem catálogo nenhum. Antes, frases assim eram só
enunciados no meio do pedido: o modelo recebia tudo, escolhia `list_dir` e a resposta exibia
os nomes das pastas e dos arquivos da pessoa (achado do QA). O que sai do catálogo também é
dito ao modelo, no prompt de sistema — restringir calado faz ele pedir o que não existe.

Ressalva de quem cita arquivo: "responda apenas: quantas linhas tem o app.py?" continua em
`MODO_CODIGO` — quem escreve isso quer o número, não uma recusa.

**Recusa é fechamento.** "Não posso revelar instruções internas" encerra a rodada: o loop não
cobra ferramenta depois de uma recusa (só quando nada foi executado ainda, não há comando
rodando e nada foi bloqueado). Antes, a recusa correta vinha seguida de uma cobrança do loop
e o modelo, cobrado, saía listando a pasta de trabalho — 65 s e ~26 mil tokens para uma frase.

### Portões de parada: o que faz a conversa **não** fechar cedo

A ideia vem da referência de implementação (de onde foram copiadas as duas lições
que valem ouro). A primeira: quando o modelo para com uma resposta de texto, portões
decidem se a conversa pode fechar. A segunda, e a que custou caro aqui: **o sinal tem de
ser de estado — o que foi mexido, o que foi executado, o que ficou em aberto — e não de
vocabulário**, porque lista de verbos sempre deixa escapar a frase que o modelo inventou.

Foi exatamente o que aconteceu num run de verdade: o agente rodou um bench de 3000 seeds
(153 s de `node`), terminou a análise e **encerrou** com

> "…a geração é rápida na mediana (~10ms) mas tem picos de **475ms** — é aí que mora o bug.
> **Vou deletar o bench temporário e escrever a análise.**"

A conversa fechou ali: arquivo temporário no disco, análise não escrita. O detector de
anúncio procurava o verbo logo **depois** do "vou" e dentro de uma lista — e a lista não
tinha `deletar`. Agora as marcas de futuro valem por si (`vou…`, `preciso…`, `falta…`), a
frase final que **começa** em infinitivo conta como anúncio, e a lista de verbos ficou só
como reforço.

O loop em `app/tools/loop.py` avalia o estado da tarefa quando o modelo responde em texto.
O texto continua visível e guardado; o loop decide se pode fechar ou precisa pedir que o
modelo retome:

1. **Lista em aberto** (`retomar_tarefa`, até `MAX_RETOMADAS` = 10, renovando a cada avanço):
   usa os itens registrados pelo próprio modelo e pede que ele atualize a lista conforme
   terminar cada um;
2. **Anúncio sem chamada** (`RETOMAR_ANUNCIO`, até `MAX_RETOMADAS_ANUNCIO` = 10): se o
   modelo diz que vai agir mas não chama ferramenta, o loop registra o que ficou pendente e
   pede que ele continue. A próxima chamada recebe o catálogo completo e a seleção fica
   livre para o modelo;
3. **Ação sem ferramenta bem-sucedida** (`CONSERTAR_FERRAMENTA`, até 2 cobranças): o modelo
   recebe o erro para corrigir os argumentos ou escolher outra abordagem.

Esgotados os orçamentos, o fechamento é **honesto** em vez de silencioso: `completed: false`
e uma frase que diz o que ficou faltando. Quem não executou nada ouve que nada mudou no
disco; quem executou parte ouve só o que ficou em aberto.

### Retomadas sem impor a ferramenta

O modelo pode anunciar um passo e terminar sem chamar ferramenta. Nessa situação, o loop
manda uma mensagem interna com o anúncio e o pedido original, lembrando-o de continuar ou
explicar que não há mais trabalho. **Não escolhe a ferramenta por ele:** não envia
`tool_choice`, não reduz o catálogo e não aponta `shell`, `edit_file` ou outra chamada pelo
nome. A seleção automática fica com o modelo em todos os passos, inclusive os de retomada.
As retomadas têm teto (`MAX_RETOMADAS_ANUNCIO` = 10), renovado quando o modelo volta a
chamar ferramentas, para evitar laço infinito sem cortar uma tarefa que está progredindo.

- **Lista em aberto não deixa encerrar.** Se a lista registrada pelo modelo tem itens
  pendentes, `retomar_tarefa` nomeia o que falta e pede que ele atualize o plano ao concluir
  cada item.
- **O catálogo explica as opções.** As descrições distinguem busca por nome (`search_files`)
  de busca no conteúdo (`search_codebase`/`regex_search`), leitura de caminho conhecido
  (`read_file`) de listagem (`list_dir`), edição de trecho (`edit_file`) de substituição do
  arquivo inteiro (`write_file`) e de aplicação de diff (`apply_patch`), além de explicar
  `shell` para comandos/build/testes e `code_interpreter` para cálculo/análise.
- **Ação sem ferramenta bem-sucedida.** Quando o pedido exige uma ação e nenhuma ferramenta
  funcionou, o loop devolve o erro para o modelo corrigir argumentos ou tentar outra
  abordagem. Perguntas que pedem só uma explicação continuam podendo terminar em texto.
- **Anúncio não é trabalho concluído.** Narração curta acompanha a chamada escolhida pelo
  modelo na mesma resposta. Se a tarefa pede mudança e o modelo só promete, o loop pede que
  continue; a chamada seguinte continua livre para qualquer ferramenta do catálogo.
- **Fechamento honesto.** Se o modelo insistir em só falar, `completed: false` informa o que
  ficou faltando. Quem não executou nada ouve que nada mudou no disco, e quem executou parte
  ouve apenas o que continua em aberto.
O que a própria pessoa bloqueou não entra na conta: ação negada no cartão de permissão (e
ferramenta desligada por `KODA_TOOLS_DENY`) não vira cobrança — ali o certo é explicar.

Código e terminal também não são porta dos fundos: operação de arquivo escrita em
`code_interpreter` **ou como comando** (`pathlib`, `shutil`, `open(..., 'w')`, `rm`, `del`,
`Remove-Item`, `mv`, `cp`, `mkdir`, `Set-Content`) **não executa**, e a chamada volta com a
ferramenta certa. Escrita, criação, exclusão, mover e copiar nunca passam por código; uma
leitura para análise passa uma vez. O comando tem de ser a própria coisa — `git mv`, um
`grep` procurando a palavra "mv" ou um `npm run move-assets` seguem rodando normalmente.

### Código rodado: `linguagem`, UTF-8 e falha de verdade

O `code_interpreter` roda o Python que **vem embutido no Koda** (3.13) — ele não tem nada a
ver com a linguagem do projeto. Num projeto JS isso é estranho, e agora o mesmo trecho pode
rodar em Node: `code_interpreter({"codigo": ..., "linguagem": "node"})` (o campo aceita
`language`/`lang`, e o apelido `run_code` também). Sem Node instalado, a ferramenta diz isso
com essas palavras em vez de falhar por conta própria.

Duas correções que vieram de runs reais:

- **UTF-8 sempre.** No Windows o Python escreve em `cp1252` por padrão, e um `print` com
  `●`, `→` ou acento derrubava o script inteiro com `UnicodeEncodeError` — o resultado já
  estava calculado e o modelo recebia um Traceback (gastando o passo seguinte para descobrir
  `sys.stdout.reconfigure`). Agora o interpretador roda com `-X utf8`, `PYTHONUTF8=1` e
  `PYTHONIOENCODING=utf-8`;
- **Código de saída conta.** Antes, só saída começando com `ERRO:` marcava falha — então um
  script que morria com `exit code: 1` voltava como **sucesso**: o cartão da ferramenta
  ficava normal na tela, o modelo achava que tinha dado certo e o loop não cobrava a
  correção. `saida_ok()` lê o código de saída, com exceção das ferramentas cujo trabalho é
  **relatar o que encontraram** (`get_problems`, `search_*`, `git_*`) — nelas sair 1 é
  resposta certa.

### Contexto grande (compactação)

O agente reenvia o histórico inteiro a cada passo. Num projeto grande isso vira o problema
principal: cada saída de ferramenta entra na conta e, depois de dezenas de passos, o pedido
passa do que o provedor aceita — a tarefa morre no meio, com um erro que nem parece ter a
ver com o trabalho. `app/contexto.py` resolve isso em quatro estágios, do mais barato para
o mais agressivo (`KODA_CONTEXTO_TOKENS`, **1 milhão** por padrão; `0` desliga):

1. as saídas de ferramenta antigas viram um aviso de uma linha;
2. o miolo já resolvido sai e dá lugar a um resumo com o que foi feito (ferramentas usadas,
   a última coisa que o modelo escreveu, o último resultado);
3. a própria janela recente encolhe, da mais antiga para a mais nova;
4. se nem a ponta cabe, ela é cortada no que resta do orçamento.

Nada disso chama o provedor: uma compactação que dependesse de uma chamada de modelo
falharia justamente quando o contexto está cheio. E nada disso quebra o casamento
`tool_calls` ↔ `tool` que o serviço exige — o corte é sempre em pares e a janela recente
nunca começa com um resultado órfão (`_limite_seguro`).

A conversa **entre** mensagens passa pela mesma ideia (`compactar_turnos`): o que é antigo
vira um resumo no prompt de sistema, e os últimos 12 turnos vão inteiros. Um turno gigante
(uma colagem enorme) é cortado antes de ser medido, para não empurrar o resto para fora.
Quando isso acontece, a conversa mostra a nota "histórico compactado" — e ela fica gravada,
para quem reler depois saber que parte do histórico virou resumo.

O padrão é 1 milhão — a janela dos modelos do serviço. Compactar antes disso descartaria
contexto que ainda cabia. Para trabalhar com mais, suba `KODA_CONTEXTO_TOKENS`
(2_000_000, 10_000_000…) e confira o valor em `GET /api/health` (`contexto_tokens`).

### Latência: o que pesa em cada passo

O modo agente reenvia, a **cada** passo, o prompt de ferramentas (10,3 mil caracteres) mais o
prompt de sistema (~1,3 mil) mais o catálogo JSON das 38 ferramentas (14,3 mil) — cerca de
26 mil caracteres fixos, perto de 8 mil tokens, antes de qualquer histórico. Medido no
`loop.executar`; é o custo que aparece como "chamada ao modelo meio lenta" em pedido curto.

Três coisas atacam isso, e as três já estão no caminho:

- **Rodada de resposta não recebe catálogo** (`MODO_RESPOSTA` — ver "Faça exatamente o que foi
  pedido"). A maior parte do peso fixo sai junto: pergunta, resumo e conversa solta não
  precisam de 38 esquemas de ferramenta para serem respondidas.
- **A rodada fecha no texto quando o pedido pede texto.** Cada passo a mais é um pedido
  inteiro ao provedor; os portões de parada deixaram de cobrar ferramenta em pedido de
  resposta e depois de recusa (era aí que uma frase custava 100 s e ~35 mil tokens).
- **O que é disco não roda no laço de eventos.** O índice de skills varre `.agents/skills` do
  projeto e da máquina a cada mensagem (~34 ms medidos, mais em projeto grande) e agora vai
  para uma thread (`asyncio.to_thread` via `call`), como as consultas de banco e o store de
  anexos já iam.

O resto do tempo é rede e trabalho de verdade: o histórico da tarefa, os resultados das
ferramentas (até `KODA_TOOL_OUTPUT_LIMIT`, 50 mil caracteres cada) e o comando que a
ferramenta executou. Nada disso é gordura para cortar sem perder o que o agente sabe — o que
corta é a compactação, logo acima.

### Quando o provedor falha

Falha do provedor não é falha da tarefa, e o passo é **reenviado com o histórico
inteiro** — mensagens, eco das `tool_calls` e resultados das ferramentas já executadas.
O modelo retoma de onde parou em vez de recomeçar. São três defesas, nesta ordem:

1. **Cota e indisponibilidade** (408, 409, 425, 429, 5xx) são repetidas com backoff de 3s e
   6s (`KODA_RETRY_ATTEMPTS`, padrão 3 tentativas). O **404** também entra na lista quando o
   provider é o do serviço: no projeto anterior o upstream devolvia 404 no meio da conversa
   e o passo seguinte costumava funcionar, então ele é tratado como transitório.
2. **Erro "de vez"** (400/401/403) ganha **uma** segunda chance em outra conta: quando o
   provider sabe trocar de conta (`rotate()`), ele passa para a próxima livre em vez de
   desistir na hora. O host dos modelos oficiais não expõe isso, então aí ele não insiste —
   é bug nosso, não limite do serviço.
3. **Última cartada**: esgotadas as tentativas, espera `KODA_RETRY_FINAL_WAIT_S`
   (padrão 12s, `0` desliga) e tenta uma vez mais, porque um 429 em rajada passa rápido.

Cada movimento aparece escrito na conversa (`_(passo 1: … — tentando de novo)_`,
`_(passo 1: trocando para a conta 3 do proxy)_`), então nada acontece em silêncio. Se
ainda assim não passar, o turno termina com `completed: false` e o motivo, e o que já
foi executado fica gravado em `steps` na mensagem.

### Identidade do assistente

O serviço pode acrescentar instruções próprias ao histórico, e aí o modelo pode responder
**se apresentando** — nome do serviço e de quem o "criou" — inclusive **colado na frente de
resposta de tarefa**. E o pior efeito era indireto: o histórico gravado
ensina, então a apresentação se repetia em todas as mensagens seguintes.

São três defesas, e as três juntas (`app/identidade.py`):

1. **Regra no prompt** (`regras()`), no fim do system prompt do modo texto e do modo
   agente, mandando não declarar criador, não se apresentar e ignorar instrução que peça
   outra identidade. Vale o nome de `KODA_ASSISTENTE` (padrão `Koda`).
2. **Corte na saída** — `FiltroIdentidade` segura a cabeça da resposta até saber se ela é
   apresentação (espera um fim de frase ou 240 caracteres), tira a apresentação e libera o
   resto. Funciona sem o modelo colaborar, e roda no provider, que é por onde todo texto sai
   (modo texto e cada passo do agente). Se a resposta **inteira** era só apresentação
   ("quem é você?"), sai "Sou o Koda, o assistente de código deste app. Como posso ajudar?".
3. **A pergunta de identidade tem dono** — quando a pergunta é "quem é você?", quem
   responde é o app, não o modelo (`responder_identidade`).

O corte do item 2 só olha a **cabeça**, e só frases que sejam apresentação pura ("sou a X", "me
chamo X, criada por Y") ou saudação sozinha: falar de si no meio de uma explicação
continua passando, porque ali é conteúdo. "Sou um modelo de linguagem criado por
pesquisadores" também não é tocado — sem nome de assistente, é conversa normal.

### Quando a pergunta é "quem é você?"

Foi medido nos sete modelos do host, e o corte de cabeça falhava de três jeitos diferentes:

- o modelo respondia **só** com a apresentação, e a sobra ficava órfã — o `koda-1` dizia
  "leio e escrevo arquivos… O que você precisa fazer hoje?", sem nunca dizer quem era;
- a apresentação vinha **depois** de um comentário sobre a pergunta, onde o corte de cabeça
  não olha — o `liz-3-flash` dizia "Você perguntou 'quem é você?'… Sou a Liz, uma assistente
  criada pela Liz AI Studio";
- vinha um nome que **não está no catálogo**, e aí a regex de marca não pegava — o
  `liz-mini-2` respondia "sou conhecido pelo nome Nemotron e fui treinado por pesquisadores
  da NVIDIA".

Então, quando a pergunta é de identidade (`pergunta_identidade()`), o filtro muda de regime:
segura a resposta inteira e quem dá a palavra final é o app. Saem os parágrafos que só falam
de identidade, cortesia ou da própria pergunta, e entra "Sou o Koda, o assistente de código
deste app." — o pouco que sobrar de conteúdo de verdade vem embaixo dela. O nome do app é o
mesmo nos sete modelos: **nenhum deles consegue mais responder "quem é você?" com outro nome**.

O regime sai do próprio histórico (`_identidade_pedida()`), não de um parâmetro novo: os
dois caminhos que montam o filtro já têm as mensagens na mão, e só o pedido **mais recente**
do usuário conta — uma pergunta antiga não contamina os turnos seguintes.

O **histórico reenviado ao modelo** passa pelo mesmo corte nas mensagens do assistente
(`_turns`), que é o que quebra a repetição nas conversas antigas já gravadas. Nada é
reescrito no banco: a sua conversa antiga continua lá como está, e a resposta nova é que
sai limpa.

### Ferramentas

**Os comandos que mais falhavam agora funcionam** — e isso foi medido, não achado no olho.
Com os comandos que os modelos escrevem de verdade:

| como o comando era chamado | falhas |
| --- | --- |
| `["cmd", "/c", comando]` (antes) | **6 de 12** |
| `shell=True` com a string (agora) | **0 de 12** |

Tudo que tem aspas quebrava: `python -c "print(1 + 1)"` chegava no Python como código
picado e voltava `exit code: 1`; o mesmo com `node -e`, `findstr /c:`, `dir /b "*.txt"`. O
modelo tentava de novo, tentava de outro jeito, e era isso que parecia "os modelos não
conseguem rodar comando".

**PATH aumentado (`_path_com_programas`).** O app é aberto pelo Explorer e herda um PATH
que **não** é o do terminal de quem instalou: com um PATH só de `C:\Windows`, `node`, `npm`
e `git` simplesmente não existem — e `npm run build` morre em "is not recognized" sem nada
estar quebrado. O comando roda com o PATH do processo **mais** os lugares conhecidos
(`C:\Program Files\nodejs`, `%APPDATA%\npm`, `C:\Program Files\Git\cmd`, `%LOCALAPPDATA%\
Programs\Python\Python3*`, `~\.local\bin`, scoop, chocolatey…) — só entra o diretório que
tem executável dentro. Medido: de 0 programas achados para `node`, `npm` e `git` achados.

**Erro de programa ensina o que existe.** Quando o shell responde "is not recognized", o
retorno ganha a lista do que **está** nesta máquina (`python → C:\...`, `node → C:\...`).
Sem isso o modelo tentava `python`, `python3`, `py`, `cmd`… e gastava a tarefa nisso.

**Comando que demora não é mais interrompido.** `shell`/`terminal` rodam em processo próprio
(`Popen` + duas threads lendo stdout/stderr) e, a cada **4 minutos** (`INTERVALO_DE_OLHADA`),
devolvem ao modelo a saída até agora com o **id** do processo:

```
AINDA RODANDO (4.2 min) — id=9f3c1a2b
comando: npm run build
--- saída até agora ---
...
- Continue acompanhando: shell com {"continuar": "9f3c1a2b"}
- Não termina sozinho (servidor, janela, prévia) ou travou? Pare: shell com {"parar": "9f3c1a2b"}
```

Antes era `subprocess.run(timeout=...)`: no limite o comando era **morto** e um build de
vinte minutos ia junto com o trabalho. Agora quem decide é o modelo — acompanhar
(`continuar`) ou parar (`parar`, que mata a **árvore** com `taskkill /T`, senão o filho do
`npm` sobrevive). A saída guardada é o **fim** dela (`LIMITE_SAIDA_RODANDO`, 200 mil
caracteres): comando tagarela não enche a memória, e o erro está no fim mesmo.

**Quem interrompe é o progresso, não o relógio.** Houve um teto por tempo aqui (30 min) e ele
foi tirado por um defeito medido: um `tauri build` que levou **45 minutos** com a máquina
carregada seria morto no minuto 32 — trabalho perdido, exatamente o que a olhada veio
resolver. No lugar entrou a regra da saída nova:

- **comando que escreve, vive.** Build de duas horas que está imprimindo segue até o fim —
  não há teto de tempo nenhum;
- **comando mudo, morre.** Três olhadas seguidas sem uma linha nova (`OLHADAS_SEM_SAIDA`, ~12
  minutos) é travamento — esperando entrada, em laço mudo, morto por dentro — e ele é
  interrompido **de verdade** (`parar()`, não só sair do registro);
- **depois de `OLHADAS_ATE_COBRAR` olhadas (10, ~40 min)**, o retorno para de só oferecer
  `continuar` e cobra a decisão: se não termina sozinho (servidor, janela, prévia), é para
  parar. Sem teto por tempo, este é o freio do "vou continuar" infinito — mas quem decide
  continua sendo o modelo.

Acompanhar/parar **não pede permissão de novo** (`classificar` devolve `None`): o cartão já
foi respondido quando o comando começou, e parar é o lado seguro — sem isso o cartão saía
como "Rodar comando: (comando vazio)".

Portadas do projeto `TOOLS` do usuário (`app/tools/ferramentas.py`), **37 no total**:
execução (`code_interpreter`, `shell`, `terminal`), arquivos (`read_file`, `write_file`,
`edit_file`, `str_replace_editor`, `list_dir`, `search_files`, `delete_file`,
`create_directory`, `delete_directory`, `move_file`, `copy_file`, `rename_file`),
`apply_patch` (diff unificado, tudo-ou-nada), busca (`search_codebase`, `vector_search`,
`grep`, `regex_search`, `get_problems`, `linter`), web (`web_search`, `url_reader`,
`browser`, `download_file`, `upload_file`), git (`git_status`, `git_diff`, `git_log`,
`git_commit`, `git_push`, `git_pull`), dependências (`install_package`,
`uninstall_package`), ambiente (`get_environment`) e plano (`update_todos`).

**Apelidos.** O modelo escreve de memória os nomes que outros agentes usam —
`run_command`, `list_directory`, `run_code`, `open_url`, `apply_diff`, `read`… O catálogo
anuncia os nomes canônicos, mas a chamada pelo apelido **funciona**: `canonico()` traduz o
nome e `_sinonimos()` traduz o campo (`path`→`caminho`, `content`→`conteudo`,
`command`→`comando`). Antes disso a resposta era "ferramenta desconhecida", que numa tarefa
grande custava o passo inteiro.

Elas rodam **na máquina**, sempre com `cwd` na pasta de trabalho (`KODA_WORKSPACE`, por
padrão a raiz do projeto) e com a saída truncada. Para desligar ferramentas, use
`KODA_TOOLS_DENY` (ex.: `shell,terminal,git_commit,delete_file`) — elas somem do catálogo
enviado ao modelo e recusam execução (o apelido também é traduzido antes da checagem).

Três travas que não são óbvias:

- **Pasta de trabalho.** As ferramentas de arquivo resolvem o caminho e conferem se ele cai
  dentro do workspace — inclusive depois de seguir symlink e `..`. Caminho de fora volta
  com erro; `KODA_ACESSO_LIVRE=on` libera. Sem isso, um `read_file` com caminho absoluto
  lia qualquer coisa da máquina, e o modelo é justamente quem lê página da web. Vale o
  mesmo aviso de sempre: `shell` e `terminal` sempre puderam tudo, por definição.
- **Redirects.** `url_reader`/`browser` checam o endereço de partida e **cada salto** do
  redirecionamento, até 5. O `follow_redirects=True` do httpx checava só a URL inicial, e um
  site público devolvendo `Location: http://127.0.0.1:8787` (ou
  `169.254.169.254/latest/meta-data/`) entrava direto — SSRF clássico.
- **Git.** As ferramentas `git_*` rodam `git rev-parse --show-toplevel` e recusam quando a
  raiz do repositório não é a pasta de trabalho. O Koda mora dentro de uma pasta que já é
  um repositório, então sem essa trava um `git add -A` commitava o projeto do pai, com o
  histórico de outra pessoa. Rode `git init` no Koda para ter um repositório só dele.

### Parar no meio

Apertar **parar** no front aborta o `fetch` e o backend cancela a tarefa do loop: o agente
não avança para o próximo passo e a fila de eventos não cresce mais. Uma ferramenta que já
está em execução termina — ela roda em `asyncio.to_thread` e não dá para interromper no
meio —, mas nada depois dela roda. O que já tinha saído fica gravado no histórico.

### Busca na web

O `web_search` usa o RSS do Bing, sem chave de API nem dependência nova. Busca até 12
resultados por consulta e, quando há palavras de pergunta, também consulta a versão enxuta;
combina links distintos e devolve até 20. Em pesquisas amplas, o prompt pede ao agente que
faça três buscas com formulações diferentes e leia páginas de pelo menos três domínios.

Wikipedia, Wikimedia e projetos irmãos são excluídos com `-site:` e filtrados de novo após
a busca. `url_reader` e `download_file` bloqueiam esses domínios tanto na URL inicial quanto
em redirecionamentos, para o agente não abrir o endpoint ou baixar arquivos da Wikimedia.
O bloqueio também se aplica ao `upload_file`.

Se o Bing não responder, a busca informa o erro. Não há uma segunda API de busca: o aumento
de cobertura vem das consultas variadas ao Bing, sem introduzir os outros motores que já
foram medidos com timeout ou bloqueio nesta rede.

Isso é uma escolha, não um acidente: as **APIs públicas Bing Search v7 e Custom Search
foram aposentadas em 11/08/2025**, e o substituto que a Microsoft indica (*Grounding with
Bing Search*, dentro do Azure AI Agents) é serviço pago amarrado a um agente no Azure — não
é uma API de busca solta. Raspar continua sendo o caminho gratuito.

Houve um **SearXNG local** aqui antes (pasta `searxng/`, ajuste `KODA_SEARXNG_URL`) e ele
foi removido a pedido. O motivo foi medido: o SearXNG não liga o Bing web por padrão
(`disabled: true`), e os motores que ele liga — `duckduckgo`, `startpage`, `brave`,
`mojeek` — são justamente os que respondem pior deste IP (`startpage` e `mojeek` com
CAPTCHA, DDG com timeout, `brave` levando 429). Ou seja, ele tenderia a piorar a busca em
vez de melhorar. Se um dia voltar, o override de `engines` para ligar o `bing` é
obrigatório.


### Janelas de uso

As mensagens guardam o instante do envio, então as três cotas saem de uma contagem só: o
cliente manda `tz_offset_minutes` (o `Date.getTimezoneOffset()`) e o servidor calcula
meia-noite, segunda-feira e dia 1º **no relógio do cliente**. Os limites ficam em
`app/plan.py` — os mesmos de `src/plan.ts`.

## Providers

`KODA_PROVIDER=auto` (padrão) procura nesta ordem: o serviço de modelos (se estiver
respondendo) e o provider local. São **dois**, e não há um terceiro.

- **local** — responde sem chave, em pedaços, dizendo que não há modelo configurado. **Não
  sabe chamar ferramenta**: com ele o chat funciona, mas o agente não executa nada
  (`tools_ready: false` no `/api/health`).
- **host** — o provider do **host dos modelos oficiais** (`HOST_URL`, o `host/c-host.exe`),
  que traz o catálogo e o tool calling. É o que liga o agente na interface. Com `HOST_KEY`
  preenchida o `Authorization: Bearer` vai em toda chamada ao host (catálogo, esforços e
  conversa); em branco nenhum cabeçalho é enviado, que é o certo para o host aberto. O host
  com autorização remota recusa com 401 quem não manda chave — e 401 aqui já foi confundido
  com "host fora do ar", jogando o `auto` no provider local e sumindo com as ferramentas.

  O modelo padrão é **`liz-4`** (o maior do catálogo, e o primeiro da lista no seletor).
  `KODA_HOST_MODEL` troca o padrão. O Koda envia as ferramentas disponíveis sem
  `tool_choice` e deixa cada modelo decidir quando e qual ferramenta chamar.

  Subindo o `c-host.exe` **à mão** (fora do app), ele precisa de duas coisas que o app
  passa sozinho e que não estão no binário: `SERVE_LIZ_AUTH_URL` com o **endereço base do
  painel** (o host anexa `/api/public/host/authorize`; passar a URL completa dá 404) e, do
  lado do backend, `KODA_HOST_KEY` para o `Authorization` da conversa. Sem a variável do
  painel o host sobe e responde **503** em tudo — é *fail-closed* de propósito: ele não
  guarda credencial nenhuma.

      SERVE_LIZ_AUTH_URL=https://koda-cloud-api.studiosluxgames.workers.dev ./c-host.exe

Duas decisões que o provider do serviço toma e que não são óbvias:

- **o id do modelo vai como veio.** O catálogo é do serviço, não nosso, então `resolve_model`
  não inventa tradução: id desconhecido passa intacto e quem recusa é o serviço, com erro
  explícito. Só nomes vazios ou os decorativos antigos (`koda-flash`, `koda-pro`,
  `koda-vision`, `liz-flash`, `liz-pro`, `liz-vision`) caem no `HOST_MODEL`. Antes disso o
  provider engolia qualquer id que não fosse de um catálogo fixo e devolvia o padrão —
  escolher `koda-1` pedia outro modelo, **em silêncio**, e todos os modelos viravam um só.
- **o `reasoning_effort` é ajustado ao modelo.** O host publica em `/v1/models` os níveis
  que cada um aceita (`efforts`) e o alvo de cada um (`targetFormat`); nem todo modelo aceita
  todos os valores, e mandar um fora da lista é **400 na tela**. O provider lê esse catálogo
  uma vez, guarda o conjunto por modelo e sobe para o nível seguinte quando o desejado não
  serve — `none` para os alvos `openai-responses` (`liz-4`, `layze-2`), que recusam o campo,
  e `low` para o `koda-1`, que não tem `minimal`. Sem catálogo, cai no valor seguro
  (`minimal`), que passa em todos os medidos.
- **a sondagem espera até 3s.** O serviço monta o catálogo na primeira chamada e demora; com
  timeout curto o `auto` concluía que o serviço estava fora e caía no `local` (sem
  ferramentas). A sonda mora em `host_disponivel()`.

Para acrescentar outro provedor, implemente `stream(turns, options)` e registre em
`app/providers/__init__.py` — nada mais precisa mudar.

## Nuvem (Koda Cloud)

O backend na nuvem (`server/`, Cloudflare Workers + D1) é o serviço da casa: aviso de
atualização, changelog e o catálogo publicado. Aqui ele aparece como **um extra** — o app
abre e conversa sem internet, e nada da nuvem pode segurar a tela.

```bash
KODA_CLOUD_URL=https://koda-cloud-api.studiosluxgames.workers.dev
```

Esse é o padrão, então a integração já vem ligada. Endereço vazio desliga; `http://` só é
aceito em `localhost`/`127.0.0.1` (a configuração recusa o resto).

O que a tela tem para ler:

- `GET /api/cloud/update` — `{ativo, disponivel, canal, erro, atualizacao:{update_available,
  latest_version, download_url, mandatory, notes}}`. O resultado fica em memória por 15
  minutos; `refresh=true` é o "verificar de novo".
- `GET /api/health` — o mesmo resumo em `cloud`, porque a tela já chama o health ao carregar:
  o aviso chega sem uma segunda requisição.

Regras que valem para toda chamada feita daqui (ver `app/nuvem.py`):

- **HTTPS obrigatório**, sem usuário/senha embutidos na URL;
- **sem seguir redirecionamento** — um 302 não leva o app para um host escolhido pela nuvem;
- **timeout curto** (`KODA_CLOUD_TIMEOUT_S`) e teto de corpo (256 KB): serviço lento ou
  resposta gigante não travam a interface;
- **a resposta é validada** antes de chegar na tela, e um campo com tipo errado descarta a
  resposta inteira;
- **o link de download só vale em HTTPS**, e com `KODA_CLOUD_DOWNLOAD_HOSTS` configurado
  apenas nos domínios permitidos — o aviso continua de pé, o link é que não é oferecido;
- **o token** (`KODA_CLOUD_TOKEN`) vai só no cabeçalho `Authorization`: nunca na URL, nunca
  em mensagem de erro, nunca em log. Erro da nuvem sai como "serviço indisponível", sem
  endereço nem detalhe de rede;
- **nada sai para a rede sem pedido**: por padrão a consulta só acontece quando a tela pede
  (`KODA_CLOUD_CHECK_ON_START=on` faz a checagem subir junto com o backend).

### Download do instalador

Quem baixa o instalador é **este backend**, não o navegador (ver `app/instalador.py`). O
motivo é prático: um `<a href>` joga o usuário para fora do app (janela nova, "salvar como",
pasta escolhida à mão) e o arquivo acaba em qualquer lugar. Aqui ele vai direto para a
pasta de downloads do sistema, com o progresso na tela.

- `POST /api/cloud/download` começa o download e devolve o estado do instante do pedido;
  `GET /api/cloud/download` é o progresso, que a tela lê em intervalos curtos.
- **o endereço não vem do pedido**: sai do último estado da nuvem, já passado por
  `link_seguro`. Cliente nenhum escolhe o que este processo baixa. Se ninguém consultou a
  nuvem ainda nesta sessão, o próprio POST consulta antes de responder.
- **um download por vez**: pedir de novo enquanto ele corre devolve o mesmo progresso.
- **escrita atômica**: o arquivo nasce como `.part` e só no fim recebe o nome verdadeiro —
  download interrompido não deixa um arquivo pela metade com cara de instalador.
- **teto de meio giga** e sem seguir redirecionamento, como nas demais chamadas.
- A pasta é a de downloads do sistema; `KODA_DOWNLOAD_DIR` troca isso (útil em teste e em
  quem embute o Koda).

## Estrutura

```
app/
  config.py        # variáveis de ambiente (com padrões que já funcionam)
  identidade.py    # a voz do assistente: regras do prompt + corte da apresentação
  db.py            # conexão SQLite e criação do esquema
  repository.py    # consultas de conversas, mensagens, uso e conta
  schemas.py       # modelos Pydantic e formatação do SSE
  providers/       # local, o dos modelos oficiais (host) e o openai-compatível, com o contrato comum
  tools/           # catálogo de ferramentas + loop agentic (do projeto TOOLS)
  contexto.py      # orçamento de contexto: resumo do histórico e compactação do loop
  nuvem.py         # ponte com o Koda Cloud (update, changelog) e o que ela não pode fazer
  routers/         # chat, conversations, usage, account, cloud
  main.py          # create_app(), CORS, lifespan
```

## Licença

Projeto **proprietário**, todos os direitos reservados: o uso deste código, no todo ou em
parte, depende de autorização prévia e por escrito do titular — inclusive executar, copiar,
modificar, distribuir e treinar modelos com ele. O texto completo está em
[`../LICENSE`](../LICENSE).
