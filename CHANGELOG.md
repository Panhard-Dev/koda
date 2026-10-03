# Changelog

Todas as mudanças relevantes do Koda. O formato segue o de *Keep a Changelog*, e a
numeração é a do `package.json` (que também é a do instalador).

## [0.6.0] — 2026-10-03

### A restrição passou a ser imposta, e o pacote deixou de carregar o que não usa

O relatório de QA (`relatorio_qa_koda_v2.md`) mostrou que a proibição de usar ferramenta
era **um pedido, não uma regra**: o catálogo enviado ao modelo era a única barreira, e o
modelo que chamasse assim mesmo era executado — devolvendo o conteúdo da máquina. Esta
versão fecha isso e os outros achados do relatório.

- **Porteira do despacho** (`app/tools/guardas.py`): o catálogo da rodada virou também a
  whitelist do despacho, consultada **antes** de a ferramenta tocar o sistema, com recusa
  que vira o resultado e **falha fechada**. Antes: 34 ferramentas oferecidas e a chamada
  devolvendo o ambiente da máquina. Depois: 2 oferecidas e a chamada negada.
- **Raciocínio fora da resposta** (`app/tools/pensamento.py`), inclusive partido entre
  pedaços do streaming.
- **Resposta duplicada** (`app/tools/repeticao.py`): o eco corta a rodada em vez de ser
  costurado na resposta.
- **Interface presa**: o evento terminal passou a sair também no caminho de erro, e o
  cliente desbloqueia quando o fluxo fecha sem terminal.
- **Resposta meta**: regra explícita no prompt — o estado interno do agente não é assunto
  da resposta.
- **Saída longa**: corte com cabeça **e cauda** (`app/tools/limites_de_saida.py`) no lugar
  do corte só de cabeça, que jogava fora o fim (onde está o erro do teste).
- **Microfone**: verificado e travado por teste — o áudio só nasce no clique do botão.
- **Falso "tarefa não concluída"**: o detector de anúncio parou de ler fechamento como
  anúncio — pedido à pessoa (antes ou depois da marca) e espera ("aguardo") não são
  trabalho pendente do agente.
- **Pacote limpo**: `app/tools/` saiu de **325 arquivos** para **7** e `app/` de **10 MB**
  para **1,2 MB**; o runtime do instalador de **74 MB** para **64 MB** (o pytest e a turma
  dele não vão mais no instalador). O material de referência fica em
  `backend/material-referencia/`, fora do pacote e do repositório.

Detalhe parte por parte: `RELEASE-0.6.0.md`.

## [0.5.2] — 2026-10-02

### Skills e MCPs cadastráveis pela tela, e o agente usando as skills

- **Botão "Adicionar Skill"** na seção Skills, ao lado da lista. Pede nome, descrição e
  comando/ação; os três são obrigatórios e a validação é da tela **e** da rota. O que é
  cadastrado aparece na mesma lista, marcado como `Cadastrada`, e o liga/desliga funciona
  igual ao das skills instaladas.
- **Botão "Adicionar MCP"** na seção MCPs, com o mesmo desenho: nome e comando/endpoint
  obrigatórios, parâmetros opcionais. O servidor entra na lista com o comando à mostra.
- **O agente passou a usar as skills de verdade.** As cadastradas entram no prompt com as
  instruções **inteiras** (não são pasta em disco, então o `read_file` não alcança); as do
  projeto entram por nome e caminho, com a ordem de ler o `SKILL.md` antes de usar; as da
  máquina entram por nome e descrição, para o agente não negar que existem. Antes, só as do
  projeto entravam — e o agente respondia "não tenho nenhuma skill instalada" com skills
  instaladas na tela.
- **O índice de skills do prompt passou a usar a pasta da conversa.** Ele usava o workspace
  padrão do servidor, então a skill do projeto sumia do prompt quando a conversa abria em
  outra pasta.
- **Correção do frontmatter em bloco.** Skill com `description: >-` (descrição em várias
  linhas) chegava ao agente como o marcador cru `>-`; agora o bloco é resolvido e a
  descrição chega inteira.
- **Cadastro recusa nome repetido** (409) em vez de sobrescrever em silêncio, e recusa
  campo obrigatório vazio (422) na própria rota — não só na tela.

### Menu de comandos do "/" no prompt box

- **O menu virou menu.** Ele era decorativo por construção — uma lista fixa de `<div>`, sem
  clique, sem setas e sem filtro, com o Enter mandando a mensagem em vez de escolher o
  comando. Agora: ↑↓ anda pela lista (com a volta ao começo), Enter e Tab completam, o clique
  completa, Esc fecha sem apagar o que foi digitado, o que se digita filtra (nome **e**
  descrição) e o item sob o cursor é trazido para dentro da área visível.
