import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { RUN_NOTES_DIR } from "./workspace.js";

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

/** Where the art an Asset replaces is kept in the Run Notes, as `<asset id>.png`, relative to the worktree. */
const REPLACED_DIR = `${RUN_NOTES_DIR}/assets/replaced`;
export const replacedCopyPath = (assetId: number) => `${REPLACED_DIR}/${assetId}.png`;

/**
 * The file of an Asset's current version, only when it is a PNG that really lives inside the worktree (a link leading
 * out of it does not count). Null otherwise.
 */
export function servableAssetFile(worktreePath: string, targetPath: string): string | null {
  try {
    const root = realpathSync(worktreePath);
    const real = realpathSync(resolve(root, targetPath));
    if (!real.startsWith(root + sep) || !statSync(real).isFile()) return null;
    const head = Buffer.alloc(PNG_SIGNATURE.length);
    const fd = openSync(real, "r");
    try {
      readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
    return head.equals(PNG_SIGNATURE) ? real : null;
  } catch {
    return null;
  }
}
