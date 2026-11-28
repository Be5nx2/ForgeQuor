-- The effort a Seat runs with: set on the Team page (NULL means the Runner's own default), and recorded on each Step
-- attempt like its model (NULL for the Runner's default, and for attempts recorded before this column).
ALTER TABLE team_seats ADD COLUMN effort TEXT;
ALTER TABLE step_attempts ADD COLUMN effort TEXT;
