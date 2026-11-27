-- Frames of an Animation Strip, side by side in one image; 1 for every other Asset.
ALTER TABLE assets ADD COLUMN frames INTEGER NOT NULL DEFAULT 1;
