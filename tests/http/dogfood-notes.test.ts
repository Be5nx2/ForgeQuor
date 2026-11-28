import { afterEach, describe, expect, it } from "vitest";
import { DogfoodNoteNotFoundError, DogfoodNoteTransitionError, InvalidInputError, type DogfoodNote, type Forge } from "../../src/forge/forge.js";
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
const post = (address: string, body: unknown) =>
  fetch(`${address}/api/dogfood-notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const saved = { id: 1, nature: "idea", target: "display", text: "A search box.", tab: "runs", origin: "tab runs", status: "new" } as unknown as DogfoodNote;

describe("the Dogfood Note routes", () => {
  it("POST /api/dogfood-notes passes the note on and answers 201 with it", async () => {
    const calls: unknown[] = [];
    const address = await serve({ createDogfoodNote: async (input) => (calls.push(input), saved) });

    const res = await post(address, { nature: "idea", target: "display", text: "A search box.", tab: "runs", runId: 42 });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: 1, text: "A search box." });
    expect(calls).toEqual([{ nature: "idea", target: "display", text: "A search box.", tab: "runs", runId: 42, projectId: undefined }]);
  });

  it("answers 400 for a body missing a field, or an id that is not a whole number", async () => {
    const address = await serve({ createDogfoodNote: async () => saved });

    const noText = await post(address, { nature: "idea", target: "display", tab: "runs" });
    const badRun = await post(address, { nature: "idea", target: "display", text: "x", tab: "runs", runId: "42" });

    expect(noText.status).toBe(400);
    expect(await noText.json()).toEqual({ error: "text is required." });
    expect(badRun.status).toBe(400);
  });

  it("answers 400 with the Forge's message for input it refuses", async () => {
    const address = await serve({ createDogfoodNote: async () => Promise.reject(new InvalidInputError("A note needs some text.")) });

    const res = await post(address, { nature: "idea", target: "display", text: " ", tab: "runs" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "A note needs some text." });
  });

  it("GET /api/dogfood-notes returns the Forge's list, passing the filters on", async () => {
    const calls: unknown[] = [];
    const address = await serve({ listDogfoodNotes: async (filter) => (calls.push(filter), { notes: [saved], newCount: 1 }) });

    const res = await fetch(`${address}/api/dogfood-notes?status=new&target=display`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ notes: [{ id: 1 }], newCount: 1 });
    expect(calls).toEqual([{ status: "new", nature: undefined, target: "display" }]);
  });

  it("GET answers 400 for an unknown filter value", async () => {
    const address = await serve({ listDogfoodNotes: async () => Promise.reject(new InvalidInputError("status must be one of: new.")) });

    const res = await fetch(`${address}/api/dogfood-notes?status=done`);

    expect(res.status).toBe(400);
  });
});

describe("the Dogfood Note status route", () => {
  const put = (address: string, id: string, body: unknown) =>
    fetch(`${address}/api/dogfood-notes/${id}/status`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("passes the status and reference on and answers the note", async () => {
    const calls: unknown[] = [];
    const address = await serve({ setDogfoodNoteStatus: async (...args) => (calls.push(args), { ...saved, status: "triaged", triageRef: "m5-01" }) });

    const res = await put(address, "1", { status: "triaged", triageRef: "m5-01" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 1, status: "triaged", triageRef: "m5-01" });
    expect(calls).toEqual([[1, "triaged", "m5-01"]]);
  });

  it("answers 400 for a missing status or a reference that is not text", async () => {
    const address = await serve({ setDogfoodNoteStatus: async () => saved });

    expect((await put(address, "1", {})).status).toBe(400);
    expect((await put(address, "1", { status: "triaged", triageRef: 5 })).status).toBe(400);
  });

  it("maps the Forge's errors: 400 invalid, 404 unknown note, 409 move not allowed", async () => {
    const fail = (e: Error) => serve({ setDogfoodNoteStatus: async () => Promise.reject(e) });

    let address = await fail(new InvalidInputError("status must be one of: new."));
    expect((await put(address, "1", { status: "x" })).status).toBe(400);
    await close?.();
    address = await fail(new DogfoodNoteNotFoundError("No Dogfood Note 9."));
    const missing = await put(address, "9", { status: "triaged" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "No Dogfood Note 9." });
    await close?.();
    address = await fail(new DogfoodNoteTransitionError("A triaged note cannot become dismissed."));
    expect((await put(address, "1", { status: "dismissed" })).status).toBe(409);
  });

  it("answers 404 for an id that is not a number", async () => {
    const address = await serve({ setDogfoodNoteStatus: async () => saved });

    expect((await put(address, "abc", { status: "triaged" })).status).toBe(404);
  });
});
