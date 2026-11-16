-- Undo migration 0038 (cookie sessions). Removes only the refresh-token table: every cookie session ends and users
-- sign in again. No other table is touched. Deploy code that does not use the table before running this.
DROP TABLE IF EXISTS auth_refresh_tokens;
