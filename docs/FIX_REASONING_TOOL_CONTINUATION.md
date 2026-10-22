# HTTP 400 na continuação com ferramentas

## O que acontecia

Um pedido começava bem, executava ferramentas e, no **segundo** passo, voltava `HTTP 400`
com a mensagem genérica "A Liz AI Studio não aceitou este pedido".

Reproduzido com `liz-4-5-super` num pedido longo — com imagem e sem imagem, com
ferramentas diferentes. Um pedido curto com duas ferramentas passava, então não era falha
de qualquer chamada de ferramenta: era a **continuação** da cadeia.

## A causa (no cliente)

O provedor devolve `reasoning_content` junto da resposta. O cliente aproveitava esse texto
no streaming só para exibir e o descartava ao montar o `StepResult`; o laço montava o turno
do assistente com `content` e `tool_calls`, e nada mais. Quem exige o próprio raciocínio de
volta no passo seguinte recusava o pedido inteiro — e o 400 não dizia qual campo faltava.

O caminho não-streaming (`step()`) descartava o campo do mesmo jeito.

## O que mudou

| Arquivo | Mudança |
|---|---|
| `backend/app/contracts/turn.py` | Campo opcional `StepResult.reasoning_content`, no fim do dataclass para não deslocar construções posicionais. |
| `backend/app/providers/openai_compat.py` | Guarda a string exata no `step()` e concatena os pedaços no `step_streaming()`; o acumulador é limpo entre tentativas. |
| `backend/app/agent/loop.py` | O campo entra no próximo turno do assistente **só quando existe**. |
| `backend/app/agent/contexto.py` | O raciocínio reenviado passa a contar no orçamento de contexto. |

`None` é ausência; `""` é campo presente e vazio — e a distinção é preservada, porque há
provedor que exige o campo mesmo vazio. Valor não textual não é ecoado. IDs, ordem,
argumentos brutos e `extra_content` das ferramentas seguem intactos.

O raciocínio fica **só** no histórico em memória da rodada: não vai para o banco, não entra
em log e não substitui a resposta visível em nenhum caminho.

## Validação

```powershell
cd backend
python -B -m unittest discover -s tests -v
```

Sete testes, sem rede (o transporte é `httpx.MockTransport`) e sem executar ferramenta de
verdade:

1. duas etapas, duas ferramentas, raciocínio fragmentado, pareamento de IDs e
   `extra_content` preservado — o upstream simulado devolve 400 se o campo não voltar;
2. preservação no caminho não-streaming;
3. string vazia ≠ campo ausente;
4. `StepResult` antigo não inventa o campo;
5. raciocínio não textual não é ecoado;
6. o raciocínio conta no orçamento de contexto;
7. a compactação não corta o raciocínio nem separa chamada de resultado.

Também rodados contra os módulos empacotados, com interpretador novo. No app reiniciado, a
conversa que falhava completou uma rodada de nove ferramentas sem o 400 — o que vale para o
caso relatado, e não é garantia para todo modelo.

## Limites

- O campo extra **consome contexto e custo**: numa rodada de nove ferramentas o raciocínio
  volta nove vezes. O orçamento conta; a fatura também sente.
- A compactação pode remover a mensagem inteira do assistente (aí o raciocínio vai junto,
  sem quebrar o pareamento), mas nunca corta o texto do raciocínio pela metade.
- Conversas extremas continuam sujeitas ao limite real do serviço.
- Reinstalar sem esta correção volta ao comportamento antigo: o pacote precisa do
  `backend/` novo (`npm run app:runtime` antes de gerar o instalador).

## Fora de escopo

"Esqueci a senha" ficou para uma alteração separada, depois de confirmar o contrato do
serviço remoto que mantém as contas — o desktop autoriza o host pela sessão da conta, e
mexer só no SQLite local não recupera senha remota. Nenhum endpoint, botão ou mecanismo de
reset foi adicionado aqui.
