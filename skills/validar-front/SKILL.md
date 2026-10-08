---
name: validar-front
description: Valida um front-end de ponta a ponta pelo MCP navegador — abre a página, interage como uma pessoa (clique, teclado, hover, arrasto, upload, toque) e confere console, rede, armazenamento e árvore de acessibilidade. Use quando precisar provar que uma alteração de interface funciona, sem depender de print: "validar a tela", "testar o front", "conferir se quebrou", "rodar a bateria de QA", "testar responsividade", "checar acessibilidade", "interagir com a página".
---

# Validar front pelo MCP `navegador`

A regra: **prove o que você fez.** Toda a leitura vem de números que o motor do navegador
calculou — geometria, cor computada, papel de acessibilidade, status de rede. O `print`
continua existindo, mas ele salva um PNG no disco e **você não enxerga arquivo**: use-o só
quando o humano for olhar.

As ferramentas chegam como `mcp__navegador__<ferramenta>`. Carregue esta skill com `use_skill`
antes de começar.

## Antes de qualquer coisa

1. **O servidor está no ar.** `mcp__navegador__abrir` devolve erro claro se não estiver.
2. **A página certa.** Aceita **qualquer site** (`https://exemplo.com`), servidor de dev
   (`localhost:PORTA`) e arquivo do disco. O Chrome sobe com perfil próprio e temporário.
3. **Use `localhost`, não `127.0.0.1`, em `fetch` de página.** Medido em 04/10/2026: a mesma
   chamada levou **6.360 ms** por `127.0.0.1` e **328 ms** por `localhost` (há proxy no
   caminho, e o `localhost` está na exceção).

## As ferramentas

**Ver** — `enxergar` (render por nó: geometria, cor, fonte, borda, canto, sombra, `z`,
`fora-da-janela`, `coberto-por`; shadow DOM aberto marcado com `shadow`; `::before/::after` em
`antes=`/`depois=`; canvas 2D e WebGL em pixels; paginado por `inicio`/`limite`), `pixels`
(quem é dono de cada ponto), `ler` (texto + interativos numerados), `estilo`, `acessibilidade`
(árvore ARIA), `console`, `rede`, `armazenamento`.

**Agir** — `clicar`, `digitar`, `tecla` (Tab, Escape, setas, Espaço, Home/End, F1..F12, com
Ctrl/Shift/Alt), `hover`, `arrastar`, `upload`, `janela` (tamanho, mobile, `toque`/`swipe`),
`rolar`, `marcar`.

**Navegar** — `abrir`, `voltar`, `avancar`, `recarregar`, `fechar`.

**Força bruta** — `executar_js`, `esperar`, `requisicao` (dublê de API: status, corpo, atraso;
`offline`; `latência`).

## O ciclo

```
abrir → esperar (a tela montar) → agir → enxergar / executar_js (conferir) → console / rede
```

**Sempre `esperar` entre agir e conferir.** Sem isso a leitura chega antes de a tela responder
e o resultado vira sorte. `esperar {seletor}` / `{texto}` / `{ate}`.

## A bateria

Cada linha diz o que **executar** e o que **ler** para provar.

### Interação
| Verificar | Como |
|---|---|
| Botão executa e não dispara duas vezes | `clicar` + `executar_js` com um contador no handler |
| Link leva à rota certa | `clicar` → `executar_js location.pathname` |
| Menu, dropdown, modal, tooltip | `clicar`/`hover` → `enxergar {seletor}` (apareceu?) |
| Modal fecha com ESC e com clique fora | `tecla {tecla:'Escape'}` → `enxergar` (saiu da leitura) |
| Formulário: vazio, inválido, válido | `digitar` + `clicar` → `enxergar` na mensagem de erro |
| Máscara (CPF, telefone, CEP) | `digitar {texto:'12345678901'}` → `executar_js` no `input.value` |
| Copiar e colar | `tecla {tecla:'a', modificadores:['Control']}` + `tecla {tecla:'c'}` + `digitar` |
| Select, checkbox, radio, switch | `clicar` → `executar_js` no `.checked`/`.value` |
| Hover, focus, active, disabled | `hover`/`clicar` → `enxergar` (mudou fundo/cor?) |
| Teclado: Tab, Espaço, setas | `tecla {tecla:'Tab', vezes:3}` → `executar_js document.activeElement.id` |
| Arrastar e soltar | `arrastar {de, para}` → `executar_js` na ordem ou no handler chamado |
| Upload | `upload {seletor, arquivos}` → `enxergar` no nome do arquivo |
| Loading, vazio, erro, sucesso | `esperar` + `enxergar` em cada estado |

