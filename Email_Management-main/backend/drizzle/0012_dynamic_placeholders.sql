-- Add custom_fields column to recipients table for storing all Excel columns as JSON
ALTER TABLE recipients
ADD COLUMN IF NOT EXISTS custom_fields varchar(5000);

-- Add available_columns column to campaigns table for tracking placeholder columns
ALTER TABLE campaigns
ADD COLUMN IF NOT EXISTS available_columns varchar(2000);
