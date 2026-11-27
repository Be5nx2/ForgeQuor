import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkAssetFile, parsePalette } from "../../src/forge/asset-checks.js";
import { makePng } from "../harness/png.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "forgequor-checks-"));
  mkdirSync(join(root, "art"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const request = { targetPath: "art/hero.png", width: 16, height: 16 };
const put = (bytes: Buffer | string, name = "hero.png") => writeFileSync(join(root, "art", name), bytes);

describe("checking an Asset file", () => {
  it("accepts a PNG with transparency at the exact size, at its path", () => {
    put(makePng(16, 16, { pixel: (x) => (x < 8 ? [255, 0, 0, 255] : [0, 0, 0, 0]) }));

    expect(checkAssetFile(root, request, null)).toEqual({ written: true, failures: [], warnings: [] });
  });

  it("says nothing was written when there is no file at the path", () => {
    expect(checkAssetFile(root, request, null)).toEqual({ written: false, failures: [], warnings: [] });
  });

  it("fails a file that is not a readable PNG", () => {
    put("<html>not an image</html>");

    const { written, failures } = checkAssetFile(root, request, null);

    expect(written).toBe(true);
    expect(failures).toEqual([expect.stringMatching(/not a readable PNG/)]);
  });

  it("fails a truncated PNG", () => {
    put(makePng(16, 16).subarray(0, 40));

    expect(checkAssetFile(root, request, null).failures).toEqual([expect.stringMatching(/not a readable PNG/)]);
  });

  it("fails a PNG without an alpha channel", () => {
    put(makePng(16, 16, { alpha: false }));

    expect(checkAssetFile(root, request, null).failures).toEqual([expect.stringMatching(/alpha channel/)]);
  });

  it("fails the wrong width or height, naming both sizes", () => {
    put(makePng(32, 16));

    expect(checkAssetFile(root, request, null).failures).toEqual([expect.stringMatching(/32x16.*16x16/)]);
  });

  it("reports every failure at once", () => {
    put(makePng(8, 8, { alpha: false }));

    expect(checkAssetFile(root, request, null).failures).toHaveLength(2);
  });

  it("fails a link that leads out of the worktree, without reading what it points to", () => {
    const outside = join(root, "outside.png");
    writeFileSync(outside, makePng(16, 16));
    mkdirSync(join(root, "wt", "art"), { recursive: true });
    symlinkSync(outside, join(root, "wt", "art", "hero.png"));

    const { written, failures } = checkAssetFile(join(root, "wt"), request, null);

    expect(written).toBe(true);
    expect(failures).toEqual([expect.stringMatching(/inside the worktree/)]);
  });
});

describe("an Animation Strip", () => {
  const strip = { ...request, frames: 4 };

  it("expects a width of frame width × frame count", () => {
    put(makePng(64, 16));
    expect(checkAssetFile(root, strip, null)).toEqual({ written: true, failures: [], warnings: [] });

    put(makePng(16, 16));
    expect(checkAssetFile(root, strip, null).failures).toEqual([expect.stringMatching(/16x16.*64x16/)]);

    put(makePng(64, 32));
    expect(checkAssetFile(root, strip, null).failures).toEqual([expect.stringMatching(/64x32.*64x16/)]);
  });

  it("treats an Asset without frames as one frame", () => {
    put(makePng(16, 16));

    expect(checkAssetFile(root, { ...request, frames: 1 }, null).failures).toEqual([]);
    expect(checkAssetFile(root, request, null).failures).toEqual([]);
  });
});

describe("the fill flag", () => {
  const filling = { ...request, fill: true };

  it("fails any transparent pixel of an Asset that must fill its square, saying how many", () => {
    put(makePng(16, 16, { pixel: (x, y) => (x === 0 && y < 3 ? [0, 0, 0, 0] : x === 1 ? [9, 9, 9, 128] : [255, 0, 0, 255]) }));

    expect(checkAssetFile(root, filling, null).failures).toEqual([expect.stringMatching(/fill its whole square.*19 .*transparent/)]);
  });

  it("accepts a fully opaque Asset, and leaves an unflagged Asset free to use transparency", () => {
    put(makePng(16, 16, { pixel: (x) => (x < 8 ? [0, 0, 0, 0] : [255, 0, 0, 255]) }));
    expect(checkAssetFile(root, request, null).failures).toEqual([]);
    expect(checkAssetFile(root, { ...request, fill: false }, null).failures).toEqual([]);

    put(makePng(16, 16));
    expect(checkAssetFile(root, filling, null)).toEqual({ written: true, failures: [], warnings: [] });
  });
});

describe("hostile files", () => {
  it("fails a PNG that claims huge dimensions without decoding it", () => {
    const head = Buffer.from(makePng(1, 1).subarray(0, 33));
    head.writeUInt32BE(60_000, 16);
    head.writeUInt32BE(60_000, 20);
    put(head);

    const started = Date.now();
    const { failures } = checkAssetFile(root, request, null);

    expect(failures).toEqual([expect.stringMatching(/60000x60000.*16x16/)]);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("fails a file far larger than any Asset", () => {
    put(Buffer.concat([makePng(16, 16), Buffer.alloc(11 * 1024 * 1024)]));

    expect(checkAssetFile(root, request, null).failures).toEqual([expect.stringMatching(/too large/)]);
  });
});

describe("the palette warning", () => {
  const palette = ["#FF0000", "#00FF00"];

  it("is silent when every opaque pixel is in the palette, whatever its case", () => {
    put(makePng(16, 16, { pixel: (x) => (x % 2 ? [255, 0, 0, 255] : [0, 255, 0, 255]) }));

    expect(checkAssetFile(root, request, parsePalette("## Palette\n#ff0000 #00ff00")).warnings).toEqual([]);
  });

  it("counts the colours outside the palette and lists a few, never failing", () => {
    put(makePng(16, 16, { pixel: (x, y) => (y < 7 ? [x * 10, 0, 1, 255] : [255, 0, 0, 255]) }));

    const result = checkAssetFile(root, request, palette);

    expect(result.failures).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/^16 colours outside the palette: (#[0-9A-F]{6}, ){4}#[0-9A-F]{6}, …$/);
  });

  it("ignores transparent pixels", () => {
    put(makePng(16, 16, { pixel: (x) => (x < 8 ? [1, 2, 3, 0] : [255, 0, 0, 255]) }));

    expect(checkAssetFile(root, request, palette).warnings).toEqual([]);
  });

  it("is skipped without a palette", () => {
    put(makePng(16, 16, { pixel: () => [1, 2, 3, 255] }));

    expect(checkAssetFile(root, request, null).warnings).toEqual([]);
  });

  it("is skipped for a file that already failed", () => {
    put(makePng(8, 8, { pixel: () => [1, 2, 3, 255] }));

    expect(checkAssetFile(root, request, palette).warnings).toEqual([]);
  });
});

describe("reading the palette from an Art Direction", () => {
  it("takes the #RRGGBB codes under the Palette heading, up to the next heading", () => {
    const text = "# Style\nUse #123456 never.\n\n## Palette\n- #ff8c24 orange\n- #080F19 night, again #FF8C24\n\n## Sizes\n#abcdef\n";

    expect(parsePalette(text)).toEqual(["#FF8C24", "#080F19"]);
  });

  it("includes the codes under subsections of the Palette heading", () => {
    expect(parsePalette("## Palette\n#111111\n### Skin\n#222222\n## Next\n#333333\n")).toEqual(["#111111", "#222222"]);
  });

  it("is null without a Palette heading or without codes under it", () => {
    expect(parsePalette("# Style\n#ff0000\n")).toBeNull();
    expect(parsePalette("## Palette\nWarm colours.\n")).toBeNull();
  });
});
