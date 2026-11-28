import { afterEach, describe, expect, it } from "vitest";
import { InvalidInputError, SeatLockedError, type Forge } from "../../src/forge/forge.js";
import { fallbackCatalog } from "../../src/runner/catalog.js";
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
const put = (address: string, seat: string, body: unknown) =>
  fetch(`${address}/api/team/${seat}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("the Team routes", () => {
  const team = { seats: [], catalog: fallbackCatalog() };

  it("GET /api/team returns the Forge's Team", async () => {
    const address = await serve({ team: async () => team });

    const res = await fetch(`${address}/api/team`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(team);
  });

  it("PUT /api/team/:seat passes the change on and returns the new Team", async () => {
    const calls: unknown[] = [];
    const address = await serve({ changeSeat: async (seat, change) => (calls.push([seat, change]), team) });

    const res = await put(address, "developer", { runner: "codex", model: "gpt" });

    expect(res.status).toBe(200);
    expect(calls).toEqual([["developer", { runner: "codex", model: "gpt" }]]);
  });

  it("PUT /api/team/:seat passes the effort on, null included", async () => {
    const calls: unknown[] = [];
    const address = await serve({ changeSeat: async (seat, change) => (calls.push([seat, change]), team) });

    await put(address, "developer", { effort: "high" });
    await put(address, "developer", { effort: null });

    expect(calls).toEqual([["developer", { effort: "high" }], ["developer", { effort: null }]]);
  });

  it("answers 400 for an unknown seat or Runner, and 409 for a seat the environment holds", async () => {
    const address = await serve({
      changeSeat: async (seat) => {
        if (seat === "janitor") throw new InvalidInputError('"janitor" is not a seat');
        throw new SeatLockedError("set by FORGEQUOR_DEVELOPER_RUNNER");
      },
    });

    const unknown = await put(address, "janitor", { runner: "claude" });
    const locked = await put(address, "developer", { runner: "claude" });

    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: '"janitor" is not a seat' });
    expect(locked.status).toBe(409);
    expect(await locked.json()).toEqual({ error: "set by FORGEQUOR_DEVELOPER_RUNNER" });
  });
});
