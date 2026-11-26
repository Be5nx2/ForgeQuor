-- When a Paused Run restarts its current Step (the Runner's Quota reset time).
ALTER TABLE runs ADD COLUMN resume_at TIMESTAMPTZ;
