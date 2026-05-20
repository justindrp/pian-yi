CREATE TABLE admin_users (
  email text PRIMARY KEY,
  name text NOT NULL,
  role text NOT NULL DEFAULT 'admin',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE edit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  action text NOT NULL,
  changed_by text NOT NULL,
  changes jsonb NOT NULL,
  created_at timestamptz DEFAULT now()
);
