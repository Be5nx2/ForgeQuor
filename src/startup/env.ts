import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

/**
 * Loads `<root>/.env` into `env`, if the file exists. Variables already set
 * (e.g. in the shell) win over the file. Returns whether a file was read.
 */
export function loadEnvFile(root: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const file = join(root, ".env");
  if (!existsSync(file)) return false;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
    if (env[key] === undefined) env[key] = value;
  }
  return true;
}
