-- The Asset fills its whole square, fully opaque.
ALTER TABLE assets ADD COLUMN fill BOOLEAN NOT NULL DEFAULT false;
