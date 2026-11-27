import { afterEach, describe, expect, it } from "vitest";
import type { Forge, QuotaStatus } from "../../src/forge/forge.js";
import { createServer } from "../../src/http/server.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe("the Quota route", () => {
  it("returns both vendors' readings with their age, dates as text, and unknown for a vendor never read", async () => {
    const status: QuotaStatus[] = [
      {
        vendor: "claude",
        reading: { fiveHour: { percentUsed: 12, resetsAt: new Date("2026-11-27T14:00:00Z") }, weekly: { percentUsed: null, resetsAt: null }, exhausted: false, readAt: new Date("2026-11-27T10:00:00Z") },
        ageSeconds: 90,
      },
      { vendor: "codex", reading: null, ageSeconds: null },
    ];
    const app = await createServer({ forge: { quota: async () => status } as unknown as Forge, tools: [] });
    close = () => app.close();
    const address = await app.listen({ port: 0, host: "127.0.0.1" });

    const res = await fetch(`${address}/api/quota`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        vendor: "claude",
        reading: { fiveHour: { percentUsed: 12, resetsAt: "2026-11-27T14:00:00.000Z" }, weekly: { percentUsed: null, resetsAt: null }, exhausted: false, readAt: "2026-11-27T10:00:00.000Z" },
        ageSeconds: 90,
      },
      { vendor: "codex", reading: null, ageSeconds: null },
    ]);
  });
});
