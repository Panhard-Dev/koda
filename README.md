# Koda

Shell de interface de chat (React 19 + Vite + Tailwind 4 + lucide-react) que reproduz a
tela do Koda: header no topo, conversa centralizada, composer com Reasoning/Web, seletor
de modelo, anexos e seletor de projeto. Sem barra lateral: a tela é uma conversa só.

## Rodando

```bash
npm install
npm run dev      # front em http://localhost:5173
npm run dev:api  # backend em http://localhost:8787 (requer uv)
npm run build    # tsc -b + vite build
npm run lint     # oxlint
```

O front funciona sozinho: se a API não responder, `src/App.tsx` cai numa resposta
simulada e avisa na própria mensagem. Com o backend de pé, a sessão inteira passa a vir
dele — histórico, cotas de uso e conta. O endereço da API é
`VITE_API_URL` (padrão `http://localhost:8787`), usado por `src/api/client.ts`.

## O que já é interativo

- Enviar mensagem com `Enter` (`Shift + Enter` quebra linha) e botão de envio; enquanto a
  resposta não chega o botão vira **parar** e a geração é realmente interrompida.
- `Reasoning` e `Web` são toggles de verdade, com estado ligado/desligado visível.
- Microfone (no modo conversa) dita para o campo via Web Speech API em `pt-BR`.
- Menu de modelo em categorias que abrem submenu (`Liz` ›, `Koda` ›), com o catálogo em
  `src/models.tsx`.
- **Esforço de raciocínio ao lado do modelo** (`src/effort.ts`), com o nível guardado **por
  modelo**: `Automático` (o padrão, que deixa o botão `Reasoning` decidir), `Mínimo`,
  `Baixo`, `Médio` e `Alto`. Vai como `reasoning_effort` no corpo do `/api/chat`.
- Anexos: menu `+` e clipe abrem o seletor de arquivos e mostram chips removíveis.
- Seletor de projeto no rodapé do composer (modo inicial) e no menu do header.
- Menu do header (três barrinhas) com `Configuração`, `Perfil`, `Chat` (nova conversa +
  histórico) e `Projeto`. O histórico guarda a conversa atual ao abrir uma nova.
- Busca dentro da conversa: o campo no header conta os acertos e esmaece as
  mensagens que não batem.
- Respostas em markdown mínimo (negrito, `código`, blocos de código, listas e títulos) e,
  no agente, uma linha por ferramenta com ícone próprio por ação — `src/components/RichText.tsx`,
  `ToolIcon.tsx` — tudo SVG inline desenhado no projeto, sem dependência nova.
- Enquanto a resposta não chega, a coroa da marca atravessa com um brilho
  (`ThinkingMark.tsx`) em vez de três pontinhos genéricos.
- Navegação por teclado nos menus (`↑` `↓` `Enter` `→` `←` `Esc`), `aria-expanded`,
  `aria-pressed` e `role="menu"`/`menuitemradio`.

## Tela de configuração

Ocupa a janela inteira (sem o header do chat) com barra própria: `Geral`, `Aparência`,
`Conta`, `Uso` e `Sobre`, e a volta pelo **Voltar para o chat**. O menu do header abre
`Configuração` (Geral) e `Perfil › Conta Koda` já na seção Conta.

- **Geral** — mostrar tempo de processamento, modelo padrão e projeto padrão.
- **Aparência** — tema (`Claro` / `Sistema` / `Escuro`) em cartões com mini prévia, cor de
  destaque (`Roxo`, `Azul`, `Verde`, `Rosa`), fonte (`Padrão` / `Serifada` /
  `Monoespaçada`) e tamanho da interface (`90%` / `100%` / `115%`), além de reduzir
  animações.
- **Conta** — avatar e nome, **Contas vinculadas** (telefone, que aceita um número e
  mostra só os 4 últimos dígitos, e Google), **Segurança da conta** com o dispositivo
  real desta sessão e **Sair da conta** — que pede confirmação e limpa conversa,
  histórico e vínculos, voltando para o chat.
