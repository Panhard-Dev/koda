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

No app instalado, o launcher marca o backend com `KODA_BACKEND_PACKAGED=1` e o
provedor padrão é `host`. Assim, variáveis `OPENAI_*` de outros programas não
redirecionam a conversa por acidente. `KODA_PROVIDER` definido explicitamente no
ambiente ou no `.env` continua prevalecendo, inclusive `auto`. No desenvolvimento,
o padrão continua sendo `auto`; o marcador é interno ao launcher, não precisa
ser configurado pelo usuário.

## Rotas

| Método | Rota | O que faz |
| --- | --- | --- |
| `GET` | `/api/health` | Estado do servidor, provider ativo, banco, pasta de trabalho e ferramentas |
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
desliga o agente de vez, `KODA_MAX_STEPS` limita os passos e `KODA_TOOL_TIMEOUT` dá um
teto de tempo (segundos) para a tarefa inteira — com o provedor fora do ar, é ele que
impede a resposta de ficar pendurada em tentativas.

Os dois padrões são **sem teto de passos** (`KODA_MAX_STEPS=0`) e **meia hora de tarefa**
(`KODA_TOOL_TIMEOUT=1800`). Não é descuido: projeto grande não cabe em número fixo de
passos, e um teto pequeno cortava trabalho legítimo pela metade — criar um conjunto de
arquivos, compilar ou rodar uma bateria de testes passa de qualquer teto curto. Quem
impede um loop sem fim é o tempo, o contador de respostas vazias do loop e o botão de
parar. Cada comando do terminal tem o seu próprio teto (`TEMPO_COMANDO`, 10 min por padrão,
ampliável pelo modelo até uma hora), porque é ali que uma suíte grande realmente demora.

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

### Portões de parada: o que faz a conversa **não** fechar cedo

