---
name: diagnosticar-logs
description: >-
  Diagnostica o que o Painel Dev abriu — site, página, jogo ou aplicação — lendo os erros de
  verdade: console, rede (4xx/5xx) e log do servidor, já sem repetição, cruzando as pontas
  para achar a causa. Orienta a investigar, corrigir e **revalidar nos logs** depois de cada
  correção e reinício, com limite de tentativas e sem declarar sucesso sem prova. Use quando
  o dono pedir "diagnostica os logs", "por que a tela quebrou", "o que está dando erro",
  "corrige o que aparece no painel de logs", "confere se ainda tem erro", ou quando o MCP
  `navegador` abrir uma página que não se comporta.
---

# Diagnosticar pelos logs

Esta skill é um **guia**, não um roteiro obrigatório. O checklist lá embaixo é um menu: use o
que serve ao problema da vez. O que **não** é opcional são as três regras do fim — validar de
verdade, não esconder falha, e parar quando não há progresso.

## O que você tem na mão

Duas ferramentas trabalham juntas, e a segunda existe porque a primeira não basta:

- **`mcp__navegador__*`** — abre a página num Chrome de verdade e a vê por dentro: `abrir`,
  `enxergar`, `ler`, `clicar`, `console`, `rede`, `executar_js`, `recarregar`, `print`.
  Responde "o que o navegador reclamou".
- **`mcp__logs__*`** — junta console, rede **e o log do servidor**, sem repetição. Responde
  "qual é a causa", inclusive quando ela está do outro lado da requisição.

A segunda não substitui a primeira: `console` e `rede` do navegador continuam sendo o caminho
para ler o que a página mandou; o `logs` é o que **cruza** isso com o servidor e tira a
repetição.

### As ferramentas do MCP `logs`

| Ferramenta | Para quê |
|---|---|
| `resumo` | Uma linha: ainda tem erro? quantos graves/leves, quantos novos, algum em laço. |
| `erros` | A lista consolidada. `fonte` (navegador/rede/servidor/todos), `severidade`, `limite`, e `desde: "baseline"` para só o que é novo. |
| `servidor` | Só a ponta do servidor, com arquivo e linha quando o trace traz. |
| `correlacionar` | Cruza uma falha do front com o log do back. Sem argumento, pega a falha grave mais recente. |
| `marcar` | Fixa a marca. **Depois dela**, `erros {desde: "baseline"}` mostra só o que nasceu — é assim que se prova que a correção pegou. |
| `config` | De onde ele está lendo. Use quando "nenhum erro" parecer suspeito. |
| `limpar` | Zera a memória do MCP (assinaturas e marca). As fontes não são tocadas. |

## O ciclo

```
abrir/reproduzir → marcar → erros (diagnosticar) → correlacionar → corrigir → revalidar → parar
```

1. **Reproduza primeiro.** Sem o erro acontecendo, não há o que diagnosticar. `abrir` a página
   (ou `recarregar`), `esperar` ela montar, e só então ler.
2. **`marcar` antes de corrigir.** A marca é o que separa "erro que já existia" de "erro que a
   minha correção introduziu". Marcar depois de corrigir não prova nada.
3. **`erros` e `correlacionar`.** Leia a lista e cruze. Um 500 no front tem causa no back; um
   `TypeError` no console não tem.
4. **Corrija a causa, não o sintoma.** Um `try/catch` que engole o erro não é correção — é o
   erro escondido, e ele volta.
5. **Revalide.** Recarregue (e **reinicie o servidor**, se a correção foi no back) e chame
   `erros {desde: "baseline"}`. Se voltar vazio, a correção pegou. Se voltar algo, você ainda
   não terminou.
6. **Pare.** Terminou quando a lista de novos está vazia **ou** quando você bateu no limite de
   tentativas e reportou o bloqueio. Não continue "conferindo" o que já está confirmado.

## O checklist — menu de referência

### Geral (primeiros passos)

