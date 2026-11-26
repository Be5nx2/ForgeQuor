import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ARTIST_INSTRUCTIONS } from "../../src/forge/assets.js";
import { checkAssetFile } from "../../src/forge/asset-checks.js";
import { createCodexRunner } from "../../src/runner/codex.js";

// Opt-in: uses the real `codex` and a little of the subscription's Quota (one image).
//   npm run smoke:codex
describe.skipIf(!process.env.FORGEQUOR_SMOKE_CODEX)("real codex (smoke)", () => {
  it("generates one 16x16 sprite and returns it as a file", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "forgequor-smoke-codex-"));
    const events: string[] = [];
    const result = await createCodexRunner().run(
      {
        instructions: ARTIST_INSTRUCTIONS,
        prompt: "Asset to draw: slime\nKind: sprite\nSize: 16x16 pixels\nTarget path: slime.png\n\nWhat it shows:\nA green slime.\n\nArt Direction (none): chunky pixel art.",
        cwd,
        model: process.env.FORGEQUOR_ARTIST_MODEL,
      },
      (e) => events.push(e.kind),
    );
    expect(result.status).toBe("succeeded");
    expect(events.length).toBeGreaterThan(0);
    const files = result.status === "succeeded" ? (result.files ?? []) : [];
    expect(files.length).toBeGreaterThan(0);
    // A PNG starts with this signature.
    expect(readFileSync(files.at(-1)!).subarray(0, 4).toString("hex")).toBe("89504e47");
    // The Asset itself is the file the Artist wrote in the working directory: a PNG with transparency at exactly 16x16.
    expect(checkAssetFile(cwd, { targetPath: "slime.png", width: 16, height: 16 }, null)).toEqual({ written: true, failures: [], warnings: [] });
  }, 300_000);
});
