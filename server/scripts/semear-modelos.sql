-- Modelos que o Koda oferece hoje, no catálogo da nuvem.
--
-- Sem isto a área "Modelos" do painel nasce vazia, porque `catalog_models` é a
-- lista que o Koda Cloud publica (e onde o admin liga/desliga modelo por conta) —
-- ela não é lida do serviço local automaticamente. Os ids são fixos e o INSERT é
-- idempotente: rodar de novo não duplica nem sobrescreve o que foi editado no
-- painel.
--
--   cd server && npm run seed:modelos

INSERT OR IGNORE INTO catalog_models
  (id, slug, name, description, provider, kind, context_window, is_active, sort_order, metadata, created_at, updated_at)
VALUES
  ('mdl-liz-4',        'liz-4',        'Liz 4',        'Modelo de raciocínio da casa; padrão do app.','host', 'chat', NULL, 1, 10, '{"origem":"catalogo-koda"}', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('mdl-liz-3-flash',  'liz-3-flash',  'Liz 3 Flash',  'Respostas rápidas do dia a dia.',      'host', 'chat', NULL, 1, 20, '{"origem":"catalogo-koda"}', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('mdl-liz-mini-2',   'liz-mini-2',   'Liz Mini 2',   'Versão leve, econômica.',              'host', 'chat', NULL, 1, 30, '{"origem":"catalogo-koda"}', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('mdl-liz-mini-1-3', 'liz-mini-1-3', 'Liz Mini 1.3', 'Versão leve anterior.',                'host', 'chat', NULL, 1, 40, '{"origem":"catalogo-koda"}', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('mdl-liz-nano',     'liz-nano',     'Liz Nano',     'O menor e mais rápido.',                'host', 'chat', NULL, 1, 50, '{"origem":"catalogo-koda"}', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('mdl-koda-1',       'koda-1',       'Koda 1',       'Modelo da casa.',                      'host', 'chat', NULL, 1, 60, '{"origem":"catalogo-koda"}', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('mdl-layze-2',      'layze-2',      'Layze 2',      'Modelo parceiro.',                     'host', 'chat', NULL, 1, 70, '{"origem":"catalogo-koda"}', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
