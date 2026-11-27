-- A retried or replayed Step gets a fresh attempt budget without its attempts being renumbered: its automatic loops count
-- from `budget_from` (the attempts it had when the human chose), and the Artist counts the versions drawn since `retried_at`.
ALTER TABLE step_states ADD COLUMN budget_from INTEGER NOT NULL DEFAULT 0;
ALTER TABLE step_states ADD COLUMN retried_at TIMESTAMPTZ;
