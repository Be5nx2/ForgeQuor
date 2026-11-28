import { describe, expect, it } from "vitest";
import { gauge, gaugeLevel, readingAge, resetText, vendorQuota, WARN_AT } from "../../web/src/quotaGauge.js";
import type { QuotaReading } from "../../web/src/api.js";

// Local-time dates, so the tests do not depend on the machine's zone.
const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi);
const NOW = local(2026, 11, 28, 9, 0).getTime(); // a Saturday
const win = (percentUsed: number | null, resetsAt: Date | null) => ({ percentUsed, resetsAt: resetsAt?.toISOString() ?? null });
const reading = (over: Partial<QuotaReading> = {}): QuotaReading => ({
  fiveHour: win(25, local(2026, 11, 28, 11, 10)),
  weekly: win(9, local(2026, 12, 2, 16, 0)),
  exhausted: false,
  readAt: new Date(NOW).toISOString(),
  ...over,
} as QuotaReading);

describe("resetText", () => {
  it("gives the time alone for a reset today", () => {
    expect(resetText(local(2026, 11, 28, 11, 10).toISOString(), NOW)).toBe("resets 11:10");
  });
  it("adds the weekday for a reset within the week", () => {
    const text = resetText(local(2026, 12, 2, 16, 0).toISOString(), NOW);
    expect(text).toMatch(/^resets \S+ 16:00$/);
    expect(text).not.toMatch(/Dec/);
  });
  it("gives the date beyond a week", () => {
    expect(resetText(local(2026, 12, 20, 16, 0).toISOString(), NOW)).toMatch(/20/);
  });
  it("is empty when unknown or unparseable", () => {
    expect(resetText(null, NOW)).toBe("");
    expect(resetText("garbage", NOW)).toBe("");
  });
});

describe("gaugeLevel", () => {
  it("is ok below the threshold and warn from it", () => {
    expect(gaugeLevel(WARN_AT - 1, false)).toBe("ok");
    expect(gaugeLevel(WARN_AT, false)).toBe("warn");
  });
  it("is exhausted at 100% or when the vendor is exhausted and the window is high or unknown", () => {
    expect(gaugeLevel(100, false)).toBe("exhausted");
    expect(gaugeLevel(95, true)).toBe("exhausted");
    expect(gaugeLevel(null, true)).toBe("exhausted");
    expect(gaugeLevel(9, true)).toBe("ok");
  });
  it("is unknown without a percent", () => {
    expect(gaugeLevel(null, false)).toBe("unknown");
  });
});

describe("gauge", () => {
  it("carries label, rounded percent, fill and reset apart", () => {
    expect(gauge("5 h", win(24.6, local(2026, 11, 28, 11, 10)), false, NOW)).toEqual({ label: "5 h", fill: 24.6, percent: "25%", resets: "resets 11:10", level: "ok" });
  });
  it("clamps the fill", () => {
    expect(gauge("5 h", win(130, null), false, NOW).fill).toBe(100);
    expect(gauge("5 h", win(-3, null), false, NOW).fill).toBe(0);
  });
  it("shows an empty '?' gauge when the percent is missing", () => {
    expect(gauge("Week", win(null, null), false, NOW)).toMatchObject({ fill: 0, percent: "?", resets: "", level: "unknown" });
  });
});

describe("readingAge", () => {
  it("speaks in just now, minutes and hours", () => {
    expect(readingAge(new Date(NOW - 10_000).toISOString(), NOW)).toBe("just now");
    expect(readingAge(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("5 min ago");
    expect(readingAge(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe("3 h ago");
  });
});

describe("vendorQuota", () => {
  it("is unknown without a reading, or with an empty one", () => {
    expect(vendorQuota(null, NOW)).toEqual({ known: false, exhausted: false, gauges: [], age: "" });
    expect(vendorQuota(reading({ fiveHour: win(null, null), weekly: win(null, null) }), NOW).known).toBe(false);
  });
  it("gives the five-hour then the week gauge, and the age", () => {
    const q = vendorQuota(reading(), NOW);
    expect(q.known).toBe(true);
    expect(q.gauges.map((g) => [g.label, g.percent, g.level])).toEqual([["5 h", "25%", "ok"], ["Week", "9%", "ok"]]);
    expect(q.age).toBe("just now");
  });
  it("turns an exhausted vendor's unknown windows red and full", () => {
    const q = vendorQuota(reading({ exhausted: true, fiveHour: win(null, local(2026, 11, 28, 11, 10)) }), NOW);
    expect(q.exhausted).toBe(true);
    expect(q.gauges[0]).toMatchObject({ level: "exhausted", fill: 100, resets: "resets 11:10" });
    expect(q.gauges[1]?.level).toBe("ok");
  });
});
