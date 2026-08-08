-- Convert scheduled_at from timestamp to varchar to prevent timezone conversion
ALTER TABLE campaigns ALTER COLUMN scheduled_at TYPE varchar(30) USING to_char(scheduled_at, 'YYYY-MM-DD HH24:MI:SS');
