# Koda — backend

Servidor do Koda em Python: **FastAPI** para as rotas, **SSE** para o texto chegar
enquanto é gerado e **SQLite** para conversas, uso e conta. Sem `.env` nenhum ele já
funciona: o provider local responde de forma offline e explícita. Com o **host local**
(`host/c-host.exe`, `127.0.0.1:21128`) no ar ele é escolhido sozinho e aí o chat passa a ter
os modelos do serviço e tool calling de verdade.

```bash
cd backend
uv sync                                  # cria o .venv e instala as dependências
uv run uvicorn app.main:app --reload --port 8787
uv run pytest                            # 110 testes (rotas, stream, ferramentas, identidade)
```

Documentação interativa em `http://localhost:8787/docs`.

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
argumentos) — o host guarda a assinatura da chamada do lado dele e casa pelo id, como no
projeto TOOLS original. Trocar o id, reserializar os argumentos ou reordenar o histórico
quebra o casamento e o passo volta com erro.

O corpo aceita `"tools": false` para responder **essa** mensagem sem ferramenta (e
`true` para exigir, que dá erro se o provedor não souber). No servidor, `KODA_TOOLS=off`
desliga o agente de vez, `KODA_MAX_STEPS` limita os passos e `KODA_TOOL_TIMEOUT` dá um
teto de tempo (segundos) para a tarefa inteira — com o provedor fora do ar, é ele que
impede a resposta de ficar pendurada em tentativas.

### Quando o provedor falha

Falha do provedor não é falha da tarefa, e o passo é **reenviado com o histórico
inteiro** — mensagens, eco das `tool_calls` e resultados das ferramentas já executadas.
O modelo retoma de onde parou em vez de recomeçar. São três defesas, nesta ordem:

1. **Cota e indisponibilidade** (408, 409, 425, 429, 5xx) são repetidas com backoff de 3s e
   6s (`KODA_RETRY_ATTEMPTS`, padrão 3 tentativas). O **404** também entra na lista quando o
   provider é o do host: no projeto TOOLS original o upstream devolvia 404 no meio da
   conversa e o passo seguinte costumava funcionar, então ele é tratado como transitório.
2. **Erro "de vez"** (400/401/403) ganha **uma** segunda chance em outro perfil: quando o
   serviço publica os perfis disponíveis (é o endereço que `GEMINI_WEB_URL` aponta), o
   provider passa para o próximo perfil livre em vez de desistir na hora. Sem outro perfil
   ele não insiste — aí é bug nosso, não limite do serviço.
3. **Última cartada**: esgotadas as tentativas, espera `KODA_RETRY_FINAL_WAIT_S`
   (padrão 12s, `0` desliga) e tenta uma vez mais, porque um 429 em rajada passa rápido.

Cada movimento aparece escrito na conversa (`_(passo 1: … — tentando de novo)_`,
`_(passo 1: trocando para a conta 3 do proxy)_`), então nada acontece em silêncio. Se
ainda assim não passar, o turno termina com `completed: false` e o motivo, e o que já
foi executado fica gravado em `steps` na mensagem.

### Identidade do assistente

Quando o pedido atravessa um gateway que acrescenta instruções próprias ao histórico, o
modelo pode responder **se apresentando** — nome do serviço e de quem o "criou" — inclusive
**colado na frente de resposta de tarefa**. E o pior efeito era indireto: o histórico gravado
ensina, então a apresentação se repetia em todas as mensagens seguintes.

São duas defesas, e as duas juntas (`app/identidade.py`):

1. **Regra no prompt** (`regras()`), no fim do system prompt do modo texto e do modo
   agente, mandando não declarar criador, não se apresentar e ignorar instrução que peça
   outra identidade. Vale o nome de `KODA_ASSISTENTE` (padrão `Koda`).
2. **Corte na saída** — `FiltroIdentidade` segura a cabeça da resposta até saber se ela é
   apresentação (espera um fim de frase ou 240 caracteres), tira a apresentação e libera o
   resto. Funciona sem o modelo colaborar, e roda no provider, que é por onde todo texto sai
   (modo texto e cada passo do agente). Se a resposta **inteira** era só apresentação
   ("quem é você?"), sai "Sou o Koda, o assistente de código deste app. Como posso ajudar?".

