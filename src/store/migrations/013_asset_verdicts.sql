-- The copy of an Artist attempt's Asset kept in the Run Notes (relative to the worktree), so past versions stay viewable.
ALTER TABLE asset_versions ADD COLUMN image_path TEXT;

-- The human's verdict on one Asset at an Asset Gate, with the version it judged.
CREATE TABLE asset_verdicts (
  id         BIGSERIAL PRIMARY KEY,
  gate_id    BIGINT NOT NULL REFERENCES gates(id),
  asset_id   BIGINT NOT NULL REFERENCES assets(id),
  version_id BIGINT REFERENCES asset_versions(id),
  -- approve or reject
  verdict    TEXT NOT NULL,
  feedback   TEXT,
  UNIQUE (gate_id, asset_id)
);