- **O menu completa o comando; quem escreve a mensagem é você.** Escolher `/plan` deixa
  `/plan ` na caixa e o cursor depois dele — **nada é enviado**, e nenhum texto pronto é
  escrito no seu lugar. O que sai é exatamente o que estiver na caixa, do jeito que você
  escreveu.
- **Só ficaram os comandos que o Koda executa.** `/goal`, `/workflow` e `/compact` saíram:
  o Koda não tem objetivo de sessão, não tem workflow, e a compactação dele é recalculada a
  cada pedido a partir do histórico guardado — os três apareceriam no menu sem fazer nada.
  Ficaram `/init` (criar ou atualizar o `AGENTS.md` do projeto) e `/plan` (planejar antes de
  executar).
- **Corretor ortográfico desligado na caixa de mensagem.** O WebView2 marcava `/pla` como
  erro de escrita, e o risco vermelho por baixo do texto parecia a caixa com cor errada.

## [0.5.1] — 2026-10-01

### Agente: a tarefa longa vai até o fim

- **Sem teto de passos nem de chamadas de ferramenta.** `max_steps` e `max_tool_calls` agora
  são `0` (sem teto) por padrão. Teto fixo truncava tarefa grande no meio, em silêncio, e
  100 passos não é "tarefa grande": montar um projeto, refatorar um módulo ou rodar uma
  bateria de testes passa disso no meio de trabalho legítimo. Quem segura um laço sem fim é
  o botão de parar, o teto de tempo da tarefa e os guardas de progresso abaixo.
- **Os limites que sobraram são de persistência, não de trabalho.** Cada contador do loop
  (retomada de anúncio, retomada de plano, cobrança de execução, narração) é **renovado a
  cada trabalho novo**. Enquanto o modelo produz, ele nunca esbarra em teto; quem esbarra é
  quem para de agir e só repete intenção — e aí a rodada fecha com o estado guardado, para
  ser retomada.
- **Correção do anúncio que encerrava a tarefa.** A retomada de anúncio estava condicionada a
  já ter ocorrido trabalho ou a ser uma tarefa de ação — o que deixava passar exatamente o
  caso mais comum: o **primeiro** anúncio, de um modelo que ainda não executou nada. Agora o
  anúncio não passa por trabalho feito em qualquer rodada de trabalho.
- **Contrato estruturado de parada.** O loop deixou de escrever frase de fechamento na
  resposta. Ele conclui com um **código** — `pending_steps`, `announced_only`, `time_limit`,
  `tool_limit`, `step_limit`, `repeated_tool`, `empty_response`, `provider_error`,
  `context_overflow`, `interrupted` — mais os itens pendentes, quantas ferramentas rodaram e
  se dá para retomar. O `done` do stream carrega `reason`, `pending_items`, `executed` e
  `resumable`.
- **A resposta é do modelo, não do produto.** Saíram da conversa as frases que pediam a
  palavra mágica ("me diga *continue* que eu sigo") e as que descreviam o que aconteceu no
  disco. Quando a rodada morre sem o modelo escrever um fechamento, o aviso é o de falha:
  *"este pedido não foi processado até o fim"* quando nada rodou, e *"esta rodada não foi
  concluída — parte das ações já pode ter sido executada, confira os efeitos"* quando rodou.
  Nunca afirmar que nada foi executado depois de a pessoa ver as ferramentas rodando.
- **Recusa por tamanho é o único motivo que não retoma.** O mesmo pedido não cabe depois;
  os outros códigos valem retomada.
- **Conferência ao parar (opt-in, desligada).** Mecanismo de *verify-on-stop*: depois de
  alterar código, o loop pode cobrar a conferência (teste, build, linter) antes de encerrar.
  Fica desligado por padrão — com ele ligado, o agente voltava a mexer no código que a pessoa
  não pediu de novo, só para "provar" que a mudança funciona. Mexer só em prosa (README,
  changelog) nunca pede conferência.

### Retomar deixou de ser uma mensagem falsa

- O botão Retomar mandava `text: "continue"` e isso virava uma **bolha de pessoa** na
  conversa: a tela mostrava o próprio usuário pedindo a palavra mágica. Agora existe
  `resume` no corpo da requisição: o backend continua do histórico que já existe, o turno
  interno não é gravado e o App não desenha bolha nenhuma.
- O turno interno de retomada fica fora da régua que classifica o pedido, então a retomada
  não muda a categoria da tarefa nem tira o catálogo de ferramentas.
