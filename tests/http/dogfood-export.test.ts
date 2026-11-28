import { afterEach, describe, expect, it } from "vitest";
import { DogfoodExportError, DogfoodNoteNotFoundError, InvalidInputError, type Forge } from "../../src/forge/forge.js";
import { createServer } from "../../src/http/server.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function serve(forge: Partial<Forge>) {
  const app = await createServer({ forge: forge as Forge, tools: [] });
  close = () => app.close();
  return app.listen({ port: 0, host: "127.0.0.1" });
}
const exportPost = (address: string, body: unknown) =>
  fetch(`${address}/api/dogfood-notes/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("the Dogfood Export route", () => {
  it("POST /api/dogfood-notes/export passes the ids on and answers the file name and content", async () => {
    const calls: unknown[] = [];
    const address = await serve({
      exportDogfoodNotes: async (ids) => (calls.push(ids), { fileName: "export_forgequor_2026-11-28_143012.md", path: "/x/y.md", content: "# Export\n" }),
    });

    const res = await exportPost(address, { ids: [3, 4] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fileName: "export_forgequor_2026-11-28_143012.md", path: "/x/y.md", content: "# Export\n" });
    expect(calls).toEqual([[3, 4]]);
  });

  it("maps the Forge's errors: 400 for a bad selection, 404 for an unknown note, 500 with the reason for an unwritable folder", async () => {
    const address = await serve({
      exportDogfoodNotes: async (ids) => {
        if (!ids.length) throw new InvalidInputError("Select at least one note to export.");
        if (ids[0] === 9) throw new DogfoodNoteNotFoundError("No Dogfood Note 9.");
        throw new DogfoodExportError("Could not write the export into /ro: EACCES. Nothing was exported.");
      },
    });

    const empty = await exportPost(address, { ids: [] });
    const missing = await exportPost(address, { ids: [9] });
    const unwritable = await exportPost(address, { ids: [1] });
    const noIds = await exportPost(address, {});

    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: "Select at least one note to export." });
    expect(missing.status).toBe(404);
    expect(unwritable.status).toBe(500);
    expect(await unwritable.json()).toEqual({ error: "Could not write the export into /ro: EACCES. Nothing was exported." });
    expect(noIds.status).toBe(400);
  });
});
