-- A Run freezes the Workflow definition it started with, and the inputs it was given (at launch, or by a Step later).
-- Nullable on purpose: a Run inserted without one (by older code or a test) follows its Workflow's current definition.
ALTER TABLE runs ADD COLUMN definition JSONB;
ALTER TABLE runs ADD COLUMN inputs JSONB NOT NULL DEFAULT '[]';

-- Runs created before M3a get the built-in definition of their Workflow (the same as src/forge/workflows/*.yaml, which a test keeps in step).
UPDATE runs SET inputs = '["task"]', definition = $json${"name":"developer","description":"The Developer works on the task, the Checks run (sending a failure back to the Developer), the pull request opens, then the human approves or rejects at the final Gate.","inputs":["task"],"steps":[{"id":"developer","type":"agent","agent":"developer","needs":[],"readonly":false,"maxAttempts":3},{"id":"checks","type":"checks","needs":["developer"],"readonly":false,"onReject":"developer","maxAttempts":3},{"id":"publish","type":"publish","needs":["checks"],"readonly":false,"maxAttempts":3},{"id":"review","type":"gate","gate":"final","needs":["publish"],"readonly":false,"onReject":"developer","maxAttempts":3}]}$json$::jsonb
WHERE workflow = 'developer';
UPDATE runs SET inputs = '["assets"]', definition = $json${"name":"assets","description":"The Artist draws each Asset Request with its Asset Checks, the human gives a verdict per Asset at the Asset Gate, then the pull request opens and the Run is Approved.","inputs":["assets"],"steps":[{"id":"artist","type":"artist","needs":[],"readonly":false,"maxAttempts":3},{"id":"review","type":"gate","gate":"asset","needs":["artist"],"readonly":false,"onReject":"artist","maxAttempts":3},{"id":"publish","type":"publish","needs":["review"],"readonly":false,"maxAttempts":3}]}$json$::jsonb
WHERE workflow = 'assets';

-- Where each Step of a Run stands, per Iteration. `sent_back` is why the Step was sent back to (the Check that failed).
CREATE TABLE step_states (
  run_id     BIGINT NOT NULL REFERENCES runs(id),
  iteration  INTEGER NOT NULL,
  step       TEXT NOT NULL,
  status     TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  sent_back  TEXT,
  -- The inputs this Step produced, dropped again when the Step is replayed.
  produced   JSONB NOT NULL DEFAULT '[]',
  -- Gates up to this id belong to an earlier pass of the Step and are ignored.
  since_gate BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, iteration, step)
);

-- The Step of the Workflow that opened a Gate, or ran an attempt.
ALTER TABLE gates ADD COLUMN step TEXT;
ALTER TABLE step_attempts ADD COLUMN step_id TEXT;
