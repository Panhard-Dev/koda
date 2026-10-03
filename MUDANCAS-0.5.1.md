# Koda 0.5.1 — tudo o que mudou

Documento completo, ponto a ponto. Base de comparação: **0.4.3** (`1d8b411`, o último release
que estava na `main`) até o estado atual da 0.5.1.

> **Escopo.** A 0.5.1 mexe em quatro frentes: o **comportamento do agente** (quando ele para,
> e o que ele diz quando para), a **retomada** de uma tarefa que ficou pela metade, a
> **interface** da conversa, e os **tetos de trabalho** do backend. No fim há uma seção com o
> que foi removido, o que ficou de fora de propósito, e o estado de cada parte.

---

## 1. O que mudou de conceito

Três ideias, e o resto é consequência delas.

1. **Tarefa longa é para ser terminada.** Não existe teto de passos nem de chamadas de
   ferramenta. Teto fixo trunca trabalho grande no meio, em silêncio, e o número que parecia
   generoso (100 passos) não é grande coisa para montar um projeto ou rodar uma bateria de
   testes. Os limites que sobraram medem **quando o modelo parou de trabalhar**, não quanto
   trabalho ele fez.
2. **O loop não fala pelo produto.** Ele não escreve mais frase de fechamento na conversa
   ("não terminei a tarefa… me diga *continue* que eu sigo"). Quando a rodada não fecha, o
   que sobe é um **contrato estruturado** — motivo, itens pendentes, o que já rodou, se dá
   para retomar — e é a interface que explica, em um cartão.
3. **Retomar é uma ação, não uma mensagem.** O botão mandava `text: "continue"` e isso virava
   uma bolha de pessoa na conversa: a tela mostrando o próprio dono pedindo a palavra mágica
   que o produto deveria saber sozinho.

---

## 2. Agente: quando o loop para (backend/app/tools/loop.py)

**Arquivo mais mexido do release: 1.624 linhas alteradas.**

### 2.1 Sem teto de passos e sem teto de chamadas

