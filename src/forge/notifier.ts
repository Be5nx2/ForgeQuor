import { execFile } from "node:child_process";

/**
 * Tells the human something without them watching the tab: a Forge core dependency. Fire-and-forget: a failure is the
 * Notifier's own business and never reaches a Run.
 */
export interface Notifier {
  notify(title: string, message: string): void | Promise<void>;
}

/** The Notifier that does nothing (`FORGEQUOR_NOTIFICATIONS=off`, and the default of a Forge without one). */
export const silentNotifier: Notifier = { notify() {} };

/** A quoted AppleScript string: backslashes and quotes escaped, line breaks flattened. */
function appleScriptString(text: string): string {
  return `"${text.replace(/\s*[\r\n]+\s*/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The AppleScript that shows a macOS notification. */
export function displayNotificationScript(title: string, message: string): string {
  return `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`;
}

/** Shows a macOS notification through `osascript` (no shell, no click action). Errors are logged and swallowed. */
export function createMacNotifier(): Notifier {
  return {
    notify(title, message) {
      try {
        execFile("osascript", ["-e", displayNotificationScript(title, message)], (error) => {
          if (error) console.error("Could not show a notification:", error.message);
        });
      } catch (e: any) {
        console.error("Could not show a notification:", e?.message ?? e);
      }
    },
  };
}

/** The macOS Notifier, or the silent one when `FORGEQUOR_NOTIFICATIONS` is `off`. */
export function notifierFromEnv(env: Record<string, string | undefined>): Notifier {
  return env.FORGEQUOR_NOTIFICATIONS?.trim().toLowerCase() === "off" ? silentNotifier : createMacNotifier();
}
