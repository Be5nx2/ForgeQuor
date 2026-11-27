-- The Iteration a Gate was opened in. Earlier Gates get theirs back: each rejected Gate started the next Iteration.
ALTER TABLE gates ADD COLUMN iteration INTEGER;
UPDATE gates g SET iteration = 1 + (
  SELECT count(*) FROM gates e WHERE e.run_id = g.run_id AND e.id < g.id AND e.decision = 'reject'
);
ALTER TABLE gates ALTER COLUMN iteration SET NOT NULL;
