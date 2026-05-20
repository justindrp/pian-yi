CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid REFERENCES customers (id) ON DELETE CASCADE,
  role text NOT NULL,
  content text NOT NULL,
  message_id text UNIQUE,
  model_used text,
  input_tokens int,
  output_tokens int,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_conversations_customer_id ON conversations (customer_id);
CREATE INDEX idx_conversations_created_at ON conversations (created_at);
CREATE INDEX idx_conversations_message_id ON conversations (message_id);

CREATE TABLE processed_messages (
  message_id text PRIMARY KEY,
  received_at timestamptz DEFAULT now(),
  processed_at timestamptz,
  error text
);
