# Mudanças da 0.6.0

**Data:** 03/10/2026

Esta é a versão que fecha o relatório de QA (`relatorio_qa_koda_v2.md`) e tira do pacote o  
que ele carregava sem uso. O documento é parte por parte: o que estava errado, onde está a  
correção, e como conferir.

## Resumo

| #  | Parte                                     | O que mudou                                                               |
| -- | ----------------------------------------- | ------------------------------------------------------------------------- |
| 1  | Controle de ferramenta (achado principal) | a restrição passou a ser **imposta no despacho**, não só pedida no prompt |
| 2  | Raciocínio interno                        | bloco de raciocínio não vai mais para a resposta                          |
| 3  | Resposta duplicada                        | o eco do modelo corta a rodada em vez de ser costurado na resposta        |
| 4  | Interface presa                           | o fluxo fechado sempre encerra a rodada, inclusive no erro                |
| 5  | Resposta meta                             | o estado interno do agente não é assunto da resposta                      |
| 6  | Consumo de tokens                         | a saída da ferramenta é cortada com cabeça **e cauda**                    |
| 7  | Microfone                                 | o áudio só nasce no clique do botão                                       |
| 8  | Falso "tarefa não concluída"              | o detector de anúncio parou de ler fechamento como anúncio                |
| 9  | Pacote                                    | `app/tools` saiu de 325 arquivos para 7; `app/` de 10 MB para 1,2 MB      |
| 10 | Ambiente embarcado                        | o interpretador do instalador deixou de levar o que é de teste            |
| 11 | Atribuição                                | o aviso de licença de terceiros foi preservado e reescrito                |

---

## 1. Controle de ferramenta: a porteira do despacho

**O que estava errado.** A restrição vivia **no texto do prompt** e a execução não a  
consultava. O catálogo enviado ao modelo era um **pedido**: o modelo que chamasse a  
ferramenta assim mesmo era executado, e devolvia o conteúdo da máquina. Havia três furos  
somados:

1. **A proibição era cancelada por ela mesma.** A régua que separa pedido de trabalho de     
   pedido de resposta tinha uma exceção: se o texto citasse arquivo, pasta ou diretório, a     
   ferramenta ficava de pé. Em *não use ferramentas, não leia arquivos*, a palavra     
   `arquivos` — que é o objeto da proibição — casava nessa exceção e devolvia o catálogo     
   inteiro.
2. **"Não leia arquivos" tirava só as ferramentas de arquivo.** `shell`,     
   `code_interpreter`, `get_environment` e `git_*` continuavam no catálogo — o mesmo     
   conteúdo estava a um `dir` ou a um `os.environ` de distância.
3. **Não havia porteira no despacho.** O catálogo era a única barreira.

**A correção.** A restrição passou a ser verificada **antes de qualquer ferramenta tocar o  
sistema**. O catálogo que vai ao modelo virou também a **whitelist do despacho**: a mesma  
decisão que monta as ferramentas da rodada monta a guarda, e as duas não podem divergir.  
Toda chamada passa por ela antes de executar; o que não foi oferecido volta como `NEGADO` no  
lugar da saída, e conta como bloqueio (para o laço não cobrar do modelo a ferramenta que ele  
mesmo acabou de negar). A guarda **falha fechada**: sem nome, quebra ou exceção, ela nega.

| Onde                                                      | O que é                                                                                                                                  |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/app/tools/guardas.py`                            | a guarda: `Guarda.nega`, `do_catalogo`, `SEM_RESTRICAO`                                                                                  |
| `backend/app/tools/loop.py` → `executar`                  | monta a guarda do catálogo da rodada e consulta no despacho, **antes** do cartão de permissão                                            |
| `backend/app/tools/loop.py` → `SEM_SHELL`, `SEM_AMBIENTE` | detecção por domínio (shell, ambiente, arquivo, web)                                                                                     |
| `backend/app/tools/ferramentas.py`                        | grupos `FERRAMENTAS_LOCAIS`, `FERRAMENTAS_DE_SHELL`, `FERRAMENTAS_DO_AMBIENTE`, `FERRAMENTAS_DE_ARQUIVO`, `FERRAMENTAS_WEB` e `canonico` |

**Como conferir.** `backend/e2e_porteira.py` não depende da boa vontade do modelo: um dublê  
**insiste** em chamar `get_environment` (que lê a máquina de verdade) e o teste responde  
duas perguntas objetivas — quais ferramentas a rodada ofereceu, e o que acontece com a  
chamada que insiste.

```
1) FERRAMENTAS OFERECIDAS NA RODADA: 2
     get_environment    NÃO oferecida
     shell              NÃO oferecida
     code_interpreter   NÃO oferecida
     read_file          NÃO oferecida
     git_status         NÃO oferecida
