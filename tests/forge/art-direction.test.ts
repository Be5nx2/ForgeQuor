import { describe, expect, it } from "vitest";
import { parseDefaultSize, parseReferences } from "../../src/forge/art-direction.js";

describe("the default size of an Art Direction", () => {
  it("reads a `Default size: WxH` line, in any list or emphasis style", () => {
    expect(parseDefaultSize("# Art\nDefault size: 16x16\n")).toEqual({ width: 16, height: 16 });
    expect(parseDefaultSize("- **Default size:** 32 × 18\n")).toEqual({ width: 32, height: 18 });
    expect(parseDefaultSize("> default size: 18x18")).toEqual({ width: 18, height: 18 });
  });

  it("reads emphasis closed before the colon, and stays on its own line", () => {
    expect(parseDefaultSize("**Default size**: 32x32")).toEqual({ width: 32, height: 32 });
    expect(parseDefaultSize("Default size:\n16x16")).toBeNull();
  });

  it("is null when there is no such line or its size is no good", () => {
    expect(parseDefaultSize("# Art\nSprites are 16x16.\n")).toBeNull();
    expect(parseDefaultSize("Default size: 0x16")).toBeNull();
    expect(parseDefaultSize("Default size: big")).toBeNull();
  });
});

describe("the reference images of an Art Direction", () => {
  it("lists the repository image paths it mentions, once each, in order", () => {
    const text = "See `assets/art/sprites/hero.png` and ![tiles](assets/art/tiles/grass.png).\nAgain assets/art/sprites/hero.png, and docs/ref-1.png.";

    expect(parseReferences(text)).toEqual(["assets/art/sprites/hero.png", "assets/art/tiles/grass.png", "docs/ref-1.png"]);
  });

  it("ignores links, absolute paths and paths leaving the repository", () => {
    const text = "https://example.com/a/b.png /etc/x.png ../outside.png ok/inside.png";

    expect(parseReferences(text)).toEqual(["ok/inside.png"]);
  });

  it("does not take a longer file name or a ./ path for a reference", () => {
    expect(parseReferences("a.png.bak ./x.png ok.png")).toEqual(["ok.png"]);
  });

  it("is empty for an Art Direction without any", () => {
    expect(parseReferences("# Art\nJust words.")).toEqual([]);
  });
});
