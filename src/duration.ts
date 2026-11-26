/** A duration for people: "150 ms", "30 seconds", "5 minutes". */
export function describeDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} seconds`;
  return `${Math.round(ms / 60_000)} minutes`;
}
