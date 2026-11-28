// What a Quota bar shows for one vendor: two gauges (five-hour window, week) each with a label, a fill, the percent
// used and the reset time apart, plus the age of the reading. Plain logic so the component only draws it.
import type { QuotaReading } from "./api.js";

type Window = QuotaReading["fiveHour"];

/** From this percent used a gauge turns orange (the "needs you" colour): 80% leaves one fifth to move a seat or queue work before the wall; below it the gauge stays the calm AI blue. */
export const WARN_AT = 80;

export type GaugeLevel = "ok" | "warn" | "exhausted" | "unknown";

export interface Gauge {
  label: string;
  /** Width of the fill, 0 to 100. */
  fill: number;
  /** "25%", or "?" when the window has no percent. */
  percent: string;
  /** "resets 11:10", "resets Sat 16:00" when not today; "" when the reset time is unknown. */
  resets: string;
  level: GaugeLevel;
}

function clock(at: Date): string {
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** The reset time alone, with the weekday (or the date beyond a week) when it is not today. */
export function resetText(resetsAt: string | null, now: number): string {
  if (!resetsAt) return "";
  const at = new Date(resetsAt);
  if (Number.isNaN(at.getTime())) return "";
  const today = new Date(now);
  if (at.toDateString() === today.toDateString()) return `resets ${clock(at)}`;
  const days = (at.getTime() - now) / 86_400_000;
  const day = days > 0 && days < 7 ? at.toLocaleDateString("en-US", { weekday: "short" }) : at.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `resets ${day} ${clock(at)}`;
}

export function gaugeLevel(percentUsed: number | null, exhausted: boolean): GaugeLevel {
  if (percentUsed === null) return exhausted ? "exhausted" : "unknown";
  if (percentUsed >= 100 || (exhausted && percentUsed >= WARN_AT)) return "exhausted";
  return percentUsed >= WARN_AT ? "warn" : "ok";
}

export function gauge(label: string, w: Window, exhausted: boolean, now: number): Gauge {
  const p = w.percentUsed;
  return {
    label,
    fill: p === null ? (exhausted ? 100 : 0) : Math.min(100, Math.max(0, p)),
    percent: p === null ? "?" : `${Math.round(p)}%`,
    resets: resetText(w.resetsAt, now),
    level: gaugeLevel(p, exhausted),
  };
}

/** True when the reading says something; an empty one is shown greyed "unknown", never as zero. */
export function isKnown(r: QuotaReading | null | undefined): r is QuotaReading {
  return !!r && (r.exhausted || r.fiveHour.percentUsed !== null || r.weekly.percentUsed !== null || !!r.fiveHour.resetsAt || !!r.weekly.resetsAt);
}

export function readingAge(readAt: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(readAt)) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  return `${Math.floor(seconds / 3600)} h ago`;
}

export interface VendorQuota {
  known: boolean;
  exhausted: boolean;
  /** Five-hour then week; empty when unknown. */
  gauges: Gauge[];
  /** How old the reading is; "" when there is none. */
  age: string;
}

export function vendorQuota(reading: QuotaReading | null | undefined, now: number): VendorQuota {
  if (!isKnown(reading)) return { known: false, exhausted: false, gauges: [], age: "" };
  return {
    known: true,
    exhausted: reading.exhausted,
    gauges: [gauge("5 h", reading.fiveHour, reading.exhausted, now), gauge("Week", reading.weekly, reading.exhausted, now)],
    age: readingAge(reading.readAt, now),
  };
}
