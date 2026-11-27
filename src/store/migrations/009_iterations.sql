-- A Run's Iteration (starts at 1; the human rejecting a final Gate with Feedback starts the next one).
ALTER TABLE runs ADD COLUMN iteration INTEGER NOT NULL DEFAULT 1;
ALTER TABLE step_attempts ADD COLUMN iteration INTEGER NOT NULL DEFAULT 1;
ALTER TABLE check_results ADD COLUMN iteration INTEGER NOT NULL DEFAULT 1;
-- The human's written reason when a Gate was rejected.
ALTER TABLE gates ADD COLUMN feedback TEXT;
