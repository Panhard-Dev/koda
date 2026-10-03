# Release 0.6.2 — o backend ganhou camadas

**Data:** 03/10/2026 · **Base:** 0.6.0

Esta versão **não muda comportamento**: mesma suíte, mesma porteira, mesmos tetos. O que ela
muda é **onde o código mora** — para que o backend possa crescer sem virar um arquivo de
quatro mil linhas. O documento é parte por parte.

## Resumo

| # | Parte | O que mudou |
| --- | --- | --- |
| 1 | Tetos | viraram infraestrutura compartilhada **e objeto** — e isso corrigiu um defeito real |
| 2 | Execução | a máquina de processo saiu do monolito |
| 3 | Contratos | tipos do turno e construtor de schema num lugar que todas as camadas alcançam |
| 4 | Agente | o laço, o contexto e a repetição saíram de `tools/` |
| 5 | Política | porteira do despacho e aprovação |
| 6 | Registro | o catálogo separado do despacho |
| 7 | Domínios | cada um dono do **próprio schema** |
| 8 | Regra | dependência entre camadas virou teste, com o furo fechado |
| 9 | Pontes | as duas da migração morreram |
| 10 | Números | o monolito encolheu 40% |

---

## 1. Tetos: `app/limits.py`

Os tetos e o corte de saída saíram de `ferramentas.py` para **infraestrutura
compartilhada** — um módulo de raiz, que não é camada: todo mundo importa, e ele não importa
ninguém do projeto.

**Por que raiz e não camada:** a execução precisa cortar a saída de um comando e o agente
precisa do mesmo corte. Se o cortador morasse numa camada, a outra teria de importar para
cima — que é exatamente o que a regra proíbe.

**O defeito que isso corrigiu.** Antes, `definir_limites` (chamada na subida do app)
escrevia em **global de módulo**. Quem tinha feito `from .ferramentas import LIMITE_SAIDA`
ficava com o valor antigo para sempre: a configuração do app valia só em quem lia pelo
módulo. Agora os tetos são um objeto (`RuntimeLimits`) e todos leem o mesmo lugar.

Medido: `definir_limites(saida=1234)` → `LIMITES.saida == 1234` em qualquer módulo.

## 2. Execução: `app/execution/`

A máquina de processo saiu do monolito:

| Arquivo | O que é |
| --- | --- |
| `tempo.py` | prazos e cancelamento (as duas `ContextVar` e os quatro ajudantes) |
| `processo.py` | `subprocess`, ambiente, argumentos, `ComandoRodando`, acompanhamento, encerramento |

**Camada folha:** não importa camada nenhuma do projeto. O que ela precisa de fora vem de
`limits` — é por isso que o cortador mora lá.

## 3. Contratos: `app/contracts/`

| Arquivo | O que é |
| --- | --- |
| `turn.py` | `ToolCall`, `StepResult`, `ToolStep` e `texto_do_conteudo` |
| `tools.py` | o `_def` — como se declara o schema de uma ferramenta |

**Por que os tipos saíram do laço:** o provedor **produz** o `StepResult` e o agente
**consome**. Se os tipos morassem no laço, o provedor importaria o agente — import para
cima. Contrato compartilhado resolve sem inverter nada.

`texto_do_conteudo` foi junto porque é a **forma do turno** (`content` string ou lista de
partes com imagem), e o provedor precisa dela sem importar o agente.

## 4. Agente: `app/agent/`

`loop.py` (o laço), `contexto.py` e `repeticao.py` saíram de `tools/`. O laço é `agent`: ele
pensa, decide o turno e fecha.

## 5. Política: `app/policy/`

| Arquivo | O que é |
| --- | --- |
| `guards.py` | a porteira do despacho — só o que a rodada ofereceu pode ser chamado |
| `approvals.py` | os modos (manual/default/auto/livre) e as regras «sempre/nunca» |

A camada **decide**; não executa e não conhece o laço.

## 6. Registro: `app/tools/registry.py`

O catálogo saiu do arquivo de ferramentas: nomes, apelidos, `canonico`, `_def`,
`DEFINICOES`, os cinco **grupos de restrição** (`FERRAMENTAS_LOCAIS`, `_DE_SHELL`,
`_DO_AMBIENTE`, `_DE_ARQUIVO`, `_WEB`), `ESCRITA` e `CAMINHOS_EXTRA`.

