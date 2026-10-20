# Correção do HTTP 400 na continuação com ferramentas

Data: 20/10/2026. Escopo: preservar `reasoning_content` entre passos da mesma rodada. Esta alteração não inclui recuperação de senha.

## Problema e causa no cliente

Um pedido podia iniciar normalmente, executar ferramentas e falhar no segundo passo com `HTTP 400` e a mensagem genérica “A Liz AI Studio não aceitou este pedido”. O problema foi reproduzido com `liz-4-5-super` em um pedido longo, tanto com imagem quanto sem imagem, e com ferramentas diferentes. Um teste curto com duas ferramentas passou na versão anterior; portanto, não era uma falha universal de qualquer chamada de ferramenta.

O cliente recebia `reasoning_content` do provedor, mas o descartava ao construir `StepResult`. O loop montava o próximo turno do assistente apenas com `content` e `tool_calls`. Isso perdia o campo exigido por provedores que precisam receber seu raciocínio original na continuação da cadeia de ferramentas. O caminho não-streaming também descartava o campo.

Um upstream sintético que exige esse contrato reproduziu a rejeição com o código anterior. Após a correção local e reinício do aplicativo, o usuário confirmou a resolução; a conversa que falhava completou uma rodada com nove chamadas de ferramentas e sem o HTTP 400. Uma chamada de shell teve falha pontual durante essa rodada, mas o agente continuou e concluiu; isso não equivale a afirmar sucesso de todas as ferramentas ou aceite geral do aplicativo. A mensagem genérica do host não revelou o diagnóstico técnico upstream nem sua identidade real.

## Alteração

| Arquivo | Mudança |
|---|---|
| `backend/app/contracts/turn.py` | Campo opcional `StepResult.reasoning_content`, acrescentado ao final para manter compatibilidade com construções anteriores. |
| `backend/app/providers/openai_compat.py` | Preserva a string exata no modo não-streaming e concatena os fragmentos no streaming; limpa o acumulador entre tentativas já existentes. |
| `backend/app/agent/loop.py` | Inclui o campo no próximo turno do assistente somente quando presente. |
| `backend/app/agent/contexto.py` | Inclui o raciocínio reenviado na estimativa de contexto. |

`None` significa ausência; `""` continua sendo um campo explicitamente vazio. Valores não textuais não são ecoados. IDs, ordem, argumentos brutos e metadados opacos das ferramentas são preservados. Não há nova tentativa de execução, mudança de permissões/credenciais nem gravação adicional do campo no banco ou nos logs. O raciocínio fica no histórico em memória e retorna ao mesmo provedor durante a rodada.

O patch de release contém apenas essa correção: diferenças locais preexistentes no comportamento de planejamento do aplicativo instalado não foram copiadas para esta branch.

## Validação

Seis testes determinísticos cobrem:

1. Duas etapas com duas ferramentas, reasoning fragmentado, pareamento dos IDs e preservação de `extra_content`; o upstream simulado devolve 400 se o campo original não voltar.
2. Preservação no caminho não-streaming.
3. Distinção entre string vazia e campo ausente no streaming.
4. Compatibilidade com `StepResult` anterior sem reasoning.
5. Rejeição de reasoning não textual no eco.
6. Contagem do reasoning no orçamento de contexto.

Executar a partir de `backend/`, com as dependências do backend disponíveis:

```powershell
python -B -m unittest discover -s tests -v
```

Os testes usam `httpx.MockTransport`: não fazem geração real, não usam conta/sessão, não executam ferramentas do usuário e não alteram o banco. Também passaram contra os módulos instalados, carregados por um interpretador novo. Isso foi separado da confirmação real após reiniciar o desktop; o processo já aberto mantinha os módulos antigos em memória até o reinício.

A revisão técnica foi limitada ao diff da correção e dividida por arquivos para evitar truncamento do material. As partes finais receberam GO para um teste controlado. Tratou-se de revisão degradada da mesma família de apoio, não aceite independente entre famílias. Apontamentos gerais preexistentes sobre o agente não foram tratados como corrigidos por este patch.

## Cuidados para a próxima versão

- Incluir os quatro arquivos no backend empacotado e executar os testes acima.
- Verificar uma continuação real com reasoning e ferramentas depois de reiniciar o aplicativo instalado.
- Não substituir `reasoning_content` por texto inventado, resumo ou resposta visível.
- Preservar o campo sem adicioná-lo a logs, relatórios de suporte ou persistência desnecessária.
- O campo adicional consome contexto. A compactação existente reduz `content` e pode remover mensagens inteiras, mas não deve cortar arbitrariamente os bytes de reasoning exigidos pelo provedor. Conversas extremas continuam sujeitas aos limites reais do serviço.
- Uma atualização/reinstalação sem este patch pode substituir a correção local; este PR é o caminho para incluí-la no próximo pacote oficial.

## Próxima etapa: “Esqueci a senha”

Solicitação registrada para uma alteração separada, após integrar esta correção. Antes de implementar, confirmar o contrato do serviço remoto que mantém as contas: o desktop usa a sessão da conta para autorizar o host, e alterar apenas o SQLite local não recupera a senha remota.

A próxima etapa deverá definir o fluxo de solicitação e confirmação, canal de recuperação previamente verificado, token de uso único com validade curta, nova senha, limites de tentativas, mensagens que não exponham a existência de contas e política de invalidação de sessões. Nenhum endpoint, botão ou mecanismo de reset foi adicionado nesta correção.
