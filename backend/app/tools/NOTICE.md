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
| `ferramentas.py` | os handlers das ferramentas e as utilidades que eles usam |
| `registry.py` | o catálogo: nomes, apelidos, grupos de restrição e o despacho (`executar`) |
| `domains/` | o **schema** de cada domínio — `files`, `shell`, `git`, `web`, `plano` |

O resto da arquitetura mora fora daqui: o laço é `app/agent/`, a máquina de processo é
`app/execution/`, a decisão é `app/policy/`, os contratos são `app/contracts/` e os tetos são
`app/limits.py`.

Até a 0.5.2 esta pasta carregava **325 arquivos**: a cópia de referência inteira, quase toda
sem uso e sem carregar. Na 0.6.3 o que não é usado saiu do pacote — foi para
`backend/material-referencia/`, que fica fora do repositório e fora do instalador.
