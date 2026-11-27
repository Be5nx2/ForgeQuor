import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { PNG } from "pngjs";

/** What the Asset Checks found about the file at an Asset's target path. */
export interface AssetCheckResult {
  /** False when there is nothing at the target path at all. */
  written: boolean;
  /** Problems that send the Asset back to the Artist. */
  failures: string[];
  /** Problems the human decides on: they never fail the Asset. */
  warnings: string[];
}

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const SAMPLE_COLOURS = 5;
/** An Asset file larger than this is refused unread: pixel art is a few kilobytes. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Where the IHDR chunk's width, height and colour type sit in a PNG. */
const IHDR_END = 33;

/** Whether the PNG can carry transparency: an alpha colour type, or a tRNS chunk. Reads the chunk headers only. */
function hasAlpha(bytes: Buffer): boolean {
  const colorType = bytes[25];
  if (colorType === 4 || colorType === 6) return true;
  for (let at = PNG_SIGNATURE.length; at + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    if (type === "tRNS") return true;
    if (type === "IDAT" || type === "IEND") return false;
    at += 12 + length;
  }
  return false;
}

const hex = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();

/** The opaque colours of a decoded image outside the palette, as #RRGGBB, in order of first appearance. */
function outsidePalette(png: PNG, palette: string[]): string[] {
  const allowed = new Set(palette);
  const found = new Set<string>();
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i + 3] !== 255) continue;
    const colour = `#${hex(png.data[i]!)}${hex(png.data[i + 1]!)}${hex(png.data[i + 2]!)}`;
    if (!allowed.has(colour)) found.add(colour);
  }
  return [...found];
}

/** How many pixels of a decoded image are not fully opaque. */
function countTransparent(png: PNG): number {
  let n = 0;
  for (let i = 3; i < png.data.length; i += 4) if (png.data[i] !== 255) n++;
  return n;
}

/**
 * Validates the file at an Asset's target path inside the worktree: a readable PNG with an alpha channel, of the
 * requested size (frame width × frame count for an Animation Strip), really inside the worktree; with the fill flag, fully opaque. With a palette, opaque colours outside it
 * only warn. Never repairs anything. The file is decoded only once its header says it has the requested size, so a hostile
 * file cannot make Forgequor allocate a huge image.
 */
export function checkAssetFile(
  worktreePath: string,
  request: { targetPath: string; width: number; height: number; frames?: number; fill?: boolean },
  palette: string[] | null,
): AssetCheckResult {
  const file = resolve(worktreePath, request.targetPath);
  try {
    lstatSync(file);
  } catch {
    return { written: false, failures: [], warnings: [] };
  }
  const failed = (message: string): AssetCheckResult => ({ written: true, failures: [message], warnings: [] });

  let bytes: Buffer;
  try {
    const root = realpathSync(worktreePath);
    const real = realpathSync(file);
    const stat = statSync(real);
    if (!real.startsWith(root + sep) || !stat.isFile()) throw new Error("outside");
    if (stat.size > MAX_FILE_BYTES) return failed(`The file is too large for an Asset (${stat.size} bytes).`);
    bytes = readFileSync(real);
  } catch {
    return failed("The target path is not a regular file inside the worktree.");
  }

  if (bytes.length < IHDR_END || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) || bytes.toString("latin1", 12, 16) !== "IHDR") {
    return failed("The file is not a readable PNG.");
  }
  const failures: string[] = [];
  if (!hasAlpha(bytes)) failures.push("The PNG has no alpha channel: it needs a transparent background.");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  // An Animation Strip holds its frames side by side: frame width × frame count.
  const expectedWidth = request.width * (request.frames ?? 1);
  if (width !== expectedWidth || height !== request.height) {
    failures.push(`The PNG is ${width}x${height}, expected exactly ${expectedWidth}x${request.height}.`);
    return { written: true, failures, warnings: [] };
  }

  let png: PNG;
  try {
    png = PNG.sync.read(bytes);
  } catch {
    return failed("The file is not a readable PNG.");
  }
  if (request.fill) {
    const transparent = countTransparent(png);
    if (transparent) failures.push(`The Asset must fill its whole square, but ${transparent} pixels are transparent.`);
  }
  const warnings: string[] = [];
  if (!failures.length && palette) {
    const off = outsidePalette(png, palette);
    if (off.length) {
      const samples = off.slice(0, SAMPLE_COLOURS).join(", ");
      warnings.push(`${off.length} ${off.length === 1 ? "colour" : "colours"} outside the palette: ${samples}${off.length > SAMPLE_COLOURS ? ", …" : ""}`);
    }
  }
  return { written: true, failures, warnings };
}

/**
 * The palette of an Art Direction: every #RRGGBB code under a "Palette" heading, up to the next heading of its level, upper-cased.
 * Null when the document has no such heading or lists no code there.
 */
export function parsePalette(artDirection: string): string[] | null {
  const lines = artDirection.split("\n");
  const start = lines.findIndex((l) => /^#{1,6}\s+palette\b/i.test(l));
  if (start < 0) return null;
  const level = /^#+/.exec(lines[start]!)![0].length;
  const colours: string[] = [];
  for (const line of lines.slice(start + 1)) {
    // The Palette section ends at the next heading of its own level or a higher one; subsections belong to it.
    const heading = /^(#{1,6})\s/.exec(line);
    if (heading && heading[1]!.length <= level) break;
    for (const m of line.matchAll(/#[0-9a-fA-F]{6}\b/g)) {
      const colour = m[0].toUpperCase();
      if (!colours.includes(colour)) colours.push(colour);
    }
  }
  return colours.length ? colours : null;
}
