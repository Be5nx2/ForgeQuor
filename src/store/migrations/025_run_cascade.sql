-- Deleting a Run (the purge of an Archived Run) takes everything that belongs to it, in one statement.
ALTER TABLE check_results DROP CONSTRAINT check_results_run_id_fkey, ADD FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE;
ALTER TABLE step_attempts DROP CONSTRAINT step_attempts_run_id_fkey, ADD FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE;
ALTER TABLE step_attempts DROP CONSTRAINT step_attempts_asset_id_fkey, ADD FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE;
ALTER TABLE gates DROP CONSTRAINT gates_run_id_fkey, ADD FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE;
ALTER TABLE assets DROP CONSTRAINT assets_run_id_fkey, ADD FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE;
ALTER TABLE asset_versions DROP CONSTRAINT asset_versions_asset_id_fkey, ADD FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE;
ALTER TABLE asset_verdicts DROP CONSTRAINT asset_verdicts_gate_id_fkey, ADD FOREIGN KEY (gate_id) REFERENCES gates(id) ON DELETE CASCADE;
ALTER TABLE asset_verdicts DROP CONSTRAINT asset_verdicts_asset_id_fkey, ADD FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE;
ALTER TABLE asset_verdicts DROP CONSTRAINT asset_verdicts_version_id_fkey, ADD FOREIGN KEY (version_id) REFERENCES asset_versions(id) ON DELETE CASCADE;
ALTER TABLE step_states DROP CONSTRAINT step_states_run_id_fkey, ADD FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE;
ALTER TABLE reviews DROP CONSTRAINT reviews_run_id_fkey, ADD FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE;
ALTER TABLE conversation_turns DROP CONSTRAINT conversation_turns_run_id_fkey, ADD FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE;
ALTER TABLE conversation_turns DROP CONSTRAINT conversation_turns_gate_id_fkey, ADD FOREIGN KEY (gate_id) REFERENCES gates(id) ON DELETE CASCADE;
