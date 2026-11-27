import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { excludeFromGit } from "./workspace.js";

/** Forgequor's own `shared` Skill Pack: the process Skills every Run's Agents may follow. */
export const SHARED_SKILL_PACK = fileURLToPath(new URL("../../skills/shared", import.meta.url));

/** Where each Runner looks for Skills, relative to the worktree. */
const SKILL_FOLDERS = [".claude/skills", ".agents/skills"];

/**
 * Places each Skill of the pack (a folder holding a SKILL.md) in the worktree, for Claude Code and for Codex, as a copy
 * (a link would point outside the worktree, where a sandbox may not read). A Skill the Project already has in that
 * folder is left alone. What is added goes to the repository's local exclude file, so it is never committed.
 * Placing twice changes nothing; a Skill that went missing is put back.
 */
export async function placeSkillPack(packDir: string, worktreePath: string): Promise<void> {
  if (!existsSync(packDir)) return;
  const skills = readdirSync(packDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(packDir, e.name, "SKILL.md")))
    .map((e) => e.name);
  const missing = SKILL_FOLDERS.flatMap((folder) => skills.map((name) => ({ folder, name }))).filter(({ folder, name }) => !existsSync(join(worktreePath, folder, name)));
  // Excluded first: a crash between the two steps must never leave a placed Skill that git would pick up.
  if (missing.length) await excludeFromGit(worktreePath, ...missing.map(({ folder, name }) => `/${folder}/${name}/`));
  for (const { folder, name } of missing) {
    mkdirSync(join(worktreePath, folder), { recursive: true });
    cpSync(join(packDir, name), join(worktreePath, folder, name), { recursive: true });
  }
}
