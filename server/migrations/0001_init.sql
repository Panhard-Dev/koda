-- ============================================================================
-- Koda Cloud — esquema inicial (Cloudflare D1 / SQLite)
-- Todas as queries da aplicação passam por prepared statements (parâmetros
-- vinculados) via a camada `src/models/`. Nenhuma string SQL é montada com
-- entrada de usuário.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Administradores: entidade separada das contas do app. Login em /admin/login.
-- A senha só existe como hash (bcrypt ou pbkdf2), nunca em texto puro.
-- ---------------------------------------------------------------------------
CREATE TABLE admins (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash     TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'superadmin')),
  -- TOTP: segredo cifrado em repouso (AES-GCM; chave em TOTP_ENCRYPTION_KEY)
  totp_secret       TEXT,
  totp_enabled      INTEGER NOT NULL DEFAULT 0,
  totp_recovery     TEXT NOT NULL DEFAULT '[]',
  failed_attempts   INTEGER NOT NULL DEFAULT 0,
  locked_until      TEXT,
  tokens_valid_from TEXT NOT NULL,
  last_login_at     TEXT,
  last_login_ip     TEXT,
  deleted_at        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX idx_admins_locked ON admins(locked_until);

-- ---------------------------------------------------------------------------
-- Contas do aplicativo.
--   status: active | suspended | banned
--   tokens_valid_from: qualquer token emitido antes disso é recusado. É o que
--   invalida na hora o acesso de quem acabou de ser suspenso/banido.
--   deleted_at: soft delete (hard delete exige ?hard=1 e some do banco).
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash     TEXT NOT NULL,
  display_name      TEXT,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'banned')),
  status_reason     TEXT,
  suspended_until   TEXT,
  status_changed_at TEXT,
  status_changed_by TEXT,
  tokens_valid_from TEXT NOT NULL,
  failed_attempts   INTEGER NOT NULL DEFAULT 0,
  locked_until      TEXT,
  last_login_at     TEXT,
  last_login_ip     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT
);

CREATE INDEX idx_users_status ON users(status);
CREATE INDEX idx_users_created ON users(created_at);
CREATE INDEX idx_users_deleted ON users(deleted_at);

-- ---------------------------------------------------------------------------
-- Refresh tokens: guardados apenas como SHA-256 (o valor cru nunca é salvo).
-- `family_id` permite detectar reuso de token roubado e derrubar a família.
-- ---------------------------------------------------------------------------
CREATE TABLE refresh_tokens (
  id           TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('admin', 'user')),
  subject_id   TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  family_id    TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT,
  replaced_by  TEXT,
  ip           TEXT,
  user_agent   TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_refresh_subject ON refresh_tokens(subject_type, subject_id);
CREATE INDEX idx_refresh_family ON refresh_tokens(family_id, created_at);
CREATE INDEX idx_refresh_expires ON refresh_tokens(expires_at);

-- ---------------------------------------------------------------------------
-- Limite de requisições. Uma única instrução UPSERT com RETURNING resolve o
-- contador de forma atômica — sem ler-depois-escrever, sem corrida.
-- ---------------------------------------------------------------------------
CREATE TABLE rate_limits (
  bucket       TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  hits         INTEGER NOT NULL,
  blocked_until INTEGER,
  updated_at   TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Histórico de tentativas de login (por IP e por conta), usado no lockout e na
-- investigação de força bruta. Não dá para apagar: ver triggers no fim.
-- ---------------------------------------------------------------------------
CREATE TABLE login_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  scope        TEXT NOT NULL CHECK (scope IN ('ip', 'account')),
  scope_key    TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('admin', 'user')),
  success      INTEGER NOT NULL,
  email        TEXT,
  ip           TEXT,
  user_agent   TEXT,
  reason       TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_login_attempts_scope ON login_attempts(scope, scope_key, created_at);
CREATE INDEX idx_login_attempts_email ON login_attempts(email, created_at);

-- ---------------------------------------------------------------------------
-- Catálogo de modelos exibidos no front.
--   is_active: liga/desliga globalmente (todos os usuários).
--   user_models: exceção por usuário (liga/desliga individualmente).
-- ---------------------------------------------------------------------------
CREATE TABLE catalog_models (
  id             TEXT PRIMARY KEY,
  slug           TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name           TEXT NOT NULL,
  description    TEXT,
  provider       TEXT NOT NULL DEFAULT 'host',
  kind           TEXT NOT NULL DEFAULT 'chat',
  context_window INTEGER,
  is_active      INTEGER NOT NULL DEFAULT 1,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  metadata       TEXT NOT NULL DEFAULT '{}',
  asset_id       TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);

