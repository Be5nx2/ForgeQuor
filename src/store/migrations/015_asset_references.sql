-- Existing repository images an Asset Request names as style references, and whether it replaces an existing file.
ALTER TABLE assets ADD COLUMN style_references JSONB NOT NULL DEFAULT '[]';
ALTER TABLE assets ADD COLUMN replace BOOLEAN NOT NULL DEFAULT false;
