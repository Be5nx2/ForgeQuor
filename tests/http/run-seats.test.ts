import { afterEach, describe, expect, it } from "vitest";
import { InvalidSeatError, SeatLockedError, type Forge } from "../../src/forge/forge.js";
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
const post = (address: string, body: unknown) => fetch(`${address}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("POST /api/runs seat overrides", () => {
  it("passes the per-seat overrides on to the Forge", async () => {
    const started: unknown[] = [];
    const address = await serve({ startRun: async (input) => (started.push(input), { id: 1 } as never) });

    const res = await post(address, { projectId: 1, task: "A bug.", seats: { developer: { runner: "codex", model: "gpt" } } });

    expect(res.status).toBe(201);
    expect(started).toMatchObject([{ seats: { developer: { runner: "codex", model: "gpt" } } }]);
  });

  it("answers 400 for an unknown seat or Runner, and 409 for a field the environment holds", async () => {
    const address = await serve({
      startRun: async (input) => {
        if ("janitor" in (input.seats ?? {})) throw new InvalidSeatError('"janitor" is not a seat');
        throw new SeatLockedError("set by FORGEQUOR_DEVELOPER_MODEL");
      },
    });

    const unknown = await post(address, { projectId: 1, task: "A bug.", seats: { janitor: { runner: "claude" } } });
    const locked = await post(address, { projectId: 1, task: "A bug.", seats: { developer: { model: "x" } } });

    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: '"janitor" is not a seat' });
    expect(locked.status).toBe(409);
    expect(await locked.json()).toEqual({ error: "set by FORGEQUOR_DEVELOPER_MODEL" });
  });
});
