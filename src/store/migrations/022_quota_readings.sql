-- The latest Quota Reading per vendor (one row each, replaced on every reading), so the Quota bars survive a restart.
-- A window's percent or reset is NULL when it is unknown.
CREATE TABLE quota_readings (
  vendor               TEXT PRIMARY KEY,
  five_hour_percent    DOUBLE PRECISION,
  five_hour_resets_at  TIMESTAMPTZ,
  weekly_percent       DOUBLE PRECISION,
  weekly_resets_at     TIMESTAMPTZ,
  exhausted            BOOLEAN NOT NULL,
  read_at              TIMESTAMPTZ NOT NULL
);
