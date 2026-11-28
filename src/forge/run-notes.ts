import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";
import type { RunNote, RunNoteInfo } from "./types.js";
import { RUN_NOTES_DIR } from "./workspace.js";

/** A Run Note bigger than this is not kept (1 MB). */
export const MAX_RUN_NOTE_BYTES = 1024 * 1024;


const decoder = new TextDecoder("utf-8", { fatal: true });

/** The text of a file's bytes, or null when they are not text (a NUL byte, or not valid UTF-8). */
function asText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Reads the text Run Notes under a worktree's Run Notes folder. Binary files, files over the size cap and anything that is
 * not a plain file (a symbolic link, say) are left out and named in `skipped` with the reason. A missing folder is no notes.
 */
export async function readRunNotes(worktreePath: string): Promise<{ notes: RunNote[]; skipped: string[] }> {
  const root = join(worktreePath, RUN_NOTES_DIR);
  const notes: RunNote[] = [];
  const skipped: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e: any) {
      if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return;
      throw e;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), `${path}/`);
        continue;
      }
      if (!entry.isFile()) {
        skipped.push(`${path} (not a plain file)`);
        continue;
      }
      const { size } = await lstat(join(dir, entry.name));
      if (size > MAX_RUN_NOTE_BYTES) {
        skipped.push(`${path} (${size} bytes, over the ${MAX_RUN_NOTE_BYTES} cap)`);
        continue;
      }
      const content = asText(await readFile(join(dir, entry.name)));
      if (content === null) skipped.push(`${path} (binary)`);
      else notes.push({ path, content, size });
    }
  }
  await walk(root, "");
  return { notes, skipped };
}

/** Where an Archived Run's Run Notes are kept. */
export function createRunNotes(pool: pg.Pool) {
  return {
    /** Keeps the notes of a Run, replacing any it already had. */
    async keep(runId: number, notes: RunNote[]): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM run_notes WHERE run_id = $1", [runId]);
        for (const n of notes) {
          await client.query("INSERT INTO run_notes (run_id, path, content, size) VALUES ($1, $2, $3, $4)", [runId, n.path, n.content, n.size]);
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    async list(runId: number): Promise<RunNoteInfo[]> {
      const { rows } = await pool.query("SELECT path, size FROM run_notes WHERE run_id = $1 ORDER BY path", [runId]);
      return rows.map((r) => ({ path: r.path, size: Number(r.size) }));
    },
    /** The note at a path, or null. */
    async get(runId: number, path: string): Promise<RunNote | null> {
      const { rows } = await pool.query("SELECT path, content, size FROM run_notes WHERE run_id = $1 AND path = $2", [runId, path]);
      return rows[0] ? { path: rows[0].path, content: rows[0].content, size: Number(rows[0].size) } : null;
    },
  };
}