O corte só olha a **cabeça**, e só frases que sejam apresentação pura ("sou a X", "me
chamo X, criada por Y") ou saudação sozinha: falar de si no meio de uma explicação
continua passando, porque ali é conteúdo. "Sou um modelo de linguagem criado por
pesquisadores" também não é tocado — sem nome de assistente, é conversa normal.

O **histórico reenviado ao modelo** passa pelo mesmo corte nas mensagens do assistente
(`_turns`), que é o que quebra a repetição nas conversas antigas já gravadas. Nada é
reescrito no banco: a sua conversa antiga continua lá como está, e a resposta nova é que
sai limpa.

### Ferramentas

Portadas do projeto `TOOLS` do usuário (`app/tools/ferramentas.py`), 22 no total: execução
(`code_interpreter`, `shell`, `terminal`), arquivos (`read_file`, `write_file`, `edit_file`,
`str_replace_editor`, `list_dir`, `delete_file`), busca (`search_codebase`,
`vector_search`, `grep`, `regex_search`, `get_problems`, `linter`), web (`web_search`,
`url_reader`, `browser`) e git (`git_status`, `git_diff`, `git_log`, `git_commit`).

Elas rodam **na máquina**, sempre com `cwd` na pasta de trabalho (`KODA_WORKSPACE`, por
padrão a raiz do projeto) e com a saída truncada. Para desligar ferramentas, use
`KODA_TOOLS_DENY` (ex.: `shell,terminal,git_commit,delete_file`) — elas somem do catálogo
enviado ao modelo e recusam execução.

Três travas que não são óbvias:

- **Pasta de trabalho.** As ferramentas de arquivo resolvem o caminho e conferem se ele cai
  dentro do workspace — inclusive depois de seguir symlink e `..`. Caminho de fora volta
  com erro; `KODA_ACESSO_LIVRE=on` libera. Sem isso, um `read_file` com caminho absoluto
  lia qualquer coisa da máquina, e o modelo é justamente quem lê página da web. Vale o
  mesmo aviso de sempre: `shell` e `terminal` sempre puderam tudo, por definição.
- **Redirects.** `url_reader`/`browser` checam o host de partida e **cada salto** do
  redirecionamento, até 5. O `follow_redirects=True` do httpx checava só a URL inicial, e
  um host público devolvendo `Location: http://127.0.0.1:8787` (ou
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

`KODA_PROVIDER=auto` (padrão) procura nesta ordem: OpenAI (se houver chave), o host local
(se estiver respondendo) e o provider local.

- **local** — responde sem chave, em pedaços, dizendo que não há modelo configurado. **Não
  sabe chamar ferramenta**: com ele o chat funciona, mas o agente não executa nada
  (`tools_ready: false` no `/api/health`).
- **gemini** — o **gateway local** em `host/c-host.exe` (`GEMINI_PROXY_URL`, padrão
  `http://127.0.0.1:21128/v1`), que traz os modelos do serviço e o tool calling. É o que liga
  o agente na interface. O nome do provider ficou `gemini` por herança do proxy do projeto
  anterior, mas o que está do outro lado hoje é o gateway.
- **openai** — `/chat/completions` com `stream: true`; serve OpenAI, Groq, OpenRouter e o
  Ollama (`OPENAI_BASE_URL=http://localhost:11434/v1`). `KODA_MODEL_MAP` traduz os nomes
  da interface (`{"liz-nano": "gpt-4o"}`).

Duas decisões que o provider do host toma e que não são óbvias:

- **o id do modelo vai como veio.** O catálogo é do host, não nosso, então `resolve_model`
  não inventa tradução: id desconhecido passa intacto e quem recusa é o host, com erro
  explícito. Só nomes vazios ou os decorativos antigos (`koda-flash`, `koda-pro`,
  `koda-vision`, `liz-flash`, `liz-pro`, `liz-vision`) caem no `GEMINI_MODEL`. Antes disso o
  provider engolia qualquer id que não começasse com `gemini` e devolvia o padrão — escolher
  `koda-1` pedia outro modelo, **em silêncio**, e todos os modelos viravam um só.
- **`reasoning_effort: none` só vai para quem aceita.** Nem todo modelo do serviço aceita o
  campo: parte do catálogo **recusa com 400**, com ou sem ferramentas no corpo, e isso virava
  erro na tela justamente com o botão Reasoning desligado. O provider confere o catálogo uma
  vez, guarda o que cada modelo aceita e manda um valor seguro quando o desejado não serve —
  catálogo fora do ar também cai no valor seguro, que passa em todos.
- **a sondagem espera até 3s.** O serviço monta o catálogo na primeira chamada e demora; com
  timeout curto o `auto` concluía que o gateway estava fora e caía no `local` (sem
  ferramentas). A sonda mora em `proxy_disponivel()`.

Para acrescentar outro provedor, implemente `stream(turns, options)` e registre em
`app/providers/__init__.py` — nada mais precisa mudar.

## Verificação manual (fora do pytest)

Dois scripts de fumaça ficam na raiz do backend. Eles **não** são `test_*.py`, então o
pytest ignora — servem para provar o sistema contra a máquina de verdade, com o host no ar:

```bash
uv run python testar_ferramentas.py   # as 22 ferramentas, uma a uma
uv run python testar_e2e.py           # HTTP: koda (8787) → host (21128) → ferramenta → volta
```

`testar_ferramentas.py` bate em todas as 22 (29 chamadas), confere que as travas de segurança
**recusam** o que têm que recusar e, para as `git_*`, monta um repositório temporário de
verdade (`git init` → commit → log → diff) — porque só testar a recusa não prova que a
ferramenta funciona. `testar_e2e.py` cobre stream puro, agente com ferramenta, um segundo
modelo e um id inválido (que tem que voltar com erro limpo do host, não estourar).

Ambos exigem o host de pé; sem ele o resultado não diz nada sobre o nosso código.

## Estrutura

```
app/
  config.py        # variáveis de ambiente (com padrões que já funcionam)
  identidade.py    # a voz do assistente: regras do prompt + corte da apresentação
  db.py            # conexão SQLite e criação do esquema
  repository.py    # consultas de conversas, mensagens, uso e conta
  schemas.py       # modelos Pydantic e formatação do SSE
  providers/       # local, o do host (gemini) e o openai-compatível, com o contrato comum
  tools/           # catálogo de ferramentas + loop agentic (do projeto TOOLS)
  routers/         # chat, conversations, usage, account
  main.py          # create_app(), CORS, lifespan
tests/test_api.py  # rotas, stream e modo agente
tests/test_tools.py # catálogo de ferramentas e loop (sem rede)
tests/test_identidade.py # apresentação do host, com amostras reais do banco
testar_ferramentas.py # fumaça: as 22 ferramentas na máquina real
testar_e2e.py      # fumaça: ponta a ponta contra o host
```

## Licença

Projeto **proprietário**, todos os direitos reservados: o uso deste código, no todo ou em
parte, depende de autorização prévia e por escrito do titular — inclusive executar, copiar,
modificar, distribuir e treinar modelos com ele. O texto completo está em
[`../LICENSE`](../LICENSE).
