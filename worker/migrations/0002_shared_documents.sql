-- Shared JSON document store for the existing UMA Management front end.
-- This migration is additive: it does not alter or delete existing records.
CREATE TABLE IF NOT EXISTS app_documents (
  collection TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (collection, doc_id)
);

-- PIN material is stored separately from staff profile documents.
-- PBKDF2 hashes are generated on the importing computer and verified by the Worker.
CREATE TABLE IF NOT EXISTS app_auth_accounts (
  staff_id TEXT PRIMARY KEY,
  mobile_norm TEXT NOT NULL,
  pin_salt_hex TEXT NOT NULL,
  pin_hash_hex TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS app_auth_mobile_idx ON app_auth_accounts(mobile_norm, active);

CREATE TABLE IF NOT EXISTS app_auth_sessions (
  token_hash TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES app_auth_accounts(staff_id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS app_auth_sessions_staff_idx ON app_auth_sessions(staff_id);
