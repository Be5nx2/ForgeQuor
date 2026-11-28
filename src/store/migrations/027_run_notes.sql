-- The text Run Notes of an Archived Run (what its worktree's .forgequor/ folder held), kept when the worktree is removed.
-- The purge of the Run takes them with it.
CREATE TABLE run_notes (
  run_id BIGINT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (run_id, path)
);
