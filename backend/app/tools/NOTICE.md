# Código de terceiros (vendorizado)

Esta pasta é uma **cópia de código de terceiros**, redistribuída sob a licença **MIT** — o
texto completo e o titular do copyright estão em `LICENSE.koda` (o nome do arquivo segue o
padrão do projeto; o **texto é o original, sem uma vírgula de diferença**).

Ela existe como **referência de implementação** e **não é importada pelo Koda**. Os arquivos
daqui dependem de um runtime que não existe neste projeto (`agent.*`, `plugins.*`,
`model_config`, `tools.registry`), então rodá-los direto não funciona.

Nomes de arquivo, de módulo e de variável foram renomeados para manter a consistência do
projeto. A **atribuição da licença não foi alterada**: o aviso de copyright e o texto da
permissão seguem intactos em `LICENSE.koda`, como a MIT exige.

O que o Koda realmente usa, já adaptado:

- `backend/app/tools/ferramentas.py` — catálogo e handlers (nomes, descrições "use isto em
  vez de X no shell" e apelidos portados da referência);
- `backend/app/tools/loop.py` — prompt do agente com o enforcement e o roteamento
  obrigatório de ferramenta portados da referência.

Ao portar qualquer coisa daqui, traga a ideia e reescreva no contrato do Koda
(`_def`/handlers de `ferramentas.py`) — não importe os módulos desta pasta.
