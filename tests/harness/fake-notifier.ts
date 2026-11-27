import type { Notifier } from "../../src/forge/notifier.js";

export interface FakeNotifier extends Notifier {
  /** What was notified, in order. */
  readonly sent: Array<{ title: string; message: string }>;
  /** Makes every notification throw (or reject, when `async`); null to stop. */
  failWith(error: Error | null, options?: { async?: boolean }): void;
}

export function createFakeNotifier(): FakeNotifier {
  const sent: FakeNotifier["sent"] = [];
  let failure: Error | null = null;
  let async = false;
  return {
    sent,
    notify(title, message) {
      sent.push({ title, message });
      if (!failure) return;
      if (async) return Promise.reject(failure);
      throw failure;
    },
    failWith(error, options) {
      failure = error;
      async = options?.async ?? false;
    },
  };
}
