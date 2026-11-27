-- What the Asset Checks found for each Artist attempt at an Asset.
ALTER TABLE asset_versions ADD COLUMN written BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE asset_versions ADD COLUMN failures JSONB NOT NULL DEFAULT '[]';
ALTER TABLE asset_versions ADD COLUMN warnings JSONB NOT NULL DEFAULT '[]';
-- The Artist's last message of that attempt.
ALTER TABLE asset_versions ADD COLUMN summary TEXT;
