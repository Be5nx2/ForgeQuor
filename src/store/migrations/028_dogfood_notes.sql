-- Dogfood Notes: short remarks the human jots while using Forgequor itself. Never deleted, content never edited.
-- The Run and Project are kept by number and name as written then (no foreign keys), so a note stays readable when they change or are purged.
CREATE TABLE dogfood_notes (
  id BIGSERIAL PRIMARY KEY,
  nature TEXT NOT NULL CHECK (nature IN ('feedback', 'idea')),
  target TEXT NOT NULL CHECK (target IN ('workflow', 'feature', 'display', 'other')),
  text TEXT NOT NULL CHECK (btrim(text) <> ''),
  tab TEXT NOT NULL,
  run_id BIGINT,
  run_title TEXT,
  project_id BIGINT,
  project_name TEXT,
  source TEXT NOT NULL DEFAULT 'internal',
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'triaged', 'dismissed')),
  triage_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX dogfood_notes_created ON dogfood_notes (created_at DESC, id DESC);
