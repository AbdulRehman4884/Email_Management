-- Add reply_to_email column to smtp_settings table
ALTER TABLE smtp_settings ADD COLUMN IF NOT EXISTS reply_to_email VARCHAR(255) DEFAULT '' NOT NULL;
