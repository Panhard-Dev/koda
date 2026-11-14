# Publicação da auditoria — estado final cloud

A última orientação autorizou Worker e migrações em produção. **Concluído:** Worker `koda-cloud-api`, versão `7dfb054f-a7fd-4268-b87d-f6f694428be7`, D1 `koda-cloud`, migrações 0005 e 0006. As escritas financeiras já estão liberadas.

Health, planos, changelog e versão responderam 200; autenticação e assinatura inválidas continuam bloqueadas (401/403). Nenhuma cobrança real foi criada. A versão 0.7.8 não recebe exigência de downgrade.

Backup atual e ponto consistente privados em `C:/Users/panhard/Downloads/Koda-TUDO-2026-10-17/koda/backups/production-rollout-1792773167999`. Restauração ensaiada em cópia; quick_check e foreign_key_check do D1 passaram. Contagens financeiras preservadas, zero aprovação sem ledger. Evidência completa: `production-rollout.json` e `production-d1-checks.json`.

O instalador será entregue como **objeto R2**, sem ativar release do atualizador. Consulte `r2-artifact.json` para URL, hash e estado do upload.

O roteiro abaixo documenta o procedimento utilizado e a recuperação.

## Evidência de staging

- Worker: `koda-audit-staging-20261023`.
- D1 de teste: `koda-audit-20261023`.
- D1 de restauração: `koda-audit-restore-20261023`.
- Configuração: `server/audit/wrangler.jsonc`.
- Runner protegido por `AUDIT_TOKEN` exclusivo; painel/cadastro fechados, sem credenciais do Mercado Pago nem serviço dos modelos.
- Resultados: `server/audit/staging-results.json`.

O script `server/audit/run-staging.py` valida explicitamente o nome e o UUID do banco de teste antes de operações remotas. Ele não aceita a configuração de produção. Gera secrets exclusivos e não os imprime. O runner importa os mesmos módulos de pagamento e assinatura do servidor.

## Sequência de atualização financeira

1. Guardar o artefato e a configuração atualmente publicados, além de exportação D1 com acesso restrito. A exportação pode indisponibilizar temporariamente o banco; programar a janela e acompanhar as solicitações.
2. Publicar o candidato com `BILLING_MAINTENANCE=true` **antes** de aplicar `0006_payment_applications.sql`. O middleware responde 503 e `Retry-After: 60` a criação/cancelamento de cobrança e webhook. Leituras e login não entram no bloqueio. A conversa local não depende dessa migração.
3. Drenar as requisições financeiras iniciadas na versão anterior. O cliente do Mercado Pago tem teto de 15 segundos, mas também é necessário verificar solicitações ainda em execução nos registros do Worker. Não liberar a migração enquanto houver escrita antiga ativa.
4. Exportar o ponto consistente para recuperação. Aplicar a migração financeira com o bloqueio ainda ativo. Conferir constraints, pagamentos e assinaturas legadas.
5. Reconciliar **candidatos a entrega ausente**. `pago_em` prova aprovação registrada, não entrega de assinatura. Uma assinatura cancelada também não prova falha: não reativar nem conceder créditos em massa a partir dessa consulta.
6. Liberar `BILLING_MAINTENANCE=false` somente com o código que usa o ledger transacional já publicado e a migração conferida. Os webhooks recusados devem ser reenviados/reconciliados com a fonte de pagamento; não simular notificações assinadas de produção.
7. Acompanhar erros 5xx, conflitos de intenção, falhas de gravação e reentregas. O mesmo pagamento deve continuar produzindo um único período/crédito.

## Recuperação

- Ativar o bloqueio financeiro antes de qualquer recuperação.
- Não alternar livremente um servidor antigo que ignora o ledger com um novo que o usa. Isso pode reaplicar efeitos mesmo que o SQL seja aditivo.
- Preferir correção de avanço quando existirem pagamentos posteriores ao backup. Restaurar o banco inteiro pode descartar eventos novos.
- Se restaurar um ponto anterior, manter cobrança bloqueada até reconciliar todos os eventos posteriores junto ao provedor, usando as chaves de idempotência originais.
- A restauração foi ensaiada em SQLite e em um **segundo D1 remoto**. Isso prova o mecanismo de exportação/importação com os dados sintéticos do teste; não certifica a recuperação de todos os dados reais da produção.

## Clientes e atualização local

As correções cloud preservam os formatos públicos existentes de cobrança. Conflitos de dono/produto/método/valor passam a ser recusados deliberadamente. No aplicativo, backend e frontend devem ser distribuídos juntos: o botão Fazer novo usa decisão estruturada, não texto livre do cliente antigo.

O novo modo de permissão é separado por conta. Um modo global antigo não é transferido automaticamente para uma conta desconhecida: o padrão seguro é usado até a pessoa selecionar o modo novamente. Histórico legado sem dono inequívoco não é atribuído à conta que estiver aberta.

O instalador pode encerrar instâncias do Koda durante atualização. Não executar instalação de teste sobre uma sessão ativa de usuário; usar VM/perfil de teste. Os testes de runtime desta auditoria usam banco, pasta e porta próprios.

## Limites que ainda precisam de evidência

- Pagamento real de sandbox do Mercado Pago: os arquivos locais encontrados contêm credenciais com prefixo de produção. Elas não foram usadas para criar cobranças de teste.
- Instalação/atualização completa em Windows isolado e sessão multijanelas real.
- O perfil de comando do agente principal executa com as permissões do usuário. O texto da UI foi corrigido para tornar isso explícito. Subagentes de leitura não têm esse poder e recebem bloqueio também no criador de processos. Isso não é uma sandbox de sistema operacional para o agente principal.
- A31 recebeu proteção nativa por handles no Windows. Passaram testes de corrida entre validação e uso, junções e preservação dos arquivos externos, além de verificação direta com o Python 3.13 distribuído. A garantia não se estende ao shell principal nem foi certificada em outros sistemas operacionais.