CREATE INDEX idx_models_active ON catalog_models(is_active, sort_order);
CREATE INDEX idx_models_slug ON catalog_models(slug);

CREATE TABLE user_models (
  user_id    TEXT NOT NULL,
  model_id   TEXT NOT NULL,
  enabled    INTEGER NOT NULL,
  granted_by TEXT,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (user_id, model_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (model_id) REFERENCES catalog_models(id) ON DELETE CASCADE
);

CREATE INDEX idx_user_models_model ON user_models(model_id);

-- ---------------------------------------------------------------------------
-- Arquivos enviados (imagens de modelo, etc.). O conteúdo vive como BLOB no
-- banco — fora de qualquer diretório servido estaticamente — e só sai por rota
-- autenticada, com validação de tipo, tamanho e extensão no upload.
-- ---------------------------------------------------------------------------
CREATE TABLE assets (
  id            TEXT PRIMARY KEY,
  filename      TEXT NOT NULL,
  original_name TEXT,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'model-image',
  data          BLOB NOT NULL,
  uploaded_by   TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_assets_kind ON assets(kind, created_at);

-- ---------------------------------------------------------------------------
-- Releases publicadas (com changelog). version_key é a versão normalizada em
-- zero-padding para o ORDER BY do SQL resolver a "última" sem trazer tudo.
-- ---------------------------------------------------------------------------
CREATE TABLE releases (
  id               TEXT PRIMARY KEY,
  version          TEXT NOT NULL UNIQUE,
  version_key      TEXT NOT NULL,
  is_prerelease    INTEGER NOT NULL DEFAULT 0,
  download_url     TEXT NOT NULL,
  notes            TEXT,
  channel          TEXT NOT NULL DEFAULT 'stable' CHECK (channel IN ('stable', 'beta')),
  mandatory        INTEGER NOT NULL DEFAULT 0,
  min_supported_version TEXT,
  published        INTEGER NOT NULL DEFAULT 0,
  published_at     TEXT,
  published_by     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX idx_releases_lookup ON releases(published, channel, is_prerelease, version_key);

-- ---------------------------------------------------------------------------
-- Avisos enviados a uma conta pelo painel.
-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  severity   TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  read_at    TEXT,
  sent_by    TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_notifications_user ON notifications(user_id, created_at);

-- ---------------------------------------------------------------------------
-- Log de auditoria — append-only por construção:
--   * só existe INSERT no código (src/models/auditLog.ts)
--   * triggers abortam UPDATE/DELETE abaixo
--   * cada linha carrega entry_hash = SHA-256 do conteúdo canônico; a rota
--     /admin/api/audit/verify recalcula e aponta qualquer adulteração
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at   TEXT NOT NULL,
  actor_type   TEXT NOT NULL,
  actor_id     TEXT,
  actor_email  TEXT,
  action       TEXT NOT NULL,
  target_type  TEXT,
  target_id    TEXT,
  outcome      TEXT NOT NULL DEFAULT 'success' CHECK (outcome IN ('success', 'failure')),
  ip           TEXT,
  user_agent   TEXT,
  request_id   TEXT,
  before_state TEXT,
  after_state  TEXT,
  details      TEXT,
  entry_hash   TEXT NOT NULL
);

CREATE INDEX idx_audit_created ON audit_log(created_at);
CREATE INDEX idx_audit_actor ON audit_log(actor_id, created_at);
CREATE INDEX idx_audit_target ON audit_log(target_type, target_id, created_at);
CREATE INDEX idx_audit_action ON audit_log(action, created_at);

CREATE TRIGGER audit_log_block_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log e append-only: UPDATE proibido');
END;

CREATE TRIGGER audit_log_block_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log e append-only: DELETE proibido');
END;

CREATE TRIGGER login_attempts_block_update
BEFORE UPDATE ON login_attempts
BEGIN
  SELECT RAISE(ABORT, 'login_attempts e append-only: UPDATE proibido');
END;
