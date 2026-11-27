-- How a Run is reviewed (solo or duo), chosen at launch; null for a Workflow without a review.
ALTER TABLE runs ADD COLUMN review_mode TEXT;

-- The Reviews written during a Run. `final` marks the one the Run acts on (a Reviewer's, or the Consolidator's in duo).
CREATE TABLE reviews (
  id         BIGSERIAL PRIMARY KEY,
  run_id     BIGINT NOT NULL REFERENCES runs(id),
  iteration  INTEGER NOT NULL,
  step_id    TEXT NOT NULL,
  attempt    INTEGER NOT NULL,
  author     TEXT NOT NULL,
  verdict    TEXT NOT NULL,
  body       TEXT NOT NULL,
  final      BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
