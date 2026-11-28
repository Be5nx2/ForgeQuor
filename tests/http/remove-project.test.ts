import { afterEach, describe, expect, it } from "vitest";
import { RemovalInterruptedError, RunStateError, type Forge } from "../../src/forge/forge.js";
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

const unknown = (id: number) => new Error(`No Project ${id}.`);

describe("the Project removal routes", () => {
  it("returns the removal preview", async () => {
    const preview = { runs: 3, activeRuns: [], archivedRuns: 1 };
    const address = await serve({ removalPreview: async () => preview });
    const res = await fetch(`${address}/api/projects/4/removal`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(preview);
  });

  it("removes a Project and answers 204", async () => {
    const seen: number[] = [];
    const address = await serve({ removeProject: async (id) => void seen.push(id) });
    const res = await fetch(`${address}/api/projects/7`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(seen).toEqual([7]);
  });

  it("answers 404 to an unknown Project, 400 to a bad number, 409 to a Project with an active Run", async () => {
    const address = await serve({
      removalPreview: async (id) => {
        throw unknown(id);
      },
      removeProject: async (id) => {
        if (id === 2) throw new RunStateError("Project Slime has 1 active Run: abandon it first.");
        throw unknown(id);
      },
    });
    expect((await fetch(`${address}/api/projects/9/removal`)).status).toBe(404);
    expect((await fetch(`${address}/api/projects/9`, { method: "DELETE" })).status).toBe(404);
    expect((await fetch(`${address}/api/projects/abc`, { method: "DELETE" })).status).toBe(400);
    expect((await fetch(`${address}/api/projects/0/removal`)).status).toBe(400);
    const busy = await fetch(`${address}/api/projects/2`, { method: "DELETE" });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: "Project Slime has 1 active Run: abandon it first." });
  });

  it("answers 502 naming the Run and pull request when the code host failed during the removal", async () => {
    const message = "Removal of Slime stopped: could not abandon Run 8 (pull request #12): GitHub is unreachable. Retry once the code host answers.";
    const address = await serve({
      removeProject: async () => {
        throw new RemovalInterruptedError(message);
      },
    });
    const res = await fetch(`${address}/api/projects/2`, { method: "DELETE" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: message });
  });
});
