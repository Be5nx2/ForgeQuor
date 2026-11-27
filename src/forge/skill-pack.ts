import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { excludeFromGit } from "./workspace.js";

/** Forgequor's own `shared` Skill Pack: the process Skills every Run's Agents may follow. */
export const SHARED_SKILL_PACK = fileURLToPath(new URL("../../skills/shared", import.meta.url));

/** Forgequor's own `skills/` folder, whose subfolders are the Skill Packs. */
export const SKILLS_ROOT = dirname(SHARED_SKILL_PACK);

/** Packs never offered to a Project: `shared` is always given, `forgequor` is for building Forgequor itself. */
const NOT_OFFERED = new Set(["shared", "forgequor"]);

const holdsSkills = (packDir: string) =>
  readdirSync(packDir, { withFileTypes: true }).some((e) => e.isDirectory() && existsSync(join(packDir, e.name, "SKILL.md")));

/** The Skill Packs a Project may pick: the folders of `skills/` that hold Skills, but `shared` and `forgequor`. Sorted by name. */
export function offeredSkillPacks(skillsRoot: string = SKILLS_ROOT): string[] {
  if (!existsSync(skillsRoot)) return [];
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !NOT_OFFERED.has(e.name) && holdsSkills(join(skillsRoot, e.name)))
    .map((e) => e.name)
    .sort();
}

/** Where each Runner looks for Skills, relative to the worktree. */
const SKILL_FOLDERS = [".claude/skills", ".agents/skills"];

/**
 * Places the packs in order, so that between two packs holding a Skill of the same name the first placed wins
 * (a Skill already in the worktree is never replaced).
 */
export async function placeSkillPacks(packDirs: string[], worktreePath: string): Promise<void> {
  for (const dir of packDirs) await placeSkillPack(dir, worktreePath);
}

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
