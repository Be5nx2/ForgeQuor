import { describe, expect, it } from "vitest";
import { displayNotificationScript, notifierFromEnv, silentNotifier } from "../../src/forge/notifier.js";

describe("the macOS notification script", () => {
  it("escapes quotes and backslashes and flattens line breaks, so a title cannot break out of the string", () => {
    const script = displayNotificationScript("Forgequor", 'Run #1 "Say \\"hi\\"": line one\nline two');
    expect(script).toBe('display notification "Run #1 \\"Say \\\\\\"hi\\\\\\"\\": line one line two" with title "Forgequor"');
  });
});

describe("choosing the Notifier", () => {
  it("is silent when FORGEQUOR_NOTIFICATIONS is off", () => {
    expect(notifierFromEnv({ FORGEQUOR_NOTIFICATIONS: "off" })).toBe(silentNotifier);
    expect(notifierFromEnv({ FORGEQUOR_NOTIFICATIONS: "OFF" })).toBe(silentNotifier);
    expect(notifierFromEnv({})).not.toBe(silentNotifier);
  });
});
