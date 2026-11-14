# Auditoria Koda — resultado em 23/10/2026

As correções preservam o fluxo de uso e tratam autorização no servidor, isolamento de dados e efeitos reais das ferramentas. Este relatório distingue implementação, evidência e limites; não declara todos os achados universalmente encerrados.

## Escopo de publicação vigente

A orientação mais recente do usuário autorizou atualizar também o Worker e as migrações necessárias em produção, para compatibilidade com o novo instalador. Worker e migrações 0005/0006 foram publicados e conferidos. O rollout está registrado em `production-rollout.json`, com backup consistente e bloqueio temporário financeiro já encerrado. O EXE será enviado ao R2 com URL direto e hash; a release do atualizador não é ativada automaticamente. Recursos remotos de auditoria são separados de produção.

## Evidências

- Backend: **100 testes e 15 subtestes passaram**, incluindo quatro testes nativos Windows e dois de morte abrupta do processo durante gravação de anexo. Um aviso de depreciação Starlette/httpx permanece registrado.
- Cloud: **10 testes passaram**, incluindo conflitos de intenção, 100 reenvios, compras concorrentes, rollback, estorno e atualização sem downgrade indevido. TypeScript do servidor passou.
- Frontend: TypeScript e build Vite passaram no pipeline Windows.
- Staging: Worker HTTPS com perfil production; dois D1 exclusivos. Backup restaurado em SQLite e no segundo D1 remoto, ledger concorrente e manutenção financeira validados. Evidência: `server/audit/staging-results.json`.
- Cópia real do D1 de produção: migrações 0005 e 0006 preservaram hashes e contagens de todas as tabelas existentes; integrity_check e foreign_key_check sem erro; restauração conferida. Evidência: `production-migration-rehearsal.json`. Esse ensaio em cópia não escreveu em produção. Posteriormente, as migrações foram aplicadas no D1 de produção sob bloqueio financeiro e conferidas; ver `production-rollout.json`.
- Runtime Python distribuído: HTTP, stream, persistência, permissões e remoção de anexo passaram. Proteção nativa também passou no Python 3.13 portátil. A primeira tentativa atingiu o limite de 60 s antes de abrir a API; repetição com diagnóstico de imports e o mesmo limite passou. O primeiro log foi preservado em `runtime-first-attempt.txt`; não houve mudança de código do produto ou afrouxamento de asserções para esse resultado.
- Instalador: consultar `PUBLICACAO.md` e logs desta pasta para resultado final e hashes.

## Ponto a ponto

