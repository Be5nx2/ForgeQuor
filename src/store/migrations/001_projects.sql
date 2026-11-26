CREATE TABLE projects (
  id             BIGSERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  local_path     TEXT NOT NULL UNIQUE,
  remote_owner   TEXT NOT NULL,
  remote_name    TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  checks         JSONB NOT NULL DEFAULT '[]',
  max_concurrent_runs INTEGER NOT NULL DEFAULT 2,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