- Retomar sem conversa devolve `400` com motivo, antes de o stream começar.

### Interface

- **Cartão de tarefa não concluída.** No fim de uma rodada que não fechou, a resposta agora
  termina com um cartão — "Tarefa não concluída" — cuja cópia muda conforme o **motivo**, que
  lista os itens pendentes com as palavras que o próprio agente registrou, avisa quando parte
  do trabalho já está no disco e traz o botão **Retomar**. O botão só aparece quando retomar
  faz sentido.
- **Cartão de compactação.** Quando o histórico é resumido, o aviso deixou de ser um
  parêntese em itálico no meio do texto e passou a ser um cartão próprio, no ponto exato da
  resposta onde a compactação aconteceu, com o motivo e o número de mensagens (ou a variação
  de tokens).
- **Raciocínio do modelo à vista.** O pensamento do modelo aparece na conversa enquanto ele
  trabalha — é ele que mostra que tem alguém ali dentro numa tarefa longa. Quem preferir a
  conversa mais limpa desliga em *Ajustes → Preferências*.
- **Ferramentas em uma linha.** As chamadas de ferramenta de uma resposta aparecem como
  **uma linha** ("3 ferramentas", com a duração somada) que abre no detalhe ao clicar, em
  vez de um passo por linha empurrando a conversa para baixo.
- **A linha "Trabalhando..." fica visível o tempo todo.** Enquanto a resposta está viva ela
  aparece embaixo do que já chegou — inclusive embaixo do passo da ferramenta —, e não só
  quando a tela ficava 800 ms em silêncio. Antes, o passo da ferramenta aparecia sozinho e
  parecia que a tarefa tinha parado ali.
- **A rolagem não puxa mais a pessoa para baixo.** A conversa só acompanha o fim quando quem
  está lendo já está no fim: subir para reler uma resposta antiga desliga o acompanhamento, e
  voltar ao fim liga de novo.
- **Duração e tamanho legíveis.** Os carimbos passaram de `2725 ms` / `314s` / `67 caracteres`
  para uma escala humana: `47 ms` → `1,4 s` → `2,7 min` → `1,2 h` → `2 d`, e
  `2,4 mil caracteres`. O corte acontece no 60 da unidade anterior.

### Backend

