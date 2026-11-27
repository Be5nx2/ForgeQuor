/**
 * Runs `task` every `ms` milliseconds until the returned function is called. A dependency of the Forge core so that
 * tests drive time by hand instead of waiting (the other half of the clock is the `now` function).
 */
export type Every = (task: () => void, ms: number) => () => void;

/** The real timer; it never keeps the process alive on its own. */
export const realEvery: Every = (task, ms) => {
  const timer = setInterval(task, ms);
  timer.unref();
  return () => clearInterval(timer);
};
