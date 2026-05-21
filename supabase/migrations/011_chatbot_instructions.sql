CREATE TABLE chatbot_instructions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instruction text NOT NULL,
  description text,
  is_active boolean DEFAULT true,
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
