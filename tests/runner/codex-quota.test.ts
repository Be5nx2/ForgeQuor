import { describe, expect, it, vi } from "vitest";
import { createCodexRunner } from "../../src/runner/codex.js";
import { parseRateLimits } from "../../src/runner/codex-quota.js";
import { fakeAppServer as fakeServer, stopped } from "../harness/fake-app-server.js";

const READ_AT = new Date("2026-11-28T10:00:00Z");

/** The answer to `account/rateLimits/read`, as recorded from the real `codex app-server`. */
const ANSWER = {
  id: 1,
  result: {
    rateLimits: {
      limitId: "codex",
      limitName: null,
      primary: { usedPercent: 2, windowDurationMins: 300, resetsAt: 1795870755 },
      secondary: { usedPercent: 11, windowDurationMins: 10080, resetsAt: 1796118612 },
      credits: null,
      planType: "plus",
      rateLimitReachedType: null,
    },
  },
};

/** A fake `codex app-server` that can answer with the recorded Quota answer. */
const fakeAppServer = (body: string) => fakeServer(body, ANSWER);

const withLimits = (limits: object) => ({ id: 1, result: { rateLimits: { ...ANSWER.result.rateLimits, ...limits } } });

describe("parseRateLimits", () => {
  it("maps the 300 min window to five-hour and the 10080 min one to weekly, resets in epoch seconds", () => {
    expect(parseRateLimits(ANSWER, READ_AT)).toEqual({
      fiveHour: { percentUsed: 2, resetsAt: new Date(1795870755 * 1000) },
      weekly: { percentUsed: 11, resetsAt: new Date(1796118612 * 1000) },
      exhausted: false,
      readAt: READ_AT,
    });
  });

  it("goes by the window length, not by the position", () => {
    const swapped = withLimits({ primary: ANSWER.result.rateLimits.secondary, secondary: ANSWER.result.rateLimits.primary });
    const r = parseRateLimits(swapped, READ_AT)!;
    expect(r.fiveHour.percentUsed).toBe(2);
    expect(r.weekly.percentUsed).toBe(11);
  });

  it("is exhausted at 100% in either window", () => {
    expect(parseRateLimits(withLimits({ secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1796118612 } }), READ_AT)!.exhausted).toBe(true);
    expect(parseRateLimits(withLimits({ primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1795870755 } }), READ_AT)!.exhausted).toBe(true);
  });

  it("is exhausted when a limit was reached", () => {
    expect(parseRateLimits(withLimits({ rateLimitReachedType: "primary" }), READ_AT)!.exhausted).toBe(true);
  });

  it("leaves a window unknown when it is missing, and ignores windows of another length", () => {
    const r = parseRateLimits(withLimits({ secondary: null, primary: { usedPercent: 40, windowDurationMins: 60, resetsAt: 1 } }), READ_AT)!;
    expect(r.fiveHour).toEqual({ percentUsed: null, resetsAt: null });
    expect(r.weekly).toEqual({ percentUsed: null, resetsAt: null });
  });

  it("returns nothing for an answer that carries no rate limits (an error, garbage)", () => {
    expect(parseRateLimits({ id: 1, error: { code: -32601, message: "no" } }, READ_AT)).toBeNull();
    expect(parseRateLimits(null, READ_AT)).toBeNull();
    expect(parseRateLimits("x", READ_AT)).toBeNull();
    expect(parseRateLimits({ id: 1, result: {} }, READ_AT)).toBeNull();
  });
});

const HAPPY = `
if (m.method === "initialize") send({ id: m.id, result: { userAgent: "fake" } });
if (m.method === "account/rateLimits/read") send({ ...ANSWER, id: m.id });
`;

describe("Codex Runner readQuota", () => {
  it("handshakes in order, reads the rate limits, and stops the process", async () => {
    const fake = fakeAppServer(HAPPY);
    const reading = await createCodexRunner({ env: fake.env, now: () => READ_AT }).readQuota!();
    expect(reading).toEqual(parseRateLimits(ANSWER, READ_AT));
    expect(fake.args()).toEqual(["app-server"]);
    expect(fake.seen()).toEqual(["initialize", "initialized", "account/rateLimits/read"]);
    await stopped(fake);
  });

  it("waits for the initialize answer before it sends anything else", async () => {
    const fake = fakeAppServer(`
if (m.method === "initialize") setTimeout(() => { global.answered = true; send({ id: m.id, result: {} }); }, 300);
else if (!global.answered) log("TOO EARLY");
if (m.method === "account/rateLimits/read") send({ ...ANSWER, id: m.id });
`);
    expect(await createCodexRunner({ env: fake.env, now: () => READ_AT }).readQuota!()).not.toBeNull();
    expect(fake.seen()).not.toContain("TOO EARLY");
    expect(fake.seen()[0]).toBe("initialize");
  });

  it("gives nothing, logs it, and stops the process when the server never answers", async () => {
    const fake = fakeAppServer("");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const started = Date.now();
    expect(await createCodexRunner({ env: fake.env, quotaTimeoutMs: 400 }).readQuota!()).toBeNull();
    // The default wait is 15 s: this only has to tell the short wait asked for from the default.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
    await stopped(fake);
  });

  it("gives nothing when the server answers with an error", async () => {
    const fake = fakeAppServer(`
if (m.method === "initialize") send({ id: m.id, result: {} });
if (m.method === "account/rateLimits/read") send({ id: m.id, error: { code: -1, message: "not signed in" } });
`);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await createCodexRunner({ env: fake.env }).readQuota!()).toBeNull();
    error.mockRestore();
  });

  it("gives nothing when codex is not installed or exits at once", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await createCodexRunner({ env: { ...process.env, PATH: "/nonexistent" } }).readQuota!()).toBeNull();
    const fake = fakeAppServer("process.exit(1);");
    expect(await createCodexRunner({ env: fake.env }).readQuota!()).toBeNull();
    error.mockRestore();
  });

  it("skips lines that are not JSON", async () => {
    const fake = fakeAppServer(`
process.stdout.write("warming up\\n");
if (m.method === "initialize") send({ id: m.id, result: {} });
if (m.method === "account/rateLimits/read") send({ ...ANSWER, id: m.id });
`);
    expect(await createCodexRunner({ env: fake.env, now: () => READ_AT }).readQuota!()).toEqual(parseRateLimits(ANSWER, READ_AT));
  });
});
