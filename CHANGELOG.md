# Changelog

Todas as mudanças relevantes do Koda. O formato segue o de *Keep a Changelog*, e a
numeração é a do `package.json` (que também é a do instalador).

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
- **Raciocínio e passos atrás de uma preferência.** O raciocínio do modelo e a lista de
  passos das ferramentas ficam ocultos por padrão; um interruptor nas configurações os traz
  de volta. Com eles ocultos, as chamadas de ferramenta de uma resposta aparecem como **uma
  linha** ("3 ferramentas", com a duração somada) que abre no detalhe ao clicar.
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
