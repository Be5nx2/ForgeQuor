import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssetNotFoundError, GateError, InvalidInputError, type Forge } from "../../src/forge/forge.js";
import { createServer } from "../../src/http/server.js";

let close: (() => Promise<void>) | undefined;
let folder: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "forgequor-http-"));
});
afterEach(async () => {
  await close?.();
  close = undefined;
  rmSync(folder, { recursive: true, force: true });
});

async function serve(forge: Partial<Forge>) {
  const app = await createServer({ forge: forge as Forge, tools: [] });
  close = () => app.close();
  return app.listen({ port: 0, host: "127.0.0.1" });
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("the Asset image route", () => {
  const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("pixels")]);

  it("serves the file the Forge core recorded for that Run's Asset, as a PNG that is never cached", async () => {
    const file = join(folder, "hero.png");
    writeFileSync(file, PNG);
    const asked: Array<[number, number]> = [];
    const address = await serve({
      async assetImage(runId, assetId) {
        asked.push([runId, assetId]);
        return file;
      },
    });

    const res = await fetch(`${address}/api/runs/3/assets/11/image`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
    expect(asked).toEqual([[3, 11]]);
  });

  it("answers 404 for an Asset the Forge core does not know for that Run, without leaking why", async () => {
    const address = await serve({
      async assetImage() {
        throw new AssetNotFoundError("No such Asset 9 in Run 3, or it has no image yet.");
      },
    });

    const res = await fetch(`${address}/api/runs/3/assets/9/image`);

    expect(res.status).toBe(404);
  });

  it("answers 404 when the recorded file vanished meanwhile", async () => {
    const address = await serve({ assetImage: async () => join(folder, "gone.png") });

    expect((await fetch(`${address}/api/runs/3/assets/1/image`)).status).toBe(404);
  });

  it("never lets the request name a path: only whole numbers are ids", async () => {
    let called = false;
    writeFileSync(join(folder, "hero.png"), PNG);
    const address = await serve({
      async assetImage() {
        called = true;
        return join(folder, "hero.png");
      },
    });

    for (const url of ["/api/runs/3/assets/..%2F..%2Fetc%2Fpasswd/image", "/api/runs/x/assets/1/image", "/api/runs/3/assets/1.5/image", "/api/runs/3/assets/-1/image"]) {
      expect((await fetch(`${address}${url}`)).status).toBe(404);
    }
    expect((await fetch(`${address}/api/runs/3/assets/1/image?path=/etc/passwd`)).status).toBe(200);
    expect(called).toBe(true);
  });
});

describe("refusing bad input", () => {
  it("answers 400 to a Gate decision refused for its input, and 409 to one refused for the Gate's state", async () => {
    const address = await serve({
      async decideGate({ gateId }) {
        if (gateId === 1) throw new InvalidInputError("Rejecting a Gate needs a Feedback saying what to change.");
        throw new GateError("Gate 2 is already decided.");
      },
    });

    const empty = await post(`${address}/api/gates/1/decision`, { action: "reject", feedback: "" });
    const decided = await post(`${address}/api/gates/2/decision`, { action: "approve" });

    expect(empty.status).toBe(400);
    expect((await empty.json()).error).toMatch(/Feedback/);
    expect(decided.status).toBe(409);
  });

  it("passes a version to the image route, and the verdicts of an Asset Gate to the Forge core", async () => {
    const file = join(folder, "old.png");
    writeFileSync(file, Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("old")]));
    const asked: unknown[] = [];
    let decided: any;
    const address = await serve({
      async assetImage(...args) {
        asked.push(args);
        return file;
      },
      async decideGate(input) {
        decided = input;
        return { id: 1 } as any;
      },
    });
    const verdicts = [{ assetId: 1, action: "approve" }, { assetId: 2, action: "reject", feedback: "Greener." }];

    expect((await fetch(`${address}/api/runs/3/assets/1/image?version=7`)).status).toBe(200);
    expect((await fetch(`${address}/api/runs/3/assets/1/image?version=../x`)).status).toBe(404);
    const res = await post(`${address}/api/gates/5/decision`, { action: "judge", verdicts });

    expect(asked).toEqual([[3, 1, 7]]);
    expect(res.status).toBe(200);
    expect(decided).toMatchObject({ gateId: 5, action: "judge", verdicts });
  });

  it("asks the Forge core for the art an Asset replaces", async () => {
    const file = join(folder, "old.png");
    writeFileSync(file, Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("old")]));
    const asked: unknown[] = [];
    const address = await serve({ async assetImage(...args) { asked.push(args); return file; } });

    expect((await fetch(`${address}/api/runs/3/assets/1/image?replaced=1`)).status).toBe(200);
    expect(asked).toEqual([[3, 1, "replaced"]]);
  });

  it("serves a Project's Art Direction facts to the Run form", async () => {
    const info = { present: true, defaultSize: { width: 16, height: 16 }, references: [], images: ["a.png"] };
    const address = await serve({ artInfo: async (id) => (id === 2 ? info : (undefined as any)) });

    const res = await fetch(`${address}/api/projects/2/art-info`);

    expect(await res.json()).toEqual(info);
  });

  it("answers 400 to a Project's art settings outside the repository", async () => {
    const address = await serve({
      async setArt() {
        throw new InvalidInputError('"/etc" is not a path inside the repository.');
      },
    });

    const res = await fetch(`${address}/api/projects/1/art`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ artDirectionPath: "/etc", artFolder: "assets/art" }),
    });

    expect(res.status).toBe(400);
  });

  it("passes the Workflow and the Asset Requests of a new Run to the Forge core", async () => {
    let received: any;
    const address = await serve({
      async startRun(input) {
        received = input;
        return { id: 1 } as any;
      },
    });
    const assets = [{ name: "hero", kind: "sprite", description: "A hero.", width: 16, height: 16 }];

    const res = await post(`${address}/api/runs`, { projectId: 2, workflow: "assets", assets });

    expect(res.status).toBe(201);
    expect(received).toMatchObject({ projectId: 2, workflow: "assets", assets });
  });

  it("still asks a developer Run for a task", async () => {
    const address = await serve({});

    expect((await post(`${address}/api/runs`, { projectId: 2 })).status).toBe(400);
  });
});