| Achado | Estado | Implementação / limite |
|---|---|---|
| A01 | Corrigido | Negação não aprova; decisão estruturada, plano imutável e consumo único. |
| A02 | Corrigido | Resultado tipado separa bloqueado, executado e sucesso; bloqueio não conta como entrega. |
| A03 | Implementado com limites | Evidência local de existência/hash/conteúdo/sintaxe/move/delete é persistida; mera leitura não conclui edição. Não certifica efeitos de toda ferramenta remota. |
| A04 | Corrigido | Verificador determinístico de leitura ativo antes da conclusão. |
| A05 | Corrigido | Botão Fazer envia decisão vinculada ao ID e snapshot do plano. |
| A06 | Refatorado | Prompt base reduzido; Plan separado; apresentação visual/interativa condicional, preservada por padrão. |
| A07 | Corrigido | Registry central de schemas/aliases e teste de contrato com handlers. |
| A08 | Corrigido | Eventos de controle internos usam papel system; fala humana permanece humana. |
| A09 | Corrigido | Skills são conteúdo externo; limites independentes do texto. |
| A10 | Corrigido | Comprimento da conversa não eleva autoridade de execução. |
| A11 | Corrigido no Windows | Estado privado protegido por DPAPI e retenção de sete dias; ausente do JSON público. Sem persistência plaintext fora de Windows. |
| A12 | Corrigido | Removido incentivo textual a expor raciocínio; opções do provider preservadas. |
| A13 | Corrigido | Consultas e exclusões por proprietário; legado sem dono inequívoco não é atribuído arbitrariamente. |
| A14 | Corrigido | Identidade imutável por requisição e janela, validada com sessão/token; propagação para threads. |
| A15 | Corrigido | Migrações locais transacionais v3, índice incondicional e backup fechado corretamente. |
| A16 | Corrigido | Anexos com proprietário e vínculo à mensagem. |
| A17 | Corrigido | Logout preserva histórico; exclusão explícita reconcilia anexos sem referência. |
| A18 | Corrigido | Estados pending/ready/deletion_pending e reconciliação periódica; testes com morte real do processo antes/depois do replace. |
| A19 | Fora do escopo | Serviço e credenciais dos modelos excluídos por orientação do usuário. |
| A20 | Corrigido e publicado no Worker | Dono é validado antes de retornar replay de pagamento. |
| A21 | Corrigido e publicado no Worker | Produto, método, valor, créditos e operação devem corresponder à intenção original. |
| A22 | Corrigido; migração aplicada e conferida em produção | Ledger transacional, reenvio idempotente, compras distintas acumulam períodos e eventos atrasados não desfazem estorno. |
| A23 | Fora do escopo | Medição do consumo de modelos excluída pelo usuário. |
| A24 | Fora do escopo | Datas de corte das cotas de modelos excluídas pelo usuário. |
| A25 | Corrigido | Autoridade Host IPv6 validada corretamente. |
| A26 | Corrigido | Leitura cloud limitada durante streaming; encoding recusado quando impede aferição. |
| A27 | Contrato explícito; sem sandbox de SO | UI informa alcance real dos comandos autorizados. Política por conta e nunca permitir respeitada. Shell principal continua com privilégios do usuário; isolamento de workspace para shell não foi implementado. |
| A28 | Corrigido | Subagente de leitura usa allowlist e bloqueio inferior de criação de processos, inclusive caminhos indiretos. |
| A29 | Corrigido | Teto compartilhado e finito de chamadas, ferramentas, duração e saída; subagente não multiplica orçamento. |
| A30 | Refatorado; não decomposição total | Separados prompts, orçamento, planos, resultados, verificação e 30 handlers de ferramentas. Loop ainda exige evolução incremental. |
| A31 | Corrigido para ferramentas de arquivo no Windows | Handles nativos sem FILE_SHARE_DELETE fixam ancestrais; abertura recusa redirecionamento; temporários exclusivos; cópia/remoção protegidas. Testes exercitam corrida real e junção. Não estende sandbox ao shell nem promete a mesma garantia em outros SOs. |
| A32 | Corrigido | Aprovação temporária vinculada a conta/janela/conversa/tarefa/chamada e prazo; reinício falha fechado; plano persiste estados. |
| A33 | Corrigido | Aceite vinculado ao snapshot original; não reutiliza identidade mutável do envio seguinte. |
| A34 | Corrigido | Falha SSE terminal, sem reenvio automático inseguro; resultado salvo não se perde por falha no rodapé. |
| A35 | Cobertura ampliada; não certificação total | Testes de efeitos reais, HTTP portátil, D1 remoto, concorrência, rollback, recuperação e corridas nativas. Pendências de ensaio manual/provedor descritas abaixo. |

## Limites e comportamento deliberado

Não houve cobrança real. O fluxo completo do Mercado Pago não foi aprovado ponta a ponta: só foram encontradas credenciais de produção, não credenciais/conta de teste. A lógica financeira foi ensaiada em SQLite e D1 remoto isolados; isso não substitui callbacks reais assinados do sandbox.

Instalação/atualização pelo assistente completo em VM Windows e uso simultâneo de várias janelas reais não foram certificados. O instalador pode encerrar instâncias abertas; não foi executado sobre a sessão ativa do usuário. Testes portáteis usam banco, pasta e porta próprios.

