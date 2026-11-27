-- When a finished Run was archived: its worktree and local branch removed. Archived is a mark, not a state: the Run keeps
-- the state it ended in (merged, closed or abandoned). NULL until archived, and always for a Run that is not over.
ALTER TABLE runs ADD COLUMN archived_at TIMESTAMPTZ;
