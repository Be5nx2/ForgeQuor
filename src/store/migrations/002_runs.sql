CREATE TABLE runs (
  id            BIGSERIAL PRIMARY KEY,
  project_id    BIGINT NOT NULL REFERENCES projects(id),
  title         TEXT NOT NULL,
  task          TEXT NOT NULL,
  tracker_ref   TEXT,
  state         TEXT NOT NULL,
  branch        TEXT,
  worktree_path TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE step_attempts (
  id               BIGSERIAL PRIMARY KEY,
  run_id           BIGINT NOT NULL REFERENCES runs(id),
  step             TEXT NOT NULL,
  attempt          INTEGER NOT NULL,
  runner           TEXT NOT NULL,
  model            TEXT,
  status           TEXT NOT NULL,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at         TIMESTAMPTZ,
  summary          TEXT,
  error            TEXT,
  quota_resets_at  TIMESTAMPTZ,
  event_log        TEXT NOT NULL DEFAULT ''
);

CREATE TABLE gates (
  id         BIGSERIAL PRIMARY KEY,
  run_id     BIGINT NOT NULL REFERENCES runs(id),
  kind       TEXT NOT NULL,
  reason     TEXT NOT NULL,
  evidence   TEXT,
  opened_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  decision   TEXT
);