Mover arquivo entre volumes agora falha de forma segura quando o rename nativo não é suportado; não há fallback inseguro que siga links. Arquivos comuns, edição e cópia são cobertos. A proteção nativa de ancestrais foi validada no Windows, alvo do instalador. Shell autorizado mantém o acesso do usuário ao host.

Prompts mantêm apresentação visual/interativa habilitada por padrão. A refatoração separou 30 handlers preservando os corpos das operações e adicionou teste de cobertura do registry. O loop ainda é grande: evitar afirmar refatoração arquitetural total.

Plugins/Store, MCPs remotos, CSP/invoke, todos os possíveis timeouts e morte de árvores de processos não receberam certificação completa. A19/A23/A24 permanecem excluídos.

## Preservação e reprodução

Alterações preexistentes, banco original e arquivos locais foram preservados; sem reset, limpeza geral ou commit agregado. Backups privados ficam em `backups/`, ignorados no Git e excluídos do instalador/R2. Não publicar exportação SQL nem credenciais.

Comandos: `python -m pytest -q`; `node --test server/tests/audit-security.test.mjs`; `tsc --noEmit` em server; `npm run app:build`; `python scripts/smoke-packaged-backend.py`. O ambiente de teste e o Python portátil precisam das dependências correspondentes. O runner `server/audit/run-staging.py` valida UUIDs exclusivos de auditoria e nunca deve ser adaptado para usar produção.

## Rollout cloud realizado

- Worker: `koda-cloud-api`, versão `7dfb054f-a7fd-4268-b87d-f6f694428be7`.
- Endpoint: https://koda-cloud-api.studiosluxgames.workers.dev . Leituras de health, versão, planos e changelog retornaram 200. Conta sem autenticação retornou 401.
- D1: `koda-cloud`, migrações 0005 e 0006 aplicadas. `quick_check=ok`, `foreign_key_check` vazio, 12 assinaturas preservadas, 5 aplicações legadas e zero pagamento aprovado sem ledger.
- Escritas financeiras pausadas por 405 segundos durante drenagem/backup/migração/conferência, depois liberadas. POSTs sem autenticação retornam 401; webhook sem assinatura retorna 403. Nenhuma cobrança real.
- Backup privado consistente: `C:/Users/panhard/Downloads/Koda-TUDO-2026-10-17/koda/backups/production-rollout-1792773167999/d1-financial-paused.sql`. SHA256 `bee5e24580b8d3d7d94d4a2042b8cd45cc0999d9ac43ba95d89678ce3a17b755`. Restauração e migração em cópia verificadas antes da aplicação remota.
- O primeiro comando de verificação via importação `--file` foi recusado pelo D1 (`SQLITE_AUTH` para PRAGMA). Foi substituído pela API de consultas `--command`, com `quick_check` e `foreign_key_check`; ambos passaram. O diagnóstico original permanece registrado.
- A release do atualizador permanece 0.7.7; o novo EXE será entregue como objeto R2, sem ativação automática.

## Instalador Windows

- EXE 0.7.8 gerado pelo pipeline Tauri/NSIS, com launcher universal e host `c-host.exe` verificados.
- Objeto R2: https://pub-4ee7a912e447471186b0543932b4a6b2.r2.dev/auditoria/2026-10-23/Koda_0.7.8_x64-setup.exe
- Tamanho: 102560768 bytes. SHA-256: `b96c2f4dad7baaec3733f8a4167f3adda8651c91a5b74bdaed915e1924bac303`. Baixamos o objeto público completo e o hash/tamanho conferem com o EXE local.
- O bucket contém somente o artefato em pasta de auditoria; o Worker continua oferecendo a release 0.7.7 até ativação separada.
- O passo MSI do mesmo pipeline estava compactando milhares de arquivos e continua separado; não interfere no EXE NSIS já gerado, envolvido pelo launcher e verificado. A instalação do wizard em VM não foi executada.
