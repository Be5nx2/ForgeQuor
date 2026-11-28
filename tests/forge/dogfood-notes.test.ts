import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createForge, DogfoodNoteNotFoundError, DogfoodNoteTransitionError, InvalidInputError, type Forge, type Project } from "../../src/forge/forge.js";
import { createTestDatabase } from "../harness/database.js";
import { createFakeCodeHost } from "../harness/fake-codehost.js";
import { createFakeRunner } from "../harness/fake-runner.js";
import { createRepoWithBareRemote, type TempRemote, type TempRepo } from "../harness/git.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The Dogfood Notes, through the Forge core: real PostgreSQL, a real Project and Run (scripted Runner, fake code host). */

let pool: pg.Pool;
let drop: () => Promise<void>;
let forge: Forge;
let worktrees: string;
const cleanups: Array<() => void> = [];
let counter = 0;

beforeAll(async () => {
  const db = await createTestDatabase();
  drop = db.drop;
  pool = db.pool;
  worktrees = mkdtempSync(join(tmpdir(), "forgequor-dogfood-"));
  forge = createForge({ pool, runner: createFakeRunner(), codeHost: createFakeCodeHost(), worktreesRoot: worktrees });
});
afterAll(async () => {
  await forge.whenIdle();
  await drop();
  rmSync(worktrees, { recursive: true, force: true });
});
afterEach(async () => {
  await pool.query("DELETE FROM dogfood_notes");
  cleanups.splice(0).forEach((c) => c());
});

async function project(): Promise<Project> {
  const { repo, remote } = createRepoWithBareRemote({ remote: `git@github.com:acme/dogfood-${++counter}.git` }) as { repo: TempRepo; remote: TempRemote };
  cleanups.push(repo.cleanup, remote.cleanup);
  const registered = await forge.registerProject({ path: repo.path });
  remote.pointOriginAtBare();
  return registered;
}

const note = { nature: "idea", target: "display", text: "The Runs list needs a search box.", tab: "runs" };

