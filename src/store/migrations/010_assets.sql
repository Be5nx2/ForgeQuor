-- Where a Project keeps its Art Direction document and its Assets.
ALTER TABLE projects ADD COLUMN art_direction_path TEXT NOT NULL DEFAULT 'docs/ART_DIRECTION.md';
ALTER TABLE projects ADD COLUMN art_folder TEXT NOT NULL DEFAULT 'assets/art';

-- The Asset Requests of an `assets` Run, in the order the Artist handles them.
CREATE TABLE assets (
  id          BIGSERIAL PRIMARY KEY,
  run_id      BIGINT NOT NULL REFERENCES runs(id),
  position    INTEGER NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  description TEXT NOT NULL,
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  -- Relative to the Run's worktree: where the Artist writes the final Asset.
  target_path TEXT NOT NULL,
  -- pending, generating, waiting (for the human's verdict) or approved.
  status      TEXT NOT NULL DEFAULT 'pending',
  UNIQUE (run_id, position)
);

-- What one Artist attempt produced for an Asset: the Runner's raw images, kept in the Run Notes as a trace.
CREATE TABLE asset_versions (
  id         BIGSERIAL PRIMARY KEY,
  asset_id   BIGINT NOT NULL REFERENCES assets(id),
  iteration  INTEGER NOT NULL,
  attempt    INTEGER NOT NULL,
  raw_images JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE step_attempts ADD COLUMN asset_id BIGINT REFERENCES assets(id);
