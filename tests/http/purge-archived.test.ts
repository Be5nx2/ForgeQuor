import { afterEach, describe, expect, it } from "vitest";
import type { Forge } from "../../src/forge/forge.js";
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

const post = (address: string, body?: unknown) =>
  fetch(`${address}/api/archived-runs/purge`, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

describe("the purge-now route", () => {
  it("purges every Project when no Project is named, and returns the count", async () => {
    const seen: unknown[] = [];
    const address = await serve({ purgeArchivedRuns: async (id) => (seen.push(id), 4) });
    const res = await post(address, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 4 });
    expect(seen).toEqual([undefined]);
  });

  it("purges one Project when it is named", async () => {
    const seen: unknown[] = [];
    const address = await serve({ purgeArchivedRuns: async (id) => (seen.push(id), 2) });
    expect(await (await post(address, { projectId: 3 })).json()).toEqual({ deleted: 2 });
    expect(seen).toEqual([3]);
  });

  it("answers 400 to a Project that is not a number, 404 to an unknown Project", async () => {
    const address = await serve({
      purgeArchivedRuns: async (id) => {
        if (id === 9) throw new Error("No Project 9.");
        return 0;
      },
    });
    for (const projectId of ["3", 0, -1, 1.5, null]) expect((await post(address, { projectId })).status, String(projectId)).toBe(400);
    const missing = await post(address, { projectId: 9 });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "No Project 9." });
  });
});
