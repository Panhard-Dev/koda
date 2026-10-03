# Plano da 0.6.3 — com o que foi medido, não com o que parece

Documento de trabalho. Nada aqui é código: é o mapa do que existe, para onde vai, e **os
quatro bloqueios de desenho** que a reorganização precisa resolver antes de cortar.

## 1. Já feito

| Passo | Estado |
| --- | --- |
| `policy/` (passo 1) | **feito** — `guards.py` + `approvals.py` movidos; ponte com prazo em `tools/guardas.py` |
| Regra de direção dos imports | **feito** — `tests/test_arquitetura.py`, com listas que encolhem |
| `limits` como infraestrutura compartilhada | **feito** — `app/limits.py` com `RuntimeLimits`; os ~99 usos leem `LIMITES.<campo>` |
| `execution/` | **feito** — `tempo.py` + `processo.py`; `ferramentas.py` de 3.934 para 3.013 linhas |
| `contracts/turn.py` | **feito** — tipos do turno + `texto_do_conteudo`; `contracts/tools.py` com o `_def` |
| `agent/` | **feito** — `loop.py`, `contexto.py`, `repeticao.py` |
| `tools/registry.py` | **feito** — catálogo, apelidos, grupos e o despacho |
| `domains/` (schemas) | **feito** — `files` (21), `shell` (5), `git` (6), `web` (5), `plano` (1) |
| `domains/` (handlers) | **falta** — os ramos de `_executar_impl` continuam em `ferramentas.py` |
| limpeza das pontes | **feito** — as duas morreram; `PONTES` e `PENDENCIAS` vazias |
| docs | **feito** — `NOTICE.md` e este documento |

## 2. A anatomia medida

### `app/tools/ferramentas.py` — 3.934 linhas

| Faixa | O que é | Destino |
| --- | --- | --- |
| 39-64 | prazos e cancelamento (ContextVars + 4 funções) | `execution/tempo.py` |
| 66-78 | `LIMITE_SAIDA`, `LIMITE_LEITURA`, `LIMITE_DE_LINHA` | `domains/files` |
| 80-129 | tetos do comando + `_RODANDO` | `execution/processo.py` |
| 132-166 | `definir_limites` (mexe nos dois assuntos) | fica no despacho, chamando os dois |
| 168-228 | reserva de vaga, `encerrar_tudo`, `encerrar_do_dono` | `execution/processo.py` |
| 230-380 | limites de busca/rede, `DOMINIOS_WIKI`, cabeçalhos | `domains/web` |
| 381-610 | `APELIDOS`, `SINONIMOS` | `tools/registry.py` |
| 574-610 | `SINONIMOS_DE_ITEM`, `ESTADOS_DE_ITEM` | `domains/plano` |
| 611-643 | `canonico`, `_sinonimos`, `_def` | `tools/registry.py` |
| 646-1040 | `DEFINICOES` (as 38 ferramentas) + `catalogo` | **dividir por domínio** |
| 939-1037 | `ESCRITA`, `FERRAMENTAS_*`, `CAMINHOS_EXTRA` | `tools/registry.py` |
| 1038-1408 | utilidades de caminho, leitura e escrita | `domains/files` |
| 1409-2172 | **o bloco de execução**: ambiente, `_which`, `_argv_shell`, `ComandoRodando`, `_rodar`, `_comecar`, `_parar` | `execution/processo.py` |
| 2173-2540 | web (Bing, leitura de página, cerca de conteúdo externo) | `domains/web` |
| 2541-2611 | git (raiz, ref, checagem de repositório) | `domains/git` |
| 2612-2866 | `classificar` + `COMANDO_PERIGOSO` | `policy/` |
| 2867-2951 | plano (`update_todos`) | `domains/plano` |
| 2952-3002 | gestores de pacote | `domains/shell` |
| 3003-3231 | aplicação de patch | `domains/files` |
| 3232-3931 | `executar` + `_executar_impl` | `tools/dispatcher.py` |

### `app/tools/loop.py` — 2.751 linhas

| O que é | Destino |
| --- | --- |
| o laço (turno, portões de parada, orçamento) | `agent/loop.py` |
| `PROMPT_FERRAMENTAS` + as cobranças (`RETOMAR_ANUNCIO`, `CONSERTAR_FERRAMENTA`…) | `agent/prompt.py` |
| `anunciou`, `SEM_SHELL`, `SEM_AMBIENTE`, `classificar_pedido`, `pedido_de_acao` | `agent/detection.py` |
| contadores do turno (`silencio`, `blocos`, `retomadas`, `uso`) | `agent/estado.py` |

