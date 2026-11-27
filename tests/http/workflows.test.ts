import { afterEach, describe, expect, it } from "vitest";
import type { Forge, WorkflowList } from "../../src/forge/forge.js";
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

describe("the Project Workflows route", () => {
  it("returns what the Forge core lists for the Project", async () => {
    const list: WorkflowList = {
      workflows: [{ name: "developer", description: "", inputs: ["task"], origin: "built-in", errors: [], file: null }],
      problem: null,
    };
    const asked: number[] = [];
    const address = await serve({
      async listWorkflows(projectId) {
        asked.push(projectId);
        return list;
      },
    });

    const res = await fetch(`${address}/api/projects/4/workflows`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(list);
    expect(asked).toEqual([4]);
  });

  it("answers 404 for a Project the Forge core does not know", async () => {
    const address = await serve({
      async listWorkflows() {
        throw new Error("No Project 9.");
      },
    });

    const res = await fetch(`${address}/api/projects/9/workflows`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "No Project 9." });
  });
});
