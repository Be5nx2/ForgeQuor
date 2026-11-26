/** Process groups started by Forgequor that are still running, so they can all be ended when Forgequor stops. */
const live = new Set<number>();

/** Remembers a detached child's process group until `forgetProcessGroup`. */
export function trackProcessGroup(pid: number | undefined) {
  if (pid) live.add(pid);
}

export function forgetProcessGroup(pid: number | undefined) {
  if (pid) live.delete(pid);
}

/** Ends a detached child and every process it started. Safe when they are already gone. */
export function killProcessGroup(pid: number | undefined) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/** Ends every tracked process group. Detached children do not get a Ctrl-C meant for Forgequor, so Forgequor passes it on. */
export function killAllProcessGroups() {
  for (const pid of live) killProcessGroup(pid);
  live.clear();
}
