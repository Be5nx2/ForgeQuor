import { afterEach, describe, expect, it } from "vitest";
import type { Forge, RunUpdate } from "../../src/forge/forge.js";
import { createServer } from "../../src/http/server.js";
import { until } from "../harness/wait.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe("the live events stream", () => {
  it("sends each Run update as a server-sent event and stops when the client leaves", async () => {
    const listeners = new Set<(u: RunUpdate) => void>();
    const forge = { subscribe: (l: (u: RunUpdate) => void) => (listeners.add(l), () => void listeners.delete(l)) } as unknown as Forge;
    const app = await createServer({ forge, tools: [] });
    close = () => app.close();
    const address = await app.listen({ port: 0, host: "127.0.0.1" });

    const controller = new AbortController();
    const res = await fetch(`${address}/api/events`, { signal: controller.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // the connection greeting

    for (const l of listeners) l({ type: "changed", runId: 7 });
    const { value } = await reader.read();
    expect(decoder.decode(value)).toBe(`data: ${JSON.stringify({ type: "changed", runId: 7 })}\n\n`);

    controller.abort();
    await until(() => expect(listeners.size).toBe(0));
  });
});
