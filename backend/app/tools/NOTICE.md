# Código de terceiros (atribuição)

Os módulos deste pacote foram escritos a partir de **código de terceiros sob licença MIT** —
o texto da licença e o titular do copyright estão em `LICENSE.koda` (o nome do arquivo segue
o padrão do projeto; o **texto é o original, sem uma vírgula de diferença**).

A atribuição fica porque a licença exige preservar o aviso de copyright. Ela **não** aparece
no produto: os módulos daqui são reescritos no contrato do Koda — nomes, mensagens e
comentários em português — e nenhum deles importa código de fora do projeto.

## O que existe aqui

| Arquivo | O que é |
| --- | --- |
| `ferramentas.py` | catálogo e handlers das ferramentas locais |
| `loop.py` | o laço do agente: prompt, portões de parada e despacho de ferramenta |
| `guardas.py` | a porteira do despacho — só o que a rodada ofereceu pode ser chamado |
| `pensamento.py` | limpeza de blocos de raciocínio no texto que vai à tela |
| `repeticao.py` | detecção de eco/degeneração da resposta |
| `limites_de_saida.py` | corte de saída longa com cabeça e cauda |

Até a 0.5.2 esta pasta carregava **325 arquivos**: a cópia de referência inteira, quase toda
sem uso e sem carregar. Na 0.6.0 o que não é usado saiu do pacote — foi para
`backend/material-referencia/`, que fica fora do repositório e fora do instalador.
