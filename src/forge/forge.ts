import type pg from "pg";
import { inspectRepository, RegistrationError } from "./workspace.js";

export { RegistrationError };

export interface Project {
  id: number;
  name: string;
  localPath: string;
  remoteOwner: string;
  remoteName: string;
  defaultBranch: string;
  checks: string[];
  maxConcurrentRuns: number;
}

export interface Forge {
  registerProject(input: { path: string }): Promise<Project>;
  listProjects(): Promise<Project[]>;
}

const COLUMNS = "id, name, local_path, remote_owner, remote_name, default_branch, checks, max_concurrent_runs";

function toProject(r: Record<string, any>): Project {
  return {
    id: Number(r.id),
    name: r.name,
    localPath: r.local_path,
    remoteOwner: r.remote_owner,
    remoteName: r.remote_name,
    defaultBranch: r.default_branch,
    checks: r.checks,
    maxConcurrentRuns: r.max_concurrent_runs,
  };
}

export function createForge(deps: { pool: pg.Pool }): Forge {
  const { pool } = deps;
  return {
    async registerProject({ path }) {
      const repo = await inspectRepository(path);
      try {
        const { rows } = await pool.query(
          `INSERT INTO projects (name, local_path, remote_owner, remote_name, default_branch)
           VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
          [repo.remoteName, repo.root, repo.remoteOwner, repo.remoteName, repo.defaultBranch],
        );
        return toProject(rows[0]);
      } catch (e: any) {
        if (e.code === "23505") throw new RegistrationError(`${repo.root} is already registered.`);
        throw e;
      }
    },

    async listProjects() {
      const { rows } = await pool.query(`SELECT ${COLUMNS} FROM projects ORDER BY id`);
      return rows.map(toProject);
    },
  };
}
