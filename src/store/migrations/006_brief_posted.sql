-- Set once the Review Brief is on the pull request, so a restarted Run does not post it again.
ALTER TABLE runs ADD COLUMN brief_posted BOOLEAN NOT NULL DEFAULT false;
