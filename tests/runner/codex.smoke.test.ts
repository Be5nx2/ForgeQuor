import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCodexRunner } from "../../src/runner/codex.js";

// Opt-in: uses the real `codex` and a little of the subscription's Quota (one image).
//   npm run smoke:codex
describe.skipIf(!process.env.FORGEQUOR_SMOKE_CODEX)("real codex (smoke)", () => {
  it("generates one 16x16 sprite and returns it as a file", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "forgequor-smoke-codex-"));
    const events: string[] = [];
    const result = await createCodexRunner().run(
      {
        instructions: "You are a pixel-art Artist. Be brief. Generate images with your image generation tool.",
        prompt: "Generate a 16x16 pixel-art sprite of a green slime on a transparent background.",
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
  }, 300_000);
});