### Estados e dados
| Verificar | Como |
|---|---|
| Dados da API aparecem | `clicar` na busca → `rede {filtro}` + `enxergar` na lista |
| Erro 400/401/404/500 tratado | `requisicao {padrao, status:500}` → `clicar` → `enxergar` na mensagem |
| Internet lenta / offline | `requisicao {latencia:3000}` ou `{offline:true}` → conferir o estado |
| Paginação, filtro, ordenação | `clicar`/`digitar` → `executar_js` na lista |
| Scroll infinito | `rolar {fim}` → `esperar` → `enxergar` (mais itens?) |
| Refresh no meio do fluxo | `armazenamento {definir}` + `{recarregar:true}` → conferir o estado |
| Sessão expirada / rota protegida | `armazenamento {limpar:true, recarregar:true}` → caiu no login? |
| Voltar/avançar do navegador | `voltar`/`avancar` → `executar_js location.pathname` |

### Aparência e acessibilidade
| Verificar | Como |
|---|---|
| Layout em mobile/tablet/desktop | `janela {largura, altura, mobile, recarregar:true}` → `enxergar` |
| Toque e swipe | `janela {acao:'toque'}` / `{acao:'swipe', dx, dy}` |
| Fontes, cores, espaçamentos | `enxergar` (valores computados) — compare com o esperado |
| Ícones e imagens carregaram | `enxergar` (o `img` traz `imagem=WxH` e `(carregando)`) |
| Animações e transições | `enxergar {seletor}` duas vezes com ~400 ms entre elas: o `transform` mudou? |
| Sobreposição e o que está por cima | `pixels` e `coberto-por` |
| Console limpo | `console` (pega o que apareceu **antes** de você olhar) |
| Papéis, nomes e estados ARIA | `acessibilidade {seletor}` |
| Foco visível e ordem de tabulação | `tecla {tecla:'Tab'}` + `acessibilidade` (`focused=true`) |
| Contraste | `executar_js` calculando a razão entre `color` e `backgroundColor` |

### Fora da interface
| Verificar | Como |
|---|---|
| SEO básico | `executar_js {codigo:'({t:document.title, m:document.querySelectorAll("meta").length})'}` |
| Performance de carga | `executar_js` em `performance.getEntriesByType('navigation')[0]` |
| localStorage/cookies/sessão | `armazenamento` |
| Bundle | `rede {filtro:'.js'}` (quantidade e tamanho) |
| Dado sensível exposto / XSS | `ler` + `enxergar` procurando o valor; `armazenamento` |

## O que NÃO dá para validar aqui

- **Fluidez de animação.** Dá para provar que anima e onde para; não dá para dizer se está
  fluido (fps, engasgo) nem avaliar a curva de easing.
- **Estética "no olho".** Contraste ruim, ícone torto e espaçamento feio não são *vistos*: são
  detectados por número (caixas que se cruzam, tamanho zero, cor exata).
- **Outro navegador.** É Chrome (o Edge também serve). Firefox e Safari não.
- **Fidelidade ao Figma.** Exigiria o arquivo de origem para comparar.
- **Lighthouse e Core Web Vitals completos.** Dá para ler o que o `performance` expõe; um
  relatório Lighthouse não.
- **iframe de outra origem** (só o quadro) e **shadow root fechado**.
- **Arrastar nativo do HTML** (`draggable="true"`): o `arrastar` usa o canal do mouse.

## Armadilhas (cada uma custou uma rodada)

- **Elemento vazio e sem tamanho não entra no `enxergar`** — não foi desenhado. Antes de
  clicar, a área de resultado costuma não existir na leitura; isso é esperado, não falha.
- **`digitar` não limpa o campo**: escreve no cursor. Campo com texto vira concatenação.
- **Modo de toque só vale depois de recarregar** (`janela {mobile:true, recarregar:true}`):
  `ontouchstart` e `navigator.maxTouchPoints` são fixados quando a página nasce.
- **Overlay `fixed` come o clique seguinte.** Depois de abrir um modal, feche-o (`Escape`)
  antes de testar outra coisa — senão o hover e o arrasto acertam o overlay.
- **Uma ação por vez, relendo a posição.** Abrir o primeiro item de uma lista empurra os
  seguintes: clicar em coordenadas medidas antes acerta o vazio.
- **A leitura é paginada, não truncada.** O `enxergar` diz o total e devolve o `inicio` da
  próxima chamada no rodapé. Página grande se lê em várias chamadas, e nada se perde.

## Ao achar um defeito

Não pare no relato. O ciclo é: **reproduzir** (a chamada que mostra o problema), **corrigir**
(o arquivo), **recarregar** (`recarregar`) e **provar de novo** (a mesma chamada, agora
passando). Sem o terceiro e o quarto passo, "corrigi" é afirmação sem prova.
