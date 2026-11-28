import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createForge, DogfoodExportError, DogfoodNoteNotFoundError, InvalidInputError, type Forge } from "../../src/forge/forge.js";
import { createTestDatabase } from "../harness/database.js";
import { createFakeCodeHost } from "../harness/fake-codehost.js";
import { createFakeRunner } from "../harness/fake-runner.js";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The Dogfood Export, through the Forge core: real PostgreSQL, a temporary export folder. */

let pool: pg.Pool;
let drop: () => Promise<void>;
let forge: Forge;
let scratch: string;
let folder: string;
const NOW = new Date("2026-11-28T14:30:12.000Z");

beforeAll(async () => {
  const db = await createTestDatabase();
  drop = db.drop;
  pool = db.pool;
  scratch = mkdtempSync(join(tmpdir(), "forgequor-dogfood-export-"));
  folder = join(scratch, "nested", "dogfood");
  forge = createForge({ pool, runner: createFakeRunner(), codeHost: createFakeCodeHost(), worktreesRoot: scratch, dogfoodExportFolder: folder, now: () => NOW });
});
afterAll(async () => {
  await forge.whenIdle();
  await drop();
  rmSync(scratch, { recursive: true, force: true });
});
afterEach(async () => {
  await pool.query("DELETE FROM dogfood_notes");
  rmSync(join(scratch, "nested"), { recursive: true, force: true });
});

/** A note written at a given time (the database stamps creation, so the test moves it). */
async function noteAt(iso: string, over: Partial<{ nature: string; target: string; text: string; tab: string }> = {}) {
  const n = await forge.createDogfoodNote({ nature: "idea", target: "display", text: "A note.", tab: "runs", ...over });
  await pool.query("UPDATE dogfood_notes SET created_at = $2 WHERE id = $1", [n.id, iso]);
  return n;
}

describe("exporting Dogfood Notes", () => {
  it("builds a header, one section per target, notes by date, with every field and the text verbatim", async () => {
    const late = await noteAt("2026-11-20T10:00:00Z", { target: "workflow", nature: "feedback", text: "Late one.", tab: "waiting" });
    const early = await noteAt("2026-11-10T10:00:00Z", { target: "workflow", text: "  Early\n\n## not a heading\n```js\ncode\n```  ", tab: "runs" });
    const other = await noteAt("2026-11-15T10:00:00Z", { target: "other", text: "Elsewhere." });
    await forge.setDogfoodNoteStatus(other.id, "triaged", "m5-01");

    const exported = await forge.exportDogfoodNotes([late.id, early.id, other.id]);

    expect(exported.fileName).toBe("export_forgequor_2026-11-28_143012.md");
    const text = exported.content;
    expect(text).toContain("- Exported: 2026-11-28T14:30:12.000Z");
    expect(text).toContain("- Notes: 3");
    // Sections in target order, notes by date inside.
    expect(text.indexOf("## workflow (2)")).toBeGreaterThan(-1);
    expect(text.indexOf("## workflow (2)")).toBeLessThan(text.indexOf("## other (1)"));
    expect(text.indexOf(`Note #${early.id}`)).toBeLessThan(text.indexOf(`Note #${late.id}`));
    expect(text).not.toContain("## display");
    // Fields, origin as text, triage reference only when present.
    expect(text).toContain(`- ID: ${late.id}`);
    expect(text).toContain("- Date: 2026-11-20T10:00:00.000Z");
    expect(text).toContain("- Nature: feedback");
    expect(text).toContain("- Target: workflow");
    expect(text).toContain("- Origin: tab waiting");
    expect(text).toContain("- Triage: m5-01");
    expect(text.match(/- Triage:/g)).toHaveLength(1);
    // The text, verbatim, inside a fence longer than the one it contains.
    expect(text).toContain("````text\n  Early\n\n## not a heading\n```js\ncode\n```  \n````");
  });

  it("writes the same content into the folder, creating it, and changes no status", async () => {
    const a = await noteAt("2026-11-10T10:00:00Z");
    await forge.setDogfoodNoteStatus(a.id, "dismissed");
    const b = await noteAt("2026-11-11T10:00:00Z");
    expect(existsSync(folder)).toBe(false);

    const exported = await forge.exportDogfoodNotes([a.id, b.id, a.id]);

    expect(exported.path).toBe(join(folder, "export_forgequor_2026-11-28_143012.md"));
    expect(readFileSync(exported.path, "utf8")).toBe(exported.content);
    expect(exported.content).toContain("- Notes: 2");
    const listed = await forge.listDogfoodNotes();
    expect(listed.notes.map((n) => `${n.id}:${n.status}`).sort()).toEqual([`${a.id}:dismissed`, `${b.id}:new`].sort());
  });

  it("never overwrites an earlier export made in the same second", async () => {
    const a = await noteAt("2026-11-10T10:00:00Z");

    const first = await forge.exportDogfoodNotes([a.id]);
    const second = await forge.exportDogfoodNotes([a.id]);

    expect(second.fileName).toBe("export_forgequor_2026-11-28_143012-2.md");
    expect(readdirSync(folder).sort()).toEqual([first.fileName, second.fileName].sort());
  });

  it("refuses an empty selection, a bad ID and an unknown note, writing nothing", async () => {
    const a = await noteAt("2026-11-10T10:00:00Z");

    await expect(forge.exportDogfoodNotes([])).rejects.toThrow(/at least one note/);
    await expect(forge.exportDogfoodNotes([0])).rejects.toThrow(InvalidInputError);
    await expect(forge.exportDogfoodNotes([1.5])).rejects.toThrow(InvalidInputError);
    await expect(forge.exportDogfoodNotes([a.id, 999999])).rejects.toThrow(DogfoodNoteNotFoundError);

    expect(existsSync(folder)).toBe(false);
  });

  it("says clearly when the folder cannot be written", async () => {
    const a = await noteAt("2026-11-10T10:00:00Z");
    // A file where the folder should be.
    writeFileSync(join(scratch, "nested"), "in the way");

    await expect(forge.exportDogfoodNotes([a.id])).rejects.toThrow(DogfoodExportError);
    await expect(forge.exportDogfoodNotes([a.id])).rejects.toThrow(/Could not write the export into .*Nothing was exported/);
  });
});