- Reproduzir o erro.
- Identificar ambiente (local, dev, homolog, produção).
- Data e hora exata do erro.
- Frequência (sempre, às vezes, só uma vez).
- Usuário/conta afetada.
- Versão/deploy/commit que gerou o erro.
- O que mudou recentemente.
- Correlation ID / request ID / trace ID.

### Frontend (o que olhar)

- Console do navegador (`errors` e `warnings`).
- Stack trace (arquivo e linha).
- Source maps.
- Aba Network (URL, método, status, payload, response, headers).
- Tempo de resposta da requisição.
- Requisição cancelada, CORS, timeout.
- Token/cookie enviado no header.
- Aba Application (localStorage, sessionStorage, cookies).
- Estado da aplicação (Redux, Context, store).
- Props e estado do componente.
- Erros de renderização (undefined, null, `map` em não-array).
- Navegador, versão e dispositivo; resolução da tela.
- Erros de build e lint.
- Ferramentas de monitoramento (Sentry, LogRocket, Datadog).
- React DevTools / Vue DevTools.

### Backend (o que olhar)

- Nível do log (error, warn, info, debug).
- Stack trace completo.
- Mensagem de exceção.
- Endpoint, método e parâmetros recebidos.
- Body e headers da requisição.
- Status HTTP retornado.
- Usuário autenticado e permissões.
- Logs do banco (query lenta, deadlock, erro de constraint).
- Query SQL gerada.
- Erros de conexão com banco, cache, fila.
- Logs de integrações externas (APIs de terceiros).
- Timeout, memória, CPU.
- Variáveis de ambiente e configurações.
- Logs de deploy e de container (Docker, Kubernetes).
- Logs de servidor (Nginx, Apache, load balancer).
- Ferramentas de monitoramento (Kibana, Grafana, CloudWatch, Datadog).
- Rastreamento entre serviços (tracing).

### Cruzar front e back

- Comparar horário do erro no front com o log do back.
- Comparar payload enviado com payload recebido.
- Verificar contrato da API (Swagger/OpenAPI).
- Verificar status code esperado vs. recebido.
- Verificar formato de datas, números e tipos.
- Verificar campos obrigatórios e nomes dos campos.
- Verificar autenticação (token expirado, header ausente).
- Verificar CORS e proxy.

### O que o dev precisa saber (para ler o que achou)

- Ler stack trace.
- Códigos de status HTTP.
- Como funciona a requisição HTTP.
- Debug (breakpoint, step over, watch).
- Git (log, blame, diff, bisect).
- SQL e leitura de query.
- Autenticação (JWT, sessão, OAuth).
- Variáveis de ambiente.
- Arquitetura do sistema e fluxo dos dados.
- Uso de ferramentas de log e monitoramento.
- Postman / Insomnia / curl para testar a API.

### Depois de achar a causa

- Corrigir a **causa raiz**.
- Escrever teste que cobre o erro.
- Testar em dev/homolog.
- Verificar se há erros parecidos em outros lugares.
- Adicionar log útil no ponto do erro.
- Documentar o erro e a solução.
- Code review.

## As regras duras

### 1. Só afirme com prova

"Corrigi" só vale com os logs de volta. A prova é `erros {desde: "baseline"}` **vazio** depois
da correção — e, se o back foi tocado, depois do **reinício** do servidor. Sem isso, o que
existe é uma hipótese, e hipótese se escreve como hipótese.

Não declare sucesso porque o sintoma sumiu da tela: o mesmo erro pode ter parado de aparecer
por outro motivo (uma requisição que deixou de ser feita, um elemento que não renderizou).
Quem decide é o log.

### 2. Não ignore falha

Erro que você não entendeu não some da lista — ele fica lá e você diz que ficou. Nunca:

- engolir exceção para "limpar" o painel;
- marcar como resolvido o que não foi reproduzido de novo;
- reduzir a severidade para o erro parar de incomodar;
- dizer "provavelmente é X" sem ter olhado X.

Se um erro é real e não dá para corrigir agora, ele entra no relatório final como **pendente**,
com o texto que o log mostrou.

