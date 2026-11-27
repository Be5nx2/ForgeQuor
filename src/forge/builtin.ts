import type pg from "pg";
import { createAssetsExtension } from "./assets.js";
import type { Extension } from "./extension.js";

/** The extensions Forgequor ships with, given the database they keep their own tables in. */
export function builtInExtensions(pool: pg.Pool): Extension[] {
  return [createAssetsExtension(pool)];
}
