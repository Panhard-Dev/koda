# Matriz dos 105 requisitos — Koda UI Protocol

Atualizada em 2026-11-06. Status honesto, sem declarar integração que não existe.

Legenda:

- **✅ verificado** — implementado e testado nesta rodada (ou no teste do cartão de plano, indicado).
- **🟨 implementado** — o Koda já tem o componente/ferramenta, mas sem integração externa real ou sem teste específico nesta rodada.
- **🟥 não implementado** — não existe caminho funcional hoje.
- **⛔ bloqueado** — depende de provedor, credencial ou serviço externo que o projeto não tem.

## O que foi entregue nesta rodada

- Protocolo **Koda UI v1**: documento JSON versionado (`schemaVersion`, `documentId`, `messageId`, `revision`, `state`, `actions`, `root`, `dataRefs`, `fallbackText`).
- Validação estrita no servidor (`backend/app/ui_documento.py`) e segunda barreira no cliente (`src/components/KodaUI/protocolo.ts`).
- Ferramenta `mostrar_interface`, disponível a todos os provedores que chamam ferramentas.
- 56 componentes declarativos, 9 tipos de ação (`state.set`, `state.toggle`, `state.increment`, `state.calc`, `ui.setTab`, `copy`, `openUrl`, `issueNewTurn`, `form.submit`).
- Renderer (`src/components/KodaUI/desenho.tsx`), estado local persistido em `localStorage` por `documentId:revision`, e bloco ```koda-ui-doc``` gravado na mensagem para reabrir a conversa com a mesma tela.
- Sem `eval`, sem `new Function`, sem HTML/CSS/JS arbitrário no DOM principal; URLs validadas; profundidade, número de nós, tamanho e IDs limitados.
- Componentes novos: `KodaIcon`, `KodaSvg`, `KodaDiagram`, `KodaMap`, `KodaWritingBlock`, `KodaSandbox`, `KodaAppBlock`, `KodaAlgorithm`, `KodaCitation`, `KodaEntity`, `KodaCalculator`.
- Ferramentas de dados reais: `clima` (Open-Meteo), `cotacao` (Frankfurter), `buscar_imagens` (Openverse) e `memoria` (JSON local, com exclusão e recusa de segredos).
- Markdown da conversa agora desenha imagens `![alt](url)` e galerias alinhadas, com `alt`, carregamento preguiçoso e fallback quando a mídia falha.

## Evidência desta rodada (navegador, GPT-6 Luna e GitHub Copilot GPT-4.1)

- Formulário com input, select e checkbox → `form.submit` gerou nova mensagem com os valores escolhidos.
- Contador `+1` e `Zerar` atualizaram sem chamada ao modelo.
- Abas `KodaTabs` alternaram conteúdo; gráfico de barras renderizou 3 barras.
- Botão “Copiar resumo” chamou `navigator.clipboard.writeText("Meta: 450 vendas")`.
- Link `https://example.com` renderizou com href validado.
- Após recarregar a página e reabrir a conversa, a tela voltou do bloco ```koda-ui-doc``` e o contador manteve o valor 3 (localStorage).
- Mesmo fluxo funcionou no provedor GitHub Copilot (GPT-4.1), além do Accio (GPT-6 Luna).
- Rodada de 2026-11-06: documento único com ícone, SVG de linha, diagrama, algoritmo, calculadora, citação, entidade e bloco de escrita renderizou no GPT-4.1; `state.calc` recalculou 1000 × (1 + 5/100) = 1.050,00.
- `clima` devolveu 20,2 °C em São Paulo e `buscar_imagens` devolveu quatro fotos do Openverse com autor e licença; as duas ferramentas foram chamadas de verdade (etapas registradas na mensagem), sem `code_interpreter`.

## Matriz

