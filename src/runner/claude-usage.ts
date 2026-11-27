import type { QuotaReading, QuotaWindow } from "./runner.js";

const UNKNOWN_WINDOW: QuotaWindow = { percentUsed: null, resetsAt: null };

/** A reading that knows nothing: what text we cannot make sense of becomes. */
export function unknownReading(readAt: Date): QuotaReading {
  return { fiveHour: UNKNOWN_WINDOW, weekly: UNKNOWN_WINDOW, exhausted: false, readAt };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The wall-clock fields of an instant in a time zone. */
function wallClock(at: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(at)
      .map((p) => [p.type, Number(p.value)]),
  );
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute!, second: parts.second! };
}

/** The instant at which a time zone's wall clock reads the given fields. */
function instantOf(timeZone: string, year: number, month: number, day: number, hour: number, minute: number): Date {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  let guess = asUtc;
  for (let i = 0; i < 3; i++) {
    const w = wallClock(new Date(guess), timeZone);
    guess += asUtc - Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  }
  return new Date(guess);
}

/**
 * Reads a reset such as "Nov 28 at 4am" or "4:30pm" in a time zone as the first such moment after `after` (the text
 * has no year). Null when it does not look like one, or the time zone is not one.
 */
export function nextOccurrence(text: string, timeZone: string, after: Date): Date | null {
  const m = /^(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2})\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(text.trim());
  if (!m) return null;
  const month = m[1] ? MONTHS.indexOf(m[1].toLowerCase()) + 1 : 0;
  if (m[1] && !month) return null;
  const hour12 = Number(m[3]);
  const minute = m[4] ? Number(m[4]) : 0;
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const hour = (hour12 % 12) + (m[5]!.toLowerCase() === "pm" ? 12 : 0);
  let today: ReturnType<typeof wallClock>;
  try {
    today = wallClock(after, timeZone);
  } catch {
    return null;
  }
  if (month) {
    const day = Number(m[2]);
    for (const year of [today.year, today.year + 1]) {
      const candidate = instantOf(timeZone, year, month, day, hour, minute);
      if (candidate > after) return candidate;
    }
    return null;
  }
  for (let ahead = 0; ahead <= 1; ahead++) {
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day + ahead));
    const candidate = instantOf(timeZone, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hour, minute);
    if (candidate > after) return candidate;
  }
  return null;
}

/** One window from its line: "Current session: 0% used · resets Nov 28 at 4am (Europe/Paris)". */
function windowOf(text: string, label: string, readAt: Date): QuotaWindow {
  const line = new RegExp(`^\\s*${label}\\s*:\\s*(\\d+(?:\\.\\d+)?)\\s*%\\s*used(?:[^\\S\\n]*[·•-][^\\S\\n]*resets\\s+([^\\n(]+?)\\s*\\(([^)\\n]+)\\))?`, "im").exec(text);
  if (!line) return UNKNOWN_WINDOW;
  return { percentUsed: Number(line[1]), resetsAt: line[2] && line[3] ? nextOccurrence(line[2], line[3].trim(), readAt) : null };
}

/**
 * Turns the text of Claude Code's `/usage` into a reading. Text with neither window yields an unknown reading, never an
 * error. A window at 100% or more makes the reading exhausted.
 */
export function parseUsage(text: string, readAt: Date): QuotaReading {
  const fiveHour = windowOf(text, "Current session", readAt);
  const weekly = windowOf(text, "Current week \\(all models\\)", readAt);
  return { fiveHour, weekly, exhausted: (fiveHour.percentUsed ?? 0) >= 100 || (weekly.percentUsed ?? 0) >= 100, readAt };
}
