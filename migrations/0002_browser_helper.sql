CREATE TABLE IF NOT EXISTS gemini_browser_accounts (
  account_id TEXT PRIMARY KEY,
  credential_ciphertext TEXT,
  credential_nonce TEXT,
  credential_version INTEGER,
  login_email_hash TEXT,
  browser_state TEXT NOT NULL DEFAULT 'idle' CHECK (browser_state IN (
    'idle', 'checking', 'ready', 'login_required',
    'manual_action_required', 'error'
  )),
  last_check_at_ms INTEGER,
  last_cookie_update_at_ms INTEGER,
  last_auto_login_at_ms INTEGER,
  auth_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (auth_failure_count >= 0),
  auto_login_attempt_date TEXT,
  auto_login_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (auto_login_attempt_count >= 0),
  notification_state TEXT,
  failure_code TEXT,
  lock_owner TEXT,
  lock_expires_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES gemini_accounts(id) ON DELETE CASCADE,
  CHECK ((credential_ciphertext IS NULL AND credential_nonce IS NULL
    AND credential_version IS NULL AND login_email_hash IS NULL)
    OR (credential_ciphertext IS NOT NULL AND credential_nonce IS NOT NULL
      AND credential_version = 1 AND login_email_hash IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_gemini_browser_schedule
  ON gemini_browser_accounts (browser_state, last_check_at_ms, account_id);
