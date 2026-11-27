-- What was said at a Run's Conversation Gates: one row per message of the chat, oldest first per conversation Step.
-- `session_id` is the Runner session an Agent turn was given in (resumed by the next turn); `gate_id` is the Gate that
-- waited on an Agent turn, or the Gate a human reply decided.
CREATE TABLE conversation_turns (
  id         BIGSERIAL PRIMARY KEY,
  run_id     BIGINT NOT NULL REFERENCES runs(id),
  step_id    TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  author     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  body       TEXT NOT NULL,
  session_id TEXT,
  gate_id    BIGINT REFERENCES gates(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_id, seq)
);
