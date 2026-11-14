# Entrega: `@`, `/` e `#` consultam arquivos reais do projeto

## Pedido atendido

- `@`, `/` e `#` passam a apontar para arquivos, pastas, subpastas e arquivos dentro de subpastas **reais** do diretório aberto.
- Nada de nome de pasta fixo: exemplos como `Pasta 1` não viram código. O alvo é resolvido contra `os.scandir`/`Path.exists` do workspace atual.
- `/` deixa de ter só `/init` e `/plan`: abre comandos, e enquanto há caminho mostra pastas/arquivos automaticamente.
- `@` continua com subs, skills, MCPs e etc.; também aceita `@index.html`, `@casa.js`, `@backend/app/api/`.
- `#` aceita `#xxx.html`, `#pasta/arquivo.py`, `#pasta/subpasta/` e crases para nomes com espaço.
- `/arquivos` sem argumento lista a raiz real; `/arquivos backend/app/providers` consulta a pasta real.
- Backend de consulta permanece em Python. Não foi criada implementação Rust nem módulo TypeScript novo para a lógica de leitura.

## O que mudou desde o último PR

### Backend Python

- `backend/app/caminhos_marcados.py`: novo módulo. Reconhece `#caminho`, `@caminho`, `/caminho` e `/arquivos [pasta]`; resolve somente dentro do workspace; bloqueia `..`, absolutos, drive letters e symlink que escapa da raiz; lê arquivo via ferramenta `read_file` e lista diretórios recursivamente com tetos de varredura/contexto.
- `backend/app/caminhos_marcados.py`: `listar_caminhos()` consulta o disco para o menu; quando o trecho digitado ainda não é uma pasta exata, mantém a listagem do diretório-pai em vez de fechar o menu.
- `backend/app/routers/projects.py`: `GET /api/projects/arquivos` devolve caminhos reais do projeto aberto para autocomplete.
- `backend/app/routers/chat.py`: `_options()`, modo texto e modo agente recebem o workspace real e injetam `contexto_marcado`.
- `backend/app/providers/base.py`: `ChatOptions.contexto_marcado` entra no `system_prompt()`.
- `backend/app/agent/loop.py`: marcador de caminho força modo projeto e limpa restrições de “não use ferramentas” apenas quando há sinal real de caminho; títulos e hashtags comuns não ativam isso.

### Front (somente UI existente)

- `src/comandos.ts`: menu `/` ampliado e reconhecimento de `/caminho` diferente de comando reservado.
- `src/mencoes.ts`: `@` continua reconhecendo `@sub`, `@mcp`, `@skill`, e passa a aceitar caminhos com ponto/barra sem confundir com tipo reservado.
- `src/components/Composer.tsx`: menu de pastas/arquivos abre para `/caminho`, `/arquivos`, `@caminho` e `#caminho`; escolher item completa o caminho real na caixa.
- `src/api/client.ts`: cliente do endpoint de caminhos reais. Este arquivo também contém mudanças locais anteriores de host/sessão e entra no PR por fazer parte do estado corrente do front.

### Outros arquivos do estado corrente

Os demais arquivos de código-fonte e documentação presentes no workspace entram neste PR. `src-tauri/` e `server/` ficam **de fora**, por solicitação do usuário, junto com artefatos locais, instaladores, runtime embutido, banco, capturas e caches. O branch local continua com esses arquivos no disco; eles não fazem parte do commit do PR.

## Segurança

- Toda resolução usa `Path.resolve()` e checa que o alvo continua dentro da raiz do projeto.
- Conteúdo consultado é injetado como dado externo, com delimitadores e UUID por bloco; não vira instrução para escrever arquivos.
- `MAX_MARCADOS`, `TETO_CONSULTA`, `TETO_CONTEXTO`, `LIMITES.itens_varredura`, `LIMITES.arquivos_busca`, `PASTAS_IGNORADAS` e `EXTENSOES_IGNORADAS` limitam leitura/listagem.
- `# Titulo`, `#hashtag`, e-mail e menções `@mcp.*` não forçam consulta de arquivo.

## Validação

- `backend/.venv/bin/python -m pytest -q tests/test_caminhos_marcados.py tests/test_restricoes_pedido.py tests/test_classificacao_pedido.py tests/test_catalogo_modelos.py tests/test_inicializacao_host.py`: `95 passed`.
- `npx tsc -b --pretty false`: sem erros.
- `py_compile` dos módulos Python alterados: OK.
- Host/backend no ar: `http://127.0.0.1:8787/api/health` → `{"status":"ok","version":"0.8.6"}`; front `http://127.0.0.1:5173/` → `200`.
- Navegador `@Navegador`: `/` mostrou comandos; `/backend/app/` e `/backend/app/providers` listaram pastas/arquivos reais; `/arquivos` listou raiz real; `@index.html`, `#src/App.tsx` e `@skill.` foram testados sem enviar mensagem ao modelo.
- Seletor de modelos aberto na UI; **nenhum modelo foi testado**, conforme pedido.
- Endpoint `/api/projects/arquivos?consulta=backend/app/api` consultado diretamente; retornou caminhos reais do workspace.

## Exclusões intencionais

- Sem merge.
- Sem gerar `.exe`, `.deb`, `.AppImage`, `.rpm`, instalador ou build de distribuição.
- Sem publicar `src-tauri/`, `server/`, `data/koda.db`, `.env`, tokens, `src-tauri/runtime-linux/`, `.tools/`, `entrega-*/`, capturas PNG/JPEG, caches e diretórios temporários.
- Testes locais em `backend/tests/` são ignorados pelo `.gitignore` do repositório; a validação foi executada no workspace e está documentada acima.

## Como revisar

1. Abrir Koda no host/front, com projeto apontando para este repositório.
2. Digitar `/` e conferir comandos.
3. Digitar `/backend/app/` e conferir pastas reais; continuar com `/backend/app/providers` ou outro caminho real.
4. Digitar `@index.html`, `#src/App.tsx`, `/arquivos` e `@skill.`.
5. Conferir que escolher uma entrada completa o caminho na caixa, sem enviar mensagem sozinha.
6. Revisar `backend/app/caminhos_marcados.py` para a regra de segurança e consulta obrigatória.
