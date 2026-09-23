<p align="center">
  <img src="public/coroa.svg" width="96" alt="Coroa do Koda">
</p>

<h1 align="center">Koda</h1>

<p align="center">
  Chat de código que roda na sua máquina: fala com o host local de modelos, executa
  ferramentas de verdade e guarda o histórico em SQLite.
</p>

<p align="center">
  <img alt="Licença" src="https://img.shields.io/badge/licen%C3%A7a-propriet%C3%A1ria-b040d0">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-149eca">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-8-9135ff">
  <img alt="FastAPI" src="https://img.shields.io/badge/FastAPI-Python-009485">
  <img alt="Testes" src="https://img.shields.io/badge/testes-110-success">
</p>

---

> ### ⚠️ Projeto proprietário — uso proibido sem autorização
>
> Este repositório está público **apenas para leitura, consulta e avaliação**.
> **Usar, copiar, modificar, distribuir, treinar modelos com ele ou explorar
> comercialmente — no todo ou em parte — sem autorização prévia, expressa e por escrito do
> titular é proibido.** Até mesmo *fork* dentro do GitHub não concede licença de uso.
>
> Leia o arquivo **[LICENSE](LICENSE)** (a versão em português é a que vale) e, para pedir
> autorização, abra uma issue aqui ou fale com [@Panhard-Dev](https://github.com/Panhard-Dev).

---

## O que é

O Koda é uma área de código com cara de chat, separada em três peças que conversam entre si:

| peça | o que é |
| --- | --- |
| **front** (`src/`) | React 19 + Vite + Tailwind 4, com o composer, o histórico, a tela de configuração e o desenho das ferramentas |
| **backend** (`backend/`) | FastAPI em Python, respostas em **SSE**, histórico em **SQLite** e o **loop agentic** das ferramentas |
| **gateway** (`host/`) | a ligação desta máquina com o serviço de modelos: expõe a conversa em `127.0.0.1:21128` no formato da API da OpenAI, que é o endereço que o backend usa. O binário é distribuído à parte ([host/README.md](host/README.md)) |

O agente é o comportamento normal, não um modo que se liga: quando o provedor sabe chamar
ferramenta, o modelo recebe as **22 ferramentas** e usa o que precisar antes de responder —
ler, escrever e editar arquivos, rodar comandos e Python, buscar no código, pesquisar na web
e mexer no git.

## Como rodar

```bash
git clone https://github.com/Panhard-Dev/koda && cd koda

npm install
npm run dev       # front em http://localhost:5173

npm run dev:api   # backend em http://localhost:8787 (requer uv)
npm run test:api  # pytest no backend
npm run build     # tsc -b + vite build
npm run lint      # oxlint
```

O front funciona sozinho: se a API não responder, ele cai numa resposta simulada e avisa na
própria mensagem. Com o backend de pé, a sessão inteira passa a vir dele — histórico, cotas
de uso, conta e ferramentas. O endereço da API é `VITE_API_URL` (padrão
`http://localhost:8787`).

Para falar com os **modelos do serviço**, coloque o gateway em `host/c-host.exe` e suba-o:
ele escuta em `127.0.0.1:21128` e o backend o encontra sozinho (`KODA_PROVIDER=auto`). Sem
ele nada quebra: quem responde é o provider local, offline e explícito sobre isso. O
`/api/health` diz qual dos dois está no ar.

```bash
curl -s localhost:8787/api/health   # "provider": "gemini" | "local"
```

## Interface

- Enviar com `Enter` (`Shift + Enter` quebra linha); enquanto a resposta não chega o botão
  vira **parar** e a geração é realmente interrompida.
- `Reasoning` e `Web` são toggles com estado visível, e o microfone (no modo conversa) dita
  para o campo em `pt-BR` via Web Speech API.
- Menu de modelo em categorias que abrem submenu (`Liz` ›, `Koda` ›, `Layze` ›), montado a
  partir do catálogo que o backend devolve.
- **Esforço de raciocínio ao lado do modelo**, guardado **por modelo**: `Automático` (o
  padrão, que deixa o `Reasoning` decidir), `Mínimo`, `Baixo`, `Médio` e `Alto`. Vai como
  `reasoning_effort` no corpo do `/api/chat`.
- Anexos, busca dentro da conversa, seletor de projeto e o menu do header (`Configuração`,
  `Perfil`, `Chat`, `Projeto`).
- Respostas em markdown mínimo (negrito, `código`, blocos, listas e títulos) e, no agente,
  **uma linha por ferramenta** com ícone próprio por ação — tudo SVG inline desenhado no
  projeto, sem dependência nova.
- Enquanto a resposta não chega, a coroa da marca atravessa com um brilho em vez de três
  pontinhos genéricos.
- Navegação por teclado nos menus (`↑` `↓` `Enter` `→` `←` `Esc`), `aria-expanded`,
  `aria-pressed` e `role="menu"` / `menuitemradio`.

### Tela de configuração

Ocupa a janela inteira, com barra própria: **Geral**, **Aparência**, **Conta**, **Uso** e
**Sobre**, e a volta pelo *Voltar para o chat*.

- **Geral** — mostrar tempo de processamento, modelo padrão e projeto padrão.
- **Aparência** — tema (`Claro` / `Sistema` / `Escuro`), cor de destaque (`Roxo`, `Azul`,
  `Verde`, `Rosa`), fonte (`Padrão` / `Serifada` / `Monoespaçada`), tamanho da interface
  (`90%` / `100%` / `115%`) e reduzir animações.
- **Conta** — avatar e nome, contas vinculadas (telefone e Google), segurança da conta com o
  dispositivo real desta sessão e **Sair da conta** (que pede confirmação).
- **Uso** — números vindos do backend, mapa de atividade do ano no estilo *heatmap* e os três
  cartões de progresso (**diário**, **semanal**, **mensal**) com porcentagem, barra e a data
  de reinício.
- **Sobre** — stack, endereço e estado do backend, e onde os dados vivem.

Nada disso passa pelo React além do estado: os valores viram atributos do `<html>`
(`data-theme`, `data-accent`, `data-font`, `data-scale`, `data-motion`) e o CSS troca os
tokens de `src/index.css`. Os componentes usam só tokens semânticos (`bg-koda-panel`,
`text-koda-fg/60`, …), então trocar de tema repinta a tela sem re-renderizar a conversa.

## Agente e ferramentas

As 22 ferramentas vêm de um projeto anterior do autor e rodam **na máquina**, com `cwd` na
pasta de trabalho (`KODA_WORKSPACE`, por padrão a raiz do projeto) e saída truncada: execução
(`code_interpreter`, `shell`, `terminal`), arquivos (`read_file`, `write_file`, `edit_file`,
`str_replace_editor`, `list_dir`, `delete_file`), busca (`search_codebase`, `vector_search`,
`grep`, `regex_search`, `get_problems`, `linter`), web (`web_search`, `url_reader`,
`browser`) e git (`git_status`, `git_diff`, `git_log`, `git_commit`).

Cada chamada vira uma linha na conversa (nome, argumentos, tempo e a saída atrás do clique) e
é gravada **junto da mensagem**, então o histórico mostra a mesma coisa depois de recarregar.

Travas que valem saber:

- as ferramentas de arquivo **só mexem dentro do workspace** (inclusive depois de seguir
  symlink e `..`); `KODA_ACESSO_LIVRE=on` libera tudo de novo;
- `url_reader` e `browser` recusam endereços privados e `localhost` **em cada salto** de
  redirecionamento — sem isso um host público devolvendo `Location: http://127.0.0.1:8787`
  (ou o metadata da nuvem) passava direto;
- as `git_*` **recusam rodar quando a pasta de trabalho está dentro de outro repositório**,
  senão um `git add -A` commitaria o projeto do pai;
- `web_search` usa **só o Bing**, raspando a página de resultados: sem chave, sem serviço no
  meio e sem plano B;
- `KODA_TOOLS_DENY=shell,terminal,git_commit,delete_file` desliga ferramentas específicas, e
  `KODA_TOOLS=off` responde sem ferramenta nenhuma;
- `shell` e `terminal` sempre puderam tudo. É o que eles são.

## Backend

FastAPI + SSE + SQLite, com cotas de uso, conta e o loop agentic. Detalhes de cada rota e de
cada decisão em **[backend/README.md](backend/README.md)**.

| Método | Rota | O que faz |
| --- | --- | --- |
| `GET` | `/api/health` | Estado do servidor, provider ativo, banco, pasta de trabalho e ferramentas |
| `POST` | `/api/chat` | Responde em `text/event-stream` e grava a conversa |
| `GET` | `/api/models` | Catálogo do seletor (vem do host, quando é ele que responde) |
| `GET` | `/api/conversations` | Histórico, mais recente primeiro |
| `GET` | `/api/usage` | Cotas diária, semanal e mensal |
| `GET` | `/api/account` | Conta e vínculos |

O corpo do `/api/chat` aceita `text`, `model`, `reasoning`, `effort`, `web`, `project`,
`attachments`, `conversation_id`, `tools`, `max_steps` e `tz_offset_minutes`. O stream sai em
`start` / `delta` / `reasoning` / `tool_call` / `tool_result` / `done` (ou `error`), e o que a
tela mostra é o que fica no banco.

Quem não sabe chamar ferramentas (o provider `local`) continua respondendo normalmente —
apenas sem executar nada, e o `/api/health` diz isso em `tools_ready`.

## Modelos e o gateway local

Os modelos são **próprios do projeto** e vêm do serviço de modelos. O que fica nesta máquina
é apenas a **ligação**: o gateway em `host/` conversa com o serviço e expõe a conversa no
formato da API da OpenAI em `http://127.0.0.1:21128` — o endereço que o backend usa
(`GEMINI_PROXY_URL`).

O catálogo **não está escrito no nosso código**: o seletor monta os grupos a partir do que o
serviço publica em tempo de execução, então modelo novo aparece no menu sem mexer no front.
O id escolhido vai **como veio** — quem valida é o serviço, e um id inválido volta como erro
explícito em vez de virar silenciosamente outro modelo.

O binário do gateway **não é versionado** (é grande e binário): coloque o seu em
`host/c-host.exe`. Sem ele o app continua de pé, com o provider local respondendo offline —
só sem modelo e sem ferramenta.

Um detalhe do Vite: o gateway roda dentro do projeto, o watcher tenta abrir o arquivo, leva
`EBUSY` (travado por estar em execução) e derruba o servidor de desenvolvimento inteiro — por
isso `host/` está em `server.watch.ignored` no `vite.config.ts`.

## O que ainda é simulado

O backend é real, mas sem o host e sem `OPENAI_API_KEY` quem escreve as respostas é o
provider local do servidor, que se apresenta como tal em vez de fingir ser um modelo. O
seletor de projeto é um `id` sem leitura de código (no modo agente a pasta real vem do
`KODA_WORKSPACE`, não dele) e o mapa de atividade de 365 dias usa dados ilustrativos — só o
dia de hoje é contado de verdade. Telefone e Google da conta são vínculos de demonstração
gravados no SQLite, sem OAuth.

## Estrutura

```
src/                  # front: App, componentes, markdown mínimo e o desenho das ferramentas
  components/         # Composer, Menu, ToolSteps, ToolIcon, ThinkingMark, SettingsScreen…
  api/client.ts       # fetch do SSE e chamadas da API
  effort.ts           # níveis de esforço do seletor ao lado do modelo
  models.tsx          # catálogo de modelos do seletor
backend/              # FastAPI + SSE + SQLite (ver backend/README.md)
  app/identidade.py   # identidade do assistente: regras do prompt + corte da apresentação
  app/tools/          # catálogo das 22 ferramentas + loop agentic
  tests/              # 110 testes, sem rede
host/                 # o binário do host não é versionado — ver host/README.md
```

## Licença e autorização de uso

**Projeto proprietário. Todos os direitos reservados.** Este repositório é público para
leitura e avaliação; **qualquer uso sem autorização prévia, expressa e por escrito do titular
é proibido** — inclusive executar, copiar, modificar, distribuir, treinar modelos de IA com
o código, usar a marca ou explorar comercialmente. O texto completo, com as definições e as
consequências, está em **[LICENSE](LICENSE)**.

Para pedir autorização: abra uma issue neste repositório ou fale com
[@Panhard-Dev](https://github.com/Panhard-Dev).

Copyright (c) 2026 Panhard-Dev.
