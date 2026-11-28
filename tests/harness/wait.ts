import { vi } from "vitest";

/**
 * Waits until `check` stops throwing (an `expect`, or a function that throws when not ready yet). For what only the
 * outside world can tell (a child process gone, a file written by one); work of the Forge is awaited with
 * `forge.whenIdle()` or an update heard through `subscribe`, not polled. `vi.waitFor` gives up after 1 s by default, a
 * limit a loaded machine passes, so this one only gives up shortly before the test's own timeout.
 */
export function until<T>(check: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(check, { timeout: 15_000, interval: 10 });
}

/** Waits until `read` returns something truthy (a file written by a child process, a process gone...) and returns it. */
export function eventually<T>(read: () => T | null | false | undefined): Promise<NonNullable<T>> {
  return until(() => {
    const value = read();
    if (!value) throw new Error("the awaited condition never became true");
    return value as NonNullable<T>;
  });
}
