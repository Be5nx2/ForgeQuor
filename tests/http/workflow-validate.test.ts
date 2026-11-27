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

const post = (address: string, body: unknown) =>
  fetch(`${address}/api/workflows/validate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("the Workflow validation route", () => {
  it("hands the YAML and the Project to the Forge core and returns its answer as it is", async () => {
    const asked: unknown[] = [];
    const answer = { valid: false, errors: [{ path: "steps", message: "A Workflow needs Steps.", line: 2 }] };
    const address = await serve({
      async validateWorkflow(yaml, projectId) {
        asked.push([yaml, projectId]);
        return answer;
      },
    });

    const res = await post(address, { yaml: "name: x", projectId: 3 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(answer);
    expect(asked).toEqual([["name: x", 3]]);
  });

  it("answers 400 without a yaml string or with a non-integer Project", async () => {
    const address = await serve({
      async validateWorkflow() {
        return { valid: true, errors: [] };
      },
    });

    expect((await post(address, {})).status).toBe(400);
    expect((await post(address, { yaml: 4 })).status).toBe(400);
    expect((await post(address, { yaml: "a", projectId: "x" })).status).toBe(400);
  });

  it("answers 404 for a Project the Forge core does not know", async () => {
    const address = await serve({
      async validateWorkflow() {
        throw new Error("No Project 9.");
      },
    });

    const res = await post(address, { yaml: "a", projectId: 9 });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "No Project 9." });
  });
});