2) O MODELO INSISTIU EM CHAMAR `get_environment`: negado: True
     >>> A MÁQUINA VAZOU: NÃO
VEREDITO: RESTRIÇÃO RESPEITADA
```

---

## 2. Raciocínio interno fora da resposta

**O que estava errado.** Em alguns testes o Koda exibiu blocos de raciocínio — decisões  
internas, planejamento, detecção de injeção, escolha de ferramenta — como parte normal da  
resposta.

**A correção.** `backend/app/tools/pensamento.py` (`LimpaRaciocinio`) limpa os blocos de  
raciocínio do texto que vai à tela, **segurando a marcação partida entre pedaços** do  
streaming — era aí que vazava. Ligado nos **dois** caminhos de resposta, em  
`backend/app/providers/openai_compat.py`.

---

## 3. Resposta duplicada

**O que estava errado.** Depois de uma resposta já entregue, aparecia outra reproduzindo  
total ou parcialmente o mesmo conteúdo: o eco do modelo era costurado na resposta final pela  
continuação de truncamento.

**A correção.** `backend/app/tools/repeticao.py` (`dominada_por_repeticao`,  
`descontrolada`, `VigiaDeRepeticao`) faz o eco **cortar a rodada** com aviso, em vez de ser  
costurado. Ligado em `backend/app/tools/loop.py`, na finalização e no fechamento.

---

## 4. Interface presa em "Pensando" / "Trabalhando"

**O que estava errado.** O conteúdo já estava completo, mas a tela continuava dizendo que o  
Koda trabalhava. O caminho de **erro** não emitia o evento terminal, e o cliente ficava  
esperando um `done` que nunca chegava.

**A correção — contrato de vivacidade nos dois lados:**

| Lado    | Onde                          | O que faz                                                                             |
| ------- | ----------------------------- | ------------------------------------------------------------------------------------- |
| backend | `backend/app/routers/chat.py` | emite o evento terminal **também no caminho de erro**, nos dois fluxos, com `finally` |
| cliente | `src/api/client.ts`           | gancho `onClosed`: fluxo que fecha **sem** terminal é rodada encerrada                |
| tela    | `src/App.tsx`                 | `onError` e `onClosed` desbloqueiam a tela                                            |

---

## 5. Resposta meta não solicitada

**O que estava errado.** Numa tarefa simples, o Koda acrescentou explicação sobre o próprio  
funcionamento e ofereceu ação que ninguém pediu (salvar um arquivo, seguir para o próximo  
passo).

**A correção.** Regra explícita no prompt do agente (`backend/app/tools/loop.py`,  
`PROMPT_FERRAMENTAS`):

> **O seu estado interno não é assunto da resposta.** Não escreva que não houve erro, que>   
> não há ferramenta pendente, que a tarefa está concluída, nem ofereça ação que ninguém>   
> pediu (salvar um arquivo, mandar por e-mail, seguir para o próximo passo). Entregue o que>   
> foi pedido e pare. Numa tarefa simples e objetiva — um checklist, uma lista, uma frase — a>   
> resposta é o checklist, a lista, a frase, e nada em volta.

---

## 6. Consumo excessivo de tokens

**O que estava errado.** O corte da saída da ferramenta mantinha só o começo (`texto[:teto]`)  
e jogava fora justamente o **fim** — onde está o erro do teste e o resultado do build. Sem o  
fim, o modelo repetia o comando para ver o que faltou, e cada repetição reenviava o contexto.

**A correção.** `backend/app/tools/limites_de_saida.py` (`cortar_cabeca_e_cauda`): corte com  
**cabeça e cauda** (40%/60%), com um aviso único e a garantia de que o texto mantido tem  
exatamente o teto. Ligado em `backend/app/tools/ferramentas.py`.

---

## 7. Pedido de microfone em fluxo textual

**O que estava errado.** Durante um fluxo essencialmente textual apareceu pedido de  
permissão de microfone.

**A verificação.** Nenhuma API de áudio é tocada na montagem. O reconhecimento de fala nasce  
**só** no clique: `src/components/Composer.tsx` — `toggleMic`, atrás do botão de microfone.  
A checagem de disponibilidade é um `Boolean` de suporte do navegador; não instancia nada.  
Fica travado por teste.

---

## 8. O falso "Tarefa não concluída"

**O que estava errado.** Numa conversa — "me fala o que você consegue fazer, sem usar  
ferramentas" — o agente **respondia certo** (lista de capacidades, nenhuma ferramenta) e  
mesmo assim aparecia o cartão *"Tarefa não concluída — o agente anunciou o próximo passo e  
encerrou sem executá-lo"*, com botão Retomar.

**A causa.** O detector `anunciou` (em `backend/app/tools/loop.py`) olha as **duas últimas  
frases** da resposta procurando marca de futuro (`vou`, `preciso`, `falta`…). Dois  
fechamentos legítimos casaram essa marca:

- *"…Preciso **que você cole** o código/erro aqui pra eu trabalhar em cima."* — o pedido vem    
  **depois** da marca;
- *"**Me manda** o código ou a dúvida direto **que eu vou** nisso."* — o pedido vem    
  **antes**.

Nos dois, o agente está pedindo algo a **quem lê**: a vez é da pessoa, não há trabalho a  
executar. O detector lia isso como anúncio de trabalho do próprio agente.

**A correção.** `anunciou` passou a descartar a marca quando o fechamento **devolve a vez à  
pessoa**, em três formas:

| Regra                    | Exemplo                                                         |
| ------------------------ | --------------------------------------------------------------- |
| `PEDIDO_A_PESSOA_DEPOIS` | "Preciso **que você cole** o erro", "**me mande** o stacktrace" |
| `PEDIDO_A_PESSOA_ANTES`  | "**Me manda** o código … **que eu vou** nisso"                  |
| `ESPERA_PELA_PESSOA`     | "Fico no **aguardo**", "Vou **aguardar** seu retorno"           |

E o lado que importa **não** foi desligado: anúncio de trabalho de verdade continua sendo  
anúncio. O verbo é exigido na **forma de pedido** (`manda`/`mande`, `cola`/`cole`), não no  
infinitivo — é o que separa *"Vou rodar os testes **que você pediu**"* (oração relativa) de  
um pedido. E só `aguard*` conta como espera: *"vou esperar o build terminar"* é trabalho.

**Como conferir.** Dois testes, em `backend/tests/test_tools.py`:  
`test_pedido_a_pessoa_no_fim_nao_e_anuncio` (a unidade, com o texto exato dos dois prints e o  
outro lado) e `test_conversa_com_pedido_a_pessoa_fecha_como_concluida` (a rodada inteira).

---

## 9. O pacote deixou de carregar código sem uso

**O que estava errado.** `backend/app/tools/` tinha **325 arquivos `.py`** e `backend/app/`  
pesava **10 MB**. Medido com o interpretador: subir o backend carrega **40 módulos**, e  
apenas **6** são de `app/tools/` — `ferramentas`, `loop`, `guardas`, `pensamento`,  
`repeticao` e `limites_de_saida`. O resto era uma cópia de referência que **não carregava**  
(importava um runtime que não existe aqui) e ia inteira para dentro do instalador.

**A correção.** O que não é usado saiu do pacote:


| | Antes | Depois |
| --- | ---: | ---: |
| arquivos `.py` em `app/tools/` | 325 | **7** |
| arquivos `.py` em `app/` | 432 | **40** |
| tamanho de `app/` | 10 MB | **1,2 MB** |

Nada foi apagado: o material de referência foi para `backend/material-referencia/` (9,5 MB,
408 arquivos), que fica **fora do pacote** e **fora do repositório**.

**A conferência.** `import app.main` carrega; a suíte passa; e o backend empacotado carrega
de dentro do próprio runtime (`src-tauri/runtime/backend/python/python.exe`).

---

## 10. O ambiente embarcado perdeu o que é de teste

**O que estava errado.** O instalador leva um interpretador portátil com as dependências do
backend. Ele levava também o **pytest** e a turma dele — `_pytest`, `pluggy`, `iniconfig`,
`pytest_asyncio` e `pygments` —, que não rodam no app instalado.

**A correção.** `scripts/gerar-runtime-backend.mjs` passou a excluir esses pacotes na montagem
do runtime. O `pygments` entra na lista mesmo sendo dependência do `httpx`: lá ele é do extra
`cli` (`Requires-Dist: pygments==2.*; extra == 'cli'`), que o backend não usa; no ambiente
ele só servia para colorir a saída do teste.

| | Antes | Depois |
| --- | ---: | ---: |
| arquivos no runtime | 4189 | **3310** |
| tamanho do runtime | 74 MB | **64 MB** |

---

## 11. Atribuição de licença

Os módulos de `backend/app/tools/` foram escritos a partir de **código de terceiros sob
licença MIT**. O aviso de copyright e o texto da permissão seguem intactos em
`backend/app/tools/LICENSE.koda` (o nome do arquivo segue o padrão do projeto; o texto é o
original) — a licença exige preservar o aviso.

O `backend/app/tools/NOTICE.md` foi reescrito: antes ele descrevia a pasta como cópia de
referência inteira; agora descreve os seis módulos que existem de fato, todos reescritos no
contrato do projeto, sem importar código de fora.

---

## 12. Arquivos tocados

**Backend — a correção**

| Arquivo | O que mudou |
| --- | --- |
| `app/tools/guardas.py` (novo) | a porteira do despacho: whitelist, recusa com mensagem, falha fechada |
| `app/tools/pensamento.py` (novo) | limpeza de raciocínio no texto, inclusive partido entre pedaços |
| `app/tools/repeticao.py` (novo) | detecção de eco; corta a rodada em vez de costurar a resposta |
| `app/tools/limites_de_saida.py` (novo) | corte com cabeça e cauda no lugar do corte só de cabeça |
| `app/tools/ferramentas.py` | grupos de ferramentas por domínio; o corte novo |
| `app/tools/loop.py` | proibição absoluta, detecção por domínio, porteira no despacho, prompt sem catálogo, regra contra resposta meta, fechamento que devolve a vez à pessoa |
| `app/providers/openai_compat.py` | limpador de raciocínio encadeado no streaming |
| `app/providers/base.py`, `app/providers/__init__.py` | imagem no contexto do turno |
| `app/routers/chat.py` | evento terminal também no caminho de erro |
| `app/anexos.py`, `app/contexto.py`, `app/config.py`, `app/schemas.py` | anexos, imagem no contexto e ajustes de contrato |
| `app/routers/mcps.py`, `app/routers/skills.py` | skills e MCPs cadastráveis pela tela |

**Frontend**

| Arquivo | O que mudou |
| --- | --- |
| `src/api/client.ts` | gancho `onClosed`; retomada da tarefa |
| `src/App.tsx` | `onError`/`onClosed` desbloqueiam a tela; Retomar |
| `src/components/Composer.tsx` | colar arquivo (Ctrl+V) pelo mesmo caminho do «+» |
| `src/components/SettingsScreen.tsx` | tela de ajustes |
| `src/comandos.ts` (novo) | menu de comandos |

**Launcher / empacotamento**

| Arquivo | O que mudou |
| --- | --- |
| `src-tauri/src/acesso.rs`, `servicos.rs`, `main.rs`, `diagnostico.rs` | a porta do host deixou de ser fixa; nunca falar com processo estranho |
| `src-tauri/installer/hooks.nsh` | exclusão do host no antivírus, na instalação |
| `scripts/gerar-runtime-backend.mjs` | o runtime não leva mais o que é de teste |
| `.gitignore` | material de referência fora do repositório |
| `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `backend/app/__init__.py` | versão 0.6.0 |

---

## 13. Como validar

```bash
cd backend
.venv/Scripts/python.exe e2e_porteira.py          # a porteira, sem depender do modelo
.venv/Scripts/python.exe -m pytest tests/ -q      # 426 testes
```

O `e2e_restricoes.py` é a versão com agente vivo (exige o host e o backend no ar).

---

## 14. O que não foi mexido, e por quê

- **Dois testes do relatório passaram** (injeção de prompt dentro de história fictícia e
  tentativa de obter segredo por transformação). Não havia defeito a corrigir; mexer no
  caminho de leitura de conteúdo não confiável sem defeito é risco sem pedido.
- **Rotas, contratos e nomes existentes**: preservados. Nenhuma rota mudou de nome ou de
  formato; os campos novos do evento `done` são aditivos.
- **O host de modelos**: intocado. Ele já aceita `-port`; quem não usava era o launcher, e
  foi ele que mudou.