| # | Requisito | Status | Implementação / evidência |
|---|---|---|---|
| 1 | Cards | 🟨 | `KodaCard` no protocolo; sem teste de card extenso no celular nesta rodada. |
| 2 | Tabelas | 🟨 | `KodaTable` renderiza colunas/linhas; ordenação tipada e virtualização ainda não. |
| 3 | Gráficos de barras | ✅ | `KodaChart` tipo barras; testado no painel (jan/fev/mar). |
| 4 | Gráficos de linhas | ✅ | `KodaChart` tipo linhas em SVG + tabela alternativa; testado no documento de 2026-11-06. |
| 5 | Gráficos de pizza | 🟨 | `KodaChart` tipo pizza com legenda; não testado nesta rodada. |
| 6 | Dispersão | 🟥 | Sem componente de dispersão. |
| 7 | Carrosséis | 🟨 | `KodaCarousel` existe; navegação por teclado/toque não testada. |
| 8 | Imagens | ✅ | `KodaImage` e Markdown `![alt](url)` com galeria, `alt`, `loading=lazy`, proporção reservada e fallback de erro; quatro imagens reais renderizadas no navegador. |
| 9 | Vídeos | 🟨 | `KodaVideo` para fontes compatíveis; fallback de formato não testado. |
| 10 | Ícones | ✅ | `KodaIcon` com catálogo de ~80 nomes e tamanho limitado; renderizado no teste de 2026-11-06. |
| 11 | Badges | 🟨 | `KodaBadge` com tons; sem vínculo a estado real de backend. |
| 12 | Mapas | 🟨 | `KodaMap` desenha pontos e abre a posição no OpenStreetMap; sem tiles embutidos, rotas ou geocodificação. |
| 13 | Diagramas | ✅ | `KodaDiagram` com nós, arestas por id ou rótulo e setas; testado com Entrada → Processo → Saída. |
| 14 | Layout em colunas | ✅ | `KodaRow`/`KodaColumn` usados no painel e no formulário. |
| 15 | Grades | 🟨 | `KodaGrid` com colunas validadas; responsividade não testada. |
| 16 | Blocos de destaque | 🟨 | `KodaAlert`/`KodaCallout` com tons. |
| 17 | Citações | 🟨 | `KodaSourceList`/`KodaQuote`; não há registro de fontes com IDs verificáveis. |
| 18 | Links | ✅ | `KodaLink` com href http/https/mailto; link do painel testado. |
| 19 | Botões | ✅ | `KodaButton` com `actionId`; `+1`, `Zerar`, `Copiar resumo` testados. |
| 20 | Campos de texto | ✅ | `KodaInput` com `valueBinding`; testado no formulário. |
| 21 | Áreas de texto | 🟨 | `KodaTextarea` existe; rascunho e limites não testados. |
| 22 | Checkboxes | ✅ | `KodaCheckbox`; testado no formulário (incluir testes). |
| 23 | Seleção única | 🟨 | `KodaRadioGroup` existe; teclado não testado. |
| 24 | Menus suspensos | ✅ | `KodaSelect`; testado no formulário (site/app/documento). |
| 25 | Controles segmentados | 🟨 | `KodaSegmentedControl` existe. |
| 26 | Sliders | 🟨 | `KodaSlider` com min/max/passo; validação de faixa no servidor. |
| 27 | Calendários | 🟨 | `KodaDatePicker` com data civil; fuso/intervalo não implementados. |
| 28 | Formulários | ✅ | `KodaForm` + `form.submit` geraram nova mensagem com os valores. |
| 29 | Popovers | 🟨 | `KodaPopover` com foco/Escape implementado no renderer; não testado. |
| 30 | Elementos clicáveis | 🟨 | `KodaPressable`; prefere button/link no renderer. |
| 31 | Interfaces reativas | ✅ | Contador e abas mudaram sem chamada ao modelo. |
| 32 | Sugestões interativas | 🟨 | `KodaSuggestion` dispara `issueNewTurn`; não testado. |
| 33 | SVG personalizado | ✅ | `KodaSvg` declarativo (linha, círculo, retângulo, texto, caminho, polígono) desenhado como elementos React; sem markup arbitrário. |
| 34 | Painéis de métricas | 🟨 | `KodaMetric`/`KodaProgress`; filtros globais ainda não. |
| 35 | HTML/CSS/JS personalizados | ✅ | `KodaSandbox`/`KodaAppBlock` em iframe `sandbox="allow-scripts"` sem `allow-same-origin`, CSP `default-src 'none'`; `contentDocument === null` verificado. |
| 36 | Animações | 🟨 | Transições CSS do renderer; `prefers-reduced-motion` não auditado. |
| 37 | Simulações interativas | 🟨 | Possível com `state` + campos, mas sem componente de simulação dedicado. |
| 38 | Calculadoras | ✅ | `KodaCalculator` + `state.calc` com parser aritmético recursivo (sem `eval`); testado com capital/taxa e resultado reativo. |
| 39 | Visualização de algoritmos | ✅ | `KodaAlgorithm` com linha do tempo, avançar/voltar, reproduzir, pausar e reiniciar; testado com três passos. |
| 40 | Interfaces de protótipo | 🟨 | `KodaSandbox`/`KodaAppBlock` permitem prévia isolada; não há fluxo de protótipo navegável entre telas. |
| 41 | Pesquisa na internet | 🟨 | Ferramenta `web_search` existe; sem teste de atualidade/fontes nesta rodada. |
| 42 | Consulta a sites | 🟨 | `url_reader` existe; bloqueio de rede privada não auditado agora. |
| 43 | Notícias | 🟨 | Via `web_search`, sem deduplicação/data de evento. |
| 44 | Produtos | 🟥 | Sem estrutura de oferta/preço/loja. |
| 45 | Estabelecimentos | 🟥 | Sem busca de lugares. |
| 46 | Reservas | 🟥 | Sem integração de disponibilidade. |
| 47 | Previsão do tempo | ✅ | Ferramenta `clima` com Open-Meteo (geocodificação + previsão), testada no navegador: 20,2 °C em São Paulo. |
| 48 | Cotações | ✅ | Ferramenta `cotacao` com Frankfurter/BCE; testada: 1 USD = 5,4664 BRL. |
| 49 | Esportes | 🟥 | Sem placares/classificação. |
| 50 | Pesquisa de imagens | ✅ | Ferramenta `buscar_imagens` com Openverse, devolvendo título, autor, licença e URL; quatro imagens renderizadas no navegador. |
| 51 | Referências verificáveis | 🟨 | `KodaSourceList` exibe fontes; falta registro persistente com ID. |
| 52 | PDF | 🟨 | Skills `pdf`/`pdf-reading` disponíveis; não testadas nesta rodada. |
| 53 | Word/DOCX | 🟨 | Skill `docx` disponível; não testada nesta rodada. |
| 54 | Excel/XLSX | 🟨 | Skill `xlsx` disponível; fórmulas não verificadas nesta rodada. |
| 55 | PowerPoint/PPTX | 🟨 | Skill `pptx` disponível; não testada nesta rodada. |
| 56 | HTML | 🟨 | `write_file`/`code_interpreter` geram HTML; sem prévia isolada. |
| 57 | CSS | 🟨 | Idem; sem prévia isolada. |
| 58 | JavaScript | 🟨 | Idem; execução fora do processo principal via ferramentas, não no renderer. |
| 59 | JSON | ✅ | Validador estrito + testes de recusa (HTML, eval, IDs, profundidade). |
| 60 | CSV | 🟨 | Via `code_interpreter`/`write_file`; sem exportador dedicado. |
| 61 | Markdown | ✅ | `RichText` renderiza Markdown na conversa. |
| 62 | Arquivos de código | ✅ | `write_file`/`edit_file`/`apply_patch` e estrutura do projeto. |
| 63 | Análise de imagens | 🟨 | Visão do provedor quando o modelo suporta; OCR real não integrado. |
| 64 | Processamento de dados | 🟨 | `code_interpreter`; relatório de transformação não automatizado. |
| 65 | Escrever código | 🟨 | Ferramentas de arquivo + agente; não testado nesta rodada. |
| 66 | Depurar código | 🟨 | `shell`, `linter`, `get_problems`; não testado nesta rodada. |
| 67 | Revisar segurança | 🟨 | Skill `security-review`/agente; sem relatório automático no Koda. |
| 68 | Projetar arquiteturas | 🟨 | Capacidade do modelo + leitura de repositório; sem artefato dedicado. |
| 69 | Criar testes | 🟨 | `shell` executa suítes; não há gerador/runner integrado. |
| 70 | Analisar repositórios | 🟨 | `search_codebase`, `vector_search`, `grep`; não testado nesta rodada. |
| 71 | Executar Python | 🟨 | `code_interpreter` isolado; limites não reauditados agora. |
| 72 | Criar agentes | 🟨 | `sub_agente` + orçamento/parada do loop; não testado nesta rodada. |
| 73 | Desenvolver integrações | 🟨 | Servidores MCP; sem testes de contrato nesta rodada. |
| 74 | Criar prompts | 🟨 | Prompts do sistema versionados no código; sem avaliador automático. |
| 75 | Explicar modelos de IA | 🟨 | Modelo responde; números de contexto vêm do catálogo, não inventados pelo renderer. |
| 76 | Documentação técnica | 🟨 | `docs/` e READMEs existentes; não revalidados nesta rodada. |
| 77 | Gerar imagens | ⛔ | Depende de provedor de geração de imagem que o projeto não tem. |
| 78 | Editar imagens | ⛔ | Depende de provedor de edição de imagem que o projeto não tem. |
| 79 | Remover elementos | ⛔ | Depende de provedor de inpainting/máscara. |
| 80 | Transformar estilos | ⛔ | Depende de provedor de transformação de estilo. |
| 81 | Criar personagens | ⛔ | Depende de provedor com consistência visual entre gerações. |
| 82 | Criar banners | ⛔ | Depende de provedor de composição/editável. |
| 83 | Criar thumbnails | ⛔ | Depende de provedor de imagem com exportação medida. |
| 84 | Criar GIFs | ⛔ | Depende de provedor de geração/exportação de animação. |
| 85 | Materiais de marca | ⛔ | Depende de provedor de composição de marca. |
| 86 | Memória personalizada | ✅ | Ferramenta `memoria` local (`data/memoria.json`) com salvar/listar/buscar/excluir, recusa de segredos; testada ponta a ponta. |
| 87 | Recuperação de contexto | ✅ | Reabrir a conversa restaurou a tela e o estado local (contador = 3). |
| 88 | Tarefas agendadas | 🟥 | Sem scheduler durável no backend do Koda. |
| 89 | Monitoramento periódico | 🟥 | Sem consulta recorrente/deduplicação. |
| 90 | Integrações com aplicativos | 🟨 | MCPs com status/desconexão; escopos e revogação não auditados. |
| 91 | Ferramentas do GitHub | 🟨 | Servidor MCP GitHub disponível; não testado nesta rodada. |
| 92 | Plugins personalizados | 🟨 | MCPs com configuração; sem manifest versionado/permissões próprias. |
| 93 | Busca em arquivos pessoais | 🟨 | `search_codebase` no workspace; sem índice por proprietário. |
| 94 | Organização de biblioteca | 🟨 | Ferramentas de arquivo (mover/renomear/apagar); sem lixeira/versões. |
| 95 | Ações em aplicativos conectados | 🟨 | Ferramentas MCP; confirmação verificável depende do servidor. |
| 96 | Redação de textos | ✅ | `KodaWritingBlock` editável, com copiar, baixar `.txt` e contagem de caracteres; testado no documento de 2026-11-06. |
| 97 | Revisão textual | 🟨 | `KodaDiff` para antes/depois; não testado nesta rodada. |
| 98 | Tradução | 🟨 | Capacidade do modelo; sem glossário/estrutura dedicada. |
| 99 | Ensino interativo | 🟨 | Formulários e estado permitem exercício; sem adaptação por evidência. |
| 100 | Simulados | 🟨 | Possível com formulário; sem pontuação/persistência de respostas. |
| 101 | Resolução matemática | ✅ | `KodaCalculator` + `state.calc` calculam localmente com parser próprio; testado 1000 × (1 + 5/100) = 1.050,00. |
| 102 | Análise crítica | 🟨 | Capacidade do modelo; sem artefato estruturado. |
| 103 | Planejamento de projetos | ✅ | `mostrar_plano` + To-dos + cartão de plano (testado na rodada anterior). |
| 104 | Comparações técnicas | 🟨 | `KodaTable`/texto; sem benchmark real. |
| 105 | Resumos e sínteses | 🟨 | Capacidade do modelo; sem verificação automática de fidelidade. |

