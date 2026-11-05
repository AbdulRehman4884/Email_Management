-- N-07 / N-17: refresh tokens for cookie sessions (short access token + rotating refresh token).
-- Only a SHA-256 hash of each token is stored. Safe to run again.
CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
  id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id           integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id         uuid NOT NULL,                     -- one login = one family; rotation keeps it
  token_hash        varchar(64) NOT NULL UNIQUE,       -- sha256 hex of the mf_rt cookie value
  csrf_hash         varchar(64) NOT NULL,              -- sha256 hex of the mf_csrf value of this session
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,              -- idle expiry (7 days after issue)
  family_expires_at timestamptz NOT NULL,              -- absolute expiry (30 days after login)
  revoked_at        timestamptz,
  replaced_by       integer REFERENCES auth_refresh_tokens(id) ON DELETE SET NULL,
  user_agent        varchar(255),
  ip_hash           varchar(64)
);
CREATE INDEX IF NOT EXISTS auth_refresh_tokens_user_idx   ON auth_refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS auth_refresh_tokens_family_idx ON auth_refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS auth_refresh_tokens_expiry_idx ON auth_refresh_tokens (expires_at);
