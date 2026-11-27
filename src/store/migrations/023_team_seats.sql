-- What the human set for each Agent seat on the Team page. One row per seat; Runner and model are each optional
-- (NULL means "not set here": the code's default applies, unless an environment variable says otherwise).
CREATE TABLE team_seats (
  seat    TEXT PRIMARY KEY,
  runner  TEXT,
  model   TEXT
);