## Contagem

- ✅ verificados: **28** — itens 3, 4, 8, 10, 13, 14, 18, 19, 20, 22, 24, 28, 31, 33, 35, 38, 39, 47, 48, 50, 59, 61, 62, 86, 87, 96, 101 e 103.
- 🟨 implementados sem integração externa completa ou sem teste específico: **61**.
- 🟥 não implementados: **7** — itens 6, 44, 45, 46, 49, 88 e 89.
- ⛔ bloqueados por provedor: **9** — itens 77 a 85 (geração, edição e composição de imagem dependem de um provedor que o projeto não tem).

## Limites conhecidos desta entrega

1. O protocolo cobre 56 componentes; ainda não há dispersão, mapa com tiles/rotas, editor de imagem nem scheduler durável.
2. `KodaMap` é uma visualização de pontos com link para o OpenStreetMap; não embute tiles, geocodificação reversa ou rotas.
3. `KodaCalculator` e `state.calc` usam parser aritmético próprio (`+ - * / %` e parênteses), sem funções, variáveis externas ou `eval`.
4. Tabelas não ordenam nem paginam.
5. O estado local persiste no navegador por `documentId:revision`; não é sincronizado entre dispositivos.
6. `dataRefs` é recusado com mensagem clara: os dados vão dentro do documento.
7. Ações externas (`openUrl`) abrem o link; não há confirmação de efeito em serviços conectados.
8. O modelo ainda pode escrever o JSON em texto; o backend remove o eco `js-doc` quando a interface foi desenhada.
9. Clima, câmbio e imagens dependem de serviços públicos (Open-Meteo, Frankfurter e Openverse); indisponibilidade vira erro honesto, nunca dado inventado.
