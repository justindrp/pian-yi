ALTER TABLE conversations ADD COLUMN intent text;
ALTER TABLE conversations ADD COLUMN message_type text DEFAULT 'text';
