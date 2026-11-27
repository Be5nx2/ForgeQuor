-- The Skill Packs a Project picked on top of `shared`, and the ones a Run started with (frozen at its first start,
-- so changing the Project's choice affects only later Runs; NULL until the Run starts).
ALTER TABLE projects ADD COLUMN skill_packs TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE runs ADD COLUMN skill_packs TEXT[];
