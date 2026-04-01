ALTER TABLE campaigns ALTER COLUMN scheduled_at TYPE timestamp USING scheduled_at::timestamp;
