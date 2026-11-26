-- Commands run in a Run's new worktree before the Developer, and whether a Run got through them.
ALTER TABLE projects ADD COLUMN setup JSONB NOT NULL DEFAULT '[]';
ALTER TABLE runs ADD COLUMN setup_done BOOLEAN NOT NULL DEFAULT false;
