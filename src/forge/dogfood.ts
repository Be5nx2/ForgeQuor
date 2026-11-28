import type pg from "pg";
import { DogfoodNoteNotFoundError, DogfoodNoteTransitionError, InvalidInputError } from "./errors.js";
import type { DogfoodNote, DogfoodNoteFilter, DogfoodNoteInput, DogfoodNoteList } from "./types.js";

export const DOGFOOD_NATURES = ["feedback", "idea"] as const;
export const DOGFOOD_TARGETS = ["workflow", "feature", "display", "other"] as const;
export const DOGFOOD_STATUSES = ["new", "triaged", "dismissed"] as const;

/** Where a note may go from each status: handled one way or the other, and back to `new` when that was a misclick. */
const TRANSITIONS: Record<string, readonly string[]> = { new: ["triaged", "dismissed"], triaged: ["new"], dismissed: ["new"] };

/** The longest origin tab name kept: the front supplies it, so it is bounded. */
const MAX_TAB_LENGTH = 40;

/** The longest triage reference kept. */
const MAX_REF_LENGTH = 200;

const COLUMNS = "id, nature, target, text, tab, run_id, run_title, project_id, project_name, source, status, triage_ref, created_at";

/** Where a note was written, as text, so an export reads without links into the app. */
function originOf(r: Record<string, any>): string {
  const parts: string[] = [];
  if (r.run_id !== null) parts.push(r.run_title ? `Run #${r.run_id} (${r.run_title})` : `Run #${r.run_id}`);
  if (r.project_name) parts.push(`Project ${r.project_name}`);
  parts.push(`tab ${r.tab}`);
  return parts.join(", ");
}

function toNote(r: Record<string, any>): DogfoodNote {
  return {
    id: Number(r.id),
    nature: r.nature,
    target: r.target,
    text: r.text,
    tab: r.tab,
    runId: r.run_id === null ? null : Number(r.run_id),
    runTitle: r.run_title,
    projectId: r.project_id === null ? null : Number(r.project_id),
    projectName: r.project_name,
    source: r.source,
    status: r.status,
    triageRef: r.triage_ref,
    createdAt: r.created_at,
    origin: originOf(r),
  };
}

function oneOf(what: string, value: unknown, allowed: readonly string[]): string {
  if (typeof value !== "string" || !allowed.includes(value)) throw new InvalidInputError(`${what} must be one of: ${allowed.join(", ")}.`);
  return value;
}

/** The Dogfood Notes: recorded as they are, listed newest first, never deleted. */
export function createDogfoodNotes(pool: pg.Pool) {
  return {
    /** Records a note with its context. Only the text is free; a blank text, a bad nature or target, or an unknown Run or Project is an InvalidInputError. */
    async create(input: DogfoodNoteInput): Promise<DogfoodNote> {
      const nature = oneOf("nature", input.nature, DOGFOOD_NATURES);
      const target = oneOf("target", input.target, DOGFOOD_TARGETS);
      if (typeof input.text !== "string" || !input.text.trim()) throw new InvalidInputError("A note needs some text.");
      const tab = typeof input.tab === "string" ? input.tab.trim() : "";
      if (!tab || tab.length > MAX_TAB_LENGTH) throw new InvalidInputError(`A note needs the tab it was written on (at most ${MAX_TAB_LENGTH} characters).`);

      let run: { id: number; title: string } | null = null;
      let projectId: number | null = null;
      if (input.runId !== undefined && input.runId !== null) {
        const { rows } = await pool.query("SELECT id, title, project_id FROM runs WHERE id = $1", [input.runId]);
        if (!rows[0]) throw new InvalidInputError(`No Run ${input.runId}.`);
        run = { id: Number(rows[0].id), title: rows[0].title };
        projectId = Number(rows[0].project_id);
      }
      if (input.projectId !== undefined && input.projectId !== null) {
        const { rows } = await pool.query("SELECT id FROM projects WHERE id = $1", [input.projectId]);
        if (!rows[0]) throw new InvalidInputError(`No Project ${input.projectId}.`);
        // A Run in view says which Project it belongs to; the two must agree.
        if (projectId !== null && projectId !== input.projectId) throw new InvalidInputError(`Run ${run!.id} is not in Project ${input.projectId}.`);
        projectId = input.projectId;
      }
      const { rows } = await pool.query(
        `INSERT INTO dogfood_notes (nature, target, text, tab, run_id, run_title, project_id, project_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT name FROM projects WHERE id = $7))
         RETURNING ${COLUMNS}`,
        [nature, target, input.text, tab, run?.id ?? null, run?.title ?? null, projectId],
      );
      return toNote(rows[0]);
    },

    /**
     * Moves a note to `triaged` (with an optional free-text reference to where it went), to `dismissed`, or back to `new`
     * (which forgets the reference). Only status and reference ever change. A status out of the list, a reference on
     * anything but `triaged`, or a reference over the limit is an InvalidInputError; a move the table does not allow is a
     * DogfoodNoteTransitionError; an unknown note is a DogfoodNoteNotFoundError.
     */
    async setStatus(id: number, status: string, triageRef?: string | null): Promise<DogfoodNote> {
      oneOf("status", status, DOGFOOD_STATUSES);
      const ref = typeof triageRef === "string" ? triageRef.trim() : "";
      if (triageRef !== undefined && triageRef !== null && typeof triageRef !== "string") throw new InvalidInputError("The reference must be text.");
      if (ref && status !== "triaged") throw new InvalidInputError("Only a triaged note keeps a reference.");
      if (ref.length > MAX_REF_LENGTH) throw new InvalidInputError(`The reference is at most ${MAX_REF_LENGTH} characters.`);
      const from = Object.entries(TRANSITIONS).filter(([, to]) => to.includes(status)).map(([f]) => f);
      // One statement checks the current status and changes it, so two clicks cannot both win.
      const { rows } = await pool.query(
        `UPDATE dogfood_notes SET status = $2, triage_ref = $3 WHERE id = $1 AND status = ANY($4) RETURNING ${COLUMNS}`,
        [id, status, ref || null, from],
      );
      if (rows[0]) return toNote(rows[0]);
      const current = await pool.query("SELECT status FROM dogfood_notes WHERE id = $1", [id]);
      if (!current.rows[0]) throw new DogfoodNoteNotFoundError(`No Dogfood Note ${id}.`);
      throw new DogfoodNoteTransitionError(`A ${current.rows[0].status} note cannot become ${status}.`);
    },

    /** The notes matching the filters (a filter left out matches all), newest first, and the count of `new` ones. An unknown filter value is an InvalidInputError. */
    async list(filter: DogfoodNoteFilter = {}): Promise<DogfoodNoteList> {
      const where: string[] = [];
      const values: string[] = [];
      for (const [column, what, value, allowed] of [
        ["status", "status", filter.status, DOGFOOD_STATUSES],
        ["nature", "nature", filter.nature, DOGFOOD_NATURES],
        ["target", "target", filter.target, DOGFOOD_TARGETS],
      ] as const) {
        if (value === undefined || value === "") continue;
        values.push(oneOf(what, value, allowed));
        where.push(`${column} = $${values.length}`);
      }
      const { rows } = await pool.query(
        `SELECT ${COLUMNS} FROM dogfood_notes ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC`,
        values,
      );
      const count = await pool.query("SELECT count(*)::int AS n FROM dogfood_notes WHERE status = 'new'");
      return { notes: rows.map(toNote), newCount: count.rows[0].n };
    },
  };
}