O laço passou a ler do registro (`registry.canonico`, `registry.FERRAMENTAS_*`,
`registry.catalogo`).

## 7. Domínios: `app/tools/domains/`

Cada domínio é **dono do próprio schema** — as 38 ferramentas foram partidas:

| Domínio | Ferramentas |
| --- | ---: |
| `files/` | 21 |
| `git/` | 6 |
| `shell/` | 5 |
| `web/` | 5 |
| `plano/` | 1 |

O registro agora **junta** os domínios em vez de guardar a lista. É isso que faz a
ferramenta nova entrar no domínio dela em vez de engordar um arquivo central.

**Cinco domínios, não seis:** `browser` é apelido de `url_reader` (o despacho trata os dois
no mesmo ramo) e `codigo` é variante do shell — o mesmo executor de processo. Criar as duas
pastas seria inventar domínio.

## 8. A regra de dependência — e o furo que ela tinha

`tests/test_arquitetura.py` percorre a árvore e falha se uma camada importar quem está acima
dela:

```
agent → policy → tools → domains → execution        (e agent → providers)
```

`providers` e `execution` são folhas. `limits`, `contracts`, os módulos de raiz e `routers/`
não são camadas — infraestrutura e porta de entrada importam o que precisam.

**O furo:** a primeira versão olhava só o **primeiro** segmento do caminho. Como os domínios
moram em `tools/domains/`, eles contavam como `tools` e a camada `domains` **nunca era
checada**. Agora a regra pega a camada **mais funda**, e só quando o primeiro segmento já é
camada — `app.contracts.tools` não é camada, nome de módulo não faz camada.

Fechar o furo acusou **5 violações reais** na hora, e todas foram corrigidas movendo o `_def`
para `contracts/tools.py` (o que também tirou um ciclo `registry ↔ domains`).

## 9. Pontes: as duas morreram

| Ponte | Morreu quando |
| --- | --- |
| `tools/guardas.py` | o laço virou `agent/loop.py` e passou a importar `policy/guards` direto |
| `tools/pensamento.py` | o limpador foi para `providers/` e ninguém mais importava daqui |
| `tools/limites_de_saida.py` | o corte virou `limits` e os importadores apontaram para lá |

A lista de pontes e a de pendências da regra estão **vazias**.

## 10. Números

| | Antes (0.6.0) | Agora |
| --- | ---: | ---: |
| `tools/ferramentas.py` | 3.934 | **2.382** |
| `tools/registry.py` | — | 633 |
| `agent/loop.py` | 2.751 *(em tools/)* | 2.699 |
| `execution/` | — | 864 |
| `policy/` | — | 263 |
| `contracts/` | — | 99 |
| `limits.py` | — | 87 |
| pontes na regra | — | **0** |
| pendências na regra | — | **0** |

## 11. Como validar

```bash
cd backend
.venv/Scripts/python.exe e2e_porteira.py          # a porteira, sem depender do modelo
.venv/Scripts/python.exe -m pytest tests/ -q      # 428 testes, inclui a regra de camadas
```

## 12. O que ficou pendente — dito com todas as letras

**Os handlers ainda moram em `ferramentas.py`.** O desenho está completo (as camadas, os
contratos, os schemas por domínio), mas os ~40 ramos de despacho continuam no arquivo de
2.382 linhas.

Tentei movê-los para `tools/dispatcher.py` nesta versão e **revertei**: deu 80 testes
vermelhos. A causa foi medida — os ramos chamam ~29 ajudantes do próprio `ferramentas.py`, e
ajudante **importado por nome não enxerga `monkeypatch`**: os testes trocam
`ferramentas.<ajudante>` e o despacho ficava com a referência antiga.

O caminho certo é mover **cada domínio com os handlers e os ajudantes dele**, um por vez,
com a suíte verde a cada um. Fica para a próxima versão.

## 13. O que **não** mudou

- **Nenhum teto.** Os valores são exatamente os mesmos.
- **Nenhuma rota, nenhum contrato de API.** Nada de fora mudou de forma.
- **O comportamento.** A suíte é a mesma, e a prova da porteira dá o mesmo veredito.
- **O host de modelos.** Intocado.