A ideia vem do Hermes (`agent/turn_stop_gates.py`, de onde foram copiadas as duas lições
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

Quatro portões, em `app/tools/loop.py`, avaliados nesta ordem quando chega uma resposta de
texto. Cada um tem orçamento próprio e **nenhum custa a resposta**: o texto já saiu na tela
e é o que fica guardado — o portão só decide se ele é o fim ou se vem mais trabalho.

1. **Lista em aberto** (`retomar_tarefa`, até `MAX_RETOMADAS` = 3, renovando a cada avanço):
   o sinal mais forte, porque não depende do que o modelo escreveu — é o que ele mesmo
   registrou que faltava. A cobrança **nomeia** os itens e manda marcar na lista o que já
   está feito, em vez de refazer;
2. **Prova do que mudou** (`PROVAR_MUDANCA`, uma vez): mudou arquivo de **código** e não
   executou nada depois disso é entrega sem prova de que funciona. O portão olha a
   extensão (README não pede teste), e vale o **comando/código que rodou depois da última
   mudança** — não o que rodou antes;
3. **Promessa no fim** (`tool_choice: "required"`, até `MAX_FORCADAS` = 3): a resposta termina
   anunciando trabalho. O passo é **refeito** com a ferramenta obrigatória — ver a seção
   abaixo;
4. **Ação sem nada ter funcionado** (`CONSERTAR_FERRAMENTA`, até 2): o pedido é uma ação e
   nenhuma ferramenta funcionou — ali não existe "não havia o que fazer", existe erro de
   argumento para ler e corrigir.

Esgotados os orçamentos, o fechamento é **honesto** em vez de silencioso: `completed: false`
e uma frase que diz o que ficou faltando. Quem não executou nada ouve que nada mudou no
disco; quem executou parte ouve só o que ficou em aberto.

### O modelo é obrigado a executar

O sintoma original: o modelo respondia **"Vou seguir com a Fase 1…"** e encerrava o passo
sem chamar ferramenta nenhuma — o plano na tela e o disco intacto. Para quem estava olhando,
o agente "falou que ia fazer e não fez". Duas defesas, e a terceira que substituiu a
cobrança:

- **lista em aberto não deixa encerrar.** É o sinal mais objetivo que existe, porque não
  depende do que o modelo escreveu: se a lista registrada por ele tem item pendente, uma
  resposta de texto é interrupção no meio da tarefa. A cobrança (`retomar_tarefa`) nomeia os
  itens em aberto — cobrança genérica vira outra linha de intenção e para de novo. Trabalho
  feito entre uma parada e outra **renova** o orçamento de retomadas (`MAX_RETOMADAS`, 3):
  numa tarefa longa o agente narra e para várias vezes no caminho, e sem isso o teto acabava
  no meio de trabalho que estava andando bem;
- **anúncio refaz o passo com a ferramenta obrigatória.** A resposta que **termina**
  anunciando o próximo passo (`vou…`, `próximo passo`, `em seguida`, `seguir com`) não vira
  mensagem de bronca no histórico: o passo é **refeito** apontando a ferramenta. O anúncio
  sai do histórico (para não virar exemplo) e o trabalho acontece — sem "cobrança" na
  conversa. Duas forças, porque uma só não cobre o catálogo:

  1. `tool_choice: "required"` — a API é obrigada a devolver uma chamada;
  2. da segunda tentativa em diante, a ferramenta **pelo nome**
     (`{"type": "function", "function": {"name": "read_file"}}`), inferida do próprio
     anúncio (`funcao_do_anuncio`). É o caso do **`liz-nano`**, que **ignora** `required`
     (medido) e chama quando a função é dita. Só ferramenta de leitura/busca/comando entra
     aqui: forçar um `write_file` que o modelo não planejou grava arquivo pela metade.

  Até `MAX_FORCADAS` (3); se nem apontada o modelo agir, o fechamento é honesto
  (`completed: false`). A checagem olha o **fim** do texto, e não o texto inteiro: uma
  explicação que só menciona o próximo passo no meio não pode virar "não terminei". A lista
  de verbos é ampla de propósito (`analisar`, `revisar`, `conferir`, `abrir`, `ler`…): era o
  `agora vou **analisar** os arquivos restantes` que passava batido e parava a tarefa;

- **nada no prompt pede turno só de fala.** A regra 5 mandava narrar "ANTES de cada
  ferramenta", e o loop injetava, a cada dois passos mudos, um pedido de narração que dizia
  *"sem pedir ferramenta nesta resposta"*. Os modelos menores leram isso como licença para
  **encerrar o passo narrando** — a tela mostrava "agora vou verificar o último arquivo" e
  nada acontecia; o loop então brigava com o anúncio que ele mesmo tinha pedido. Agora a
  linha curta e a chamada vão na **mesma resposta**, e a narração pedida pelo loop exige a
  ferramenta junto;
- **tarefa de ação sem nenhuma ferramenta também.** Se o pedido é uma ação ("arruma o
  bug") e nada rodou ainda, a resposta de texto não encerra a tarefa: entra
  `CONSERTAR_FERRAMENTA` (ler o erro, corrigir o argumento, executar). Pergunta de verdade
  (`o que faz…?`) segue respondida em texto, como deve ser. Registrar o plano **não** conta
  como ferramenta que funcionou — e, logo depois do plano, a cobrança de erro não aparece:
  ali nada foi tentado, então não há erro para consertar;
- **depois das cobranças, a verdade.** Se o modelo insistir em só falar, o `done` sai com
  `completed: false` e a mensagem diz o que faltou pelo nome. A frase é verdadeira nos dois
  casos: quem não executou nada ouve que nada mudou no disco, e quem executou parte do
  trabalho ouve só o que ficou em aberto — dizer "nada foi executado" depois de arquivos
  criados seria mentira na cara de quem viu as ferramentas rodando.

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
`npm` sobrevive). A saída guardada é o **fim** dela (`LIMITE_SAIDA_RODANDO`, 24 mil
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

O `web_search` usa **só o Bing**, e nada mais. Uma requisição para
`https://www.bing.com/search`, as tags `<li class="b_algo">` lidas na mão e os 6 primeiros
resultados formatados em título, URL e resumo. Sem chave de API, sem dependência nova e sem
serviço intermediário — a função é `_busca_bing`, em `app/tools/ferramentas.py`.

Duas coisas que valem saber:

- **A URL de cada resultado vem embrulhada.** O Bing devolve
  `bing.com/ck/a?u=a1<base64url>` no `href`; `_decodificar_url_bing` extrai a URL de
  verdade. O payload é base64**url** (usa `-` e `_`), então a decodificação tem que ser
  `urlsafe_b64decode` — com o `b64decode` comum a URL volta como o wrapper cru.
- **Não existe plano B.** Se o Bing devolver uma página de bloqueio, a busca retorna
  `(sem resultados)`; se a rede cair, retorna um `ERRO: o Bing não respondeu`. O modelo não
  tem como distinguir bloqueio de busca vazia, e agora não há uma segunda fonte para
  mascarar isso. Medido nesta máquina: 14 de 14 consultas voltaram com 6 resultados cada,
  média de ~1,3 s — o `User-Agent` de bot do Koda não incomoda o Bing.

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

`KODA_PROVIDER=auto` (padrão) procura nesta ordem: OpenAI (se houver chave), o serviço de
modelos (se estiver respondendo) e o provider local.

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
  O `liz-nano` era o padrão e saiu: ele **ignora** o `tool_choice` genérico e é justamente
  o modelo que mais encerra anunciando em vez de executar (medido — ver os portões de
  parada). `KODA_HOST_MODEL` troca o padrão.

  Subindo o `c-host.exe` **à mão** (fora do app), ele precisa de duas coisas que o app
  passa sozinho e que não estão no binário: `SERVE_LIZ_AUTH_URL` com o **endereço base do
  painel** (o host anexa `/api/public/host/authorize`; passar a URL completa dá 404) e, do
  lado do backend, `KODA_HOST_KEY` para o `Authorization` da conversa. Sem a variável do
  painel o host sobe e responde **503** em tudo — é *fail-closed* de propósito: ele não
  guarda credencial nenhuma.

      SERVE_LIZ_AUTH_URL=https://koda-cloud-api.studiosluxgames.workers.dev ./c-host.exe
- **openai** — `/chat/completions` com `stream: true`; serve OpenAI, Groq, OpenRouter e o
  Ollama (`OPENAI_BASE_URL=http://localhost:11434/v1`). `KODA_MODEL_MAP` traduz os nomes
  da interface (`{"liz-nano": "gpt-4o"}`).

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
