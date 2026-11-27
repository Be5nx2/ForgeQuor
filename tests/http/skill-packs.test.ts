import { afterEach, describe, expect, it } from "vitest";
import { InvalidInputError, type Forge } from "../../src/forge/forge.js";
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

const put = (address: string, id: number, body: unknown) =>
  fetch(`${address}/api/projects/${id}/skill-packs`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("the Skill Pack routes", () => {
  it("lists the packs offered", async () => {
    const address = await serve({ offeredSkillPacks: () => ["godot"] });
    expect(await (await fetch(`${address}/api/skill-packs`)).json()).toEqual({ offered: ["godot"] });
  });

  it("hands the chosen packs to the Forge core", async () => {
    const set: unknown[] = [];
    const address = await serve({
      async setSkillPacks(id, packs) {
        set.push([id, packs]);
        return { id, skillPacks: packs } as any;
      },
    });
    const res = await put(address, 3, { packs: ["godot"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 3, skillPacks: ["godot"] });
    expect(set).toEqual([[3, ["godot"]]]);
  });

  it("refuses an unknown pack with 400, a malformed body with 400, an unknown Project with 404", async () => {
    const address = await serve({
      async setSkillPacks(id) {
        if (id === 9) throw new Error("No Project 9.");
        throw new InvalidInputError("Unknown Skill Pack: nope.");
      },
    });
    expect((await put(address, 1, { packs: ["nope"] })).status).toBe(400);
    expect((await put(address, 1, { packs: "godot" })).status).toBe(400);
    expect((await put(address, 9, { packs: [] })).status).toBe(404);
  });
});