- **"Faça exatamente o que foi pedido — nada além".** O pedido é classificado **antes** do
  primeiro passo: pergunta, resumo, explicação ou texto solto roda como rodada de resposta,
  sem catálogo de arquivo, shell, web ou código (só o anexo da conversa continua disponível);
  pedido que toca no projeto roda com o catálogo completo e é para ser feito por inteiro,
  validado antes de entregar. Instrução negativa explícita ("não use a web", "não use
  arquivos", "responda apenas…") tira a ferramenta do catálogo de verdade, em vez de virar
  uma frase que o modelo pode ignorar. Na dúvida o veredito é trabalho, não conversa.
- **Tetos de saída das ferramentas** passaram a valer no backend inteiro por configuração:
  saída de ferramenta (50 mil caracteres), linhas de listagem ou busca (2 mil), linha única
  na leitura (2 mil) e leitura de arquivo (100 mil). Arquivo minificado não come mais o
  orçamento da leitura em uma única linha.
- **Menos latência por mensagem.** O índice de skills saiu do laço de eventos (media ~34 ms
  por mensagem, ~62 ms quando a listagem de skills estava cheia).
- **Nota de compactação sem duplicação** no caminho de texto.

### Instalador: o antivírus não apaga mais o serviço de modelos

- **O sintoma, num PC de cliente:** o `c-host.exe` era executado, o Windows Defender
  respondia `ERROR_VIRUS_INFECTED` (`os error 225`) e **apagava o arquivo**. A partir daí o
  log do app virava `c-host.exe ausente` em laço, e o Koda ficava sem os modelos oficiais
  para sempre — reinstalar só fazia o antivírus comer o arquivo de novo.
- **O que o instalador passou a fazer:** pede ao Windows, **uma vez**, para não verificar a
  pasta `host` (`Add-MpPreference -ExclusionPath`), do mesmo jeito que a tela do Defender
  oferece. É a única forma de o app impedir a remoção sem mexer no binário do host, que é
  ofuscado e não tem assinatura digital — o que dispara a heurística.
- Exclusão no Defender exige administrador: aparece **um UAC** durante a instalação. Recusou?
  A instalação segue; o host fica sujeito ao antivírus, como antes.
- **Instalação silenciosa (`/S`, o caminho da atualização automática) pula o passo**, para o
  UAC não travar o updater.
- **O log do app passou a dizer o que aconteceu**: `o ANTIVÍRUS bloqueou o host: o Windows
  recusou executar … e costuma removê-lo em seguida (ERROR_VIRUS_INFECTED)` com o caminho das
  Exclusões — em vez do texto cru do Windows. A mensagem de arquivo ausente também aponta o
  antivírus.
- **Correção definitiva, ainda pendente:** assinar o binário do host. A exclusão resolve o
  caso; a assinatura resolve a causa.

### Launcher: a porta do host deixou de ser fixa

- **A 21128 era uma aposta, e ela se perdia em campo.** Numa máquina onde outro programa já
  ocupa essa porta, o app não subia o host — e o sintoma era "host: fora do ar" com o
  backend atendendo normalmente. Pior: quando havia alguém ouvindo lá, o ramo de reuso
  tratava o estranho como "host já está no ar — reutilizando", e o backend mandava
  `Authorization: Bearer <sessão da conta>` para ele a cada conversa. Endereço fixo na
  máquina de outra pessoa não é endereço.
- **No app instalado as duas portas passam a ser sorteadas** na abertura (a do backend e a
  do host), como já era a da API. O launcher passa `-port <sorteada>` ao host e
  `KODA_HOST_URL` ao backend — é essa variável que amarra os dois lados, e sem ela o app
  subiria o host numa porta e conversaria com outra. O host **não** mudou: ele aceita
  `-port` desde sempre (o default dele é que era o problema).
- **Em dev nada muda**: 8787 e 21128 continuam sendo as portas, que é o que o Vite, o
  `backend/.env` e os `probe_*.py` esperam.
- **Um estranho na porta não é mais tocado nem consultado.** O `liberar_porta` deixou de ser
  um `bool` que misturava "outra janela do Koda" com "programa alheio": só outra janela é
  reutilizada; sobra de execução morta sai da frente; o resto faz o app sortear outra porta
  (instalado) ou desistir com o motivo no log (dev).
- **O diagnóstico mostra a porta real** do host e do backend nesta execução, em vez de
  imprimir 21128 num app que está noutra porta.

### Anexos: a imagem chega ao modelo de verdade

- **Imagem anexada virou visão, não etiqueta.** Até aqui todo anexo era tratado como texto: o
  turno do usuário levava só o bloco de metadados e a `read_attachment` respondia "não há
  texto para ler aqui". Um modelo que enxerga imagem ficava cego. Agora o `content` do turno
  vira lista de partes (`text` + `image_url` com data URL base64) quando o modelo escolhido
  enxerga imagem — nos **dois** caminhos (texto e agente). Sem imagem, o `content` continua
  sendo uma string: o caminho antigo não mudou.
- **Quem enxerga imagem.** O host não publica essa capacidade em `/v1/models` (só `efforts` e
  `reasoningFloor`), então a lista é configuração: `KODA_HOST_VISAO`, padrão
  `liz-4,liz-3-flash,koda-1,layze-2`. Modelo fora da lista recebe o anexo pelos metadados,
  como antes — o pedido não é recusado.
- **Teto de 5 MB por imagem** no corpo do pedido. Acima disso a imagem fica só no store e o
  bloco de anexos diz o que é, em vez de o pedido inteiro falhar.
- **Colar imagem (Ctrl+V) funciona.** O `textarea` só aceitava texto: colar uma captura de
  tela não fazia nada. Agora sobe pelo mesmo caminho do «+».
- **A compactação de contexto preserva a imagem.** Com o `content` em lista, o corte de
  histórico trocava a lista por uma string cortada — apagando a imagem e deixando o `repr`
  com o base64 como fala do usuário. Corrigido, junto com o cálculo de tokens (imagem conta
  por resolução, não pelo tamanho do base64) e a leitura do pedido na régua de categoria.

### Removido

- **A pasta `server/`** saiu do repositório. Ela é o painel/backend de nuvem de uma fase
  anterior do produto, não faz parte do app que este repositório constrói, e ficou parada
  enquanto o resto andou. Continua recuperável no histórico do Git caso precise voltar.

### Notas

- A pasta `backend/tests/` continua fora do versionamento, por decisão do projeto. A suíte
  (337 testes) roda localmente com `npm run verificar` e não vai no commit.
- `backend/app/tools/` contém uma pasta de **código de terceiros, vendorizado** (licença MIT,
  texto e titular em `LICENSE.koda`, origem e regra de uso em `NOTICE.md`). Ela é referência
  de implementação: não é importada por nenhum módulo do Koda e não roda aqui, porque depende
  de um runtime que não existe neste projeto.
