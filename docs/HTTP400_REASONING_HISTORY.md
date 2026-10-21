# HTTP 400 após continuar uma conversa com ferramentas

A primeira correção preservava `reasoning_content` somente entre passos do loop em memória. Ao salvar e reconstruir uma conversa, esse campo era descartado. Um serviço que exige sua devolução em thinking com ferramentas podia rejeitar o próximo pedido com HTTP 400. A mensagem genérica na interface escondia o erro upstream sobre ausência de `reasoning_content`.

Esta alteração adiciona persistência SQLite privada e migração aditiva, restaura o campo no histórico do agente Host e conserva metadados opacos das chamadas sem permitir sobrescrita dos campos estruturais. Os campos privados ficam excluídos dos modelos públicos/API/SSE. O orçamento passa a contar o estado preservado, mantendo o pedido atual mesmo se ele sozinho exceder o limite.

Mensagens antigas já perderam seu conteúdo privado; a compatibilidade envia um campo vazio explícito, sem inventar texto. A reconstrução histórica existente continua agrupando chamadas da mesma mensagem: não se afirma reprodução exata de cada resposta original.

Regressões cobrem handlers de texto/agente, sucesso e erro, armazenamento/reabertura, migração idempotente, isolamento de API/SSE, histórico com 45 chamadas e transporte de metadados no loop real sem repetir ferramenta. Executar `python -B -m unittest discover -s tests -v` com as dependências do backend.

Validação no aplicativo: um teste somente leitura concluiu na conversa histórica que havia falhado, usando Liz 4.5 Super e esforço máximo no Windows 10. Isso comprova o caminho exercitado; não garante todas as tarefas longas nem todas as causas possíveis de HTTP 400. A variante instalada no Windows 11 preserva ajustes locais preexistentes de timeout/contexto, que não fazem parte desta PR.

Aplicações manuais exigem backup consistente do banco e dos arquivos, Koda completamente fechado e comparação dos hashes de origem. O pacote anterior de quatro arquivos não contém esta correção de persistência. Não houve alteração de credenciais, endpoint, contas ou permissões de ferramentas.
