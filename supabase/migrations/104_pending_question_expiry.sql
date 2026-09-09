-- When the question was parked with an admin, so a question nobody ever
-- answered can stop claiming to be live.
--
-- `pending_bot_response` means one thing: the customer asked something an
-- admin still owes them an answer to. Three things read it — the model's
-- prompt renders it as "a question is with an admin right now" and forbids the
-- model answering it, every later inbound message pushes "New message —
-- question still unanswered", and the inbox's Unanswered tab is
-- `escalated_to_human OR pending_bot_response`.
--
-- Nothing but a human ever cleared it. `ask_admin_for_help` and the
-- claimed-escalation guard set it; only a takeover, a manual send, or the
-- bot-reply route unset it. A question an admin never got round to therefore
-- stayed live forever, and on 2026-09-09 nineteen of the twenty-five threads in
-- the Unanswered tab were flags that had outlived the thing that set them —
-- Clariza's since 10 July over a delivery photo she had already confirmed
-- arriving, Valen's since 3 July with no question recorded at all. Three times
-- the real backlog, which is why nobody reads the tab, which is why the six
-- real ones sat for days.
--
-- The timestamp is what makes expiry possible without dropping a customer who
-- is still waiting: it is refreshed every time that customer writes again while
-- the flag stands, so a thread that chases us never ages out and a thread that
-- moved on does.
ALTER TABLE customer_flags
  ADD COLUMN IF NOT EXISTS pending_bot_question_at timestamptz;

-- Existing flags are dated from the thread's own last message rather than from
-- now, so the first sweep clears the ones that have been dead for months
-- instead of granting all nineteen a fresh window.
UPDATE customer_flags f
SET pending_bot_question_at = COALESCE(
  (
    SELECT MAX(c.created_at)
    FROM conversations c
    WHERE c.customer_id = f.customer_id
  ),
  f.created_at,
  now()
)
WHERE f.pending_bot_response IS TRUE
  AND f.pending_bot_question_at IS NULL;

INSERT INTO settings (key, value, description)
VALUES (
  'pending_question_expiry_hours',
  '48',
  'Hours a question parked with an admin stays on the Unanswered tab with no word from the customer. The clock restarts every time the customer writes again, so a thread that chases us never expires.'
)
ON CONFLICT (key) DO NOTHING;