- `max_steps` e `max_tool_calls` valem `0` = **sem teto** (já era o padrão na 0.4.3, mas os
  comentários e o contrato mudaram de sentido — antes era "sem teto para não encerrar tarefas
  longas", agora é uma regra explícita e testada).
- Um teste novo trava isso: `test_agente_sem_teto_de_chamadas_de_ferramenta_por_padrao`.
- Quem impede um laço sem fim passou a ser: o botão de parar, o teto de tempo da tarefa
  (`tool_timeout_s`), o contador de respostas vazias, e os guardas de progresso do item 2.2.

### 2.2 Os limites que sobraram são de **persistência**, não de trabalho

Cada contador do loop é **renovado a cada trabalho novo** (`ferramentas_ok` avançando).
Enquanto o modelo produz, ele nunca esbarra em teto. Quem esbarra é quem **para de agir e só
repete intenção** — e aí a rodada fecha com o estado guardado, para ser retomada.

| Contador | Valor | O que ele limita |
|---|---|---|
| `MAX_RETOMADAS_ANUNCIO` | 10 | Quantas vezes um anúncio sem execução é retomado por mensagem interna |
| `MAX_RETOMADAS` | 10 | Quantas vezes uma tarefa parada com itens do plano em aberto é retomada |
| `MAX_COBRANCAS` | 2 | Quantas vezes o loop cobra execução quando nenhuma ferramenta funcionou |
| `MAX_SILENCIO` / `MAX_NARRACOES` | 1 / 6 | Passos calados seguidos antes de cobrar uma linha de narração |
| `MAX_VAZIAS` | 30 | Respostas vazias seguidas do provedor antes de desistir |
| `MAX_TENTATIVAS` / `ESPERA_BASE` | 5 / 3,0 s | Reenvios de um passo quando quem falhou foi o provedor |

Nenhum deles é opcional: medido no projeto de referência, um comando vivo com o modelo
respondendo só texto levava o processo a **511 MB em 6 s** (laço infinito).

### 2.3 O bug que encerrava a tarefa no primeiro anúncio (correção)

A retomada de anúncio estava condicionada a **já ter ocorrido trabalho** (`ferramentas_ok`)
ou a ser uma tarefa de ação reconhecida pelo vocabulário do pedido. Resultado: o caso **mais
comum** — o modelo anuncia o próximo passo antes de executar qualquer coisa — caía fora da
condição e a conversa fechava ali. Agora a condição é de **estado**: existe catálogo de
ferramentas e a rodada é de trabalho. Exemplo real que quebrava:

> *"Separe a seção do chat no index.html."* → o modelo responde *"Vou separar a seção do chat
> em uma página própria."* e para. Antes: fim. Agora: retomada, e o `edit_file` acontece.

### 2.4 Contrato estruturado de parada

O loop passou a concluir com um **código de motivo** em vez de uma frase. A tabela completa:

| Código | Significado |
|---|---|
| `pending_steps` | A lista que o próprio modelo registrou ficou com item em aberto |
| `announced_only` | O modelo anunciou o próximo passo e encerrou sem executá-lo |
| `time_limit` | O tempo máximo da tarefa acabou |
| `tool_limit` | O teto de chamadas de ferramenta foi atingido |
| `step_limit` | O limite de passos foi atingido |
| `repeated_tool` | A mesma chamada se repetiu mesmo após o aviso, e o ciclo foi interrompido |
| `empty_response` | O provedor respondeu vazio várias vezes seguidas |
| `provider_error` | O provedor caiu e não deu para continuar |
| `context_overflow` | O provedor recusou o tamanho do pedido, e não coube nem reduzido |
| `interrupted` | A tarefa foi interrompida |

- **`context_overflow` é o único que não retoma** (`NAO_RETOMAVEL`): o mesmo pedido não vai
  caber depois, então oferecer "Retomar" ali seria vender uma promessa falsa.
- O `Resultado` do loop ganhou três campos: **`pendentes`** (itens em aberto, com o texto que
  o modelo deu), **`executou`** (quantas ferramentas rodaram de verdade) e a propriedade
  **`retomavel`**.
- Esses códigos são o **contrato entre backend e interface**: mudar um código é mudar os dois
  lados, e há teste para os motivos principais.

### 2.5 O que o loop deixou de escrever na conversa

Removidas todas as frases que o loop inventava no lugar da resposta do modelo:

- `'Me diga "continue" que eu sigo do próximo item.'`
- `"Não consegui concluir a tarefa: o modelo anunciou o próximo passo… me diga “continue”…"`
- `"Nada mudou no disco — me diga “continue” que eu recomeço."`
- `"Não terminei a tarefa: {motivo}. O que já foi feito está no disco."`
- `"A tarefa ficou incompleta; ainda falta: …"`
- `"Não consegui continuar: o provedor recusou o pedido por tamanho… Divida a tarefa…"`
- `"Interrompi a tarefa porque o modelo repetiu a mesma ferramenta…"`

O que fica **é o que o modelo escreveu**. Quando ele não escreve nada, entra a regra do aviso
de falha (item 2.6) — e não uma instrução de uso.

### 2.6 Regra do aviso de falha

Duas frases, escolhidas pelo **estado**, nunca pelo texto do modelo:

- Nada executado → *"Este pedido não foi processado até o fim."*
- Algo executado → *"Esta rodada não foi concluída. Parte das ações já pode ter sido
  executada — confira os efeitos antes de repetir o pedido."*

A regra de ouro: **nunca afirmar que nada foi executado** depois de a pessoa ver as
ferramentas rodando. Antes havia um caso em que o fechamento dizia "nada mudou no disco" com
arquivos recém-criados.

### 2.7 Conferência ao parar (mecanismo novo, **desligado**)

- Portei um portão de *verify-on-stop*: depois de alterar código, o loop pode cobrar a
  conferência (teste, build, linter) antes de encerrar — com `MAX_VERIFICACOES = 2`.
- Ele lê **estado**, nunca vocabulário: guarda os caminhos alterados (`mudados`), marca
  `precisa_conferir` quando uma ferramenta que escreve tem sucesso, e limpa a marca quando
  uma ferramenta de conferência roda.
- **Mexer só em prosa não levanta o sinal**: uma lista de extensões (`.md`, `.txt`, `.csv`,
  `.rst`, `.log`…) e de nomes de arquivo (LICENSE, NOTICE, CHANGELOG…) isenta README e
  afins — não há o que executar num README.
- **Fica desligado por padrão** (`VERIFICAR_AO_PARAR = False`), como na referência, que também
  é opt-in por configuração. O motivo é medido: com o portão ligado, o agente voltava a mexer
  no código que a pessoa não pediu de novo, só para "provar" que a mudança funciona. Quem
  decide se roda o teste é quem pediu.

### 2.8 `tool_choice` saiu do provedor

- Removido o parâmetro `escolha_ferramenta` de `step()` e de `step_streaming()` no provider
  OpenAI-compatível. O caminho antigo forçava `tool_choice: "required"` (ou apontava a
  ferramenta pelo nome) para obrigar o modelo a chamar algo depois de um anúncio.
- Consequência: **com ferramentas, nenhum `tool_choice` é enviado** — o provedor mantém a
  seleção automática e o modelo escolhe se chama e qual chama. Isso era fonte de erro com
  modelos que ignoram `required` e de chamadas fora do cartão de permissão.
- Junto saiu a maquinaria `FORCAVEIS`/`MAX_FORCADAS`/`catalogo_de_leitura`.

### 2.9 Mensagens internas do loop

- As mensagens que o loop injeta no histórico (cobrança de narração, continuação, continuação
  de resposta truncada, cobrança de execução, e a **retomada pelo botão**) ficam fora da régua
  que classifica o pedido (`pedido_do_usuario`). Sem isso, retomar faria a rodada ser lida como
  "pedido novo de resposta" e a retomada viria **sem catálogo de ferramentas** — o oposto do
  que o botão quer.
- Nova constante `RETOMAR_TAREFA`: o texto interno da retomada pedida pela interface.

---

## 3. Retomar virou ação de verdade

**Antes:** o botão mandava `{ text: 'continue' }`. Isso criava um turno de usuário no banco e
desenhava uma bolha de pessoa na tela.

**Agora**, de ponta a ponta:

- **`ChatRequest.resume`** (novo campo em `backend/app/schemas.py`). Retomar dispensa `text`:
  a validação que exigia "mensagem ou anexo" não se aplica quando é retomada.
- **`_prepare`** trata o caso separadamente: **não grava turno de usuário nenhum**. Monta o
  histórico da conversa existente e acrescenta o turno interno `RETOMAR_TAREFA` **só em
  memória**.
- **`_conversa_existe`** valida na rota, **antes** de o stream começar — porque depois do
  início do stream o status já foi `200` e um erro viraria stream truncado em vez de erro
  legível. Nova validação: retomar sem conversa devolve **`400`** com motivo.
- **No App** (`src/App.tsx`): `resume` **não** cria bolha de usuário — o estado só é
  atualizado quando não é retomada. O texto do payload vai vazio.
- **No cartão** (`src/components/TarefaIncompleta.tsx`): o botão só aparece quando
  `resumable` é verdadeiro **e** existe ação ligada. Nos motivos que não retomam
  (`context_overflow`), o cartão aparece só como relatório, sem botão.

### 3.1 O contrato no evento `done`

O evento `done` do stream ganhou quatro campos:

| Campo | Tipo | Para que serve |
|---|---|---|
| `reason` | string \| null | O código do motivo (tabela do item 2.4) |
| `pending_items` | string[] | Os itens do plano que ficaram em aberto |
| `executed` | number | Quantas ferramentas rodaram de verdade |
| `resumable` | boolean | Se o botão Retomar deve aparecer |

---

## 4. Interface

### 4.1 Cartão de tarefa não concluída (`TarefaIncompleta.tsx`, reescrito)

- Título **"Tarefa não concluída"**, com ícone de alerta.
- **A cópia muda conforme o motivo**: cada código da tabela do item 2.4 tem uma linha de
  leitura própria, e a tradução mora no frontend — o backend não precisa saber escrever
  português de tela.
- **Lista os itens pendentes** com as palavras que o próprio agente registrou no plano.
- Quando `executed > 0`, acrescenta: *"O que já foi executado está no disco — confira antes de
  repetir."* Antes disso, a frase "nada foi executado" era dita mesmo com arquivos no disco.
- **Botão Retomar** com estado de ocupado (`Retomando…` enquanto há resposta rodando) — dois
  turnos ao mesmo tempo não dá.

### 4.2 Cartão de compactação (`Compactacao.tsx` + `compactacao.ts`, novos)

- Antes, quando o histórico era resumido, o aviso era um parêntese em itálico **dentro** do
  texto do modelo (`_(histórico compactado: 13 mensagens antigas viraram resumo…)_`), o que
  sujava a resposta e ainda duplicava no caminho de texto.
- Agora é um **cartão próprio**, no ponto exato da resposta onde a compactação aconteceu.
- `src/compactacao.ts` separa o texto por **regex ancorada** nos quatro motivos possíveis
  (`historico`, `contexto`, `reducao`, `corte`). Garantia testada: texto **sem** aviso
  atravessa byte a byte idêntico.
- O cartão mostra ícone e tom conforme o motivo, mais um selo em fonte mono com o número
  (`13 mensagens`) ou a variação de tokens (`~612k → ~148k (−464k)`).
- Duas animações novas em `src/index.css`: `compact-in` e `compact-shine`.
- **A duplicação foi removida** no caminho de texto do `chat.py`: a nota saía duas vezes.

### 4.3 A linha "Trabalhando…" fica visível o tempo todo

- **Antes:** só aparecia quando a tela ficava **800 ms em silêncio** (ou quando não havia
  conteúdo nenhum ainda). Enquanto as palavras chegavam, ela sumia — e o passo da ferramenta
  aparecia sozinho, parecendo que a tarefa tinha parado ali.
- **Agora:** enquanto a resposta está viva, ela fica no fim do que já chegou, **inclusive
  logo abaixo do passo da ferramenta**. O silêncio deixou de ser o critério.

### 4.4 A rolagem não puxa mais a pessoa para baixo

- **Antes:** cada pedacinho de texto que chegava chamava `scrollIntoView`. Subir para reler
  uma resposta antiga era inútil — o próximo token trazia de volta. Não dava para ler nada
  enquanto o modelo escrevia.
- **Agora** (`src/App.tsx`): a rolagem só acompanha o fim **quando quem está lendo já está no
  fim**, com 80 px de folga (o arredondamento do zoom e a última linha meio cortada não contam
  como "saiu do fim"). Subir para o meio da conversa **desliga** o acompanhamento; voltar ao
  fim **liga** de novo; mandar mensagem ou retomar **religa** sempre.
- Também saiu o `behavior: 'smooth'` da rolagem automática: com animação, a posição real fica
  atrás do texto e a própria medição interpretava isso como "saiu do fim" — o acompanhamento
  se desligava sozinho no meio da resposta.

### 4.5 Raciocínio do modelo à vista (ligado por padrão)

- O pensamento do modelo aparece na conversa enquanto ele trabalha. Numa tarefa longa é ele
  que mostra que tem alguém ali dentro.
- Existe um interruptor em **Ajustes → Preferências → "Mostrar raciocínio do modelo"**, para
  quem preferir a conversa mais limpa. **Não** é o padrão.
- *Correção de rota:* numa primeira passada esse raciocínio tinha sido escondido por padrão.
  Foi revertido — esconder estava errado, e a documentação (README, changelog, tela de ajustes)
  foi corrigida junto.

### 4.6 Ferramentas em uma linha (e o raciocínio desacoplado)

- As chamadas de ferramenta de uma resposta aparecem como **uma linha** — "2 ferramentas", com
  a **duração somada** — que abre no detalhe de cada chamada por um clique. Antes, cada passo
  virava uma linha própria e empurrava a conversa para baixo.
- **O interruptor de raciocínio não controla mais isso.** Ele controla só o pensamento; as
  ferramentas ficam sempre na forma resumida, com o detalhe a um clique. Amarrar as duas
  coisas faria ligar o pensamento empurrar a conversa de novo.

### 4.7 Duração e tamanho em escala humana (`src/duracao.ts`, novo)

- `formatarDuracao(ms)`: `47 ms` → `1,4 s` → `2,7 min` → `1,2 h` → `2 d`. A régua sobe sozinha
  ao chegar em **60** da unidade anterior.
- `formatarCaracteres(n)`: `67 caracteres` / `2,4 mil caracteres`.
- Números em pt-BR, com 1 decimal abaixo de 10 e 0 acima.
- Aplicado em **quatro** lugares com uma implementação só: `ToolSteps.tsx`, `Reasoning.tsx`,
  `MessageFooter.tsx` (que tinha a própria cópia) e `WorkingLine.tsx`.
- Antes: `2725 ms`, `4833 ms` e `314s` convivendo na mesma tela.

### 4.8 Outros

- `SettingsScreen.tsx`: interruptor novo nas Preferências (raciocínio), com descrição
  explicando o que ele faz.
- `harnessChat.tsx`: cenário novo de **compactação** (as três variantes do cartão + a linha
  resumida de ferramentas) e o cenário de conversa misturada, que agora renderiza o cartão de
  tarefa não concluída nos três estados que importam (com itens pendentes, por queda de
  provedor, e no motivo que não retoma).

---

## 5. Backend

### 5.1 "Faça exatamente o que foi pedido — nada além"

O pedido é classificado **antes** do primeiro passo, e a categoria decide o catálogo:

- **`MODO_RESPOSTA`** — pergunta, resumo, explicação ou texto solto: a rodada roda **sem**
  ferramenta de arquivo, shell, web ou código. Só o anexo da conversa continua disponível
  (`FERRAMENTAS_DE_RESPOSTA = {"read_attachment"}`), porque ler o PDF que a pessoa colou faz
  parte de responder o que ela perguntou.
- **`MODO_CODIGO`** — pedido que toca no projeto (nome de arquivo, pasta, código, teste, git,
  erro…) ou que pede mudança de verdade: catálogo completo, e o trabalho é para ser feito **por
  inteiro**, validado antes de entregar.
- **Na dúvida o veredito é trabalho**, não conversa: negar ferramenta a quem pediu trabalho é
  pior do que oferecer ferramenta a quem pediu conversa (que, no máximo, responde sem usá-la).

Isso resolve o caso medido: *"teste de funcionamento responda com um ok"* fazia o agente listar
a pasta de trabalho, ler quatro arquivos e rodar `node --check` — porque "teste" está na lista
de verbos de ação.

### 5.2 Instrução negativa tira a ferramenta do catálogo **de verdade**

- "não use a web", "não use arquivos", "não use ferramenta nenhuma", "responda apenas…" —
  antes eram só uma frase no meio do pedido, e o modelo recebia o catálogo inteiro e escolhia
  `list_dir`. A resposta exibia os nomes das pastas e dos arquivos da pessoa.
- Agora a ferramenta **não é oferecida**, e o modelo é avisado no prompt de sistema do que
  **não** está disponível nesta rodada — tirar sem dizer nada faz o modelo pedir o que não
  existe, ou pior, responder como se tivesse usado.
- Cada restrição vale para o **último pedido da pessoa**, e não como regra permanente da
  conversa.

### 5.3 Tetos de saída das ferramentas (antes → depois)

| Constante | Antes | Agora | O que é |
|---|---|---|---|
| `LIMITE_SAIDA` | 12.000 | **50.000** | Caracteres que uma ferramenta devolve ao modelo |
| `LIMITE_LEITURA` | — (novo) | **100.000** | Teto de leitura de um arquivo/anexo por vez |
| `LIMITE_DE_LINHA` | — (novo) | **2.000** | Teto de **uma** linha (arquivo minificado) |
| `LIMITE_LISTAGEM` | 800 | **2.000** | Entradas de uma listagem ou busca |
| `LIMITE_SAIDA_RODANDO` | 24.000 | **200.000** | Saída guardada de um comando ainda rodando |

- `LIMITE_DE_LINHA` existe por um caso concreto: arquivo minificado é **uma linha** de
  megabytes, e sem esse teto ela comia o orçamento inteiro da leitura — o modelo recebia um
  começo de linha, sem fim e sem contexto.
- `LIMITE_LEITURA` fica **acima** do teto de saída de propósito: o arquivo é lido inteiro e o
  corte acontece num lugar só.
- Tudo isso virou **configuração** (`KODA_TOOL_OUTPUT_MAX_BYTES`, `_MAX_LINES`,
  `_MAX_LINE_LENGTH`, `KODA_FILE_READ_MAX_CHARS`) e é aplicado no backend inteiro por
  `ferramentas.definir_limites()`, chamado uma vez na subida. `tool_output_limit` (o que fica
  na tela e no histórico) subiu de **4.000 para 50.000**.

### 5.4 Latência: trabalho de disco fora do laço de eventos

- O índice de skills (`indice_para_agente`) varre `.agents/skills` do projeto e da máquina e
  lê o `SKILL.md` de cada uma. Chamada direta, ela **segurava o laço de eventos antes de o
  pedido ao modelo sair**, e o atraso aparecia inteiro na espera do primeiro passo.
- Agora roda em thread (`await call(...)`). Medido: **~34 ms por mensagem**, chegando a
  **~62 ms** com a listagem de skills cheia.

### 5.5 Cancelamento cooperativo entre threads

- O `cancelamento` virou `threading.Event` compartilhado, e as ferramentas o enxergam por
  `ContextVar` (`_CANCELAMENTO_DA_FERRAMENTA`), junto com o prazo restante da tarefa
  (`_PRAZO_DA_FERRAMENTA`).
- Cada tarefa tem um id (`dono`): o botão Parar derruba **só os processos daquela tarefa**
  (`ferramentas.encerrar_do_dono`), e não os de outras conversas.
- Chamadas HTTP das ferramentas herdam o prazo restante (`_timeout_httpx`), em vez de terem um
  timeout próprio desconectado do tempo que ainda resta.

### 5.6 O rascunho do modelo em português

- O prompt de sistema agora exige que o **raciocínio** seja em português do Brasil, não só a
  resposta: *"o rascunho antes da resposta aparece na tela de quem está acompanhando, e
  rascunho em inglês no meio de uma conversa em português é vazamento de bastidor, não
  conteúdo."*
- Regra correspondente no prompt de ferramentas (pensar em pt-BR).
- O bloco "**Faça exatamente o que foi pedido — nada além**" entrou no `PROMPT_FERRAMENTAS`.

### 5.7 A imagem do anexo chega ao modelo (visão de verdade)

**O defeito:** todo anexo era tratado como texto. O turno do usuário levava só o bloco
`[anexos desta mensagem]` com nome/tipo/tamanho, e a `read_attachment` respondia "o conteúdo
é uma imagem — não há texto para ler aqui". Resultado: **nenhum** modelo enxergava imagem,
inclusive os que enxergam (`liz-4`, `liz-3-flash`, `koda-1`, `layze-2`).

**A correção:** o `content` do turno do usuário vira lista de partes
(`{type: text}` + `{type: image_url}` com data URL base64), que é o formato de visão da API
OpenAI. Sem imagem, o `content` continua string — o caminho antigo não mudou.

| Peça | Onde | O que faz |
|---|---|---|
| `ChatTurn.imagens` | `providers/base.py` | Imagens que viajam **junto** do turno (data URLs) |
| `conteudo_do_turno` | `providers/openai_compat.py` | Monta `content` string ou lista de partes |
| `_turns(…, store, visao)` | `routers/chat.py` | Lê a imagem do store pelo id e monta as data URLs |
| `_visao_ativa` | `routers/chat.py` | O modelo enxerga **e** a mensagem trouxe imagem? |
| `data_url` / `cabe_inline` | `anexos.py` | Data URL base64 e o teto de 5 MB do corpo |
| `aceita_imagem` | `config.py` | Resolve alias e confere a lista de modelos com visão |

- Os **dois** caminhos usam isso: o de texto (via `_messages`) e o do agente (via
  `conteudo_do_turno` na lista `mensagens` do loop).
- **Quem enxerga imagem é configuração**, não adivinhação: o host **não publica** a
  capacidade em `/v1/models` (só `efforts` e `reasoningFloor` — conferido no payload e no
  binário). A lista vive em `KODA_HOST_VISAO`, padrão `liz-4,liz-3-flash,koda-1,layze-2`.
  Modelo fora dela recebe o anexo pelos metadados, como antes: o pedido não é recusado.
- **Teto de 5 MB** (`anexos.MAX_IMAGEM_INLINE`). Acima dele a imagem fica só no store e o
  bloco diz o que é, em vez de o pedido inteiro falhar.

**A armadilha que a mudança criou, e foi corrigida junto.** Com `content` em lista, tudo que
fazia `str(mensagem["content"])` passaria a enxergar o `repr` **com o base64 dentro**:

- `contexto.py` — `texto_do_conteudo()` e `_reduzir()` (encolhe só o texto e **preserva** a
  imagem); `tokens_de_mensagem` conta imagem por resolução (`TOKENS_POR_IMAGEM = 1500`), não
  pelo tamanho do base64; `_com_texto` usa `dataclasses.replace` para não perder `imagens`.
- `tools/loop.py` — `pedido_do_usuario` (senão o pedido parecia gigante só pelo base64 e o
  agente exigia um plano que ninguém pediu).
- `providers/openai_compat.py` — `_texto_do_usuario` (filtro de identidade).

**Colar imagem.** `Composer.tsx`: o `addFiles` virou casca de `subirArquivos(File[])` e o
`<textarea>` ganhou `onPaste` — Ctrl+V sobe os arquivos da área de transferência pelo mesmo
caminho do «+». `preventDefault` só quando há arquivo: colar texto continua colando texto.

### 5.8 A porta do host deixou de ser fixa (o defeito que só aparecia no PC dos outros)

**O sintoma:** "backend: no ar em 127.0.0.1:49779 · host: fora do ar em 127.0.0.1:21128" —
e isso "rola muito em outros PC", porque a 21128 é uma porta que qualquer programa pode
estar usando. Três defeitos se somavam, e o terceiro é o grave:

1. **A porta era constante.** `PORTA_HOST = 21128` no Rust, e o backend com um literal
   compilado (`127.0.0.1:21128/v1` em `config.py`).
2. **Ninguém amarrava os dois lados.** O launcher não passava `KODA_HOST_URL` ao backend. O
   gancho `KODA_HOST_PORT` movia só o host — o comentário no `main.rs` admitia: "com a
   variável ligada é só o ciclo de vida que faz sentido".
3. **Vazamento de credencial.** Se a porta estivesse ocupada e o dono **não** fosse
   `c-host.exe`, o `liberar_porta` devolvia `false` e o `iniciar_host` caía no ramo que loga
   *"host já está no ar — reutilizando"* e retorna **true**. O app passava a conversar com o
   programa alheio — e o `HostProvider.headers()` manda
   `Authorization: Bearer <sessão da conta>` em cada pedido. A `diagnostico.rs` só olhava
   `porta_no_ar`, então podia dizer "no ar" com um estranho escutando.

**A correção, no launcher (`src-tauri/src/`):**

| Peça | Antes | Agora |
|---|---|---|
| Porta do host | `PORTA_HOST` fixa | sorteada no instalado, 21128 em dev |
| Fonte de verdade | `Papel::porta()` + `Acesso` | só `Acesso` (`porta` e `porta_host`) |
| Ligação com o backend | nenhuma | `KODA_HOST_URL` passado pelo launcher |
| Porta ocupada por estranho | reutilizava (e vazava o token) | não fala, não mata: sorteia outra |
| Diagnóstico | imprimia 21128 | imprime a porta real da execução |

- `acesso::escolher_portas(empacotado) -> (api, host)`; a segunda porta é sorteada
  **excluindo a primeira** — `porta_livre` abre e fecha o soquete na hora, então duas
  chamadas seguidas podiam devolver o mesmo número e os dois serviços brigariam por ele.
- `liberar_porta` deixou de ser `bool` e virou o enum `Porta { Livre, OutraJanela,
  Estranha(motivo) }`: o `false` antigo misturava *"é de outra janela do Koda, reutilize"*
  com *"tem um programa estranho aqui"*, e era essa confusão que produzia o vazamento.
- No dev a 21128 continua sendo a porta, e se estiver ocupada por outro programa o app
  **falha com o motivo no log** em vez de subir por cima do que é do desenvolvedor.

**O host não mudou.** Ele já aceita `-port` desde sempre (`go/main.go:32`; medido:
`c-host.exe -port 21999` sobe e responde). O `koda/host/c-host.exe` é byte a byte o build do
`zyro/open` (mesmo sha256). Por isso esta correção **não** exigiu rebuildar o host — e, de
quebra, o host de produção que o dono sobe à mão na 21128 não é mais derrubado quando o app
abre (antes era: um `c-host.exe` naquela porta caía como "sobra de execução anterior" e era
encerrado).

**Um preço assumido:** duas janelas do Koda abertas ao mesmo tempo passam a ter **dois**
hosts (um por janela), em vez de a segunda reutilizar o da primeira. É um processo a mais; a
alternativa seria um arquivo de descoberta com pid+porta na pasta de dados, que é maquinaria
nova para um caso raro.

**Verificação:** `cargo test` → 30 testes, incluindo
`as_duas_portas_do_instalado_sao_livres_e_diferentes` e `o_dev_fica_nas_portas_fixas`. E o
outro lado da amarração, medido: `KODA_HOST_URL=http://127.0.0.1:49731/v1` → o `Settings` do
backend responde `host_url = http://127.0.0.1:49731/v1`.

### 5.9 O antivírus apagava o `c-host.exe` (o defeito que só aparecia no PC dos outros, 2)

**O sintoma:** num PC de cliente, o log do app mostrava

```
falha ao iniciar o host: … o arquivo contém um vírus ou software possivelmente indesejado. (os error 225)
c-host.exe ausente
```

`os error 225` é `ERROR_VIRUS_INFECTED`: o Windows Defender recusou **executar** o binário e,
em seguida, **apagou o arquivo**. Depois disso não há o que reerguer — o log passa a repetir
"c-host.exe ausente" para sempre e o Koda fica sem os modelos oficiais. Reinstalar não
resolvia: o antivírus apagava de novo na primeira execução.

**Por que acontece:** o `c-host.exe` é compilado com ofuscação (`garble -literals -tiny`) e
**não tem assinatura digital**. Binário ofuscado e sem assinatura é o retrato falado que a
heurística do Defender procura.

**O que mudou (só no koda):**

- `src-tauri/installer/hooks.nsh` — o `NSIS_HOOK_POSTINSTALL` passa a rodar
  `Add-MpPreference -ExclusionPath '$INSTDIR\host'` via `ExecShellWait "runas"`: o instalador
  **pede ao Windows, uma vez, para não verificar a pasta do host** — o mesmo que a tela do
  Defender oferece em Exclusões. Exclui a pasta `host` (que só tem o binário) para a exclusão
  sobreviver a uma troca de nome.
- Exige administrador, então aparece **um UAC** na instalação. Recusou? A instalação segue e
  o host continua sujeito ao antivírus — o app diz no log o que houve.
- **Instalação silenciosa pula o passo** (`/S` é o caminho da atualização automática, e o UAC
  não pode aparecer no meio dela). Quem instalou olhando a tela já tem a exclusão.
- `src-tauri/src/main.rs` — `antivirus_bloqueou()` (erros 225 e 1260) e `aviso_de_antivirus()`:
  o log passa a dizer **o ANTIVÍRUS bloqueou o host**, com o caminho das Exclusões, em vez da
  frase crua do Windows. A mensagem de arquivo ausente também aponta o antivírus.

**O que isto resolve:** reinstalar o instalador novo no PC afetado regrava o `c-host.exe` (que
o Defender apagou) **e** cria a exclusão antes da primeira execução.

**O que continua pendente:** assinar o binário do host com um certificado de código. A
exclusão resolve o caso; a assinatura resolve a causa — e é a única coisa que dispensa o UAC.
Também não foi possível validar a exclusão nesta máquina de desenvolvimento: o Defender não
responde aqui (`Add-MpPreference` devolve `Provider load failure`), e em PC com **Tamper
Protection** ligada o Windows pode recusar a exclusão vinda de script.

---

## 6. Configuração e documentação

- **`backend/.env.example`**: 32 linhas novas, com os tetos de saída e os prazos do `shell`
  explicados um a um.
- **`backend/README.md`**: 228 linhas reescritas. Seções novas, entre outras: *"Faça exatamente
  o que foi pedido — nada além"* e *"Latência: o que pesa em cada passo"*. Tabela de variáveis
  atualizada com os quatro tetos novos.
- **`README.md`** (raiz): bullets atualizados para o cartão de compactação, o rascunho do
  modelo à vista, o tempo em escala humana e o "exatamente o que foi pedido".
- **`CHANGELOG.md`** (novo): entrada completa da 0.5.1.
- **`MUDANCAS-0.5.1.md`**: este documento.

---

## 7. Removido e limpeza

### 7.1 A pasta `server/` saiu do repositório

- **75 arquivos**, ~13.000 linhas: painel/backend de nuvem de uma fase anterior do produto
  (controllers, services, views, migrations SQL, um worker Cloudflare).
- Não faz parte do app que este repositório constrói e ficou parada enquanto o resto andou.
- Removida com `git rm -r --cached`: **a cópia local foi preservada no disco**, e a pasta
  entrou no `.gitignore` com o motivo escrito — para não voltar por acidente num `git add -A`.
- Recuperável no histórico do Git, íntegra.

### 7.2 Maquinaria morta removida do loop

`portao_de_parada()`, `MAX_FORCADAS`, `FORCAVEIS`, `escolha_forcada()`, `catalogo_de_leitura()`
e `funcao_do_anuncio()` — todo o caminho que forçava ferramenta com `tool_choice`.

### 7.3 Identificadores da origem limpados dos comentários

O repositório é **público**. Numa passada de limpeza, os comentários que citavam caminhos e
símbolos internos do projeto de referência foram reescritos para explicar a **decisão** sem
depender do código de lá. O que saiu, sem citar os nomes:

- a variável de ambiente que ligava a conferência ao parar;
- os caminhos internos `agent/…` e `gateway/…` citados nos comentários;
- o nome do portão de conferência e o da configuração de teto de turno;
- os nomes da tabela de motivos e do aviso de falha;
- as chaves de configuração dos tetos de saída das ferramentas.

Arquivos tocados: `loop.py`, `ferramentas.py`, `config.py`, `.env.example`,
`backend/README.md`. Verificado depois: **zero** ocorrências no repositório inteiro.

### 7.4 `.gitignore`

- `server/` (com o motivo em comentário).
- `backend/tmp*/` — diretório temporário que a suíte cria no CWD quando o pytest roda de
  `backend/`; ele estava aparecendo como sujeira e entrando no lint.

---

## 8. Versão e artefato

- **Versão 0.5.1 em 6 lugares**: `package.json`, `package-lock.json` (2 entradas),
  `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` (só o pacote
  `koda` — os outros `0.5.x` do lock são de crates de terceiros), `backend/app/__init__.py`.
- **Instalador**: `src-tauri/target/release/bundle/nsis/Koda_0.5.1_x64-setup.exe`, ~24,8 MB.
- **O `host/c-host.exe` vai dentro do instalador** (`tauri.conf.json` → `resources`:
  `"../host/c-host.exe": "host/c-host.exe"`). O `npm run app:bundle:host` confere no fim do
  build que o script NSIS inclui a linha `File /a "/oname=host\c-host.exe"` e que o lançador
  corrige TEMP/TMP. Sem essa conferência o build falha — não sai instalador sem o host.

---

## 9. Verificação

- `npm run verificar` = `tsc -b` + `oxlint` + a suíte do backend.
- **337 testes passando**, TypeScript sem erros, lint sem erros.
- Testes novos deste ciclo:
  - `test_retomar_nao_cria_bolha_de_usuario` — retoma e confere no banco que **não** existe
    turno novo de usuário, e que nenhuma fala é "continue".
  - `test_retomar_sem_conversa_recusa_com_erro_claro` — `400` antes do stream começar.
  - `test_retomada_pelo_botao_nao_entra_na_regua_do_pedido` — a retomada não muda a categoria
    nem tira o catálogo.
  - `test_agente_sem_teto_de_chamadas_de_ferramenta_por_padrao` — sem teto por padrão, e teto
    explícito continua valendo.
- Testes atualizados por mudança de comportamento (o comportamento antigo era o defeito):
  anúncio insistente, recusa por tamanho, erro transitório de provedor, e a tarefa que estoura
  o orçamento avisando a tela de forma estruturada.

> **A pasta `backend/tests/` continua fora do versionamento**, por decisão do projeto (está no
> `.gitignore`, com o comentário *"o repositório é de leitura, não leva teste"*). Os 337 testes
> rodam local e **não** vão no commit.

---

## 10. O que **não** entrou (de propósito ou pendente)

- **Recuperação durável entre reinícios.** O plano é um marcador persistido de tarefa em
  andamento, limpeza por *compare-and-swap* e promoção para retomada na subida do app — para
  uma tarefa morta por queda do app voltar sozinha. Hoje a retomada depende da conversa estar
  gravada e de a pessoa clicar em Retomar. **Pendente.**
- **Escada de auto-recuperação do provedor.** Hoje o reenvio é 5 tentativas com espera
  crescente de base 3 s e teto de 10 s (~38 s no total). O desenho mais generoso (esperas de
  15/30/60 s com jitter e respeito ao `Retry-After` do provedor, ~4 min de insistência) **não
  foi portado**. Pendente.
- **Tetos de persistência ainda existem.** Eles são generosos e se renovam a cada trabalho
  novo, mas continuam sendo um teto: um modelo que passe 10 vezes seguidas anunciando sem
  executar nada acaba tendo a rodada fechada. Isso é intencional (é o guarda contra o laço
  infinito medido), mas é uma escolha, não uma ausência de limite.
- **O exe instalador contém a pasta de código vendorizado** (~8 MB de referência que não é
  importada por nenhum módulo). O `gerar-runtime-backend.mjs` copia `backend/app` inteiro, sem
  filtro. Otimizável.

---

## 11. Resumo dos arquivos tocados

**Backend** — `tools/loop.py` (1.624 linhas), `tools/ferramentas.py` (320),
`routers/chat.py` (81), `config.py` (45), `providers/openai_compat.py` (14),
`schemas.py` (16), `providers/base.py` (7), `main.py` (5), `contexto.py` (2),
`__init__.py` (versão), `.env.example` (32), `README.md` (228).

**Visão no anexo (item 5.7)** — `anexos.py`, `config.py`, `contexto.py`,
`providers/base.py`, `providers/openai_compat.py`, `providers/__init__.py`,
`routers/chat.py`, `tools/ferramentas.py`, `tools/loop.py`.

**Launcher (item 5.8)** — `src-tauri/src/acesso.rs` (as duas portas),
`src-tauri/src/servicos.rs` (saiu `Papel::porta()`), `src-tauri/src/main.rs` (enum `Porta`,
`iniciar_host`, `KODA_HOST_URL`), `src-tauri/src/diagnostico.rs` (porta real).
**O host não foi tocado.**

**Frontend** — `App.tsx` (291), `components/ToolSteps.tsx` (155),
`components/TarefaIncompleta.tsx` (124), `components/Compactacao.tsx` (124, novo),
`compactacao.ts` (122, novo), `harnessChat.tsx` (64), `duracao.ts` (59, novo),
`index.css` (34), `api/client.ts` (21), `components/SettingsScreen.tsx` (16),
`components/MessageFooter.tsx` (5), `components/WorkingLine.tsx` (3),
`components/Reasoning.tsx` (3), `components/Composer.tsx` (colar imagem).

**Raiz e empacotamento** — `CHANGELOG.md` (novo), `MUDANCAS-0.5.1.md` (novo), `README.md`,
`.gitignore`, `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`,
`src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`.

**Removidos** — `server/` (75 arquivos).
