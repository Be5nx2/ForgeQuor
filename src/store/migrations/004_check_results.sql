CREATE TABLE check_results (
  id          BIGSERIAL PRIMARY KEY,
  run_id      BIGINT NOT NULL REFERENCES runs(id),
  attempt     INTEGER NOT NULL,
  command     TEXT NOT NULL,
  exit_status INTEGER,
  output      TEXT NOT NULL DEFAULT '',
  ran_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
