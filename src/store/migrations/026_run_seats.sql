-- The per-Run seat overrides the human gave at launch, and the seats the Run started with (frozen at its first start,
-- so a Team change affects only later Runs; NULL until the Run starts, and for a Run from before M4).
ALTER TABLE runs ADD COLUMN seat_overrides JSONB;
ALTER TABLE runs ADD COLUMN seats JSONB;