describe("jotting a Dogfood Note", () => {
  it("records the note as typed, with source internal, status new, the tab and the date", async () => {
    const before = Date.now();

    const created = await forge.createDogfoodNote({ ...note, text: "  Keep my\n  spacing.  " });

    expect(created).toMatchObject({
      nature: "idea",
      target: "display",
      text: "  Keep my\n  spacing.  ",
      tab: "runs",
      source: "internal",
      status: "new",
      triageRef: null,
      runId: null,
      projectId: null,
      origin: "tab runs",
    });
    expect(created.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect((await forge.listDogfoodNotes()).notes).toEqual([created]);
  });

  it("accepts a note about a Project in view and names it", async () => {
    const p = await project();

    const created = await forge.createDogfoodNote({ ...note, tab: "projects", projectId: p.id });

    expect(created).toMatchObject({ projectId: p.id, projectName: p.name, runId: null, origin: `Project ${p.name}, tab projects` });
  });

  it("accepts a note about a Run in view, takes its Project along and keeps the Run's title as it was", async () => {
    const p = await project();
    const run = await forge.startRun({ projectId: p.id, workflow: "bugfix", task: "The player cannot jump twice.", title: "Double jump" });
    await forge.whenIdle();

    const created = await forge.createDogfoodNote({ ...note, tab: "runs", runId: run.id });

    expect(created).toMatchObject({ runId: run.id, runTitle: "Double jump", projectId: p.id, projectName: p.name });
    expect(created.origin).toBe(`Run #${run.id} (Double jump), Project ${p.name}, tab runs`);
  });

  it("keeps saying which Run it was written about after that Run is purged", async () => {
    const p = await project();
    const run = await forge.startRun({ projectId: p.id, workflow: "bugfix", task: "Fix the thing.", title: "Thing" });
    await forge.whenIdle();
    const created = await forge.createDogfoodNote({ ...note, runId: run.id });

    await pool.query("DELETE FROM runs WHERE id = $1", [run.id]);

    expect((await forge.listDogfoodNotes()).notes[0]).toMatchObject({ id: created.id, runId: run.id, origin: `Run #${run.id} (Thing), Project ${p.name}, tab runs` });
  });

  it("refuses an empty or blank text with a clear message, recording nothing", async () => {
    await expect(forge.createDogfoodNote({ ...note, text: "" })).rejects.toThrow(InvalidInputError);
    await expect(forge.createDogfoodNote({ ...note, text: " \n\t " })).rejects.toThrow(/needs some text/);
    expect((await forge.listDogfoodNotes()).notes).toEqual([]);
  });

  it("refuses a nature or target outside the lists", async () => {
    await expect(forge.createDogfoodNote({ ...note, nature: "rant" })).rejects.toThrow(/nature must be one of: feedback, idea/);
    await expect(forge.createDogfoodNote({ ...note, target: "game" })).rejects.toThrow(/target must be one of: workflow, feature, display, other/);
  });

  it("refuses an unknown Run or Project, and a Run that is not in the Project given", async () => {
    const p = await project();
    const other = await project();
    const run = await forge.startRun({ projectId: p.id, workflow: "bugfix", task: "Fix the thing.", title: "Thing" });
    await forge.whenIdle();

    await expect(forge.createDogfoodNote({ ...note, runId: 999999 })).rejects.toThrow(/No Run 999999/);
    await expect(forge.createDogfoodNote({ ...note, projectId: 999999 })).rejects.toThrow(/No Project 999999/);
    await expect(forge.createDogfoodNote({ ...note, runId: run.id, projectId: other.id })).rejects.toThrow(InvalidInputError);
    expect((await forge.listDogfoodNotes()).notes).toEqual([]);
  });

  it("refuses a missing tab", async () => {
    await expect(forge.createDogfoodNote({ ...note, tab: " " })).rejects.toThrow(InvalidInputError);
  });
});

describe("listing Dogfood Notes", () => {
  it("lists newest first and counts the new ones, whatever the filter", async () => {
    const a = await forge.createDogfoodNote({ ...note, text: "first" });
    const b = await forge.createDogfoodNote({ ...note, nature: "feedback", target: "workflow", text: "second" });
    await pool.query("UPDATE dogfood_notes SET status = 'triaged' WHERE id = $1", [a.id]);

    const all = await forge.listDogfoodNotes();
    const feedback = await forge.listDogfoodNotes({ nature: "feedback" });
    const triaged = await forge.listDogfoodNotes({ status: "triaged" });
    const none = await forge.listDogfoodNotes({ target: "other" });

    expect(all.notes.map((n) => n.id)).toEqual([b.id, a.id]);
    expect(all.newCount).toBe(1);
    expect(feedback.notes.map((n) => n.id)).toEqual([b.id]);
    expect(triaged.notes.map((n) => n.id)).toEqual([a.id]);
    expect(triaged.newCount).toBe(1);
    expect(none.notes).toEqual([]);
  });

  it("refuses an unknown filter value", async () => {
    await expect(forge.listDogfoodNotes({ status: "done" })).rejects.toThrow(InvalidInputError);
  });

  it("keeps the Project name as written when it is later renamed", async () => {
    const p = await project();
    const created = await forge.createDogfoodNote({ ...note, projectId: p.id });
    await pool.query("UPDATE projects SET name = 'renamed' WHERE id = $1", [p.id]);

    expect((await forge.listDogfoodNotes()).notes[0]).toMatchObject({ id: created.id, projectName: p.name });
  });
});

describe("reviewing Dogfood Notes", () => {
  it("triages a note with its reference, keeps it listed, and changes nothing else", async () => {
    const created = await forge.createDogfoodNote({ ...note, text: "  As typed.  " });

    const triaged = await forge.setDogfoodNoteStatus(created.id, "triaged", " dogfood-07 ");

    expect(triaged).toEqual({ ...created, status: "triaged", triageRef: "dogfood-07" });
    const listed = await forge.listDogfoodNotes();
    expect(listed.notes).toEqual([triaged]);
    expect(listed.newCount).toBe(0);
    expect((await forge.listDogfoodNotes({ status: "triaged" })).notes).toEqual([triaged]);
  });

  it("triages without a reference, and dismisses", async () => {
    const a = await forge.createDogfoodNote(note);
    const b = await forge.createDogfoodNote(note);

    expect(await forge.setDogfoodNoteStatus(a.id, "triaged")).toMatchObject({ status: "triaged", triageRef: null });
    expect(await forge.setDogfoodNoteStatus(b.id, "dismissed")).toMatchObject({ status: "dismissed", triageRef: null });
    expect((await forge.listDogfoodNotes()).notes).toHaveLength(2);
  });

  it("brings a triaged or dismissed note back to new, forgetting the reference, and the count follows", async () => {
    const a = await forge.createDogfoodNote(note);
    const b = await forge.createDogfoodNote(note);
    await forge.setDogfoodNoteStatus(a.id, "triaged", "m5-01");
    await forge.setDogfoodNoteStatus(b.id, "dismissed");
    expect((await forge.listDogfoodNotes()).newCount).toBe(0);

    const backA = await forge.setDogfoodNoteStatus(a.id, "new");
    const backB = await forge.setDogfoodNoteStatus(b.id, "new");

    expect(backA).toMatchObject({ status: "new", triageRef: null });
    expect(backB).toMatchObject({ status: "new" });
    expect((await forge.listDogfoodNotes()).newCount).toBe(2);
  });

  it("refuses the moves the table does not allow, leaving the note as it was", async () => {
    const created = await forge.createDogfoodNote(note);
    await forge.setDogfoodNoteStatus(created.id, "triaged", "m5-01");

    await expect(forge.setDogfoodNoteStatus(created.id, "dismissed")).rejects.toThrow(DogfoodNoteTransitionError);
    await expect(forge.setDogfoodNoteStatus(created.id, "triaged", "other")).rejects.toThrow(DogfoodNoteTransitionError);
    await expect(forge.setDogfoodNoteStatus((await forge.createDogfoodNote(note)).id, "new")).rejects.toThrow(DogfoodNoteTransitionError);

    expect((await forge.listDogfoodNotes({ status: "triaged" })).notes[0]).toMatchObject({ id: created.id, triageRef: "m5-01" });
  });

  it("refuses an unknown status, a reference that does not fit, and an unknown note", async () => {
    const created = await forge.createDogfoodNote(note);

    await expect(forge.setDogfoodNoteStatus(created.id, "done")).rejects.toThrow(/status must be one of/);
    await expect(forge.setDogfoodNoteStatus(created.id, "dismissed", "why")).rejects.toThrow(InvalidInputError);
    await expect(forge.setDogfoodNoteStatus(created.id, "triaged", "x".repeat(201))).rejects.toThrow(InvalidInputError);
    await expect(forge.setDogfoodNoteStatus(999999, "triaged")).rejects.toThrow(DogfoodNoteNotFoundError);
    expect((await forge.listDogfoodNotes()).notes[0]).toMatchObject({ id: created.id, status: "new" });
  });
});