### 3. Limite de tentativas — e bloqueio se não houver progresso

Sem limite, "corrigir erro" vira laço infinito: mexer, revalidar, mexer de novo no mesmo
lugar. O teto é este:

- **3 tentativas por erro.** Depois da terceira, pare.
- **2 voltas de `corrigir → revalidar` sem evidência nova.** Se a segunda volta não trouxe
  informação que a primeira não tinha (uma linha de log diferente, um valor diferente, um
  arquivo diferente), pare.
- Ao parar por limite, **não** diga que resolveu. Escreva: o que tentou, o que cada tentativa
  mostrou, e o erro que continua pendente — com o texto do log.

Bloqueio não é fracasso; esconder o bloqueio é. Três causas comuns de bloqueio, e o que dizer:

- **a causa está fora do seu alcance** (chave de API, serviço de terceiro fora do ar, permissão
  de servidor): diga qual é e o que o log mostrou;
- **não dá para reproduzir**: diga que não reproduziu, e o que tentou;
- **a correção depende de reiniciar algo que você não reinicia**: diga o que precisa ser
  reiniciado e por quê.

### 4. Não entre em laço

O laço tem duas formas, e as duas aparecem nos logs:

- **o erro se repete** — o MCP marca `repetindo` e conta `×N`. Se `ocorrencias` só cresce a
  cada `erros`, sua correção não pegou: **pare e releia**, não repita a mesma tentativa.
- **você se repete** — chamar `erros` de novo sem ter mudado nada não traz informação. Entre
  duas leituras tem de haver uma ação: uma correção, um reinício, uma reprodução.

Se você se pegar chamando as mesmas ferramentas com os mesmos argumentos, pare e reporte.

## Revalidar depois de correção e de reinício

A ordem importa:

1. `marcar` — **antes** de mexer (ou imediatamente depois de reiniciar, se o reinício é o que
   introduz a mudança).
2. Aplique a correção.
3. Se a correção foi no **front**: `recarregar` e `esperar`.
   Se foi no **back**: reinicie o servidor e só então `recarregar`.
4. `erros {desde: "baseline"}`. Vazio = pegou. Com itens = ainda não.
5. `resumo` para fechar: o estado tem de ser "LIMPO" (ou ter só os pendentes que você decidiu
   reportar).

**Reiniciar sem revalidar não prova nada.** O servidor que voltou pode estar com o erro antigo
em memória, e um log que não foi relido é um log que não foi conferido.

## Pegadinhas

- **O MCP `logs` lê o log do servidor pelo caminho convencionado** (`data/dev-server.log`) ou
  pelo que estiver em `KODA_DEV_SERVER_LOG`. Se `config` disser que não achou, **diga que não
  achou** — não conclua que o servidor está limpo. "Sem log do servidor" e "servidor sem erro"
  são coisas diferentes.
- **Depois de editar o código do MCP**, a conexão já aberta continua com a versão velha:
  recicle com `POST /api/mcps/<nome>/toggle` duas vezes, ou reinicie o backend.
- **`localhost` e não `127.0.0.1`** ao abrir a página: nesta máquina o `127.0.0.1` passa por
  proxy e fica lento.
- **Espere a tela montar** (`esperar`) entre agir e ler. Ler antes da hora devolve o estado
  anterior, e a conclusão sai errada sem avisar.
- **Um erro que aparece só no console pode ser sintoma, não causa.** O `correlacionar` existe
  para isso: se ele não achar nada no servidor, é sinal de que a falha é do cliente — e o
  contrário também vale.

## O que provar no fim

Um relatório curto, com número:

- **o que estava quebrado**, com a linha do log que prova (texto + arquivo:linha);
- **a causa**, e como o `correlacionar` mostrou (ou por que não deu para correlacionar);
- **o que foi mudado**, arquivo por arquivo;
- **a revalidação**: o resultado de `erros {desde: "baseline"}` depois da correção — e depois
  do reinício, quando houve reinício;
- **o que ficou pendente**, com o texto do log, se ficou algo.