- **Uso** — números vindos do backend (mensagens e conversas gravadas), o mapa de
  atividade do ano no estilo *heatmap* (que usa a cor de destaque escolhida) e três
  cartões de progresso: **Uso diário**, **Uso semanal** e **Uso mensal**, cada um com
  porcentagem, barra, `Ver detalhes` e a data de reinício (amanhã, próxima segunda e dia
  1º do mês seguinte). As contagens saem das mensagens gravadas e os tetos de
  `app/plan.py` chegam pela API — offline, `src/plan.ts` responde pelo mesmo plano. Só o
  dia de hoje do mapa usa a atividade real; o histórico é ilustrativo.
- **Sobre** — stack, endereço e estado do backend e onde os dados vivem.

### Como a aparência funciona

Nada disso passa pelo React além do estado: os valores são escritos em atributos do
`<html>` (`data-theme`, `data-accent`, `data-font`, `data-scale`, `data-motion`) e o CSS
troca os tokens definidos em `src/index.css`. Os componentes usam só tokens semânticos
(`bg-koda-panel`, `text-koda-fg/60`, `ring-koda-fg/8`, …), então trocar de tema repinta a
tela inteira sem re-renderizar a conversa. O tema `Sistema` usa `color-scheme: light dark`
com `light-dark()`, seguindo o sistema operacional ao vivo.

## Backend

O servidor fica em `backend/` — **Python com FastAPI**, respostas em **SSE** (o texto
chega sendo gerado, e o botão de parar aborta o `fetch`) e **SQLite** para conversas,
mensagens e conta:

```bash
cd backend
uv sync
uv run uvicorn app.main:app --reload --port 8787
uv run pytest   # 77 testes
```

Sem nenhuma configuração ele já responde: o provider `local` gera o texto no próprio
servidor. Com o **host local** no ar (`host/c-host.exe`, `127.0.0.1:21128`) ele é escolhido
automaticamente e aí sim existe tool calling de verdade; com `OPENAI_API_KEY` no
`backend/.env` vale o provider OpenAI-compatível — que serve OpenAI, Groq, OpenRouter ou um
Ollama local via `OPENAI_BASE_URL`. A resposta
do servidor viaja em eventos `start` / `delta` / `done`, e o que a tela mostra é o que
fica no banco: conversas, cotas e ferramentas chamadas sobrevivem ao reload. Detalhes em
`backend/README.md`.

### Host local (modelos)

O host fica em `host/c-host.exe` — um binário Go que abre uma API compatível com a da
OpenAI em `http://127.0.0.1:21128` e **não pede chave nenhuma**. É ele que serve os
modelos; o backend só aponta para lá (`GEMINI_PROXY_URL`) e usa o catálogo que ele
publica:

| id | nome na interface |
| --- | --- |
| `liz-nano` | Liz Nano |
| `liz-4` | Liz 4 |
| `liz-3-flash` | Liz 3 Flash |
| `liz-mini-2` | Liz Mini 2 |
| `liz-mini-1-3` | Liz Mini 1.3 |
| `koda-1` | Koda 1 |
| `layze-2` | Layze 2 |

O catálogo **não está escrito no nosso código**: `GET /v1/models` do host é a fonte, e o
seletor do front monta os grupos pelo prefixo do id (`liz-` › Liz, `koda-` › Koda, `layze-`
› Layze) — modelo novo que apareça no host entra sozinho no menu. O id vai para o host
**como veio**: quem valida é ele, e um id inventado volta como erro explícito
(`model "X" is not available on this host`) em vez de virar silenciosamente outro modelo.

Duas armadilhas que já custaram tempo aqui, e que o código trata:

- o host é **lento na primeira chamada** (ele busca o catálogo do upstream antes de
  responder), então a sondagem de disponibilidade do provider espera até 3s — com timeout
  curto o `auto` concluía que o host estava fora e caía no provider `local`, que **não tem
  ferramenta nenhuma**;
