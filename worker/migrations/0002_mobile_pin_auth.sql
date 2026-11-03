
-- UMA Management V2
-- Add mobile login and secure PIN storage.
-- Existing email/password accounts remain intact.

ALTER TABLE users ADD COLUMN mobile TEXT;
ALTER TABLE users ADD COLUMN pin_hash TEXT;

CREATE UNIQUE INDEX users_mobile_unique
ON users(mobile)
WHERE mobile IS NOT NULL AND mobile <> '';

CREATE TABLE auth_login_attempts (
    mobile_key TEXT PRIMARY KEY,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    updated_at TEXT NOT NULL
);
