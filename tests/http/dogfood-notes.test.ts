import { afterEach, describe, expect, it } from "vitest";
import { InvalidInputError, type DogfoodNote, type Forge } from "../../src/forge/forge.js";
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