- o `c-host.exe` injeta uma **persona própria** na conversa, e ela vencia quando o modelo
  falava de si: as respostas começavam com "oii, eu sou a Liz, criada pela Liz AI Studio! 💜".
  O backend manda uma regra de identidade no prompt e **corta a apresentação da saída**
  (`backend/app/identidade.py`), inclusive no histórico reenviado ao modelo — sem isso ela
  se repetia em todas as mensagens seguintes. O nome do assistente é `KODA_ASSISTENTE`.
- dois modelos (`liz-4` e `layze-2`) **recusam `reasoning_effort: none` com 400** — com o
  botão Reasoning desligado, a resposta virava erro. O provider lê o `targetFormat` de cada
  modelo em `/v1/models` e manda `minimal` para esses.
- o `c-host.exe` roda **dentro do projeto**, e o watcher do Vite tenta abrir o arquivo,
  leva `EBUSY` (travado por estar em execução) e derruba o servidor de desenvolvimento
  inteiro. Por isso `host/` está em `server.watch.ignored` no `vite.config.ts`.

### Ferramentas (agente)

O Koda é uma área de código, então as ferramentas **não são um modo que se liga**: quando o
provedor sabe chamar ferramenta, o modelo recebe as **22 ferramentas** portadas do projeto
TOOLS e usa o que precisar antes de responder — ler/gravar/editar arquivos, rodar comandos
e Python, buscar no código, pesquisar na web e mexer no git.

Cada chamada vira uma linha na conversa (nome, argumentos, tempo e a saída guardada atrás
do clique) e é gravada junto da mensagem, então o histórico mostra a mesma coisa depois de
recarregar. Os limites:

- provedor que não sabe chamar ferramentas (o `local`, que responde offline) continua
  respondendo normalmente, só sem executar nada;
- `url_reader` e `browser` recusam endereços privados e `localhost` — e agora **também
  checam cada salto de redirecionamento**, porque um host público que devolve
  `Location: http://127.0.0.1` (ou o metadata da nuvem, `169.254.169.254`) passava direto;
- `web_search` usa **só o Bing** — uma requisição para a página de resultados, sem chave e
  sem serviço no meio. Não há plano B: se o Bing devolver bloqueio, a busca volta vazia.
  (As APIs oficiais do Bing foram aposentadas em 11/08/2025, então raspar é o caminho
  gratuito que sobrou.)
- as ferramentas de arquivo (`read_file`, `write_file`, `edit_file`, `list_dir`,
  `delete_file`, `linter`) **só mexem dentro do workspace** — caminho absoluto para fora
  volta com erro. `KODA_ACESSO_LIVRE=on` libera tudo de novo. `shell` e `terminal` sempre
  puderam tudo: é o que eles são;
- as ferramentas `git_*` **recusam rodar quando a pasta de trabalho está dentro de outro
  repositório** — sem isso um `git add -A` commitaria o projeto do pai. O Koda mora dentro
  de uma pasta versionada, então rode `git init` nele para ter um repositório só dele;
- `KODA_WORKSPACE` define a pasta onde elas trabalham (padrão: a raiz do projeto) e
  `KODA_TOOLS_DENY` desliga ferramentas específicas — ex.:
  `KODA_TOOLS_DENY=shell,terminal,git_commit,delete_file` para um comportamento quase
  somente-leitura;
- apertar **parar** cancela de fato a tarefa do agente: o loop não avança para o próximo
  passo. Uma ferramenta já em execução termina (roda em thread, não dá para cortar no meio);
- `KODA_TOOLS=off` responde sem ferramenta nenhuma, e a API ainda aceita
  `"tools": false` numa mensagem específica.

## O que ainda é simulado

O backend é real, mas sem o host local e sem `OPENAI_API_KEY` quem escreve as respostas é
o provider local do servidor, que se apresenta como tal em vez de fingir ser um modelo.
O seletor de projeto ainda é um `id` sem leitura de código (no modo Tools a pasta real vem
do `KODA_WORKSPACE`, não dele) e o mapa de atividade de 365 dias usa dados ilustrativos
(só o dia de hoje é contado de verdade). Telefone e Google da conta são vínculos de
demonstração gravados no SQLite, sem OAuth.