### Os domínios que existem de verdade: **cinco**

`files`, `shell`, `git`, `web`, `plano`.

**Não são seis.** `browser` é **apelido** de `url_reader` (o despacho trata os dois no mesmo
ramo), e `codigo` (`code_interpreter`) é **variante do shell** — o mesmo runner de processo.
Criar as duas pastas seria inventar domínio.

## 3. Os quatro bloqueios — cada um pede uma decisão, não esforço

### 3.1 `_limitar` dentro da execução

`_formatar` — o formatador da saída de comando — chama `_limitar`, que chama
`limites_de_saida`. Com a árvore acordada, esse módulo é `agent/limites_de_saida.py`, e
`execution → agent` é proibido pela regra.

Saídas possíveis:

1. **injetar o cortador** — `_formatar`/`_rodar`/`_rodar_lista`/`_comecar`/`_acompanhar`
   recebem a função (≈10 assinaturas e chamadas);
2. **gancho de módulo** — `execution` tem um `_LIMITAR` instalado pela camada de
   ferramentas no import (1 linha, comportamento idêntico, mas é estado global);
3. **`limites_de_saida.py` como módulo de raiz** (fora de `agent/`) — a execução pode
   importar módulo de raiz sem violar a regra, mas contraria a árvore acordada.

### 3.2 `definir_limites` mexe em global de dois assuntos

A função é chamada pelo `main.py` e reatribui:

- `LIMITE_SAIDA`, `LIMITE_LEITURA`, `LIMITE_DE_LINHA`, `LIMITE_LISTAGEM` → **arquivos**;
- `TEMPO_COMANDO`, `INATIVIDADE_MAX_S`, `INTERVALO_DE_OLHADA` → **execução**.

Separando os módulos, qualquer `from x import CONST` **congela** o valor e a configuração
para de valer — regressão silenciosa, sem teste que pegue. Precisa de acesso por atributo
(`processo.TEMPO_COMANDO`) ou de um setter por módulo.

### 3.3 `providers/` depende de `tools/loop`

`openai_compat.py` importa `StepResult`, `ToolCall` e o `pensamento` — os tipos do turno
moram no laço. Para `providers/` não depender do agente:

- os tipos (`StepResult`, `ToolCall`, `ToolStep`, `Piece`) precisam sair para
  `providers/base.py`, que é o **contrato do provedor**;
- o `pensamento` (limpador de raciocínio no fluxo) precisa de endereço que o provedor
  alcance — e `providers/` é folha, então **não pode** vir de `agent/`.

### 3.4 `_executar_impl` não é movimento, é refatoração semântica

São ~665 linhas com ~40 ramos `if nome == "..."`, e os ramos compartilham variáveis locais
(`workspace`, `acesso_livre`, `argumentos`, `dono`, `anexos`). "Cada domínio dono do próprio
handler" exige extrair cada ramo para uma função com assinatura própria — e decidir o que
cada uma recebe. É a parte mais delicada da 0.6.3, e a que mais rende: é ela que faz o
arquivo de 3.934 linhas deixar de existir.

## 4. Ordem de execução

1. `policy/` — **feito**
2. `execution/` + `domains/shell/` — **bloqueado em 3.1 e 3.2**
3. `agent/` — bloqueado em 3.3 (os tipos saem do laço)
4. `tools/registry.py` + `tools/dispatcher.py` — bloqueado em 3.4
5. `domains/` (files, git, web, plano) — bloqueado em 3.4
6. `compatibility/` + remover as pontes
7. regra de direção — **feito** (ganha as camadas novas a cada passo)
8. docs/NOTICE

## 5. Por que não cabe num passe só

- **4 blocos** de execução + **4 seções** do laço + **5 domínios** + registro e despacho
  ≈ **25 módulos novos**.
- Cada movimento tem de fechar com a suíte verde, porque os quatro bloqueios acima são
  **silenciosos**: nenhum deles quebra um teste no dia em que é introduzido — quebram o
  comportamento depois, e é exatamente o tipo de defeito que este projeto não aceita.
- O `_executar_impl` sozinho é uma refatoração semântica de ~40 ramos.

O caminho honesto é **um passo por vez, verde em cada um** — não porque falte vontade, mas
porque os bloqueios 3.1 a 3.3 são decisões de desenho que mudam a interface, e tomá-las
sozinho seria inventar o que não foi acordado.
