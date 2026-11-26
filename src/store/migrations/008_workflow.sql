-- Which Workflow a Run follows. Every Run so far is a developer Run.
ALTER TABLE runs ADD COLUMN workflow TEXT NOT NULL DEFAULT 'developer';
