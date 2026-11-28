import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Forge } from "../../src/forge/forge.js";
import { createServer } from "../../src/http/server.js";

let close: (() => Promise<void>) | undefined;
let webRoot: string;
beforeEach(() => {
  webRoot = mkdtempSync(join(tmpdir(), "forgequor-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><div id=app>the app</div>");
  mkdirSync(join(webRoot, "assets"));
  writeFileSync(join(webRoot, "assets", "app.js"), "console.log('app')");
});
afterEach(async () => {
  await close?.();
  close = undefined;
  rmSync(webRoot, { recursive: true, force: true });
});

async function serve(forge: Partial<Forge> = {}) {
  const app = await createServer({ forge: forge as Forge, tools: [], webRoot });
  close = () => app.close();
  return app.listen({ port: 0, host: "127.0.0.1" });
}

describe("the app on client routes", () => {
  it.each(["/", "/runs", "/runs/12", "/new", "/projects/3", "/workflows", "/team", "/inbox", "/nowhere/at/all"])("serves index.html at %s", async (path) => {
    const res = await fetch(`${await serve()}${path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("the app");
  });

  it("still serves static assets as themselves", async () => {
    const res = await fetch(`${await serve()}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log('app')");
  });

  it("answers 404 for a missing asset, not the app", async () => {
    const res = await fetch(`${await serve()}/assets/missing.js`);
    expect(res.status).toBe(404);
  });

  it("does not shadow the API: an unknown /api path is a JSON 404 and a real one answers", async () => {
    const base = await serve({ listProjects: async () => [] });
    const unknown = await fetch(`${base}/api/nope`);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("content-type")).toContain("application/json");
    const known = await fetch(`${base}/api/projects`);
    expect(await known.json()).toEqual([]);
  });

  it("answers 404 to a POST on a client route", async () => {
    const res = await fetch(`${await serve()}/runs/1`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});
