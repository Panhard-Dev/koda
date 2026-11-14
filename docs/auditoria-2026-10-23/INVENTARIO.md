# Inventário de entrega

| Componente | Destino / estado |
|---|---|
| Backend Python local: planos, autorização, proprietários, anexos, verificação, orçamento, caminhos e ferramentas | Incluído no runtime do instalador Windows |
| Frontend React: sessão por janela/conta, decisão estruturada e permissões explícitas | Incluído nos assets do instalador Windows |
| Aplicativo Tauri, host, MCPs, skills e Node portátil | Recursos previstos pela configuração de bundle; banco e .env excluídos |
| Worker cloud: pagamentos, ledger, estornos, manutenção e atualização sem downgrade | Publicado em produção no Worker koda-cloud-api; testes locais, staging e smoke de produção passaram |
| D1: 0005_mcps.sql e 0006_payment_applications.sql | Aplicadas no D1 koda-cloud após backup, drenagem financeira e ensaio de restauração; integridade conferida |
| Migração SQLite local v3 | Executada pelo aplicativo no banco local com backup; ensaio em cópia preservou histórico |
| Instalador EXE 0.7.8 | Objeto R2 enviado e hash verificado: https://pub-4ee7a912e447471186b0543932b4a6b2.r2.dev/auditoria/2026-10-23/Koda_0.7.8_x64-setup.exe; release não ativada |
| MSI | Gerado localmente pelo pipeline; não enviado ao R2 por não ser o EXE solicitado |
| Testes, scripts e relatórios | Permanecem no checkout para revisão e reprodução; não são dados de produção |
| Backups e exportação D1 | Privados em backups/, fora do instalador e do R2 |
| A19/A23/A24 | Fora do escopo: serviço/credenciais e consumo dos modelos |

source-inventory.json registra hashes das fontes finais. O checkout já continha mudanças; não houve commit geral nem substituição das alterações preexistentes.
