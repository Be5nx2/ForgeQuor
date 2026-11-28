-- Project removal: set when a removal begins and cleared only by the removal finishing (the Project row is deleted).
-- While set, no Run is launched on the Project and none of its Queued Runs is started; it survives restarts.
ALTER TABLE projects ADD COLUMN removing_since TIMESTAMPTZ;
